'use strict';
/*
 * The page's archive flow, driven in a headless Chromium over the DevTools protocol against
 * an in-test HTTP server that serves index.html and plays scripted /api answers. Skipped
 * with a reason when no Chromium is found (tools/screenshot.cjs knows the usual paths).
 *
 *   node:test ──▶ fake API (http) ◀── index.html in headless Chrome ◀── CDP over Node's WebSocket
 *                   scripted /api/sessions, /api/end, /api/unarchive, /api/search, /api/focus
 *                   every call except the poll is recorded for the assertions
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { browser } = require('../../tools/screenshot.cjs');

let CHROME = null;
try { CHROME = browser(); } catch (_) { CHROME = null; }
const opts = { skip: CHROME ? false : 'no Chromium found; set SCREENSHOT_BROWSER to run the page suite', timeout: 60000 };

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const TOKEN = 'test-token';
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const P = 'cccccccc-3333-4333-8333-333333333333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function row(sessionId, title, status, extra) {
  return Object.assign({ sessionId, title, status, waitingFor: status === 'waiting' ? 'permission prompt' : null, name: null, lastPrompt: null, cwd: 'C:\\code\\x', window: { id: 1, label: 'x' }, ageMinutes: 1, contextTokens: 1000, pct: 1, transcriptPath: null, kind: 'interactive', pid: 100, archived: false }, extra);
}
function snapshotOf(sessions) {
  return { at: Date.now(), stale: false, error: null, limits: { compact: 100000, save: 90000 }, platform: 'win32', sessions, usage: { state: 'ok', at: Date.now(), ageSeconds: 0, subscriptionType: 'x', windows: { five_hour: { label: '5h', usedPct: 1, resetsAt: null, expired: false } }, account: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'dev@example.com', orgName: 'Example', subscriptionType: 'x' }, accountError: null } };
}

// -- fake API ----------------------------------------------------------------------------

const fake = { snapshot: snapshotOf([]), end: () => ({ status: 200, body: { ok: true, code: 'ended' } }), search: { rows: [] }, calls: [] };
let PORT = 0;
function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
function serve(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (u.pathname === '/') {
    const html = INDEX
      .replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="board-token" content="' + TOKEN + '">')
      .replace('var POLL_MS = 4000;', 'var POLL_MS = 250;')
      .replace('<script>', '<script>window.confirm = function () { return window.__confirmAnswer !== false; }; window.prompt = function () { return null; };'
        + ' Object.defineProperty(navigator, "clipboard", { value: { writeText: function (t) { window.__copied = t; return Promise.resolve(); } } }); window.Notification = undefined;</script>\n<script>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.headers['x-board-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
  if (u.pathname === '/api/sessions') return json(res, 200, fake.snapshot);
  fake.calls.push({ method: req.method, path: u.pathname, query: u.search });
  if (u.pathname.startsWith('/api/end/')) { const r = fake.end(u.pathname.slice('/api/end/'.length), u.searchParams); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/unarchive/')) return json(res, 200, { ok: true });
  if (u.pathname.startsWith('/api/focus/')) return json(res, 200, { ok: true });
  if (u.pathname === '/api/search') {
    return json(res, 200, Object.assign({ requestId: u.searchParams.get('requestId'), query: u.searchParams.get('q'), content: true, total: fake.search.rows.length, shown: fake.search.rows.length, partial: false, skipped: 0, rgAvailable: true }, fake.search));
  }
  return json(res, 404, { error: 'not found' });
}
function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

// -- Chrome over the DevTools protocol ----------------------------------------------------

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } }; }
  send(method, params, sessionId) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); }); }
}
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));
const kill = (pid) => { if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* gone */ } } else { try { process.kill(pid); } catch (_) { /* gone */ } } };

let server = null;
let chrome = null;
let cdp = null;
let userDataDir = null;

test.before(async () => {
  if (!CHROME) return;
  PORT = await freePort();
  server = http.createServer(serve);
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res));
  const cdpPort = await freePort();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-page-chrome-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + userDataDir, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let info = null;
  for (let i = 0; i < 100 && !info; i++) { try { info = await getJson('http://127.0.0.1:' + cdpPort + '/json/version'); } catch (_) { await sleep(200); } }
  if (!info) throw new Error('Chrome did not open its debugging port');
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  cdp = new CDP(ws);
});

test.after(async () => {
  if (chrome) kill(chrome.pid);
  if (server) await new Promise((res) => server.close(res));
  if (userDataDir) {   // Chrome's crash handler may hold a file for a moment; a leftover temp profile is not a failure
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* leave it to the OS temp cleanup */ }
  }
});

