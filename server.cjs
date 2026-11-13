#!/usr/bin/env node
/**
 * Optional browser front end for Session Board: serves extension/index.html on localhost and
 * exposes the shared data layer (extension/core.cjs) as a small JSON API. The same page and
 * data layer run inside VS Code via the extension.
 *
 * Every /api route requires the per-run token the server embeds into the page, and a Host
 * of 127.0.0.1:<port> (Origin, when sent, must match too): the end, unarchive, seen, mute,
 * unmute and title routes change state, the usage and title-suggest routes start a CLI process, and the
 * search route returns private transcript text.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const core = require('./extension/core.cjs');
const { createStepsService } = require('./extension/steps-service.cjs');

const PORT = Number(process.env.SESSION_DASHBOARD_PORT) || 4317;
const INDEX_HTML = path.join(__dirname, 'extension', 'index.html');
const STEPS_HTML = path.join(__dirname, 'extension', 'steps.html');
const TOKEN = crypto.randomBytes(16).toString('hex');
const HOST = '127.0.0.1:' + PORT;
const STEPS_BODY_LIMIT = 64 * 1024;   // the one route in this file that parses a body

// Pushes (follow, indexing progress) have no open socket to ride on in the browser front end,
// so each session keeps a small bounded queue the page drains by polling; a push past the cap
// drops the oldest rather than growing without bound.
const PUSH_QUEUE_CAP = 500;
const pushQueues = new Map();   // sessionId -> { seq, items: [{ seq, msg }] }

function queuePush(sessionId, msg) {
  let q = pushQueues.get(sessionId);
  if (!q) { q = { seq: 0, items: [] }; pushQueues.set(sessionId, q); }
  q.seq += 1;
  q.items.push({ seq: q.seq, msg });
  if (q.items.length > PUSH_QUEUE_CAP) q.items.splice(0, q.items.length - PUSH_QUEUE_CAP);
}

const stepsService = createStepsService({
  resolveTranscript: (sessionId) => core.transcriptIndex().get(sessionId)
    || core.liveTranscripts(sessionId)[0] || core.stowedTranscripts(sessionId)[0] || null,
  sessionTitle: (sessionId) => {
    const row = core.lastGoodRows().find((r) => r.sessionId === sessionId);
    return (row && (row.title || row.name)) || null;
  },
  dataDir: core.DATA_DIR,
  rg: { probe: () => core.rgProbe(), run: core.run, RG_BASE: core.RG_BASE, jsonEscaped: core.jsonEscaped },
});
let stepsSubscribed = new Set();
function ensureStepsSubscription(sessionId) {
  if (stepsSubscribed.has(sessionId)) return;
  stepsSubscribed.add(sessionId);
  stepsService.subscribe(sessionId, (msg) => queuePush(sessionId, msg));
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function authorized(req) {
  if (req.headers.host !== HOST) return false;
  const origin = req.headers.origin;
  if (origin && origin !== 'http://' + HOST) return false;
  return req.headers['x-board-token'] === TOKEN;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return null; }
}

/** A request body up to `limit` bytes, or { tooLarge: true } once it is exceeded. The rest of
    the body is drained rather than the socket destroyed, so the 413 response the caller writes
    still reaches the client instead of looking like a dropped connection. Every other route in
    this file parses its input from the query string; this is the one place that reads a body,
    because steps messages (open/body/search/seen/close) carry structured fields a query string
    cannot hold cleanly. */
function readBoundedBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;   // still draining so 'end' fires; the bytes themselves are dropped
      total += chunk.length;
      if (total > limit) { tooLarge = true; resolve({ tooLarge: true }); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooLarge) resolve({ text: Buffer.concat(chunks).toString('utf8') }); });
    req.on('error', () => { if (!tooLarge) resolve({ text: '' }); });
  });
}

