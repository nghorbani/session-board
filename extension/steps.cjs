'use strict';
/*
 * steps.cjs: reads one Claude Code transcript (a JSONL file that is really a tree: retries and
 * edited messages leave abandoned branches) and turns it into a story: compact step records
 * along the active path, with their full bodies available on demand.
 *
 * createStepIndex(file, deps) returns an index over one transcript.
 *   index.open(onProgress)  indexes the whole file once: the last `tailBytes` first (so the
 *     caller has something to show right away), then the remaining bytes backward in
 *     `chunkBytes` chunks with a `setImmediate` yield between chunks, calling onProgress(frac)
 *     as it goes. Only complete lines (terminated by a newline) are ever parsed.
 *   index.poll()  reads whatever the file grew by since the last look, folds the new lines into
 *     the same node map, and recomputes the active path. Returns
 *     { appended, reset, unreadable, generation }: appended steps are new tail steps on the
 *     current path; reset, when the path changed further back (a retry or an edited message),
 *     names the step id the page should redraw from (or null/undefined otherwise); unreadable
 *     is the number of lines this poll could not parse; generation is the index's current
 *     generation number (see below).
 *   index.steps()  the compact step records along the active path, in file order.
 *   index.body(stepId)  reads the stored line(s) back from disk and returns the full body for
 *     that step's kind (see bodyFor below). A body over 200 KB is cut to the first 200 KB with
 *     { truncated: true, size }. Every read checks that the line at the stored offset still
 *     parses and still carries the step's uuid; on a mismatch it returns { stale: true }
 *     instead of guessing.
 *   index.counts()  { byKind: { you: n, text: n, ... }, unreadable: n } over the current steps.
 *   index.generation()  a number that changes whenever the file's identity changes or it got
 *     smaller (a new session file at the same path, or a corrupted tail cut away): either one
 *     starts a fresh index from scratch, never a graft onto the old node map.
 *
 * buildSections(steps, bodyFn) is a pure function (no file access through bodyFn unless called)
 * that splits a step list into sections for the page: a new section starts at every input of
 * the session's owner (a you step, an answered question, an approved plan). Returns
 * { sections, strip } where a section's heading IS its opening you/question/plan step (so that
 * step never also appears as a body row), and strip carries the header-tile counts.
 *
 * Dependencies (fs, the chunk and tail sizes) are injected the way notify.cjs takes deps,
 * defaulting to the real ones, so tests can swap them; no vscode import anywhere in this file.
 */

const nodeFs = require('fs');

const TREE_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);
// system subtypes that are known bookkeeping (hook summaries, informational notes): left out
// of the steps entirely, same as attachments, rather than shown as a folded "other" step.
const KNOWN_HOOK_SUBTYPES = new Set(['stop_hook_summary', 'informational']);
const BODY_LIMIT = 200 * 1024;
const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
// first window when looking backward for a line start; it doubles until a newline turns up
const LINE_SEARCH_BYTES = 64 * 1024;

/* ---------- small text helpers (shared by the reader and the section builder) ---------- */

function textOf(content) {
  if (typeof content === 'string') return content.trim().startsWith('<') ? '' : content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && !String(b.text || '').trim().startsWith('<'))
    .map((b) => b.text || '').join('\n');
}
/* The owner's own words, however the line stored them: a plain string (the common case), or a
   list of blocks (a pasted image, a file reference) for a message typed with an attachment or a
   queued prompt sent while the model was still working. Text blocks are joined as textOf does;
   an image block becomes the word "(image)" rather than vanishing or stringifying to
   "[object Object]" (Array's default join calls String() on every element, and a plain object's
   String() is exactly that). Any other block kind is left out, same as textOf already does for
   non-text blocks. */
/* The blocks Claude Code itself writes into the owner's turn: the output of a local command, a
   slash command's own record, a task notification, what the IDE had open. They are told by
   their first tag. Any other text that starts with "<" is the owner's: markup they typed, or a
   paste (which Claude Code wraps in <pasted_content>). */
const ENVELOPE_RE = /^<(?:task-notification|command-message|command-name|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|ide_opened_file|ide_selection|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)\b/;
function isEnvelope(text) { return ENVELOPE_RE.test(String(text || '').trim()); }