const SAMPLE = `(function () {
  var q = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var ids = function (sel) { return q(sel + ' .row[data-session]').map(function (r) { return r.getAttribute('data-session'); }); };
  var text = function (sel) { var e = document.querySelector(sel); return e ? e.textContent : null; };
  return {
    waiting: ids('#l-waiting'), busy: ids('#l-busy'), idle: ids('#l-idle'), archivedList: ids('#l-archived'), results: ids('#l-results'),
    counts: (text('#counts') || '').replace(/\\s+/g, ' ').trim(),
    toggleArchived: text('#toggleArchived'),
    confirmText: text('.row .iconbtn.confirm'),
    errorText: text('.row.error .sub span'),
    chips: q('.row .chip.archived').length,
    dimmed: q('.row.archived').length,
    pendingEnd: JSON.parse(JSON.stringify(state.pendingEnd)),
    copied: window.__copied || null,
    acct: text('.u-acct'),
    acctTitle: (function () { var e = document.querySelector('.u-acct'); return e ? e.getAttribute('title') : null; })()
  };
})()`;

async function openPage() {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:' + PORT + '/' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  };
  const page = {
    sample: () => ev(SAMPLE),
    click: (sel) => ev('(function () { var e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) throw new Error("no element " + ' + JSON.stringify(sel) + '); e.click(); return true; })()'),
    search: (q) => ev('(function () { var q = document.getElementById("q"); q.value = ' + JSON.stringify(q) + '; q.dispatchEvent(new Event("input")); q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); return true; })()'),
    until: async (pred, what) => {
      const start = Date.now();
      let s = null;
      while (Date.now() - start < 8000) { try { s = await ev(SAMPLE); if (pred(s)) return s; } catch (_) { /* page still loading */ } await sleep(100); }
      throw new Error('timed out waiting for ' + what + '; last sample: ' + JSON.stringify(s));
    },
    close: () => cdp.send('Target.closeTarget', { targetId }),
  };
  await page.until((s) => s.counts.length > 0, 'the page to render');
  return page;
}

const endCalls = (id) => fake.calls.filter((c) => c.path === '/api/end/' + id);
const rowSel = (id) => '.row[data-session="' + id + '"]';

test('page: ⤓ asks Archive?, posts archive=1, and the row leaves', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle'), row(B, 'Busy one', 'busy', { pid: 200 })]);
  fake.end = () => ({ status: 200, body: { ok: true, code: 'ended', archived: true } });
  const page = await openPage();
  await page.until((s) => s.idle.includes(A) && s.busy.includes(B), 'both rows');
  await page.click(rowSel(A) + ' .iconbtn.archive');
  let s = await page.sample();
  assert.equal(s.confirmText, 'Archive?');
  await page.click(rowSel(A) + ' .iconbtn.confirm');
  s = await page.until((x) => !x.idle.includes(A), 'the archived row to leave');
  assert.deepEqual(endCalls(A).map((c) => c.query), ['?archive=1']);
  assert.deepEqual(s.pendingEnd[A], { kind: 'ended', pid: 100 });
  assert.equal(s.counts, '0 need you · 1 working · 1 idle');
  fake.snapshot = snapshotOf([row(B, 'Busy one', 'busy', { pid: 200 })]);
  s = await page.until((x) => !x.pendingEnd[A], 'the ended marker to clear once the snapshot drops the id');
  assert.equal(s.counts, '0 need you · 1 working · 0 idle');
  await page.close();
});

test('page: needs-force asks once more and retries with force and archive', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(B, 'Busy one', 'busy', { pid: 200 })]);
  let n = 0;
  fake.end = () => (++n === 1 ? { status: 409, body: { ok: false, code: 'needs-force', status: 'busy' } } : { status: 200, body: { ok: true, code: 'ended', archived: true } });
  const page = await openPage();
  await page.until((s) => s.busy.includes(B), 'the busy row');
  await page.click(rowSel(B) + ' .iconbtn.archive');
  await page.click(rowSel(B) + ' .iconbtn.confirm');
  await page.until((s) => !s.busy.includes(B), 'the row to leave after the retry');
  assert.deepEqual(endCalls(B).map((c) => c.query), ['?archive=1', '?force=1&archive=1']);
  await page.close();
});

