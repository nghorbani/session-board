'use strict';
/*
 * steps-service.cjs: one message-based service in front of steps.cjs's transcript reader,
 * shared by both transports (the VS Code panel in extension.js and the browser routes in
 * server.cjs). Every viewer action is a message answered by handle(msg) with a `<type>Result`
 * reply carrying the request's requestId; live updates (follow, indexing progress) arrive
 * through subscribe(sessionId, cb) as pushes, not through handle().
 *
 * Pure module: no vscode import, every external effect (fs, the follow timer, the ripgrep
 * runner, the transcript lookup, the session title) is injected like notify.cjs, so the host
 * tests never touch a real transcript, a real `claude` or a real ripgrep.
 *
 * One index per open session, kept only while a viewer is open: open()
 * creates or reuses it, close() releases it (and the follow timer) once no subscriber is left.
 */

const nodeFs = require('fs');
const path = require('path');

const stepsMod = require('./steps.cjs');
const { createNotesStore } = require('./notes.cjs');

const SEARCH_CAP = 500;

function uuidOk(sessionId) {
  return typeof sessionId === 'string' && /^[0-9a-f-]{8,64}$/i.test(sessionId);
}

/* "HH:MM" in local time, the same way the page's fmtClock reads a step's timestamp; an
   unparsable or missing "at" reads as an empty clock rather than "NaN:NaN". */