function ownerText(content) {
  if (typeof content === 'string') return isEnvelope(content) ? '' : content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (!b || typeof b !== 'object') return '';
    if (b.type === 'text') return isEnvelope(b.text) ? '' : (b.text || '');
    if (b.type === 'image') return '(image)';
    return '';
  }).filter(Boolean).join('\n');
}
function rawText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' ? b.text || '' : '[' + String(b && b.type) + ']')).join('\n');
}
function cut(s, max) {
  s = String(s == null ? '' : s);
  max = max || 6000;
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n[... ' + (s.length - max) + ' more characters]';
}
function between(s, a, b) {
  const i = s.indexOf(a);
  if (i === -1) return '';
  const j = s.indexOf(b, i + a.length);
  return j === -1 ? '' : s.slice(i + a.length, j);
}
function strings(v, depth, out) {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object' && depth > 0) for (const k of Object.keys(v)) strings(v[k], depth - 1, out);
  return out;
}
function summary(name, input) {
  input = input || {};
  if (name === 'Bash' || name === 'PowerShell') return (input.description ? input.description + '\n' : '') + '$ ' + String(input.command || '');
  if (name === 'Read' || name === 'Edit' || name === 'Write') return String(input.file_path || '');
  if (name === 'Grep' || name === 'Glob') return String(input.pattern || '') + (input.path ? '  in ' + input.path : '');
  if (name === 'Skill') return String(input.skill || '');
  if (name === 'AskUserQuestion') return (input.questions || []).map((q) => String(q.question || '').split('\n')[0]).join('\n');
  if (name === 'ToolSearch') return String(input.query || '');
  let j;
  try { j = JSON.stringify(input); } catch (_) { j = ''; }
  return j.length > 300 ? j.slice(0, 300) + ' ...' : j;
}
function stripTags(s) {
  s = String(s || '');
  for (;;) {
    const i = s.indexOf('<gstack-qid:');
    if (i === -1) break;
    const j = s.indexOf('>', i);
    if (j === -1) break;
    s = s.slice(0, i) + s.slice(j + 1);
  }
  return s.trim();
}
// 'Your questions have been answered: "Q"="A", "Q2"="A2". You can now ...' to [{ q, a }]
function parseAnswerSentence(res) {
  const out = [];
  let s = String(res || '');
  const start = s.indexOf('answered: ');
  if (start === -1) return out;
  s = s.slice(start + 10);
  while (s.charAt(0) === '"') {
    const mid = s.indexOf('"="');
    if (mid === -1) break;
    let end = s.indexOf('", "', mid + 3);
    const last = s.indexOf('". You can', mid + 3);
    if (end === -1 || (last !== -1 && last < end)) end = last;
    if (end === -1) end = s.indexOf('". ', mid + 3);
    if (end === -1) end = s.lastIndexOf('"');
    if (end <= mid + 2) break;
    out.push({ q: s.slice(1, mid).split('\n')[0], a: s.slice(mid + 3, end) });
    s = s.slice(end + 3);
  }
  return out;
}
// result content may carry one "answered:" sentence, or one text block per question (format 2).
function parseAnswers(resultContent) {
  if (Array.isArray(resultContent)) {
    const texts = resultContent.filter((b) => b && b.type === 'text').map((b) => String(b.text || ''));
    if (texts.length > 1) {
      let out = [];
      for (const t of texts) out = out.concat(parseAnswerSentence(t));
      if (out.length) return out;
    }
    return parseAnswerSentence(resultText(resultContent));
  }
  return parseAnswerSentence(String(resultContent || ''));
}
/* `list` without `item` when `item` stands in it as a whole entry of a comma-separated list
   (the start or a comma before it, the end or a comma after it); null when it does not. */
function takeItem(list, item) {
  let from = 0;
  for (;;) {
    const at = list.indexOf(item, from);
    if (at === -1) return null;
    const before = list.slice(0, at).trimEnd();
    const after = list.slice(at + item.length).trimStart();
    if ((before === '' || before.endsWith(',')) && (after === '' || after.startsWith(','))) {
      return list.slice(0, at) + list.slice(at + item.length);
    }
    from = at + 1;
  }
}

// The question as it was asked: header, full text, every option, and what was chosen.
function fullQuestions(input, parsed) {
  return ((input && input.questions) || []).map((q, i) => {
    const text = String(q.question || '');
    const first = text.split('\n')[0];
    const hit = parsed.find((p) => p.q === first) || parsed[i] || null;
    let rest = hit ? String(hit.a) : '';
    // An answer is the chosen labels joined by ", " plus whatever the owner typed. A label
    // counts only as a whole item of that list, and the longest labels are taken first, so
    // "Go" is not found inside "Go with tests" or inside typed words that start with it.
    const labels = (q.options || []).map((o) => String(o.label || ''));
    const chosenLabels = new Set();
    for (const label of [...new Set(labels)].filter(Boolean).sort((a, b) => b.length - a.length)) {
      const taken = takeItem(rest, label);
      if (taken !== null) { chosenLabels.add(label); rest = taken; }
    }
    const options = (q.options || []).map((o) => {
      const label = String(o.label || '');
      return { label, description: String(o.description || ''), chosen: chosenLabels.has(label) };
    });
    rest = rest.split(',').map((x) => x.trim()).filter(Boolean).join(', ');
    return { header: String(q.header || ''), question: stripTags(text), multiSelect: !!q.multiSelect, options, other: rest, answered: !!hit };
  });
}

/* ---------- line classification ---------- */

function isNotificationUserText(t) {
  return t.indexOf('Another Claude session sent a message') === 0 || t.indexOf('[SYSTEM NOTIFICATION') === 0;
}
// A line the system writes when a turn is cancelled mid-flight, not a word the owner typed: it
// must not read as one of their messages or open a section. Exact match only, the way Claude
// Code itself writes this single-block text content.
const INTERRUPTED_MARKERS = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);
function isInterruptedMarkerText(t) {
  return INTERRUPTED_MARKERS.has(String(t || '').trim());
}

/* ---------- the graph node (one per tree line) ----------
 * Kept compact on purpose: no message bodies, only what active-path walking, result joining and
 * step building need, plus the byte range to re-read the line on demand.
 */
function makeNode(o, offset, length) {
  const content = o.message ? o.message.content : null;
  const toolUseIds = [];
  const toolResultIds = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_use' && b.id) toolUseIds.push(b.id);
      if (b.type === 'tool_result' && b.tool_use_id) toolResultIds.push(b.tool_use_id);
    }
  }
  return {
    uuid: o.uuid,
    parentUuid: o.parentUuid || null,
    logicalParentUuid: o.logicalParentUuid || null,
    type: o.type,
    isSidechain: !!o.isSidechain,
    messageId: o.message ? o.message.id : null,
    toolUseIds,
    toolResultIds,
    offset,
    length,
  };
}