test('page: a resumed archived session comes back only when it waits; busy stays put away until ⤒', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  fake.end = () => ({ status: 200, body: { ok: true, code: 'ended', archived: true } });
  const page = await openPage();
  await page.until((s) => s.idle.includes(A), 'the idle row');
  await page.click(rowSel(A) + ' .iconbtn.archive');
  await page.click(rowSel(A) + ' .iconbtn.confirm');
  await page.until((s) => s.pendingEnd[A] && s.pendingEnd[A].kind === 'ended', 'the ended marker');

  // the same id resumes with a new pid before any snapshot dropped it: waiting shows up
  fake.snapshot = snapshotOf([row(A, 'Spike', 'waiting', { pid: 101, archived: true })]);
  let s = await page.until((x) => x.waiting.includes(A), 'the resumed waiting row');
  assert.equal(s.pendingEnd[A], undefined, 'the ended marker cleared on the pid change');
  assert.ok(s.chips >= 1, 'the archived chip shows');
  assert.equal(s.counts, '1 need you · 0 working · 0 idle');

  // busy again: put away, listed under the toggle
  fake.snapshot = snapshotOf([row(A, 'Spike', 'busy', { pid: 101, archived: true })]);
  s = await page.until((x) => x.toggleArchived === 'Show 1 archived', 'the archived toggle');
  assert.ok(!s.busy.includes(A), 'busy archived row is hidden');
  assert.equal(s.counts, '0 need you · 0 working · 0 idle');
  await page.click('#toggleArchived');
  s = await page.until((x) => x.archivedList.includes(A), 'the revealed archived row');
  assert.ok(s.dimmed >= 1, 'the revealed row is dimmed');
  await page.click(rowSel(A) + ' .iconbtn.unarchive');
  s = await page.until((x) => x.busy.includes(A), 'the row back in Working after ⤒');
  assert.deepEqual(fake.calls.filter((c) => c.path.startsWith('/api/unarchive/')).map((c) => c.path), ['/api/unarchive/' + A]);
  assert.equal(s.toggleArchived, null);
  await page.close();
});

test('page: clicking an archived search row unarchives it first, then copies the resume command', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([]);
  fake.search = { rows: [{ sessionId: P, title: 'Old spike', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\x\\p.jsonl', ageMinutes: 5000, archived: true, snippets: [] }] };
  const page = await openPage();
  await page.search('Old');
  let s = await page.until((x) => x.results.includes(P), 'the search row');
  assert.ok(s.chips >= 1, 'the archived chip on the search row');
  await page.click(rowSel(P));
  s = await page.until((x) => x.chips === 0, 'the chip to go after the unarchive reply');
  assert.deepEqual(fake.calls.filter((c) => c.path.startsWith('/api/unarchive/')).map((c) => c.path), ['/api/unarchive/' + P]);
  assert.equal(s.copied, 'claude --resume ' + P, 'the resume command was copied');
  fake.search = { rows: [] };
  await page.close();
});

test('page: a failed marker write shows ended, not archived on the row', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  fake.end = () => ({ status: 200, body: { ok: true, code: 'ended', archived: false, archiveError: 'EACCES' } });
  const page = await openPage();
  await page.until((s) => s.idle.includes(A), 'the idle row');
  await page.click(rowSel(A) + ' .iconbtn.archive');
  await page.click(rowSel(A) + ' .iconbtn.confirm');
  const s = await page.until((x) => x.errorText !== null, 'the error text');
  assert.equal(s.errorText, 'ended, not archived: EACCES');
  await page.close();
});

test('page: ✕ is unchanged and posts without archive', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  fake.end = () => ({ status: 200, body: { ok: true, code: 'ended' } });
  const page = await openPage();
  await page.until((s) => s.idle.includes(A), 'the idle row');
  await page.click(rowSel(A) + ' .iconbtn.end');
  let s = await page.sample();
  assert.equal(s.confirmText, 'End?');
  await page.click(rowSel(A) + ' .iconbtn.confirm');
  s = await page.until((x) => !x.idle.includes(A), 'the ended row to leave');
  assert.deepEqual(endCalls(A).map((c) => c.query), ['']);
  await page.close();
});

test('page: the usage strip names the signed-in account, org and plan on hover', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([]);
  const page = await openPage();
  let s = await page.until((x) => x.acct !== null, 'the account in the strip');
  assert.equal(s.acct, 'dev@example.com');
  assert.match(s.acctTitle, /^Example · x · claude\.ai/);
  const snap = snapshotOf([]);
  snap.usage = { state: 'no-limits', at: Date.now(), ageSeconds: 0, available: false, windows: null, account: { loggedIn: false, authMethod: 'none', email: null }, accountError: null };
  fake.snapshot = snap;
  s = await page.until((x) => x.acct === 'not logged in', 'the logged-out line in the no-limits state');
  const snap2 = snapshotOf([]);
  snap2.usage = { state: 'error', at: Date.now(), ageSeconds: 0, available: true, windows: null, error: 'claude exited with 2', account: null, accountError: 'boom' };
  fake.snapshot = snap2;
  s = await page.until((x) => x.acct === null, 'no account line when none is known');
  await page.close();
});
