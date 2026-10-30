'use strict';
/*
 * The page's archive, section and Blinded flows, driven in a headless Chromium over the
 * DevTools protocol against an in-test HTTP server that serves index.html and plays scripted
 * /api answers. Skipped with a reason when no Chromium is found (tools/screenshot.cjs knows
 * the usual paths).
 *
 *   node:test ──▶ fake API (http) ◀── index.html in headless Chrome ◀── CDP over Node's WebSocket
 *                   scripted /api/sessions, /api/end, /api/unarchive, /api/blind, /api/unblind,
 *                   /api/search, /api/focus; every call except the poll is recorded for the assertions
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
function snapshotOf(sessions, extra) {
  return Object.assign({ at: Date.now(), stale: false, error: null, limits: { compact: 100000, save: 90000 }, platform: 'win32', sessions, usage: { state: 'ok', at: Date.now(), ageSeconds: 0, subscriptionType: 'x', windows: { five_hour: { label: '5h', usedPct: 1, resetsAt: null, expired: false } }, account: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'dev@example.com', orgName: 'Example', subscriptionType: 'x' }, accountError: null } }, extra || {});
}

// -- fake API ----------------------------------------------------------------------------

const fake = { snapshot: snapshotOf([]), end: () => ({ status: 200, body: { ok: true, code: 'ended' } }), unarchive: () => ({ status: 200, body: { ok: true, restoredTo: null } }), retitle: () => ({ status: 200, body: { ok: true, title: 'Renamed by model' } }), blind: () => ({ status: 200, body: { ok: true, blinded: true } }), unblind: () => ({ status: 200, body: { ok: true, blinded: false } }), search: { rows: [] }, calls: [] };
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
  if (u.pathname.startsWith('/api/unarchive/')) { const r = fake.unarchive(u.pathname.slice('/api/unarchive/'.length)); return setTimeout(() => json(res, r.status, r.body), r.delayMs || 0); }
  if (u.pathname.startsWith('/api/blind/')) { const r = fake.blind(u.pathname.slice('/api/blind/'.length)); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/unblind/')) { const r = fake.unblind(u.pathname.slice('/api/unblind/'.length)); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/focus/')) return json(res, 200, { ok: true });
  if (u.pathname.startsWith('/api/seen/')) return json(res, 200, { ok: true });
  if (u.pathname.startsWith('/api/retitle/')) { const r = fake.retitle(u.pathname.slice('/api/retitle/'.length)); return json(res, r.status, r.body); }
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
    rows: ids('#sections'), archivedList: ids('#l-archived'), results: ids('#l-results'),
    sections: q('#sections .section').map(function (sec) { var h = sec.querySelector('.fold'); var b = sec.querySelector('.section-head .badge'); var t = sec.querySelector('button[data-act="stale"]'); return { key: sec.getAttribute('data-section'), label: h.querySelector('.label').textContent, here: !!h.querySelector('.chip.here'), expanded: h.getAttribute('aria-expanded'), folded: sec.classList.contains('folded'), badge: b ? b.textContent : null, tone: b ? (b.classList.contains('wait') ? 'wait' : 'unseen') : null, rows: ids('#sections .section[data-section="' + sec.getAttribute('data-section') + '"]'), stale: t ? t.textContent : null }; }),
    blinded: (function () { var sec = document.querySelector('#g-blinded .section'); if (!sec) return null; var h = sec.querySelector('.fold'); var b = sec.querySelector('.section-head .badge'); return { expanded: h.getAttribute('aria-expanded'), folded: sec.classList.contains('folded'), badge: b ? b.textContent : null, tone: b ? (b.classList.contains('wait') ? 'wait' : 'unseen') : null, waitingHead: sec.classList.contains('waiting'), groups: q('#g-blinded .subhead').map(function (sh) { var gb = sh.querySelector('.badge'); return { label: sh.querySelector('.label').textContent, badge: gb ? gb.textContent : null, n: sh.querySelector('.n').textContent }; }), rows: ids('#g-blinded') }; })(),
    title: document.title,
    blindBusy: q('.iconbtn.blind:disabled, .iconbtn.unblind:disabled').length,
    unblindOn: q('.row[data-session]').filter(function (r) { return r.querySelector('.iconbtn.unblind'); }).map(function (r) { return r.getAttribute('data-session'); }),
    blindedChips: q('.row .chip.blinded').length,
    actionsOverflow: q('.row .actions').filter(function (a) { return a.scrollWidth > a.clientWidth; }).length,
    notes: window.__notes || null,
    titles: q('.row[data-session]').map(function (r) { var t = r.querySelector('.title'); return r.getAttribute('data-session') + '=' + (t ? t.textContent : ''); }),
    statusWords: q('.row[data-session]').map(function (r) { var t = r.querySelector('.status span:last-child'); return r.getAttribute('data-session') + '=' + (t ? t.textContent : ''); }),
    retitleBusy: q('.iconbtn.retitle:disabled').length,
    counts: (text('#counts') || '').replace(/\\s+/g, ' ').trim(),
    toggleArchived: text('#toggleArchived'),
    confirmText: text('.row .iconbtn.confirm'),
    errorText: text('.row.error .sub span'),
    chips: q('.row .chip.archived').length,
    chipTexts: q('.row[data-session]').map(function (r) { var c = r.querySelector('.chip.archived'); return r.getAttribute('data-session') + '=' + (c ? c.textContent : ''); }),
    unarchiveOn: q('.row[data-session]').filter(function (r) { return r.querySelector('.iconbtn.unarchive'); }).map(function (r) { return r.getAttribute('data-session'); }),
    paths: q('.row[data-session]').map(function (r) { return r.getAttribute('data-session') + '=' + r.getAttribute('data-path'); }),
    notice: (function () { var e = document.getElementById('notice'); return e && e.classList.contains('show') ? e.textContent : null; })(),
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
    type: (q) => ev('(function () { var q = document.getElementById("q"); q.value = ' + JSON.stringify(q) + '; q.dispatchEvent(new Event("input")); return true; })()'),
    eval: (expr) => ev(expr),
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
  await page.until((s) => s.rows.includes(A) && s.rows.includes(B), 'both rows');
  await page.click(rowSel(A) + ' .iconbtn.archive');
  let s = await page.sample();
  assert.equal(s.confirmText, 'Archive?');
  await page.click(rowSel(A) + ' .iconbtn.confirm');
  s = await page.until((x) => !x.rows.includes(A), 'the archived row to leave');
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
  await page.until((s) => s.rows.includes(B), 'the busy row');
  await page.click(rowSel(B) + ' .iconbtn.archive');
  await page.click(rowSel(B) + ' .iconbtn.confirm');
  await page.until((s) => !s.rows.includes(B), 'the row to leave after the retry');
  assert.deepEqual(endCalls(B).map((c) => c.query), ['?archive=1', '?force=1&archive=1']);
  await page.close();
});

test('page: a resumed archived session comes back only when it waits; busy stays put away until ⤒', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  fake.end = () => ({ status: 200, body: { ok: true, code: 'ended', archived: true } });
  const page = await openPage();
  await page.until((s) => s.rows.includes(A), 'the idle row');
  await page.click(rowSel(A) + ' .iconbtn.archive');
  await page.click(rowSel(A) + ' .iconbtn.confirm');
  await page.until((s) => s.pendingEnd[A] && s.pendingEnd[A].kind === 'ended', 'the ended marker');

  // the same id resumes with a new pid before any snapshot dropped it: waiting shows up
  fake.snapshot = snapshotOf([row(A, 'Spike', 'waiting', { pid: 101, archived: true })]);
  let s = await page.until((x) => x.rows.includes(A) && x.statusWords.includes(A + '=permission prompt'), 'the resumed waiting row');
  assert.equal(s.pendingEnd[A], undefined, 'the ended marker cleared on the pid change');
  assert.ok(s.chips >= 1, 'the archived chip shows');
  assert.equal(s.counts, '1 need you · 0 working · 0 idle');

  // busy again: put away, listed under the toggle
  fake.snapshot = snapshotOf([row(A, 'Spike', 'busy', { pid: 101, archived: true })]);
  s = await page.until((x) => x.toggleArchived === 'Show 1 archived', 'the archived toggle');
  assert.ok(!s.rows.includes(A), 'busy archived row is hidden');
  assert.equal(s.counts, '0 need you · 0 working · 0 idle');
  await page.click('#toggleArchived');
  s = await page.until((x) => x.archivedList.includes(A), 'the revealed archived row');
  assert.ok(s.dimmed >= 1, 'the revealed row is dimmed');
  await page.click(rowSel(A) + ' .iconbtn.unarchive');
  s = await page.until((x) => x.rows.includes(A), 'the row back in its section after ⤒');
  assert.deepEqual(fake.calls.filter((c) => c.path.startsWith('/api/unarchive/')).map((c) => c.path), ['/api/unarchive/' + A]);
  assert.equal(s.toggleArchived, null);
  await page.close();
});

test('page: clicking a board-archived search row waits for the restore, then copies and shows the restored path', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([]);
  fake.search = { rows: [{ sessionId: P, title: 'Old spike', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\x\\p.jsonl', ageMinutes: 5000, archived: true, archivedBy: 'board', snippets: [] }] };
  fake.unarchive = () => ({ status: 200, body: { ok: true, restoredTo: 'C:\\p\\x\\p.jsonl' }, delayMs: 600 });
  const page = await openPage();
  await page.search('Old');
  let s = await page.until((x) => x.results.includes(P), 'the search row');
  assert.ok(s.chips >= 1, 'the archived chip on the search row');
  await page.click(rowSel(P));
  await sleep(250);
  s = await page.sample();
  assert.equal(s.copied, null, 'nothing copied while the restore is pending');
  s = await page.until((x) => x.chips === 0, 'the chip to go after the unarchive reply');
  assert.deepEqual(fake.calls.filter((c) => c.path.startsWith('/api/unarchive/')).map((c) => c.path), ['/api/unarchive/' + P]);
  assert.equal(s.copied, 'claude --resume ' + P, 'the resume command was copied after the reply');
  assert.ok(s.paths.includes(P + '=C:\\p\\x\\p.jsonl'), 'the row carries the restored path: ' + JSON.stringify(s.paths));
  fake.search = { rows: [] };
  fake.unarchive = () => ({ status: 200, body: { ok: true, restoredTo: null } });
  await page.close();
});

test('page: a failed restore on a search row click copies nothing and shows the notice', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([]);
  fake.search = { rows: [{ sessionId: P, title: 'Old spike', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\x\\p.jsonl', ageMinutes: 5000, archived: true, archivedBy: 'board', snippets: [] }] };
  fake.unarchive = () => ({ status: 500, body: { ok: false, error: 'a different file is already at C:\\p\\x\\p.jsonl; C:\\t\\x\\p.jsonl stays' } });
  const page = await openPage();
  await page.search('Old');
  await page.until((x) => x.results.includes(P), 'the search row');
  await page.click(rowSel(P));
  const s = await page.until((x) => x.notice !== null, 'the notice');
  assert.match(s.notice, /unarchive failed: a different file is already at/);
  assert.equal(s.copied, null, 'nothing copied');
  assert.ok(s.chips >= 1, 'the row stays archived');
  fake.search = { rows: [] };
  fake.unarchive = () => ({ status: 200, body: { ok: true, restoredTo: null } });
  await page.close();
});

test('page: ⧉ on a board-archived search row restores first, then copies', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([]);
  fake.search = { rows: [{ sessionId: P, title: 'Old spike', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\x\\p.jsonl', ageMinutes: 5000, archived: true, archivedBy: 'board', snippets: [] }] };
  fake.unarchive = () => ({ status: 200, body: { ok: true, restoredTo: 'C:\\p\\x\\p.jsonl' } });
  const page = await openPage();
  await page.search('Old');
  await page.until((x) => x.results.includes(P), 'the search row');
  await page.click(rowSel(P) + ' .iconbtn.copy');
  const s = await page.until((x) => x.copied === 'claude --resume ' + P, 'the copy after the restore');
  assert.deepEqual(fake.calls.filter((c) => c.path.startsWith('/api/unarchive/')).map((c) => c.path), ['/api/unarchive/' + P]);
  assert.equal(s.chips, 0, 'the chip went with the restore');
  fake.search = { rows: [] };
  fake.unarchive = () => ({ status: 200, body: { ok: true, restoredTo: null } });
  await page.close();
});

test('page: a failed marker write shows ended, not archived on the row', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  fake.end = () => ({ status: 200, body: { ok: true, code: 'ended', archived: false, archiveError: 'EACCES' } });
  const page = await openPage();
  await page.until((s) => s.rows.includes(A), 'the idle row');
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
  await page.until((s) => s.rows.includes(A), 'the idle row');
  await page.click(rowSel(A) + ' .iconbtn.end');
  let s = await page.sample();
  assert.equal(s.confirmText, 'End?');
  await page.click(rowSel(A) + ' .iconbtn.confirm');
  s = await page.until((x) => !x.rows.includes(A), 'the ended row to leave');
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

test('page: an unseen answer shows the unseen status and counts on its section badge; opening it clears both', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle', { unseen: true }), row(B, 'Old', 'idle')]);
  const page = await openPage();
  let s = await page.until((x) => x.rows.includes(A) && x.rows.includes(B), 'both rows');
  assert.equal(s.counts, '0 need you · 0 working · 1 unseen · 1 idle');
  assert.ok(s.statusWords.includes(A + '=unseen'), JSON.stringify(s.statusWords));
  assert.ok(s.statusWords.includes(B + '=idle'));
  assert.deepEqual([s.sections[0].badge, s.sections[0].tone, s.sections[0].rows], ['1', 'unseen', [A, B]], 'the unseen row sorts first and counts on the badge');
  await page.click(rowSel(A));
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle'), row(B, 'Old', 'idle')]);
  s = await page.until((x) => x.statusWords.includes(A + '=idle') && fake.calls.some((c) => c.path === '/api/focus/' + A), 'the row idle after the click, and the open at the server');
  assert.ok(fake.calls.some((c) => c.method === 'POST' && c.path === '/api/focus/' + A), 'the open went to the server');
  assert.equal(s.counts, '0 need you · 0 working · 2 idle');
  assert.equal(s.sections[0].badge, null, 'the badge is gone');
  await page.close();
});

test('page: a click on an unseen row without a window copies the command and still marks it seen', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle', { unseen: true, window: null })]);
  const page = await openPage();
  await page.until((x) => x.rows.includes(A), 'the unseen row');
  await page.click(rowSel(A));
  await page.until((x) => fake.calls.some((c) => c.path === '/api/seen/' + A), 'the seen call');
  const s = await page.sample();
  assert.equal(s.copied, 'claude --resume ' + A);
  await page.close();
});

test('page: ✎ asks for a new title and shows it when it arrives', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  const page = await openPage();
  await page.until((x) => x.rows.includes(A), 'the row');
  await page.click(rowSel(A) + ' .iconbtn.retitle');
  let s = await page.until((x) => x.titles.includes(A + '=Renamed by model'), 'the new title');
  assert.ok(fake.calls.some((c) => c.method === 'POST' && c.path === '/api/retitle/' + A));
  assert.equal(s.retitleBusy, 0, 'the button is free again');
  fake.retitle = () => ({ status: 502, body: { ok: false, code: 'failed', message: 'model not available' } });
  await page.click(rowSel(A) + ' .iconbtn.retitle');
  s = await page.until((x) => x.errorText !== null, 'the failure on the row');
  assert.equal(s.errorText, 'retitle failed: model not available');
  fake.retitle = () => ({ status: 200, body: { ok: true, title: 'Renamed by model' } });
  await page.close();
});

test('page: a row archived in Claude Code is put away without ⤒, its chip says so, and a click opens it without unarchiving', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle', { archived: true, archivedBy: 'claude-code' }), row(B, 'Board one', 'idle', { pid: 200, archived: true, archivedBy: 'board' })]);
  const page = await openPage();
  let s = await page.until((x) => x.toggleArchived === 'Show 2 archived', 'both rows put away');
  await page.click('#toggleArchived');
  s = await page.until((x) => x.archivedList.includes(A) && x.archivedList.includes(B), 'the revealed rows');
  assert.ok(s.chipTexts.includes(A + '=archived in Claude Code'), JSON.stringify(s.chipTexts));
  assert.ok(s.chipTexts.includes(B + '=archived'));
  assert.deepEqual(s.unarchiveOn, [B], '⤒ only on the board-archived row');
  await page.click(rowSel(A));
  await page.until((x) => fake.calls.some((c) => c.path === '/api/focus/' + A), 'the open of the Claude Code row');
  assert.ok(!fake.calls.some((c) => c.path.startsWith('/api/unarchive/')), 'no unarchive for a Claude Code archive');
  await page.click(rowSel(B));
  await page.until((x) => fake.calls.some((c) => c.path === '/api/unarchive/' + B), 'the live board-archived row still unarchives on a click');
  await page.close();
});

test('page: ⤒ on a row archived in both places keeps the Claude Code chip and leaves the row put away', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle', { archived: true, archivedBy: 'both' })]);
  const page = await openPage();
  await page.until((x) => x.toggleArchived === 'Show 1 archived', 'the row put away');
  await page.click('#toggleArchived');
  let s = await page.until((x) => x.archivedList.includes(A), 'the revealed row');
  assert.ok(s.chipTexts.includes(A + '=archived here and in Claude Code'), JSON.stringify(s.chipTexts));
  await page.click(rowSel(A) + ' .iconbtn.unarchive');
  s = await page.until((x) => x.chipTexts.includes(A + '=archived in Claude Code'), 'the chip after ⤒');
  assert.ok(s.archivedList.includes(A), 'still put away: Claude Code holds its own flag');
  assert.deepEqual(s.unarchiveOn, [], 'no ⤒ left');
  await page.close();
});

test('page: an archive whose move failed shows the notice after the row has left', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  fake.end = () => { fake.snapshot = snapshotOf([]); return { status: 200, body: { ok: true, code: 'ended', archived: true, moved: false, moveError: 'running again under pid 5' } }; };
  const page = await openPage();
  await page.until((x) => x.rows.includes(A), 'the idle row');
  await page.click(rowSel(A) + ' .iconbtn.archive');
  await page.click(rowSel(A) + ' .iconbtn.confirm');
  const s = await page.until((x) => x.notice !== null && !x.rows.includes(A), 'the notice with the row gone');
  assert.equal(s.notice, 'archived; transcript not moved: running again under pid 5');
  fake.end = () => ({ status: 200, body: { ok: true, code: 'ended' } });
  await page.close();
});

// -- sections, Blinded, badges and muting ---------------------------------------------------

const C = 'dddddddd-4444-4444-8444-444444444444';
const D = 'eeeeeeee-5555-4555-8555-555555555555';
const E = 'ffffffff-6666-4666-8666-666666666666';
const win = (id, label) => ({ window: { id, label } });
const blindCalls = () => fake.calls.filter((c) => /^\/api\/(un)?blind\//.test(c.path)).map((c) => c.path);

test('page: one section per window, this window first, then by activity, Elsewhere last; the badge counts waiting and unseen', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([
    row(A, 'Alpha idle', 'idle', win(1, 'alpha')),
    row(B, 'Beta unseen', 'idle', Object.assign({ unseen: true }, win(2, 'beta'))),
    row(C, 'Gamma waits', 'waiting', win(3, 'gamma')),
    row(E, 'Gamma old idle', 'idle', Object.assign({ ageMinutes: 30 }, win(3, 'gamma'))),
    row(D, 'Nowhere', 'idle', { window: null }),
  ], { thisWindowId: 2 });
  const page = await openPage();
  const s = await page.until((x) => x.sections.length === 4, 'four sections');
  assert.deepEqual(s.sections.map((sec) => sec.key), ['w2', 'w3', 'w1', 'none']);
  assert.deepEqual(s.sections.map((sec) => sec.label), ['beta', 'gamma', 'alpha', 'Elsewhere']);
  assert.deepEqual(s.sections.map((sec) => sec.here), [true, false, false, false]);
  assert.deepEqual(s.sections.map((sec) => [sec.badge, sec.tone]), [['1', 'unseen'], ['1', 'wait'], [null, null], [null, null]]);
  assert.deepEqual(s.sections[1].rows, [C, E], 'waiting before idle inside a section');
  assert.deepEqual(s.sections.map((sec) => sec.expanded), ['true', 'true', 'true', 'true']);
  assert.equal(s.blinded, null, 'no Blinded section without blinded rows');
  assert.equal(s.counts, '1 need you · 0 working · 1 unseen · 3 idle');
  assert.equal(s.title, '(1) Sessions');
  assert.equal(s.actionsOverflow, 0, 'five icons and the age fit the actions cell');
  await page.close();
});

test('page: ⊘ moves the row under folded Blinded at once and posts /api/blind; the header unfolds it; ⊙ brings it back', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle'), row(B, 'Other', 'idle', { pid: 200 })]);
  const page = await openPage();
  await page.until((x) => x.rows.includes(A), 'the row');
  await page.click(rowSel(A) + ' .iconbtn.blind');
  let s = await page.until((x) => x.blinded !== null, 'the Blinded section');
  assert.deepEqual([s.rows, s.blinded.folded, s.blinded.expanded, s.blinded.badge, s.blinded.rows], [[B], true, 'false', null, [A]], 'moved at once, folded, no badge for an idle row');
  assert.equal(s.blindBusy, 1, 'both buttons wait for the reply');
  await page.until(() => blindCalls().length === 1, 'the POST');
  assert.deepEqual(blindCalls(), ['/api/blind/' + A]);
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle', { blinded: true }), row(B, 'Other', 'idle', { pid: 200 })]);
  s = await page.until((x) => x.blindBusy === 0, 'the snapshot agrees and the buttons are free');
  assert.deepEqual(s.blinded.rows, [A]);
  await page.click('#g-blinded .fold');
  s = await page.until((x) => x.blinded && !x.blinded.folded, 'unfolded');
  assert.deepEqual([s.blinded.expanded, s.blinded.groups, s.unblindOn], ['true', [{ label: 'x', badge: null, n: '1' }], [A]]);
  await page.click(rowSel(A) + ' .iconbtn.unblind');
  s = await page.until((x) => x.rows.includes(A), 'the row back in its section at once');
  assert.equal(s.blinded, null);
  await page.until(() => blindCalls().length === 2, 'the second POST');
  assert.deepEqual(blindCalls(), ['/api/blind/' + A, '/api/unblind/' + A]);
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle'), row(B, 'Other', 'idle', { pid: 200 })]);
  await page.until((x) => x.blindBusy === 0 && x.rows.includes(A), 'settled');
  await page.close();
});

test('page: a failed /api/blind drops the pending state, the row returns and the notice says why', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  fake.blind = () => ({ status: 500, body: { ok: false, error: 'EACCES: permission denied' } });
  const page = await openPage();
  await page.until((x) => x.rows.includes(A), 'the row');
  await page.click(rowSel(A) + ' .iconbtn.blind');
  const s = await page.until((x) => x.notice !== null && x.rows.includes(A), 'the row back with the notice');
  assert.equal(s.notice, 'blind failed: EACCES: permission denied');
  assert.deepEqual([s.blinded, s.blindBusy], [null, 0]);
  fake.blind = () => ({ status: 200, body: { ok: true, blinded: true } });
  await page.close();
});

test('page: a waiting blinded row stays under Blinded and turns its header amber; an archived blinded row stays under Archived', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'waiting', { blinded: true }), row(B, 'Old', 'idle', { pid: 200, blinded: true, archived: true, archivedBy: 'board' }), row(C, 'Plain', 'idle', { pid: 300 })]);
  const page = await openPage();
  const s = await page.until((x) => x.blinded !== null && x.toggleArchived !== null, 'Blinded and the archived toggle');
  assert.deepEqual([s.blinded.rows, s.blinded.badge, s.blinded.tone, s.blinded.waitingHead, s.blinded.folded], [[A], '1', 'wait', true, true]);
  assert.equal(s.toggleArchived, 'Show 1 archived', 'archived wins over blinded');
  assert.deepEqual(s.rows, [C]);
  assert.equal(s.counts, '0 need you · 0 working · 1 idle', 'the waiting blinded row counts nowhere');
  assert.equal(s.title, 'Sessions');
  await page.close();
});

test('page: muted: no Notification for a blinded row that starts waiting, none when it is unblinded, one for a new waiting row', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle'), row(B, 'Other', 'idle', { pid: 200 })]);
  const page = await openPage();
  await page.until((x) => x.rows.includes(A) && x.rows.includes(B), 'both rows');
  await page.eval('window.__notes = []; window.Notification = function (t) { window.__notes.push(t); }; window.Notification.permission = "granted"; true');
  fake.snapshot = snapshotOf([row(A, 'Spike', 'waiting', { blinded: true }), row(B, 'Other', 'idle', { pid: 200 })]);
  let s = await page.until((x) => x.blinded !== null, 'the blinded waiting row');
  await sleep(600);                                          // two more polls
  s = await page.sample();
  assert.deepEqual(s.notes, [], 'blinded: silent');
  fake.snapshot = snapshotOf([row(A, 'Spike', 'waiting'), row(B, 'Other', 'idle', { pid: 200 })]);
  s = await page.until((x) => x.rows.includes(A), 'unblinded');
  await sleep(600);
  s = await page.sample();
  assert.deepEqual(s.notes, [], 'unblinded while waiting: still silent');
  fake.snapshot = snapshotOf([row(A, 'Spike', 'waiting'), row(B, 'Other', 'waiting', { pid: 200 })]);
  s = await page.until((x) => x.notes && x.notes.length === 1, 'one Notification for the new waiting row');
  assert.deepEqual(s.notes, ['Other needs you']);
  await page.close();
});

test('page: a typed filter shows a blinded row in its section with a chip and unfolds a folded section for the match', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike blinded', 'idle', { blinded: true }), row(B, 'Other', 'idle', { pid: 200 })]);
  const page = await openPage();
  let s = await page.until((x) => x.blinded !== null && x.rows.includes(B), 'Blinded and the section');
  await page.click('#sections .section[data-section="w1"] .fold');
  s = await page.until((x) => x.sections[0].folded, 'the section folded');
  assert.equal(s.sections[0].expanded, 'false');
  await page.type('blinded');
  s = await page.until((x) => x.rows.includes(A), 'the blinded match in its section');
  assert.deepEqual([s.sections[0].folded, s.sections[0].expanded, s.blindedChips, s.blinded, s.rows], [false, 'true', 1, null, [A]]);
  await page.type('');
  s = await page.until((x) => x.blinded !== null, 'Blinded again');
  assert.deepEqual([s.sections[0].folded, s.rows], [true, [B]], 'the fold state survived the filter');
  await page.close();
});

test('page: stale idle rows fold per section behind their own button, and a header folds its section', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Fresh', 'idle', win(1, 'alpha')), row(B, 'Old', 'idle', Object.assign({ pid: 200, ageMinutes: 300 }, win(1, 'alpha'))), row(C, 'Older', 'idle', Object.assign({ pid: 300, ageMinutes: 400 }, win(2, 'beta')))]);
  const page = await openPage();
  let s = await page.until((x) => x.sections.length === 2, 'two sections');
  assert.deepEqual(s.sections.map((sec) => [sec.rows, sec.stale]), [[[A], 'Show 1 idle over 2h'], [[], 'Show 1 idle over 2h']]);
  await page.click('#sections .section[data-section="w1"] button[data-act="stale"]');
  s = await page.until((x) => x.sections[0].rows.length === 2, 'the stale row shown');
  assert.deepEqual(s.sections.map((sec) => [sec.rows, sec.stale]), [[[A, B], 'Hide 1 idle over 2h'], [[], 'Show 1 idle over 2h']], 'the other section keeps its own toggle');
  await page.click('#sections .section[data-section="w1"] .fold');
  s = await page.until((x) => x.sections[0].folded, 'folded');
  assert.deepEqual([s.sections[0].expanded, s.sections[1].folded], ['false', false]);
  await page.close();
});