function clockOf(at) {
  const d = new Date(at);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/* The step's own words, on one line, cut to 120 characters: what "About your step at ..." quotes
   back so the owner on the other end recognises which step the note is about without reading the
   whole transcript again. Collapses internal newlines to spaces first, since the quoted form in
   the hand-over text is always one line. */
function oneLineExcerpt(text, max) {
  max = max || 120;
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/* The text handed to a session for one note, built in this one place so the single-note
   send and "send all" share the exact same phrasing. stepText is whatever the step shows as its
   own body (steps-service's stepVisibleText, or the compact preview when the body has not
   loaded); stepAt is the step's ISO timestamp. */
function buildNoteSendText(stepAt, stepText, noteText) {
  return 'About your step at ' + clockOf(stepAt) + ' ("' + oneLineExcerpt(stepText) + '"): ' + String(noteText || '').trim();
}

/* "Send all notes": every note in step order (the order its step occurs in the transcript, not
   note creation time), each in buildNoteSendText's own form, one per paragraph. items is
   [{ at, stepText, noteText }, ...] already sorted by the caller. */
function buildNotesSendAllText(items) {
  return items.map((it) => buildNoteSendText(it.at, it.stepText, it.noteText)).join('\n\n');
}

function createStepsService(deps) {
  deps = deps || {};
  const fs = deps.fs || nodeFs;
  const resolveTranscript = deps.resolveTranscript || (() => null);
  const sessionTitle = deps.sessionTitle || (() => null);
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;
  const pollIntervalMs = deps.pollIntervalMs || 1000;
  // While the backward pass runs, a provisional push (the sections and strip built so far) goes
  // out at most this often; every push carries the whole section list, so one per chunk of a
  // large transcript would send the same megabytes hundreds of times over.
  const progressIntervalMs = deps.progressIntervalMs === undefined ? 500 : deps.progressIntervalMs;
  const now = deps.now || Date.now;
  const rg = deps.rg || {};
  const dataDir = deps.dataDir || path.join(require('os').homedir(), '.session-board-steps');
  const chunkBytes = deps.chunkBytes;
  const tailBytes = deps.tailBytes;
  const createStepIndex = deps.createStepIndex || stepsMod.createStepIndex;
  const buildSections = deps.buildSections || stepsMod.buildSections;
  const notes = deps.notes || createNotesStore({ fs, dataDir });
  /* Hands the built text to whichever transport this host runs over. The webview host
     passes its own VS Code `revealHere`/clipboard routine; server.cjs passes its clipboard-only
     one; a test passes a fake and asserts on what it was called with. meta carries context a
     transport may want (stepId, noteId, kind: 'single' | 'all') without steps-service needing to
     know what either transport does with it. Resolves to { ok, message } (message is the line the
     page shows, e.g. "In the chat box and on the clipboard."); never throws. */
  const deliver = deps.deliver || (async () => ({ ok: false, message: 'no send-to-session transport configured' }));

  const sessions = new Map(); // sessionId -> { index, file, subscribers: Set, timer, searchRun }

  function seenDir() { return path.join(dataDir, 'steps-seen'); }
  function seenFile(sessionId) { return path.join(seenDir(), sessionId + '.json'); }

  /* The seen marker has its own reader/writer rather than reusing core.cjs's readMarkers,
     because readMarkers deletes any marker file without a numeric top-level `at`; this record
     carries `stepId` as its payload, with `at` only as the write time for that same rule. */
  function readSeen(sessionId) {
    try {
      const o = JSON.parse(fs.readFileSync(seenFile(sessionId), 'utf8'));
      return o && typeof o.stepId === 'string' ? o.stepId : null;
    } catch (_) { return null; }
  }
  function writeSeen(sessionId, stepId) {
    fs.mkdirSync(seenDir(), { recursive: true });
    const tmp = seenFile(sessionId) + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), stepId: String(stepId) }));
    fs.renameSync(tmp, seenFile(sessionId));
  }

  function push(sessionId, msg) {
    const s = sessions.get(sessionId);
    if (!s) return;
    for (const cb of s.subscribers) { try { cb(msg); } catch (_) { /* a broken subscriber must not break the others */ } }
  }

  function errorMessage(e) { return String((e && e.message) || e || 'unknown error'); }

  /* Create or reuse the session's state and return as soon as the index's first pass over the
     file's tail (its newest steps, `tailBytes` from the end, steps.cjs's own default 2 MB) is
     in, never waiting for the whole backward pass over a huge transcript. A subscriber may
     register before "open" runs (the transport wires up its push listener first); that leaves
     a slot with no index yet, which this fills in rather than replacing, so the earlier
     subscriber is never dropped.
     idx.open() walks backward in chunks and calls its progress callback after each one. On a
     file at or under `tailBytes` (the ordinary case until a session gets large) there is no
     separate tail step, so resolving on the first callback would mean replying with one chunk
     of a small file. Instead this tracks the fraction of the file covered so far and takes
     first paint once it reaches the tail's own share of the file (1.0 for a file no bigger
     than the tail, which then finishes indexing in full before this resolves) or once indexing
     completes outright, whichever comes first.
     idx.open()'s own promise keeps running after first paint: further backward progress lands
     in the background, each step pushed to subscribers as a provisional update with the
     sections and strip built so far, and the index is marked "still indexing" for this session
     until that promise settles, which startFollow checks so a poll never races the backward
     pass for the same bytes. */
  function ensureSession(sessionId) {
    let s = sessions.get(sessionId);
    if (s && s.index) return Promise.resolve(s);
    const file = resolveTranscript(sessionId);
    if (!file) return Promise.resolve(null);
    const idx = createStepIndex(file, { fs, chunkBytes, tailBytes });
    if (s) { s.index = idx; s.file = file; } else {
      s = { index: idx, file, subscribers: new Set(), timer: null, searchRun: null };
      sessions.set(sessionId, s);
    }
    s.indexing = true;
    s.pushedIds = new Set();
    const sameSlot = () => sessions.get(sessionId) === s;
    let totalSize = 0;
    try { totalSize = fs.statSync(file).size; } catch (_) { /* open() will find the same miss */ }
    const tailFraction = totalSize > 0 ? Math.min(1, (tailBytes || 2 * 1024 * 1024) / totalSize) : 1;
    return new Promise((resolveFirstPaint) => {
      let firstPaintSeen = false;
      let lastProgressAt = null;
      const takeFirstPaint = () => { if (!firstPaintSeen) { firstPaintSeen = true; resolveFirstPaint(s); } };
      // indexingDone only turns false, and startFollow only starts polling, once this settles:
      // idx.poll() reads forward from the index's own sizeSeen, which open() does not set until
      // its whole backward pass is through, so a poll that ran while it was still in flight
      // would re-read bytes the backward pass had not accounted for yet and could ingest lines
      // twice or miss the point where the two passes should meet.
      s.indexingDone = idx.open((frac) => {
        // frac reaching 1 here means the backward pass is about to settle on its own very next
        // microtask; that settling (below) is what flips s.indexing to false, so first paint is
        // never taken on this exact tick, only strictly before it, or indexing has not
        // finished and a caller reading s.indexing right after first paint would see stale
        // (true) state for a file that is in fact already fully indexed.
        if (frac >= tailFraction && frac < 1) takeFirstPaint();
        if (sameSlot() && (lastProgressAt === null || now() - lastProgressAt >= progressIntervalMs)) {
          lastProgressAt = now();
          const { sections, strip } = buildSections(idx.steps(), idx.body);
          push(sessionId, { type: 'stepsProgress', sessionId, generation: idx.generation(), fraction: frac, done: false, sections, strip, steps: freshCompact(s, idx.steps()) });
        }
      }).then(() => {
        takeFirstPaint();   // settling is always a cue too, however small the file or short the pass
        if (sameSlot()) {
          s.indexing = false;
          const { sections, strip } = buildSections(idx.steps(), idx.body);
          push(sessionId, { type: 'stepsProgress', sessionId, generation: idx.generation(), fraction: 1, done: true, sections, strip, steps: freshCompact(s, idx.steps()) });
        }
      }, (e) => {
        takeFirstPaint();
        if (sameSlot()) {
          s.indexing = false;
          push(sessionId, { type: 'stepsProgress', sessionId, fraction: 1, done: true, error: errorMessage(e) });
        }
      });
    });
  }

  function startFollow(sessionId, s) {
    if (s.timer != null) return;
    s.timer = setIntervalFn(async () => {
      try {
        // a slot released while a tick was waiting (the last viewer closed) has nobody to tell
        if (sessions.get(sessionId) !== s) { stopFollow(s); return; }
        if (s.indexing) return;   // the backward pass still owns sizeSeen; wait for it to finish once
        const res = await s.index.poll();
        if (!fs.existsSync(s.file)) {
          push(sessionId, { type: 'stepsChanged', sessionId, error: 'transcript moved or removed' });
          return;
        }
        // A result that came in for a step already shown (an answer, an approval, a tool's
        // output) adds no step, but it changes what that step says and can open a section.
        const updated = res.updated || [];
        if (!res.appended.length && !updated.length && res.reset === null) return;
        const { sections, strip } = buildSections(s.index.steps(), s.index.body, s.index.fullText);
        const generation = s.index.generation();
        if (res.reset !== null && res.reset !== undefined) {
          // the path changed further back: ids may answer to other steps now, so send them all
          s.pushedIds = new Set();
          push(sessionId, { type: 'stepsChanged', sessionId, generation, reset: res.reset, sections, strip, steps: freshCompact(s, s.index.steps()) });
        } else {
          push(sessionId, {
            type: 'stepsChanged', sessionId, generation,
            appended: res.appended.map((st) => st.id), updated: updated.map((st) => st.id),
            sections, strip, steps: freshCompact(s, res.appended).concat(compactSteps(updated)),
          });
        }
      } catch (e) {
        push(sessionId, { type: 'stepsChanged', sessionId, error: errorMessage(e) });
      }
    }, pollIntervalMs);
  }

  function stopFollow(s) {
    if (s.timer != null) { clearIntervalFn(s.timer); s.timer = null; }
  }

  function releaseIfIdle(sessionId) {
    const s = sessions.get(sessionId);
    if (!s || s.subscribers.size) return;
    stopFollow(s);
    sessions.delete(sessionId);
  }

  /* The compact records of the steps no push has carried yet. A section list names steps by
     id only, so a viewer can draw a section only when it holds the records of its steps:
     the open reply gives the ones known then, and every later push gives the ones it adds
     (earlier steps while the index walks backward, new ones while the session runs). */
  function freshCompact(s, stepsArr) {
    const fresh = stepsArr.filter((st) => !s.pushedIds.has(st.id));
    for (const st of fresh) s.pushedIds.add(st.id);
    return compactSteps(fresh);
  }

  function compactSteps(stepsArr) {
    // what "open" hands the page per step: enough to render a row without a body() round trip.
    // generation travels with it so a later body request for this exact step can be told apart
    // from a same-id step born of a fresh index (steps.cjs's own stale check, see body()).
    return stepsArr.map((s) => ({ id: s.id, kind: s.kind, at: s.at, preview: s.preview, title: s.title, approved: s.approved, durationMs: s.durationMs, blockType: s.blockType, generation: s.generation }));
  }

  // ---------------------------------------------------------------------------------------
  // message handlers
  // ---------------------------------------------------------------------------------------

  async function handleOpen(msg) {
    const sessionId = String(msg.sessionId || '');
    const reply = { type: 'openResult', requestId: msg.requestId };
    if (!uuidOk(sessionId)) return Object.assign(reply, { ok: false, message: 'not a session id' });
    let s;
    try {
      s = await ensureSession(sessionId);
    } catch (e) {
      return Object.assign(reply, { ok: false, message: errorMessage(e) });
    }
    if (!s) return Object.assign(reply, { ok: false, message: 'no transcript found for this session' });
    // The viewer may have closed while the first pass was reading: its slot is gone then, and a
    // timer started now would poll the file for nobody until the host exits.
    if (sessions.get(sessionId) !== s) return Object.assign(reply, { ok: false, message: 'the viewer closed before the transcript was read' });
    startFollow(sessionId, s);
    const stepsArr = s.index.steps();
    const { sections, strip } = buildSections(stepsArr, s.index.body, s.index.fullText);
    return Object.assign(reply, {
      ok: true,
      title: sessionTitle(sessionId) || null,
      sections,
      strip,
      steps: compactSteps(stepsArr),
      counts: s.index.counts(),
      generation: s.index.generation(),
      // true while the backward pass over the rest of the file still runs in the background;
      // the tail alone (this reply's sections) is already in. Earlier sections and the strip
      // are provisional until a stepsProgress push with done:true lands.
      indexing: Boolean(s.indexing),
      seenStepId: readSeen(sessionId),
      notes: notesSafe(sessionId),
    });
  }

  /* notes.cjs throws on a bad id or empty/oversized text; the open reply and every push must
     still carry whatever list it can read rather than fail the whole message over a stray file. */
  function notesSafe(sessionId) {
    try { return notes.list(sessionId); } catch (_) { return []; }
  }

  function pushNotesChanged(sessionId) {
    push(sessionId, { type: 'notesChanged', sessionId, notes: notesSafe(sessionId) });
  }

  async function handleBody(msg) {
    const sessionId = String(msg.sessionId || '');
    const s = sessions.get(sessionId);
    if (!s || !s.index) return { type: 'bodyResult', sessionId, stepId: msg.stepId, stale: true };
    // a request names the step by id plus the generation it was shown under (compactSteps), so
    // steps.cjs's own stale check can tell a step held across a re-index from a fresh one that
    // happens to reuse the same id.
    const held = msg.generation !== undefined ? { id: msg.stepId, generation: msg.generation } : msg.stepId;
    const b = s.index.body(held);
    return Object.assign({ type: 'bodyResult', sessionId, stepId: msg.stepId }, b);
  }

  /* bodies: one round trip for every step the page wants to show text for right now (the
     sections near the viewport), instead of one body message per step. Each entry carries its
     own stepId/generation pair the same way a single body request does, and a step this
     session's index no longer holds (closed, re-indexed) answers { stale: true } like body()
     does, never a thrown error that would drop the rest of the batch. With `forExport` the
     page is writing the story out: every text comes whole, past the 200 KB a row shows, and
     a tool call comes without its result, which no export prints. */
  async function handleBodies(msg) {
    const sessionId = String(msg.sessionId || '');
    const s = sessions.get(sessionId);
    const stepIds = Array.isArray(msg.stepIds) ? msg.stepIds : [];
    const generation = msg.generation;
    const items = stepIds.map((stepId) => {
      if (!s || !s.index) return Object.assign({ stepId, stale: true });
      const held = generation !== undefined ? { id: stepId, generation } : stepId;
      return Object.assign({ stepId }, msg.forExport ? s.index.exportBody(held) : s.index.body(held));
    });
    return { type: 'bodiesResult', sessionId, generation, items };
  }

  async function handleSeen(msg) {
    const sessionId = String(msg.sessionId || '');
    if (!uuidOk(sessionId)) return { type: 'seenResult', ok: false, message: 'not a session id' };
    try {
      writeSeen(sessionId, msg.stepId);
      return { type: 'seenResult', ok: true, sessionId, stepId: msg.stepId };
    } catch (e) {
      return { type: 'seenResult', ok: false, message: errorMessage(e) };
    }
  }

  // -- notes -------------------------------------------------------------------------------

  async function handleNoteAdd(msg) {
    const sessionId = String(msg.sessionId || '');
    try {
      const note = notes.add(sessionId, String(msg.stepId || ''), msg.text);
      pushNotesChanged(sessionId);
      return { type: 'noteAddResult', ok: true, sessionId, note };
    } catch (e) {
      return { type: 'noteAddResult', ok: false, sessionId, message: errorMessage(e) };
    }
  }

  async function handleNoteEdit(msg) {
    const sessionId = String(msg.sessionId || '');
    try {
      const note = notes.edit(sessionId, String(msg.noteId || ''), msg.text);
      if (!note) return { type: 'noteEditResult', ok: false, sessionId, message: 'that note is gone' };
      pushNotesChanged(sessionId);
      return { type: 'noteEditResult', ok: true, sessionId, note };
    } catch (e) {
      return { type: 'noteEditResult', ok: false, sessionId, message: errorMessage(e) };
    }
  }

  async function handleNoteDelete(msg) {
    const sessionId = String(msg.sessionId || '');
    try {
      const removed = notes.delete(sessionId, String(msg.noteId || ''));
      pushNotesChanged(sessionId);
      return { type: 'noteDeleteResult', ok: true, sessionId, removed };
    } catch (e) {
      return { type: 'noteDeleteResult', ok: false, sessionId, message: errorMessage(e) };
    }
  }

  async function handleClose(msg) {
    const sessionId = String(msg.sessionId || '');
    releaseIfIdle(sessionId);
    return { type: 'closeResult', ok: true, sessionId };
  }

  // -- send to session ------------------------------------------------------------------------

  /* The step a note is filed against, as buildNoteSendText needs it: its timestamp and its own
     visible text (falling back to the compact preview when the body is not loaded, same as the
     page's Work line summaries do, so a send never waits on a body round trip that never
     resolves because the step fell off the path). Returns null when the session or the step is
     not currently held (closed, re-indexed): a send then still writes the sent record (the note
     itself does not require its step to still be on the path), but the text falls back to
     the note's own words alone. */
  function stepContextFor(s, stepId) {
    if (!s || !s.index) return null;
    const stepsArr = s.index.steps();
    const step = stepsArr.find((st) => st.id === stepId);
    if (!step) return null;
    return { at: step.at, text: stepVisibleText(s, stepId) || step.preview || '' };
  }

  async function handleNoteSend(msg) {
    const sessionId = String(msg.sessionId || '');
    const noteId = String(msg.noteId || '');
    const s = sessions.get(sessionId);
    let note;
    try { note = notes.get(sessionId, noteId); } catch (e) { return { type: 'noteSendResult', ok: false, sessionId, noteId, message: errorMessage(e) }; }
    if (!note) return { type: 'noteSendResult', ok: false, sessionId, noteId, message: 'that note is gone' };
    const ctx = stepContextFor(s, note.stepId) || { at: '', text: '' };
    const text = buildNoteSendText(ctx.at, ctx.text, note.text);
    let result;
    try {
      result = await deliver(sessionId, text, { stepId: note.stepId, noteId, kind: 'single' });
    } catch (e) {
      return { type: 'noteSendResult', ok: false, sessionId, noteId, message: errorMessage(e) };
    }
    if (result && result.ok) {
      try { notes.addSent(sessionId, noteId, 'steer'); } catch (_) { /* the reply still reports success to the page */ }
      pushNotesChanged(sessionId);
    }
    // text travels back even on a copy-only reply (ok: false from a transport that cannot reach
    // a chat box): the browser page has no other way to learn the exact string it must put on
    // its own clipboard, since deliver() built it, not the caller.
    return { type: 'noteSendResult', ok: !!(result && result.ok), sessionId, noteId, text, message: (result && result.message) || 'nothing happened' };
  }

  async function handleNotesSendAll(msg) {
    const sessionId = String(msg.sessionId || '');
    const s = sessions.get(sessionId);
    let list;
    try { list = notes.list(sessionId); } catch (e) { return { type: 'notesSendAllResult', ok: false, sessionId, message: errorMessage(e) }; }
    if (!list.length) return { type: 'notesSendAllResult', ok: false, sessionId, message: 'no notes to send' };
    // step order: the order each note's own step occurs in the transcript, not note creation
    // time. A note whose step fell off the path (not found by stepContextFor) sorts after every
    // note still on the path, in the order notes.list already returned (by creation time).
    const stepsArr = s && s.index ? s.index.steps() : [];
    const indexOf = new Map(stepsArr.map((st, i) => [st.id, i]));
    const ordered = list.slice().sort((a, b) => {
      const ia = indexOf.has(a.stepId) ? indexOf.get(a.stepId) : Infinity;
      const ib = indexOf.has(b.stepId) ? indexOf.get(b.stepId) : Infinity;
      return ia - ib;
    });
    const items = ordered.map((n) => {
      const ctx = stepContextFor(s, n.stepId) || { at: '', text: '' };
      return { at: ctx.at, stepText: ctx.text, noteText: n.text, noteId: n.id };
    });
    const text = buildNotesSendAllText(items);
    let result;
    try {
      result = await deliver(sessionId, text, { noteIds: items.map((it) => it.noteId), kind: 'all' });
    } catch (e) {
      return { type: 'notesSendAllResult', ok: false, sessionId, message: errorMessage(e) };
    }
    if (result && result.ok) {
      for (const it of items) { try { notes.addSent(sessionId, it.noteId, 'steer'); } catch (_) { /* best effort per note */ } }
      pushNotesChanged(sessionId);
    }
    return { type: 'notesSendAllResult', ok: !!(result && result.ok), sessionId, text, message: (result && result.message) || 'nothing happened' };
  }

  /* The whole text of a step whose body the page shows cut at 200 KB: what "Open full text"
     opens in an editor tab, or copies in a browser. */
  function handleFullText(msg) {
    const sessionId = String(msg.sessionId || '');
    const s = sessions.get(sessionId);
    const reply = { type: 'fullTextResult', sessionId, stepId: msg.stepId };
    if (!s || !s.index) return Object.assign(reply, { ok: false, message: 'session not open' });
    // named with the generation the page shows the step under, like a body, so a step held
    // across a replaced transcript is not answered with the text of another
    const stepId = String(msg.stepId || '');
    const full = s.index.fullText(msg.generation !== undefined ? { id: stepId, generation: msg.generation } : stepId);
    if (full.stale) return Object.assign(reply, { ok: false, message: 'that step is no longer in the transcript' });
    return Object.assign(reply, { ok: true, text: full.text });
  }

  // -- search ------------------------------------------------------------------------------

  /* A hit's visible text is confirmed by checking it actually occurs (case-insensitively) in
     the step's rendered body, so a byte-offset that landed inside a tool call's raw JSON input
     (an id, a path, a signature) rather than text the page shows does not count as a hit.
     Stated limit, also in the README: a match has to sit inside one stored field, the way Claude Code
     wrote it (JSON.stringify: printable and non-ASCII letters literal, quotes/backslashes/
     control characters escaped, the same encoding jsonEscaped produces). A query that only
     matches across the join of two fields this function concatenates (a tool's title and its
     input summary, say) is not found, because the stored transcript never carries that joined
     string as a contiguous run of bytes for ripgrep or the Node fallback to hit. */
  function stepVisibleText(s, stepId) {
    const b = s.index.body(stepId);
    if (!b) return '';
    if (typeof b.text === 'string') return b.text;
    const parts = [];
    if (b.title) parts.push(b.title);
    if (b.input) parts.push(b.input);
    if (b.result) parts.push(b.result);
    if (b.description) parts.push(b.description);
    if (b.prompt) parts.push(b.prompt);
    if (b.report) parts.push(b.report);
    if (b.questions) for (const q of b.questions) { parts.push(q.header, q.question, q.other); for (const o of q.options) parts.push(o.label, o.description); }
    return parts.filter(Boolean).join('\n');
  }

  async function runSearch(sessionId, s, query, requestId, controller) {
    const q = String(query || '');
    const stepsArr = s.index.steps();
    let candidateIds = [];
    const rgInfo = await (rg.probe ? rg.probe() : Promise.resolve({ path: null }));
    if (controller.signal.aborted) return { cancelled: true };

    if (rgInfo && rgInfo.path && s.file) {
      // rg runs with --byte-offset --only-matching --fixed-strings --ignore-case and two -e patterns (the
      // literal query and its JSON-escaped form, the way the string is actually stored), never
      // --json (a single stored line can run to megabytes). Offsets name candidate steps by the
      // byte range of the tree line they fall in; every tree-line step built from that line is a
      // candidate, so a hit is never missed for landing on, say, the second text block of a
      // split response. Candidates are then confirmed against each step's own visible text.
      // Single file, no -H: ripgrep's --byte-offset output is "offset:match" per line (never a
      // path prefix, so a colon inside the matched text itself cannot be confused with one).
      const args = [...(rg.RG_BASE || []), '--byte-offset', '--only-matching', '--fixed-strings', '--ignore-case',
        '-e', q, '-e', (rg.jsonEscaped ? rg.jsonEscaped(q) : q), s.file];
      const r = await rg.run(rgInfo.path, args, { signal: controller.signal });
      if (controller.signal.aborted) return { cancelled: true };
      const offsets = [];
      for (const ln of String((r && r.stdout) || '').split('\n')) {
        if (!ln) continue;
        const i = ln.indexOf(':');
        if (i === -1) continue;
        const off = Number(ln.slice(0, i));
        if (Number.isFinite(off)) offsets.push(off);
      }
      candidateIds = stepsAtOffsets(s, stepsArr, offsets);
    } else {
      // Node fallback: a streaming scan of the file, matching the same two forms.
      candidateIds = await nodeScan(s, stepsArr, q, controller.signal);
      if (controller.signal.aborted) return { cancelled: true };
    }

    const confirmed = [];
    const ql = q.toLowerCase();
    for (const id of candidateIds) {
      if (controller.signal.aborted) return { cancelled: true };
      const visible = stepVisibleText(s, id).toLowerCase();
      if (visible.indexOf(ql) !== -1) confirmed.push(id);
      if (confirmed.length >= SEARCH_CAP) break;
    }
    // Notes are searched too: a hit in a note's text lands on the step the
    // note is attached to, same as any other hit on that step.
    if (ql && confirmed.length < SEARCH_CAP) {
      const seen = new Set(confirmed);
      for (const note of notesSafe(sessionId)) {
        if (seen.has(note.stepId)) continue;
        if (String(note.text || '').toLowerCase().indexOf(ql) !== -1) { confirmed.push(note.stepId); seen.add(note.stepId); }
        if (confirmed.length >= SEARCH_CAP) break;
      }
    }
    const capped = confirmed.length >= SEARCH_CAP && candidateIds.length > confirmed.length;
    return { type: 'searchResult', sessionId, requestId, query: q, stepIds: confirmed, capped };
  }

  /* Map the byte offsets of hits (from ripgrep or the Node fallback) to the steps that show the
     text there, through the index's sourceRanges(step): the step's own line, the line of its
     result and the line of its report. A line may carry several block steps (a split response,
     several tool_use blocks); all of them become candidates. The offsets are sorted once and
     each range is looked up by bisection, so a common word with hundreds of thousands of hits
     costs steps times log(hits), not steps times hits. */
  function stepsAtOffsets(s, stepsArr, offsets) {
    if (!offsets.length) return [];
    const sorted = Float64Array.from(offsets).sort();
    const holdsHit = (r) => {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < r.offset) lo = mid + 1; else hi = mid;
      }
      return lo < sorted.length && sorted[lo] < r.offset + r.length;
    };
    const ids = [];
    for (const st of stepsArr) {
      if (s.index.sourceRanges(st).some(holdsHit)) ids.push(st.id);
    }
    return ids;
  }

  /* Scan of the file for the two forms of the query (plain and JSON-escaped, the way the text
     is stored), used only when ripgrep is unavailable. The file is read as bytes, chunk by
     chunk, and searched one line at a time: memory stays at one line however large the file,
     and a hit is recorded as the byte offset of its line, which is all the mapping to steps
     needs (a line is one tree node). Character positions of a decoded string would drift from
     byte offsets after the first non-ASCII character. */
  async function nodeScan(s, stepsArr, q, signal) {
    const needles = [...new Set([q, (rg.jsonEscaped ? rg.jsonEscaped(q) : q)])].filter(Boolean).map((n) => n.toLowerCase());
    if (!needles.length) return [];
    const offsets = [];
    await new Promise((resolve) => {
      let rs;
      try { rs = fs.createReadStream(s.file); } catch (_) { resolve(); return; }
      let carry = [];      // the pieces of a line that runs across chunks
      let carryLen = 0;
      let lineStart = 0;   // byte offset of the line in progress
      let pos = 0;         // byte offset of the chunk in hand
      const test = (buf, offset) => {
        let lower;
        try { lower = buf.toString('utf8').toLowerCase(); } catch (_) { return; }   // a line too long for one string
        if (needles.some((n) => lower.indexOf(n) !== -1)) offsets.push(offset);
      };
      rs.on('data', (chunk) => {
        let from = 0;
        for (;;) {
          const nlAt = chunk.indexOf(10, from);
          if (nlAt === -1) break;
          const piece = chunk.subarray(from, nlAt);
          test(carryLen ? Buffer.concat(carry.concat([piece]), carryLen + piece.length) : piece, lineStart);
          carry = [];
          carryLen = 0;
          lineStart = pos + nlAt + 1;
          from = nlAt + 1;
        }
        if (from < chunk.length) { const rest = chunk.subarray(from); carry.push(rest); carryLen += rest.length; }
        pos += chunk.length;
      });
      rs.on('end', () => { if (carryLen) test(Buffer.concat(carry, carryLen), lineStart); resolve(); });
      rs.on('error', () => resolve());
      if (signal) signal.addEventListener('abort', () => { rs.destroy(); resolve(); }, { once: true });
    });
    return stepsAtOffsets(s, stepsArr, offsets);
  }

  async function handleSearch(msg) {
    const sessionId = String(msg.sessionId || '');
    const s = sessions.get(sessionId);
    const requestId = msg.requestId;
    if (!s) return { type: 'searchResult', sessionId, requestId, query: String(msg.query || ''), stepIds: [], capped: false, message: 'session not open' };
    if (s.searchRun) s.searchRun.controller.abort();
    const controller = new AbortController();
    s.searchRun = { controller };
    try {
      const res = await runSearch(sessionId, s, msg.query, requestId, controller);
      if (res.cancelled) return { type: 'searchResult', sessionId, requestId, query: String(msg.query || ''), stepIds: [], capped: false, cancelled: true };
      return res;
    } finally {
      if (s.searchRun && s.searchRun.controller === controller) s.searchRun = null;
    }
  }

  function handleCancelSearch(msg) {
    const sessionId = String(msg.sessionId || '');
    const s = sessions.get(sessionId);
    if (s && s.searchRun) { s.searchRun.controller.abort(); s.searchRun = null; }
    return { type: 'cancelSearchResult', ok: true, sessionId };
  }

  /* Every reply names the request it answers. The webview transport has nothing else to match
     a reply to its request with: a reply without the id leaves the page waiting for good (no
     step text, a note that never closes), while the browser transport, where the HTTP
     response is the reply, would not notice. */
  async function handle(msg) {
    const reply = await dispatch(msg);
    if (reply && msg && msg.requestId !== undefined && reply.requestId === undefined) reply.requestId = msg.requestId;
    return reply;
  }

  async function dispatch(msg) {
    if (!msg || typeof msg !== 'object') return { type: 'errorResult', message: 'bad message' };
    switch (msg.type) {
      case 'open': return handleOpen(msg);
      case 'body': return handleBody(msg);
      case 'bodies': return handleBodies(msg);
      case 'fullText': return handleFullText(msg);
      case 'search': return handleSearch(msg);
      case 'cancelSearch': return handleCancelSearch(msg);
      case 'seen': return handleSeen(msg);
      case 'noteAdd': return handleNoteAdd(msg);
      case 'noteEdit': return handleNoteEdit(msg);
      case 'noteDelete': return handleNoteDelete(msg);
      case 'noteSend': return handleNoteSend(msg);
      case 'notesSendAll': return handleNotesSendAll(msg);
      case 'close': return handleClose(msg);
      default: return { type: 'errorResult', message: 'unknown message type: ' + String(msg.type) };
    }
  }

  function subscribe(sessionId, cb) {
    let s = sessions.get(sessionId);
    if (!s) {
      // a subscriber may arrive before open() if the transport wires it up first; create the
      // slot lazily so startFollow has somewhere to record its timer once open() runs.
      s = { index: null, file: resolveTranscript(sessionId), subscribers: new Set(), timer: null, searchRun: null };
      sessions.set(sessionId, s);
    }
    s.subscribers.add(cb);
    return () => {
      const cur = sessions.get(sessionId);
      if (!cur) return;
      cur.subscribers.delete(cb);
      releaseIfIdle(sessionId);
    };
  }

  return { handle, subscribe };
}

module.exports = { createStepsService, buildNoteSendText, buildNotesSendAllText };
