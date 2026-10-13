#!/usr/bin/env node
/**
 * Optional browser front end for Session Board: serves extension/index.html on localhost and
 * exposes the shared data layer (extension/core.cjs) as a small JSON API. The same page and
 * data layer run inside VS Code via the extension.
 *
 * Every /api route requires the per-run token the server embeds into the page, and a Host
 * of 127.0.0.1:<port> (Origin, when sent, must match too): the end, unarchive, seen and
 * retitle routes change state, the usage and retitle routes start a CLI process, and the
 * search route returns private transcript text.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const core = require('./extension/core.cjs');

const PORT = Number(process.env.SESSION_DASHBOARD_PORT) || 4317;
const INDEX_HTML = path.join(__dirname, 'extension', 'index.html');
const TOKEN = crypto.randomBytes(16).toString('hex');
const HOST = '127.0.0.1:' + PORT;

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
    try { core.unarchiveSession(sessionId); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }

  if (route.startsWith('/api/seen/') && req.method === 'POST') {
    const sessionId = safeDecode(route.slice('/api/seen/'.length));
    if (!sessionId || !core.UUID_RE.test(sessionId)) return sendJson(res, 400, { ok: false, error: 'not a session id' });
    try { core.markSeen(sessionId); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  }

  if (route.startsWith('/api/retitle/') && req.method === 'POST') {
    // One short model call over the transcript; the reply is stored as the board's title.
    const sessionId = safeDecode(route.slice('/api/retitle/'.length));
    if (!sessionId || !core.UUID_RE.test(sessionId)) return sendJson(res, 400, { ok: false, code: 'invalid', message: 'not a session id' });
    const result = await core.retitleSession(sessionId);
    const codes = { invalid: 400, 'no-transcript': 404, timeout: 504, failed: 502, empty: 502 };
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