/* ---------- the index ---------- */

function createStepIndex(file, deps) {
  deps = deps || {};
  const fs = deps.fs || nodeFs;
  const tailBytes = deps.tailBytes || DEFAULT_TAIL_BYTES;
  const chunkBytes = deps.chunkBytes || DEFAULT_CHUNK_BYTES;

  let generation = 0;
  let nodes = new Map();       // uuid -> node
  let toolResults = new Map(); // tool_use_id -> { offset, length } of the line that carries that result
  let reportsByToolUse = new Map(); // tool_use_id -> report text (task-notification)
  let reportsByAgentId = new Map(); // agentId -> report text (agent-message)
  let agentIdOfToolUse = new Map(); // tool_use_id -> agentId (from the launch result)
  let reportRanges = new Map();     // tool_use_id or 'agent:' + agentId -> { offset, length } of the line its report came in
  let unreadable = 0;
  let identity = null;  // { dev, ino, birthtimeMs } best-effort file identity
  let sizeSeen = 0;     // bytes already folded into the node map
  let path = [];        // step records along the active path, in order
  let pathById = new Map();    // step id -> step record of the active path
  let resultFacts = new Map(); // tool_use_id -> what a plan or question step takes from its result
  // While a poll reads what the file gained: the tool_use ids whose result or report came in.
  // A result adds no step of its own, but the step of its call reads differently from then on
  // (a question has its answer, a plan its approval, a tool its output).
  let touched = null;

  function fileIdentity() {
    try {
      const st = fs.statSync(file);
      return { dev: st.dev, ino: st.ino, birthtimeMs: Number(st.birthtimeMs) || 0, size: st.size, mtimeMs: st.mtimeMs };
    } catch (_) {
      return null;
    }
  }
  function sameIdentity(a, b) {
    if (!a || !b) return false;
    if (a.ino && b.ino && a.dev === b.dev) return a.ino === b.ino;
    return a.birthtimeMs === b.birthtimeMs;
  }

  function resetState() {
    generation += 1;
    nodes = new Map();
    toolResults = new Map();
    reportsByToolUse = new Map();
    reportsByAgentId = new Map();
    agentIdOfToolUse = new Map();
    reportRanges = new Map();
    unreadable = 0;
    sizeSeen = 0;
    path = [];
    pathById = new Map();
    resultFacts = new Map();
  }

  /* feed one parsed line object plus its byte range into the shared maps */
  function ingest(o, offset, length) {
    if (o && typeof o === 'object') {
      if (o.type === 'queue-operation') { grabReports(String(o.content || ''), offset, length); return; }
      if (o.type === 'attachment') {
        grabReports(strings(o.attachment, 4, []).join('\n'), offset, length);
        // attachments can still be tree nodes if they carry a uuid; fall through below
      }
    }
    if (!o || !TREE_TYPES.has(o.type) || !o.uuid) return;
    const node = makeNode(o, offset, length);
    // A line that parses can still hold a block of a shape nothing here expects (a tool input
    // that is a number, a list of questions that is a string). Such a line shows no step and
    // is counted as unreadable; it stays a node, so the steps behind it keep their ancestry,
    // and the lines after it are read as usual.
    let specs = [];
    try { specs = stepSpecsOf(o); } catch (_) { unreadable += 1; }
    if (specs.length) { node.at = o.timestamp || ''; node.specs = specs; }
    nodes.set(o.uuid, node);
    const content = o.message ? o.message.content : null;
    if (o.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || b.type !== 'tool_result') continue;
          const t = resultText(b.content);
          toolResults.set(b.tool_use_id, { offset, length, isError: b.is_error === true });
          if (touched) touched.add(b.tool_use_id);
          const agMatch = /agentId:\s*([^\s).]+)/.exec(t);
          if (agMatch) agentIdOfToolUse.set(b.tool_use_id, agMatch[1]);
        }
      }
      grabReports(rawText(content), offset, length);
    }
  }

  function grabReports(raw, offset, length) {
    if (!raw) return;
    if (raw.indexOf('<task-notification>') !== -1) {
      const id = between(raw, '<tool-use-id>', '</tool-use-id>').trim();
      const r = between(raw, '<result>', '</result>').trim();
      if (id && r && r.indexOf('was delivered to you as a message') === -1) {
        reportsByToolUse.set(id, r);
        reportRanges.set(id, { offset, length });
        if (touched) touched.add(id);
      }
    }
    if (raw.indexOf('<agent-message from="') !== -1) {
      const ag = between(raw, '<agent-message from="', '"');
      let r = between(raw, '<agent-message from="' + ag + '">', '</agent-message>');
      const mark = r.indexOf('The report follows:');
      if (mark !== -1) r = r.slice(mark + 19);
      r = r.split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n').trim();
      if (ag && r) {
        reportsByAgentId.set(ag, r);
        reportRanges.set('agent:' + ag, { offset, length });
        if (touched) for (const [toolUseId, agentId] of agentIdOfToolUse) if (agentId === ag) touched.add(toolUseId);
      }
    }
  }

  function parseLine(buf) {
    const s = buf.toString('utf8');
    if (!s.trim()) return undefined; // blank line: not unreadable, just skip
    try { return JSON.parse(s); } catch (_) { unreadable += 1; return null; }
  }

  /* split a buffer into complete-line records: { obj, offset, length } for each line ending in \n,
     counting offsets relative to `base`. Returns { records, consumedBytes } where consumedBytes
     is the length up to and including the last newline (a trailing partial line is left out). */
  function splitLines(buf, base) {
    const records = [];
    let start = 0;
    let consumed = 0;
    for (;;) {
      const nl = buf.indexOf(10, start); // '\n'
      if (nl === -1) break;
      const lineBuf = buf.slice(start, nl);
      const length = nl - start + 1;
      const offset = base + start;
      const parsed = parseLine(lineBuf);
      if (parsed !== undefined) records.push({ obj: parsed, offset, length: nl - start });
      start = nl + 1;
      consumed = start;
    }
    return { records, consumedBytes: consumed };
  }

  async function yieldTurn() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  /* The offset right after the nearest newline before `searchEnd` (0 when there is none,
     i.e. the file's first line reaches all the way to `searchEnd`). Reads backward in a small
     window that doubles until that newline turns up or the file start is reached, so one very
     long line (well over a chunk) is still found whole and a short one costs a short read. */
  function lineStartBefore(searchEnd) {
    if (searchEnd <= 0) return 0;
    let windowBytes = Math.min(chunkBytes, LINE_SEARCH_BYTES);
    for (;;) {
      const start = Math.max(0, searchEnd - windowBytes);
      const buf = readRange(start, searchEnd);
      const nl = buf.lastIndexOf(10);
      if (nl !== -1) return start + nl + 1;
      if (start === 0) return 0;
      windowBytes *= 2;
    }
  }
  /* One backward step of about `wantBytes`: ingest every complete line between the line start
     at or before `rightBoundary - wantBytes` and `rightBoundary` (always either the file size
     or a position right after some newline), in one read. Returns that line start, the new
     right boundary for the caller's next step. The step starts at a true line start, so it
     never parses a partial line, and it reaches back at least one whole line however long
     that line is. */
  function readBackwardStep(rightBoundary, wantBytes) {
    if (rightBoundary <= 0) return 0;
    const lineStart = lineStartBefore(Math.min(rightBoundary - 1, Math.max(0, rightBoundary - wantBytes)));
    const lines = splitLines(readRange(lineStart, rightBoundary), lineStart);
    for (const r of lines.records) ingest(r.obj, r.offset, r.length);
    return lineStart;
  }

  async function open(onProgress) {
    resetState();
    const ident = fileIdentity();
    identity = ident;
    const totalSize = ident ? ident.size : 0;
    if (!totalSize) { sizeSeen = 0; recomputePath(); return; }

    // First paint: the last `tailBytes` read as one step, no yield before it, so the caller has
    // the newest steps right away. The tail read's own partial leading line is simply deferred
    // to the first backward chunk below, the same way every later chunk defers its own. The
    // path is rebuilt right after this first step too (not only once the whole file is in),
    // so a caller that stops awaiting at the first onProgress call already has a usable,
    // if incomplete, path to show.
    let rightBoundary = totalSize;
    if (totalSize > tailBytes) {
      rightBoundary = readBackwardStep(totalSize, tailBytes);
      recomputePath();
      if (onProgress) onProgress((totalSize - rightBoundary) / totalSize);
    }

    // Then continue backward in `chunkBytes` steps, yielding the event loop between them,
    // until the start of the file.
    while (rightBoundary > 0) {
      rightBoundary = readBackwardStep(rightBoundary, chunkBytes);
      recomputePath();
      if (onProgress) onProgress((totalSize - rightBoundary) / totalSize);
      if (rightBoundary > 0) await yieldTurn();
    }
    // sizeSeen marks only complete lines as read; a partial trailing line (no newline yet) is
    // left for the next poll to pick up once it is finished.
    sizeSeen = lineStartBefore(totalSize);
    recomputePath();
  }

  function readRange(start, end) {
    if (end <= start) return Buffer.alloc(0);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  }

  async function poll() {
    const ident = fileIdentity();
    if (!ident) return { appended: [], updated: [], reset: undefined, unreadable, generation };
    if (!sameIdentity(ident, identity) || ident.size < sizeSeen) {
      const prevPathIds = path.map((s) => s.id);
      await open();
      return { appended: path.slice(), updated: [], reset: prevPathIds.length ? (path[0] ? path[0].id : null) : null, unreadable, generation };
    }
    if (ident.size === sizeSeen) return { appended: [], updated: [], reset: null, unreadable, generation };
    const buf = readRange(sizeSeen, ident.size);
    const { records, consumedBytes } = splitLines(buf, sizeSeen);
    const gained = new Set();
    touched = gained;
    try { for (const r of records) ingest(r.obj, r.offset, r.length); } finally { touched = null; }
    sizeSeen += consumedBytes;
    identity = ident;
    const oldPath = path;
    recomputePath();
    const res = diffPath(oldPath, path);
    // steps that were on the path before this poll and whose result came in with it
    const fresh = new Set(res.appended.map((s) => s.id));
    res.updated = gained.size ? path.filter((st) => st.toolUseId && gained.has(st.toolUseId) && !fresh.has(st.id)) : [];
    return res;
  }

  function diffPath(oldPath, newPath) {
    const oldIds = oldPath.map((s) => s.id);
    let common = 0;
    while (common < oldIds.length && common < newPath.length && oldIds[common] === newPath[common].id) common++;
    if (common === oldIds.length) {
      return { appended: newPath.slice(common), reset: null, unreadable, generation };
    }
    return { appended: newPath.slice(common), reset: newPath.length > common ? newPath[common].id : (oldIds[common] || null), unreadable, generation };
  }

  /* ---------- active path ---------- */

  function findTip() {
    // the newest non-sidechain tree node in file order. Nodes are ingested backward during the
    // initial index and forward during a later poll, so "newest" is decided by byte offset
    // (true file order), never by insertion order into the node map.
    let best = null;
    for (const n of nodes.values()) {
      if (n.isSidechain) continue;
      if (!best || n.offset > best.offset) best = n;
    }
    return best ? best.uuid : null;
  }

  function recomputePath() {
    const tip = findTip();
    const chainUuids = [];
    const seen = new Set();
    let cur = tip;
    while (cur && nodes.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chainUuids.push(cur);
      const n = nodes.get(cur);
      cur = n.parentUuid || n.logicalParentUuid;
    }
    chainUuids.reverse();
    path = buildSteps(chainUuids);
    pathById = new Map();
    for (const st of path) pathById.set(st.id, st);
  }

  /* ---------- turning ancestor nodes into step records ---------- */

  function readLineObj(node) {
    const buf = readRange(node.offset, node.offset + node.length);
    const s = buf.toString('utf8');
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  /* A tool result is read from its line when someone asks for it; the index keeps only where
     that line is, so the results of a long session never sit in memory. */
  function resultContentFor(toolUseId) {
    const r = toolResults.get(toolUseId);
    if (!r) return undefined;
    const o = readLineObj(r);
    const content = o && o.message ? o.message.content : null;
    if (!Array.isArray(content)) return undefined;
    const b = content.find((x) => x && x.type === 'tool_result' && x.tool_use_id === toolUseId);
    return b ? b.content : undefined;
  }
  function toolResultFor(toolUseId) {
    const c = resultContentFor(toolUseId);
    return c === undefined ? '' : cut(resultText(c), 20000);
  }
  /* What a plan step (approved or not) or a question step (the answers) takes from its result,
     read once per call and kept: results do not change. Nothing is kept while the result has
     not arrived, so a later look finds it. */
  function resultFact(toolUseId, derive, missing) {
    if (resultFacts.has(toolUseId)) return resultFacts.get(toolUseId);
    const c = resultContentFor(toolUseId);
    if (c === undefined) return missing;
    const v = derive(c);
    resultFacts.set(toolUseId, v);
    return v;
  }
  function reportFor(toolUseId) {
    if (reportsByToolUse.has(toolUseId)) return reportsByToolUse.get(toolUseId);
    const agentId = agentIdOfToolUse.get(toolUseId);
    if (agentId && reportsByAgentId.has(agentId)) return reportsByAgentId.get(agentId);
    const res = toolResultFor(toolUseId);
    return res.indexOf('Async agent launched') === -1 ? res : '';
  }

  /* The steps one tree line gives, worked out once while the parsed line is in hand: block
     index, kind and the fields of the step record. The path is rebuilt from these after every
     chunk and every poll, so it must not go back to the file for them. What depends on a tool
     result (a plan's approval, a question's answers) is filled in by buildSteps, because a
     result is read before its call on the backward pass and after it on a poll. */
  function stepSpecsOf(o) {
    const out = [];
    const add = (bi, kind, fields) => { out.push({ bi, kind, fields }); };
    const content = o.message ? o.message.content : null;
    if (o.type === 'attachment') {
      // A message typed while the model was still working is queued and delivered as an
      // attachment line, not a user line: attachment.type "queued_command" with
      // attachment.origin.kind "human" is the owner's own words (origin "peer" is another
      // session's message, "task-notification" is bookkeeping; neither is a you step). Left
      // unhandled, this line contributes nothing, so the section it opens is attributed to
      // whatever came next instead of to the owner.
      const att = o.attachment;
      if (att && att.type === 'queued_command' && att.origin && att.origin.kind === 'human') {
        const t = ownerText(att.prompt).trim();
        if (t && !isNotificationUserText(t)) add(0, 'you', { preview: previewOf(t) });
      }
    } else if (o.type === 'user') {
      if (o.isMeta || o.isCompactSummary) return out;
      if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) return out;
      const t = ownerText(content).trim();
      if (!t || isNotificationUserText(t)) return out;
      // A cancelled-turn line the system writes, never a word the owner typed: it must not
      // read as one of their messages or open a section.
      if (isInterruptedMarkerText(t)) add(0, 'interrupted', { preview: 'Interrupted' });
      else add(0, 'you', { preview: previewOf(t) });
    } else if (o.type === 'assistant') {
      if (o.isApiErrorMessage) {
        add(0, 'error', { preview: previewOf(textOf(content) || 'API error') });
        return out;
      }
      const blocks = Array.isArray(content) ? content : [];
      for (let bi = 0; bi < blocks.length; bi++) {
        const b = blocks[bi];
        if (!b) continue;
        if (b.type === 'text' && String(b.text || '').trim()) {
          add(bi, 'text', { preview: previewOf(b.text) });
        } else if (b.type === 'thinking') {
          const text = String(b.thinking || '');
          if (text) add(bi, 'update', { preview: previewOf(text) });
          else add(bi, 'reasoning', { preview: '', durationMs: Number(o.thinkingDurationMs) || 0 });
        } else if (b.type === 'tool_use') {
          const input = b.input || {};
          if (b.name === 'ExitPlanMode') {
            add(bi, 'plan', { preview: previewOf(String(input.plan || '')), toolUseId: b.id });
          } else if (b.name === 'Agent') {
            add(bi, 'subagent', {
              title: String(input.subagent_type || 'agent'),
              preview: previewOf(String(input.description || '')),
              toolUseId: b.id,
            });
          } else if (b.name === 'AskUserQuestion') {
            add(bi, 'question', { preview: previewOf(stripTags(summary(b.name, b.input))), toolUseId: b.id, rawInput: b.input });
          } else {
            const fields = { title: b.name || 'tool', preview: previewOf(summary(b.name, b.input)), toolUseId: b.id };
            // the file an edit changed, kept on the step so counting files needs no read
            if (b.name === 'Edit' || b.name === 'Write') fields.path = String(input.file_path || '');
            add(bi, 'tool', fields);
          }
        } else {
          add(bi, 'other', { preview: '', blockType: String(b.type || 'unknown') });
        }
      }
    } else if (o.type === 'system') {
      if (o.subtype === 'compact_boundary') {
        const m = o.compactMetadata || {};
        add(0, 'compaction', { preview: 'Context compacted: ' + (m.preTokens || '?') + ' to ' + (m.postTokens || '?') + ' tokens' });
      } else if (o.subtype === 'api_error') {
        add(0, 'error', { preview: previewOf(String(o.content || 'API error')) });
      } else if (KNOWN_HOOK_SUBTYPES.has(o.subtype)) {
        // bookkeeping the reader already understands and deliberately leaves out, not "other".
      } else {
        add(0, 'other', { preview: '', blockType: 'system:' + String(o.subtype || 'unknown') });
      }
    }
    return out;
  }

  function buildSteps(chainUuids) {
    const out = [];
    for (const u of chainUuids) {
      const node = nodes.get(u);
      if (!node || !node.specs) continue;
      for (const sp of node.specs) {
        const step = Object.assign({ id: node.uuid + ':' + sp.bi, at: node.at, kind: sp.kind, nodeUuid: node.uuid, blockIndex: sp.bi, generation }, sp.fields);
        if (sp.kind === 'plan') step.approved = resultFact(step.toolUseId, (c) => resultText(c).indexOf('approved') !== -1, false);
        else if (sp.kind === 'question') step.rawAnswers = resultFact(step.toolUseId, parseAnswers, []);
        else if (sp.kind === 'tool') {
          // a call whose result came back as an error did not do what it names: an Edit that
          // failed changed no file
          const result = toolResults.get(step.toolUseId);
          if (result && result.isError) step.failed = true;
        }
        out.push(step);
      }
    }
    return out;
  }

  /* The first 200 characters, as a copy: a slice of a long string keeps the whole string alive,
     and these previews stay in memory for every step of the session. */
  function previewOf(s) {
    s = String(s || '');
    return s.length > 200 ? Buffer.from(s.slice(0, 200), 'utf8').toString('utf8') : s;
  }

  /* ---------- body on demand ---------- */

  function findStep(stepId) {
    return pathById.get(stepId) || null;
  }

  /* `stepId` is a plain step id (the common case: look it up in the current path) or a step
     record a caller kept from an earlier look (its `generation` is checked first, so a step
     held across a poll that started a new generation is caught even if the file happens to
     reuse the same uuid and block index, which a bare id string could not tell apart). */
  function body(stepId, whole, noResult) {
    const heldGeneration = stepId && typeof stepId === 'object' ? stepId.generation : undefined;
    const id = stepId && typeof stepId === 'object' ? stepId.id : stepId;
    if (heldGeneration !== undefined && heldGeneration !== generation) return { stale: true };
    const step = findStep(id);
    if (!step) return { stale: true };
    const node = nodes.get(step.nodeUuid);
    if (!node) return { stale: true };
    const o = readLineObj(node);
    if (!o || o.uuid !== step.nodeUuid) return { stale: true };
    const content = o.message ? o.message.content : null;
    const blocks = Array.isArray(content) ? content : [];
    const b = blocks[step.blockIndex];
    // `whole` lifts the 200 KB cut (fullText below): the same text, to its end
    const textBody = (text) => cutBody(String(text == null ? '' : text), {}, whole);

    if (step.kind === 'you') return textBody(o.type === 'attachment' ? ownerText(o.attachment && o.attachment.prompt) : ownerText(content));
    if (step.kind === 'interrupted') return textBody('Interrupted');
    if (step.kind === 'error') return textBody(textOf(content) || String(o.content || 'API error'));
    if (step.kind === 'compaction') return textBody(step.preview);
    if (step.kind === 'text') return textBody(b ? b.text : '');
    if (step.kind === 'update') return textBody(b ? b.thinking : '');
    if (step.kind === 'reasoning') return Object.assign(textBody(''), { durationMs: step.durationMs });
    if (step.kind === 'other') return Object.assign(textBody(''), { blockType: step.blockType });
    if (step.kind === 'tool') {
      const input = (b && b.input) || {};
      const inputSummary = summary(step.title, input);
      // `noResult` leaves the result unread (exportBody below): an export words its Work
      // lines from the call alone, and a result is a line of its own, megabytes at times
      const out = { title: step.title, input: inputSummary };
      if (!noResult) out.result = toolResultFor(step.toolUseId);
      if (step.title === 'Edit' || step.title === 'Write' || step.title === 'Read') out.path = String(input.file_path || '');
      return out;
    }
    if (step.kind === 'plan') {
      const input = (b && b.input) || {};
      return cutBody(String(input.plan || ''), { approved: step.approved }, whole);
    }
    if (step.kind === 'subagent') {
      const input = (b && b.input) || {};
      return {
        title: step.title,
        description: String(input.description || ''),
        prompt: String(input.prompt || ''),
        report: reportFor(step.toolUseId) || '',
      };
    }
    if (step.kind === 'question') {
      const parsed = step.rawAnswers || [];
      return { questions: fullQuestions(step.rawInput || {}, parsed) };
    }
    return textBody('');
  }

  function cutBody(text, extra, whole) {
    if (!whole && text.length > BODY_LIMIT) {
      return Object.assign({ text: text.slice(0, BODY_LIMIT), truncated: true, size: text.length }, extra);
    }
    return Object.assign({ text, truncated: false, size: text.length }, extra);
  }

  /* The whole text of a step whose body was cut at BODY_LIMIT ("Open full text" on the page):
     read from the same line, to its end. A step without a text of its own answers ''. */
  function fullText(stepId) {
    const b = body(stepId, true);
    if (!b || b.stale) return { stale: true };
    return { text: typeof b.text === 'string' ? b.text : '' };
  }

  function counts() {
    const byKind = {};
    for (const s of path) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    return { byKind, unreadable };
  }

  /* Every stretch of the file that a step's visible text comes from: its own line, the line
     that carries the result of its call, and the line a subagent's report arrived in. Search
     maps the byte offset of a hit back to steps through these, so text that only a result or
     a report holds is found on the step that shows it. */
  function sourceRanges(step) {
    const out = [];
    const node = step ? nodes.get(step.nodeUuid) : null;
    if (node) out.push({ offset: node.offset, length: node.length });
    if (step && step.toolUseId) {
      const result = toolResults.get(step.toolUseId);
      if (result) out.push(result);
      const agentId = agentIdOfToolUse.get(step.toolUseId);
      const report = reportRanges.get(step.toolUseId) || (agentId ? reportRanges.get('agent:' + agentId) : undefined);
      if (report) out.push(report);
    }
    return out;
  }

  return {
    open,
    poll,
    steps() { return path.slice(); },
    body(stepId) { return body(stepId); },   // callers get the cut body; the whole text is fullText's
    // what an export of the story takes: the whole text of a step, a tool call without its result
    exportBody(stepId) { return body(stepId, true, true); },
    fullText,
    counts,
    sourceRanges,
    generation() { return generation; },
  };
}