async function handle(req, res) {
  const parsed = new URL(req.url || '/', 'http://' + HOST);
  const route = parsed.pathname;

  if (route === '/' || route === '/index.html') {
    let html;
    try { html = fs.readFileSync(INDEX_HTML, 'utf8'); } catch (_) {
      res.writeHead(500, { 'content-type': 'text/plain' }); res.end('extension/index.html missing'); return;
    }
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="board-token" content="' + TOKEN + '">');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }

  if (route === '/steps') {
    let html;
    try {
      html = fs.readFileSync(STEPS_HTML, 'utf8');
    } catch (_) {
      html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
        + '<body style="font-family: sans-serif; padding: 2em;">Steps viewer coming soon.</body></html>';
    }
    // the session id comes from ?session=, the same way the board page carries its token: a
    // meta tag the page reads once at load, not a query string it would have to keep parsing.
    const sessionId = String(parsed.searchParams.get('session') || '').replace(/"/g, '&quot;');
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">'
      + '<meta name="board-token" content="' + TOKEN + '">'
      + '<meta name="steps-session" content="' + sessionId + '">');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }

  if (!route.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  if (!authorized(req)) return sendJson(res, 403, { error: 'forbidden: token or origin' });

  if (route === '/api/sessions' && req.method === 'GET') {
    const pending = core.refreshUsageIfStale(5 * 60 * 1000);   // keeps the strip fresh with no VS Code window open
    if (pending) pending.catch(() => { /* reported through usageState */ });
    return sendJson(res, 200, await core.snapshot());
  }

  if (route.startsWith('/api/focus/') && req.method === 'POST') {
    const sessionId = safeDecode(route.slice('/api/focus/'.length));
    if (!sessionId || !core.UUID_RE.test(sessionId)) return sendJson(res, 400, { error: 'not a session id' });
    const row = core.lastGoodRows().find((r) => r.sessionId === sessionId);
    if (!row) return sendJson(res, 404, { error: 'unknown session' });
    try { core.markSeen(sessionId); } catch (_) { /* the jump still happens; the flag returns on the next poll */ }
    const win = await core.windowForPid(Number(row.pid));
    if (!win) return sendJson(res, 409, { error: 'no VS Code window owns this session' });
    try {
      const viaBoard = core.boardAlive(win.exthostPid);
      await core.focusSession(sessionId, win.windowId, { viaBoard });
      return sendJson(res, 200, { ok: true, windowId: win.windowId, viaBoard });
    } catch (e) {
      return sendJson(res, 502, { error: 'code --open-url failed: ' + String(e.message || e) });
    }
  }

  if (route.startsWith('/api/end/') && req.method === 'POST') {
    const sessionId = safeDecode(route.slice('/api/end/'.length));
    if (!sessionId || !core.UUID_RE.test(sessionId)) return sendJson(res, 400, { ok: false, code: 'invalid', error: 'not a session id' });
    // ?archive=1 ends the session and keeps it off the board; an archived `gone` or `unknown` is a success (ok decides).
    const result = await core.endSession(sessionId, { force: parsed.searchParams.get('force') === '1', archive: parsed.searchParams.get('archive') === '1' });
    const codes = { ended: 200, invalid: 400, unknown: 404, gone: 404, mismatch: 409, 'needs-force': 409, pending: 409, partial: 409, denied: 403, timeout: 500, failed: 500, unsupported: 501 };
    return sendJson(res, result.ok ? 200 : (codes[result.code] || 500), result);
  }

  if (route.startsWith('/api/unarchive/') && req.method === 'POST') {
    const sessionId = safeDecode(route.slice('/api/unarchive/'.length));
    if (!sessionId || !core.UUID_RE.test(sessionId)) return sendJson(res, 400, { ok: false, error: 'not a session id' });
    try {
      const r = await core.unarchiveSession(sessionId);   // brings a stowed transcript back first
      return sendJson(res, 200, { ok: true, restoredTo: (r && r.restoredTo) || null });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }

  if (route.startsWith('/api/seen/') && req.method === 'POST') {
    const sessionId = safeDecode(route.slice('/api/seen/'.length));
    if (!sessionId || !core.UUID_RE.test(sessionId)) return sendJson(res, 400, { ok: false, error: 'not a session id' });
    try { core.markSeen(sessionId); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }

  for (const [prefix, muted] of [['/api/mute/', true], ['/api/unmute/', false]]) {
    if (route.startsWith(prefix) && req.method === 'POST') {
      // the bell on a row: the shared marker under the data dir; the next poll carries the flag.
      const sessionId = safeDecode(route.slice(prefix.length));
      if (!sessionId || !core.UUID_RE.test(sessionId)) return sendJson(res, 400, { ok: false, error: 'not a session id' });
      try {
        if (muted) core.muteSession(sessionId); else core.unmuteSession(sessionId);
        return sendJson(res, 200, { ok: true, muted });
      } catch (e) { return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
    }
  }

  if (route === '/api/order' && req.method === 'POST') {
    // A move on the page: the group's complete order, ids comma-joined in the query (this file
    // parses no bodies). 8000 characters is about 216 ids, the cap the page mirrors; core caps
    // the list at 500 for the host transport.
    const raw = parsed.searchParams.get('ids') || '';
    if (raw.length > 8000) return sendJson(res, 400, { ok: false, error: 'too many ids' });
    const ids = raw.split(',').filter(Boolean).map(safeDecode);
    if (!ids.length || ids.some((id) => !id || !core.UUID_RE.test(id))) return sendJson(res, 400, { ok: false, error: 'not a session id' });
    try { return sendJson(res, 200, { ok: true, count: core.setOrder(ids) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }

  if (route === '/api/order/mode' && req.method === 'POST') {
    const mode = parsed.searchParams.get('mode') || '';
    if (mode !== 'activity' && mode !== 'manual') return sendJson(res, 400, { ok: false, error: 'mode must be activity or manual' });
    try { core.setSortMode(mode); return sendJson(res, 200, { ok: true, mode }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }

  if (route === '/api/order/show' && req.method === 'POST') {
    // The header's "running | open | all" switch: the board-wide file every window reads.
    const show = parsed.searchParams.get('show') || '';
    if (!core.SHOW_MODES.includes(show)) return sendJson(res, 400, { ok: false, error: 'show must be one of ' + core.SHOW_MODES.join(', ') });
    try { core.setShowMode(show); return sendJson(res, 200, { ok: true, show }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }

  if (route.startsWith('/api/archive/') && req.method === 'POST') {
    // ⤓ on an ended row: the archive marker, then the transcript move; a running session is refused (409).
    const sessionId = safeDecode(route.slice('/api/archive/'.length));
    if (!sessionId || !core.UUID_RE.test(sessionId)) return sendJson(res, 400, { ok: false, code: 'invalid', message: 'not a session id' });
    const result = await core.archivePast(sessionId);
    const codes = { invalid: 400, running: 409, failed: 500 };
    return sendJson(res, result.ok ? 200 : (codes[result.code] || 500), result);
  }

  if (route.startsWith('/api/title/suggest/') && req.method === 'POST') {
    // One short model call over the transcript; nothing is stored.
    const sessionId = safeDecode(route.slice('/api/title/suggest/'.length));
    if (!sessionId || !core.UUID_RE.test(sessionId)) return sendJson(res, 400, { ok: false, code: 'invalid', message: 'not a session id' });
    const result = await core.suggestTitle(sessionId);
    const codes = { invalid: 400, 'no-transcript': 404, timeout: 504, failed: 502, empty: 502 };
    return sendJson(res, result.ok ? 200 : (codes[result.code] || 500), result);
  }

  if (route.startsWith('/api/title/') && req.method === 'POST') {
    // Writes Claude Code's title (the custom-title line and the sidecar) of a session that is
    // not running; a running one answers 409 claude-owned. The title rides in the query string.
    const sessionId = safeDecode(route.slice('/api/title/'.length));
    if (!sessionId || !core.UUID_RE.test(sessionId)) return sendJson(res, 400, { ok: false, code: 'invalid', message: 'not a session id' });
    const title = parsed.searchParams.get('title') || '';
    if (title.length > 200) return sendJson(res, 400, { ok: false, code: 'invalid', message: 'title too long' });
    const result = core.renameSession(sessionId, title);
    const codes = { invalid: 400, empty: 400, 'claude-owned': 409, 'no-transcript': 404, failed: 500 };
    return sendJson(res, result.ok ? 200 : (codes[result.code] || 500), result);
  }

  if (route === '/api/usage/refresh' && req.method === 'POST') {
    // Runs the CLI usage probe now (core throttles to one per 15 s); the reply is usageState().
    const u = await core.fetchUsage();
    return sendJson(res, u.state === 'error' ? 502 : 200, u);
  }

  if (route === '/api/search' && req.method === 'GET') {
    const q = String(parsed.searchParams.get('q') || '').slice(0, 200);
    const content = parsed.searchParams.get('content') === '1';
    const requestId = String(parsed.searchParams.get('requestId') || Date.now()).slice(0, 64);
    const ac = new AbortController();
    req.on('close', () => { if (!res.writableEnded) ac.abort(); });   // a closed tab stops the rg children
    const result = await core.searchSessions(q, { content, requestId, signal: ac.signal });
    return sendJson(res, 200, result);
  }

  if (route === '/api/steps' && req.method === 'POST') {
    const body = await readBoundedBody(req, STEPS_BODY_LIMIT);
    if (body.tooLarge) return sendJson(res, 413, { error: 'body too large' });
    let msg;
    try { msg = JSON.parse(body.text); } catch (_) { return sendJson(res, 400, { error: 'invalid JSON' }); }
    if (!msg || typeof msg !== 'object') return sendJson(res, 400, { error: 'invalid JSON' });
    if (msg.sessionId) ensureStepsSubscription(String(msg.sessionId));
    const reply = await stepsService.handle(msg);
    return sendJson(res, 200, reply);
  }

  if (route === '/api/steps/poll' && req.method === 'GET') {
    const sessionId = String(parsed.searchParams.get('session') || '');
    if (!core.UUID_RE.test(sessionId)) return sendJson(res, 400, { error: 'not a session id' });
    const after = Number(parsed.searchParams.get('after') || 0) || 0;
    const q = pushQueues.get(sessionId);
    const items = q ? q.items.filter((it) => it.seq > after) : [];
    return sendJson(res, 200, { seq: q ? q.seq : after, pushes: items.map((it) => it.msg) });
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) sendJson(res, 500, { error: String((e && e.message) || e) });
    else { try { res.end(); } catch (_) { /* ignore */ } }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('Session Board: http://' + HOST + '\n');
  process.stdout.write('Ctrl+C to stop.\n');
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    process.stderr.write('Port ' + PORT + ' is in use. Set SESSION_DASHBOARD_PORT to pick another.\n');
    process.exit(1);
  }
  throw e;
});
