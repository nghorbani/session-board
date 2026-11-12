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
 * One index per open session, kept only while a viewer is open (steps.cjs's E2 rule): open()
 * creates or reuses it, close() releases it (and the follow timer) once no subscriber is left.
 */

const nodeFs = require('fs');
const path = require('path');

const stepsMod = require('./steps.cjs');

const SEARCH_CAP = 500;

function uuidOk(sessionId) {
  return typeof sessionId === 'string' && /^[0-9a-f-]{8,64}$/i.test(sessionId);
}

function createStepsService(deps) {
  deps = deps || {};
  const fs = deps.fs || nodeFs;
  const resolveTranscript = deps.resolveTranscript || (() => null);
  const sessionTitle = deps.sessionTitle || (() => null);
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;
  const pollIntervalMs = deps.pollIntervalMs || 1000;
  const rg = deps.rg || {};
  const dataDir = deps.dataDir || path.join(require('os').homedir(), '.session-board-steps');
  const chunkBytes = deps.chunkBytes;
  const tailBytes = deps.tailBytes;
  const createStepIndex = deps.createStepIndex || stepsMod.createStepIndex;
  const buildSections = deps.buildSections || stepsMod.buildSections;

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

  /* Create or reuse the session's state. A subscriber may register before "open" runs (the
     transport wires up its push listener first); that leaves a slot with no index yet, which
     this fills in rather than replacing, so the earlier subscriber is never dropped. Starting
     the index is async; callers await ensureSession before reading state.index.steps() so
     "open" never races the first paint. */
  async function ensureSession(sessionId) {
    let s = sessions.get(sessionId);
    if (s && s.index) return s;
    const file = resolveTranscript(sessionId);
    if (!file) return null;
    const idx = createStepIndex(file, { fs, chunkBytes, tailBytes });
    if (s) { s.index = idx; s.file = file; } else {
      s = { index: idx, file, subscribers: new Set(), timer: null, searchRun: null };
      sessions.set(sessionId, s);
    }
    let sawProgress = false;
    await idx.open((frac) => {
      sawProgress = true;
      push(sessionId, { type: 'stepsProgress', sessionId, fraction: frac, done: false });
    });
    if (sawProgress) push(sessionId, { type: 'stepsProgress', sessionId, fraction: 1, done: true });
    return s;
  }

  function startFollow(sessionId, s) {
    if (s.timer != null) return;
    s.timer = setIntervalFn(async () => {
      try {
        const res = await s.index.poll();
        if (!fs.existsSync(s.file)) {
          push(sessionId, { type: 'stepsChanged', sessionId, error: 'transcript moved or removed' });
          return;
        }
        if (!res.appended.length && res.reset === null) return;
        const { sections, strip } = buildSections(s.index.steps(), s.index.body);
        if (res.reset !== null && res.reset !== undefined) {
          push(sessionId, { type: 'stepsChanged', sessionId, reset: res.reset, sections, strip });
        } else {
          push(sessionId, { type: 'stepsChanged', sessionId, appended: res.appended, sections, strip });
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
    startFollow(sessionId, s);
    const stepsArr = s.index.steps();
    const { sections, strip } = buildSections(stepsArr, s.index.body);
    return Object.assign(reply, {
      ok: true,
      title: sessionTitle(sessionId) || null,
      sections,
      strip,
      steps: compactSteps(stepsArr),
      counts: s.index.counts(),
      generation: s.index.generation(),
      indexing: false, // open() always finishes the backward pass before replying; progress already arrived as pushes
      seenStepId: readSeen(sessionId),
    });
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

  async function handleClose(msg) {
    const sessionId = String(msg.sessionId || '');
    releaseIfIdle(sessionId);
    return { type: 'closeResult', ok: true, sessionId };
  }

  // -- search ------------------------------------------------------------------------------

  /* A hit's visible text is confirmed by checking it actually occurs (case-insensitively) in
     the step's rendered body, so a byte-offset that landed inside a tool call's raw JSON input
     (an id, a path, a signature) rather than text the page shows does not count as a hit.
     Stated limit (plan E16): a match has to sit inside one stored field, the way Claude Code
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
    if (b.questions) for (const q of b.questions) { parts.push(q.question); for (const o of q.options) parts.push(o.label, o.description); }
    return parts.join('\n');
  }

  async function runSearch(sessionId, s, query, requestId, controller) {
    const q = String(query || '');
    const stepsArr = s.index.steps();
    let candidateIds = [];
    const rgInfo = await (rg.probe ? rg.probe() : Promise.resolve({ path: null }));
    if (controller.signal.aborted) return { cancelled: true };

    if (rgInfo && rgInfo.path && s.file) {
      // E6: --byte-offset --only-matching --fixed-strings --ignore-case, two -e patterns (the
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
    const capped = confirmed.length >= SEARCH_CAP && candidateIds.length > confirmed.length;
    return { type: 'searchResult', sessionId, requestId, query: q, stepIds: confirmed, capped };
  }

  /* Map each byte offset (from ripgrep or the Node fallback) to every step built from the tree
     line covering it, through the index's nodeRange(uuid) hook. A line may carry several block
     steps (a split response, several tool_use blocks); all of them become candidates, so a hit
     on any one text/tool_use/thinking block of that line is never missed. */
  function stepsAtOffsets(s, stepsArr, offsets) {
    if (!offsets.length) return [];
    const ids = [];
    const seen = new Set();
    const sorted = offsets.slice().sort((a, b) => a - b);
    for (const st of stepsArr) {
      if (seen.has(st.id)) continue;
      const r = s.index.nodeRange(st.nodeUuid);
      if (!r) continue;
      for (const off of sorted) {
        if (off >= r.offset && off < r.offset + r.length) { seen.add(st.id); ids.push(st.id); break; }
      }
    }
    return ids;
  }

  /* Streaming scan of the whole file for the two forms of the query (plain and JSON-escaped,
     the way the text is actually stored), used only when ripgrep is unavailable. Reads the
     file in chunks rather than loading the whole thing at once. */
  async function nodeScan(s, stepsArr, q, signal) {
    const needles = [...new Set([q, (rg.jsonEscaped ? rg.jsonEscaped(q) : q)])].filter(Boolean).map((n) => n.toLowerCase());
    if (!needles.length) return [];
    const text = await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(s.file, { encoding: 'utf8' });
      let buf = '';
      rs.on('data', (chunk) => { buf += chunk; });
      rs.on('end', () => resolve(buf));
      rs.on('error', reject);
      if (signal) signal.addEventListener('abort', () => rs.destroy(new Error('aborted')), { once: true });
    }).catch(() => '');
    const lower = text.toLowerCase();
    const offsets = [];
    for (const needle of needles) {
      let from = 0;
      for (;;) {
        const i = lower.indexOf(needle, from);
        if (i === -1) break;
        offsets.push(i);
        from = i + needle.length;
      }
    }
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

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return { type: 'errorResult', message: 'bad message' };
    switch (msg.type) {
      case 'open': return handleOpen(msg);
      case 'body': return handleBody(msg);
      case 'search': return handleSearch(msg);
      case 'cancelSearch': return handleCancelSearch(msg);
      case 'seen': return handleSeen(msg);
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

module.exports = { createStepsService };