/* =======================================================================
   Sections: split the path's steps into story sections for the page.
   A new section starts at every input of the session's owner: a you step,
   an answered question, or an approved plan. The section's heading IS that
   opening step (never duplicated as a body row).
======================================================================= */

// 'other' is a block or line of a kind this reader does not know: it stays in the story,
// inside a Work line that names the kind, so a changed transcript format shows up on the page
const QUIET_KINDS = new Set(['tool', 'reasoning', 'subagent', 'other']);

/* A paste arrives wrapped in <pasted_content id="..."> ... </pasted_content>, in front of or
   between the words typed with it. Returns what stands outside the paste blocks, and what the
   first block holds; a block cut off before its closing tag runs to the end of the text. */
function splitPaste(text) {
  let pasted = null;
  const own = String(text || '').replace(/<pasted_content\b[^>]*>([\s\S]*?)(?:<\/pasted_content>|$)/g, (_, inner) => {
    if (pasted === null) pasted = inner;
    return '\n';
  });
  return { own: own.trim(), pasted: String(pasted || '').trim() };
}

function headingForYou(step, bodyFn, wholeFn) {
  // the preview is the start of the same text and longer than any heading, so it serves
  // without a read; a step that carries none (a caller's own record) is read
  const text = step.preview || ((bodyFn(step.id) || {}).text);
  if (String(text || '').indexOf('<pasted_content') !== -1) {
    // A paste: the heading is what you typed with it, which may stand after the paste and so
    // past the preview (the message is read for it); a message that is nothing but a paste
    // is headed by the start of the pasted text. The wrapper tag is never the heading.
    // `wholeFn` reads the message to its end: a body is cut at 200 KB, and a longer paste
    // would hide what was typed after it.
    const whole = wholeFn ? wholeFn(step.id) : null;
    const parts = splitPaste((whole && typeof whole.text === 'string' ? whole.text : (bodyFn(step.id) || {}).text) || text);
    if (parts.own) return firstSentence(parts.own, 90) || 'Message';
    return 'Pasted: ' + (firstSentence(parts.pasted, 80) || 'text');
  }
  return firstSentence(text, 90) || 'Message';
}
function headingForQuestion(step, bodyFn) {
  const b = bodyFn(step.id);
  const q = (b.questions || [])[0];
  if (!q) return 'Answered';
  const chosen = (q.options || []).filter((o) => o.chosen).map((o) => o.label);
  const parts = chosen.slice();
  if (q.other) parts.push(q.other);
  const s = parts.join(', ');
  return firstSentence(s, 90) || (q.answered ? 'Answered' : 'Not answered yet');
}
function firstSentence(t, max) {
  max = max || 100;
  t = String(t || '').trim().replace(/^#+\s*/, '');
  if (!t) return '';
  const l = t.split('\n')[0];
  const m = l.match(/^(.{8,110}?[.!?])\s/);
  const s = m ? m[1] : l;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function durMs(a, b) {
  const d1 = new Date(a).getTime();
  const d2 = new Date(b).getTime();
  if (isNaN(d1) || isNaN(d2)) return 0;
  return Math.max(0, d2 - d1);
}
const ACTIVE_GAP_CAP_MS = 10 * 60 * 1000;
/* Active time: the sum of the gaps between consecutive steps, each gap counted up to the cap, so
   an idle stretch (inside a section or between them) never inflates it: a session left open
   for a day with one hour of real work still reads about one hour. Applied once over the whole
   step sequence rather than per section, so a long pause that happens to fall at a section
   boundary is capped the same as one inside a section: one rule everywhere a timing fact is
   shown, not a looser one for gaps between sections. */
function activeTimeOf(idsInOrder, byId) {
  let ms = 0;
  for (let i = 1; i < idsInOrder.length; i++) {
    const prev = byId.get(idsInOrder[i - 1]);
    const cur = byId.get(idsInOrder[i]);
    if (!prev || !cur) continue;
    ms += Math.min(durMs(prev.at, cur.at), ACTIVE_GAP_CAP_MS);
  }
  return ms;
}

/* `bodyFn(stepId)` reads a step's body as the page shows it; `wholeFn(stepId)`, when given,
   reads a step's whole text ({ text }), for the one heading that needs it. */
function buildSections(stepsArr, bodyFn, wholeFn) {
  const sections = [];
  let cur = { kind: 'lead', heading: 'Session start', at: stepsArr.length ? stepsArr[0].at : '', body: [], openerId: null };
  let quiet = [];

  function flushQuiet() {
    if (quiet.length) cur.body.push({ kind: 'work', items: quiet.slice() });
    quiet = [];
  }
  function openSection(kind, heading, at, openerId) {
    flushQuiet();
    sections.push(cur);
    cur = { kind, heading, at, body: [], openerId };
  }

  for (const s of stepsArr) {
    if (s.kind === 'you') {
      openSection('you', headingForYou(s, bodyFn, wholeFn), s.at, s.id);
      continue;
    }
    if (s.kind === 'question') {
      const b = bodyFn(s.id);
      const answered = (b.questions || []).some((q) => q.answered);
      if (answered) {
        openSection('question', headingForQuestion(s, bodyFn), s.at, s.id);
      } else {
        flushQuiet();
        cur.body.push({ kind: 'question', stepId: s.id });
      }
      continue;
    }
    if (s.kind === 'plan') {
      flushQuiet();
      cur.body.push({ kind: 'plan', stepId: s.id });
      if (s.approved) openSection('approve', 'Plan approved', s.at, s.id);
      continue;
    }
    // an update is the short text the chat showed between tool calls and then replaced: it reads
    // as a text of its own, never folded into the Work line around it
    if (s.kind === 'text' || s.kind === 'update' || s.kind === 'error' || s.kind === 'compaction' || s.kind === 'interrupted') {
      flushQuiet();
      cur.body.push({ kind: s.kind, stepId: s.id });
      continue;
    }
    if (QUIET_KINDS.has(s.kind)) { quiet.push(s.id); continue; }
  }
  flushQuiet();
  sections.push(cur);
  const filtered = sections.filter((s) => s.body.length || s.kind !== 'lead');

  const byId = new Map();
  for (const s of stepsArr) byId.set(s.id, s);
  const filesChangedAll = new Set();
  let decisions = 0;
  for (const sec of filtered) {
    if (sec.kind === 'you' || sec.kind === 'question' || sec.kind === 'approve') decisions++;
    // The facts line under a section: how many tool and subagent calls it made, and how many
    // distinct files it edited or wrote.
    const filesChangedHere = new Set();
    sec.toolCalls = 0;
    for (const row of sec.body) {
      if (row.kind !== 'work') continue;
      for (const id of row.items) {
        const st = byId.get(id);
        if (!st || (st.kind !== 'tool' && st.kind !== 'subagent')) continue;
        sec.toolCalls++;
        if (st.kind === 'tool' && (st.title === 'Edit' || st.title === 'Write') && !st.failed) {
          const file = st.path !== undefined ? st.path : (bodyFn(id) || {}).path;
          if (file) { filesChangedAll.add(file); filesChangedHere.add(file); }
        }
      }
    }
    sec.filesChanged = filesChangedHere.size;
  }
  function sectionStepIds(sec) {
    const ids = sec.openerId ? [sec.openerId] : [];
    for (const row of sec.body || []) {
      if (row.stepId) ids.push(row.stepId);
      if (row.items) ids.push(...row.items);
    }
    return ids;
  }
  // Active time: the sum of the gaps between consecutive steps of the whole session, each
  // gap counted up to activeTimeOf's cap, so an idle stretch does not inflate it even when it
  // falls inside one section. Each section gets the same figure over its own steps, so a facts
  // line built from a section object reads by the identical rule as the header tile.
  const allIds = stepsArr.map((s) => s.id);
  const activeTimeMs = activeTimeOf(allIds, byId);
  for (const sec of filtered) sec.activeTimeMs = activeTimeOf(sectionStepIds(sec), byId);
  const wallClockMs = stepsArr.length ? durMs(stepsArr[0].at, stepsArr[stepsArr.length - 1].at) : 0;
  const strip = {
    activeTimeMs,
    wallClockMs,
    sections: filtered.length,
    decisions,
    filesChanged: filesChangedAll.size,
  };
  return { sections: filtered, strip };
}

module.exports = {
  createStepIndex,
  buildSections,
};
