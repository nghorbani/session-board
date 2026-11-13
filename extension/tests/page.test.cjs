'use strict';
/*
 * The page's archive, section and Mute flows, driven in a headless Chromium over the
 * DevTools protocol against an in-test HTTP server that serves index.html and plays scripted
 * /api answers. Skipped with a reason when no Chromium is found (tools/screenshot.cjs knows
 * the usual paths).
 *
 *   node:test ──▶ fake API (http) ◀── index.html in headless Chrome ◀── CDP over Node's WebSocket
 *                   scripted /api/sessions, /api/end, /api/unarchive, /api/mute, /api/unmute,
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

const fake = { snapshot: snapshotOf([]), end: () => ({ status: 200, body: { ok: true, code: 'ended' } }), unarchive: () => ({ status: 200, body: { ok: true, restoredTo: null } }), suggest: () => ({ status: 200, body: { ok: true, title: 'Suggested by model' } }), title: (id, t) => ({ status: 200, body: { ok: true, title: t } }), mute: () => ({ status: 200, body: { ok: true, muted: true } }), unmute: () => ({ status: 200, body: { ok: true, muted: false } }), search: { rows: [] }, calls: [] };
fake.order = (ids) => ({ status: 200, body: { ok: true, count: ids ? ids.split(',').length : 0 } });
fake.mode = (m) => ({ status: 200, body: { ok: true, mode: m } });
fake.show = (v) => ({ status: 200, body: { ok: true, show: v } });
fake.archive = () => ({ status: 200, body: { ok: true, moved: true } });
let PORT = 0;
function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
function serve(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (u.pathname === '/') {
    const html = INDEX
      .replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="board-token" content="' + TOKEN + '">')
      .replace('var POLL_MS = 4000;', 'var POLL_MS = 250;')
      .replace('<script>', '<script>window.confirm = function () { return window.__confirmAnswer !== false; }; window.__prompts = []; window.prompt = function (m, v) { window.__prompts.push([m, v]); return window.__promptAnswer === undefined ? null : window.__promptAnswer; };'
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
  if (u.pathname.startsWith('/api/mute/')) { const r = fake.mute(u.pathname.slice('/api/mute/'.length)); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/unmute/')) { const r = fake.unmute(u.pathname.slice('/api/unmute/'.length)); return json(res, r.status, r.body); }
  if (u.pathname === '/api/order') { const r = fake.order(u.searchParams.get('ids') || ''); return setTimeout(() => json(res, r.status, r.body), r.delayMs || 0); }
  if (u.pathname === '/api/order/show') { const r = fake.show(u.searchParams.get('show') || ''); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/archive/')) { const r = fake.archive(u.pathname.slice('/api/archive/'.length)); return json(res, r.status, r.body); }
  if (u.pathname === '/api/order/mode') { const r = fake.mode(u.searchParams.get('mode') || ''); return setTimeout(() => json(res, r.status, r.body), r.delayMs || 0); }
  if (u.pathname.startsWith('/api/focus/')) return json(res, 200, { ok: true });
  if (u.pathname.startsWith('/api/seen/')) return json(res, 200, { ok: true });
  if (u.pathname.startsWith('/api/title/suggest/')) { const r = fake.suggest(u.pathname.slice('/api/title/suggest/'.length)); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/title/')) { const r = fake.title(u.pathname.slice('/api/title/'.length), u.searchParams.get('title')); return json(res, r.status, r.body); }
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
    sections: q('#sections > .section').map(function (sec) { var rowsOf = function (el) { return Array.prototype.slice.call(el.querySelectorAll(':scope > .section-body > .row[data-session]')).map(function (r) { return r.getAttribute('data-session'); }); }; var h = sec.querySelector(':scope > .section-head .fold'); var b = h.querySelector('.badge'); var t = sec.querySelector(':scope > .section-body > .empty > button[data-act="stale"]'); return { key: sec.getAttribute('data-section'), label: h.querySelector('.label').textContent, here: !!h.querySelector('.chip.here'), expanded: h.getAttribute('aria-expanded'), folded: sec.classList.contains('folded'), badge: b ? b.textContent : null, tone: b ? (b.classList.contains('wait') ? 'wait' : 'unseen') : null, n: h.querySelector('.n').textContent, rows: rowsOf(sec), stale: t ? t.textContent : null, groups: sec.querySelectorAll('.section .section').length }; }),
    title: document.title,
    mode: (function () { var b = document.querySelector('#sortMode button[aria-pressed="true"]'); return b && document.getElementById('sortMode').style.display !== 'none' ? b.getAttribute('data-mode') : null; })(),
    handles: q('.row .handle').length,
    focused: document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-session') : null,
    dropMarks: q('.row.drop-before, .row.drop-after').length,
    muteBusy: q('.iconbtn.mute:disabled, .iconbtn.unmute:disabled').length,
    unmuteOn: q('.row[data-session]').filter(function (r) { return r.querySelector('.iconbtn.unmute'); }).map(function (r) { return r.getAttribute('data-session'); }),
    mutedRows: q('.row.muted[data-session]').map(function (r) { return r.getAttribute('data-session'); }),
    mutedChips: q('.row .chip.muted').length,
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
    filterline: (function () { var e = document.getElementById('filterline'); return e && e.style.display !== 'none' ? e.textContent : null; })(),
    agents: q('.row[data-session] .agent').map(function (a) { return a.closest('.row').getAttribute('data-session') + '=' + a.textContent; }),
    prompts: window.__prompts || [],
    showSwitch: (function () { var b = document.querySelector('#showMode button[aria-pressed="true"]'); return b && document.getElementById('showMode').style.display !== 'none' ? b.getAttribute('data-show') : null; })(),
    endedRows: q('#sections .row.past[data-session]').map(function (r) { return r.getAttribute('data-session'); }),
    heads: q('#sections > .section > .section-head .n').map(function (n) { return n.textContent; }),
    sids: q('.row[data-session] .sid').map(function (b) { return b.closest('.row').getAttribute('data-session') + '=' + b.textContent; }),
    details: q('.row[data-session] .details').map(function (d) { return d.closest('.row').getAttribute('data-session') + '=' + d.textContent; }),
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
    key: (sid, k) => ev('(function () { var r = document.querySelector(' + JSON.stringify(rowSel(sid)) + '); if (!r) throw new Error("no row"); r.focus(); r.dispatchEvent(new KeyboardEvent("keydown", { key: ' + JSON.stringify(k) + ', altKey: true, bubbles: true, cancelable: true })); return true; })()'),
    drag: (sid, target, before) => ev('(function () { var h = document.querySelector(' + JSON.stringify(rowSel(sid) + ' .handle') + '); if (!h) return { error: "no handle" };'
      + ' var t = document.querySelector(' + JSON.stringify(rowSel(target)) + '); if (!t) return { error: "no target" };'
      + ' var dt = new DataTransfer(); h.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));'
      + ' var rect = t.getBoundingClientRect(); var y = ' + (before ? 'rect.top + 1' : 'rect.bottom - 1') + ';'
      + ' var over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }); t.dispatchEvent(over); var allowed = over.defaultPrevented;'
      + ' var marks = document.querySelectorAll(".row.drop-before, .row.drop-after").length;'
      + ' t.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));'
      + ' h.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));'
      + ' return { allowed: allowed, marks: marks }; })()'),
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

const titleCalls = () => fake.calls.filter((c) => c.path.startsWith('/api/title/')).map((c) => c.path + (c.query || ''));

test('page (browser): ✎ asks for a suggestion, prefills the prompt, writes what you confirm and shows it; Escape writes nothing', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  const page = await openPage();
  await page.until((x) => x.rows.includes(A), 'the row');
  await page.eval('window.__promptAnswer = "Typed title"; true');
  await page.click(rowSel(A) + ' .iconbtn.retitle');
  let s = await page.until((x) => x.titles.includes(A + '=Typed title'), 'the new title');
  assert.deepEqual(s.prompts.map((p) => p[1]), ['Suggested by model'], 'prefilled with the suggestion');
  assert.deepEqual(titleCalls(), ['/api/title/suggest/' + A, '/api/title/' + A + '?title=Typed%20title']);
  assert.equal(s.retitleBusy, 0, 'the button is free again');
  fake.calls.length = 0;
  await page.eval('window.__promptAnswer = null; true');
  await page.click(rowSel(A) + ' .iconbtn.retitle');
  await page.until((x) => x.prompts.length === 2 && x.retitleBusy === 0, 'the prompt dismissed');
  assert.deepEqual(titleCalls(), ['/api/title/suggest/' + A], 'Escape: nothing written');
  await page.close();
});

test('page (browser): a running session answers 409; the title goes on the clipboard and the notice says to rename it in Claude Code; a failed write shows on the row', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  fake.title = () => ({ status: 409, body: { ok: false, code: 'claude-owned', message: 'the session is running' } });
  const page = await openPage();
  await page.until((x) => x.rows.includes(A), 'the row');
  await page.eval('window.__promptAnswer = "Mine"; true');
  await page.click(rowSel(A) + ' .iconbtn.retitle');
  let s = await page.until((x) => x.notice !== null, 'the notice');
  assert.match(s.notice, /^rename it in Claude Code/);
  assert.deepEqual([s.copied, s.retitleBusy, s.titles], ['Mine', 0, [A + '=Spike']]);
  fake.title = () => ({ status: 500, body: { ok: false, code: 'failed', message: 'EACCES' } });
  await page.click(rowSel(A) + ' .iconbtn.retitle');
  s = await page.until((x) => x.errorText !== null, 'the failure on the row');
  assert.equal(s.errorText, 'rename failed: EACCES');
  fake.suggest = () => ({ status: 502, body: { ok: false, code: 'failed', message: 'model not available' } });
  fake.title = (id, t) => ({ status: 200, body: { ok: true, title: t } });
  await page.eval('window.__prompts = []; true');
  await page.click(rowSel(A) + ' .iconbtn.retitle');
  s = await page.until((x) => x.prompts.length === 1, 'the prompt without a suggestion');
  assert.deepEqual([s.prompts[0][1], /no suggestion: model not available/.test(s.prompts[0][0])], ['Spike', true], 'prefilled with the current title');
  fake.suggest = () => ({ status: 200, body: { ok: true, title: 'Suggested by model' } });
  await page.close();
});

test('page (browser): an ended session in the search results has ✎ too', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([]);
  fake.search = { rows: [{ sessionId: P, title: 'Old spike', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\x\\p.jsonl', ageMinutes: 5000, snippets: [] }] };
  const page = await openPage();
  await page.search('Old');
  await page.until((x) => x.results.includes(P), 'the search row');
  await page.eval('window.__promptAnswer = "Ended name"; true');
  await page.click(rowSel(P) + ' .iconbtn.retitle');
  await page.until(() => titleCalls().length === 2, 'suggest and write');
  assert.deepEqual(titleCalls(), ['/api/title/suggest/' + P, '/api/title/' + P + '?title=Ended%20name']);
  fake.search = { rows: [] };
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

// -- session id and details --------------------------------------------------------------

test('page: every row shows "Session <first 8>"; a click folds out the details with the full id, start, pid, window and transcript; ⧉ copies; the row does not open', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle', { startedAt: new Date(2026, 10, 9, 13, 5).getTime(), transcriptPath: 'C:\\p\\x\\' + A + '.jsonl', window: { id: 4, label: 'webapp' } })]);
  const page = await openPage();
  let s = await page.until((x) => x.rows.includes(A), 'the row');
  assert.deepEqual([s.sids, s.details], [[A + '=Session ' + A.slice(0, 8)], []]);
  await page.click(rowSel(A) + ' .sid');
  s = await page.until((x) => x.details.length === 1, 'the details line');
  assert.equal(s.details[0], A + '=id' + A + '⧉started2026-11-09 13:05 · pid100 · windowwebapptranscriptC:\\p\\x\\' + A + '.jsonl⧉');
  assert.equal(fake.calls.filter((c) => /^\/api\/(focus|seen)\//.test(c.path)).length, 0, 'the id click does not open the session');
  await page.click(rowSel(A) + ' .details .copyval');
  s = await page.until((x) => x.copied === A, 'the id copied');
  await page.click(rowSel(A) + ' .sid');
  s = await page.until((x) => x.details.length === 0, 'folded again');
  await page.close();
});

test('page: a search row shows its id too, and its details carry the transcript path', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([]);
  fake.search = { rows: [{ sessionId: P, title: 'Old spike', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\x\\p.jsonl', ageMinutes: 5000, snippets: [] }] };
  const page = await openPage();
  await page.search('Old');
  let s = await page.until((x) => x.results.includes(P), 'the search row');
  assert.ok(s.sids.includes(P + '=Session ' + P.slice(0, 8)));
  await page.click(rowSel(P) + ' .sid');
  s = await page.until((x) => x.details.length === 1, 'the details line');
  assert.ok(s.details[0].includes('transcriptC:\\t\\x\\p.jsonl'), s.details[0]);
  assert.equal(s.details[0].includes('pid'), false, 'no process for a past row');
  fake.search = { rows: [] };
  await page.close();
});

test('page: the filter takes an id as Claude Code shows it ("Session f8005c0d") or bare', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle'), row(B, 'Other', 'idle', { pid: 200 })]);
  const page = await openPage();
  await page.until((x) => x.rows.length === 2, 'both rows');
  await page.type('Session ' + B.slice(0, 8));
  let s = await page.until((x) => x.rows.length === 1, 'filtered by the id');
  assert.deepEqual(s.rows, [B]);
  await page.type(A.slice(0, 8).toUpperCase());
  s = await page.until((x) => x.rows.length === 1 && x.rows[0] === A, 'bare id, any case');
  await page.type('Session board');
  s = await page.until((x) => x.rows.length === 0, 'not an id: an ordinary query');
  await page.close();
});

// -- ended sessions (Claude Code's list per window) -----------------------------------------

const ended = (sessionId, title, extra) => Object.assign({ sessionId, status: 'ended', live: false, title, lastPrompt: null, cwd: 'C:\\code\\x', transcriptPath: 'C:\\p\\x\\' + sessionId + '.jsonl', path: 'C:\\p\\x\\' + sessionId + '.jsonl', folder: 'C--code-x', ageMinutes: 60, hasTranscript: true, archived: false, window: { id: 1, label: 'x' } }, extra);
const searchCalls = () => fake.calls.filter((c) => c.path === '/api/search').map((c) => new URLSearchParams(c.query).get('q') + ':' + new URLSearchParams(c.query).get('content'));

test('page: a window section shows its ended, unarchived sessions after the running ones, newest first, with "+ N ended" on the head; ⤓ archives one and it leaves', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Running one', 'idle')], { ended: [ended(C, 'Older ended', { ageMinutes: 3000 }), ended(B, 'Recent ended', { ageMinutes: 25 }), ended(D, null, { ageMinutes: 90, lastPrompt: 'no title yet', window: { id: 2, label: 'other' } })], order: { mode: 'activity', show: 'all' }, thisWindowId: 1 });
  const page = await openPage();
  let s = await page.until((x) => x.sections.length === 2 && x.endedRows.length === 3, 'both sections');
  assert.deepEqual(s.sections[0].rows, [A, B, C], 'running first, then ended newest first');
  assert.deepEqual(s.heads, ['1 + 2 ended', '0 + 1 ended'], 'a window with only ended sessions gets its section');
  assert.equal(s.statusWords.find((w) => w.startsWith(B)), B + '=ended');
  assert.equal(s.showSwitch, 'all');
  assert.equal(s.counts, '0 need you · 0 working · 1 idle', 'the counts strip counts running sessions only');
  await page.click(rowSel(B) + ' .iconbtn[data-act="archivepast"]');
  s = await page.until((x) => !x.endedRows.includes(B), 'gone at once');
  await page.until(() => fake.calls.some((c) => c.method === 'POST' && c.path === '/api/archive/' + B), 'the POST');
  fake.snapshot = snapshotOf([row(A, 'Running one', 'idle')], { ended: [ended(C, 'Older ended', { ageMinutes: 3000 }), ended(D, null, { ageMinutes: 90, window: { id: 2, label: 'other' } })], order: { mode: 'activity', show: 'all' }, thisWindowId: 1 });
  await sleep(600);
  s = await page.sample();
  assert.equal(s.endedRows.includes(B), false, 'and stays gone');
  fake.archive = () => ({ status: 409, body: { ok: false, code: 'running', message: 'the session is running; end it first' } });
  await page.click(rowSel(C) + ' .iconbtn[data-act="archivepast"]');
  s = await page.until((x) => x.notice !== null && x.endedRows.includes(C), 'back with the notice');
  assert.equal(s.notice, 'archive failed: the session is running; end it first');
  fake.archive = () => ({ status: 200, body: { ok: true, moved: true } });
  await page.close();
});

test('page: the switch "running" hides the ended rows and a section that only had ended rows; "all" brings them back', opts, async () => {
  fake.calls.length = 0;
  const snap = (show) => snapshotOf([row(A, 'Running one', 'idle')], { ended: [ended(B, 'Recent ended'), ended(D, 'Other window', { window: { id: 2, label: 'other' } })], order: { mode: 'activity', show } });
  fake.snapshot = snap('all');
  const page = await openPage();
  let s = await page.until((x) => x.endedRows.length === 2, 'ended rows');
  await page.click('#showMode button[data-show="running"]');
  s = await page.until((x) => x.endedRows.length === 0, 'hidden at once');
  assert.deepEqual([s.sections.length, s.showSwitch, s.heads], [1, 'running', ['1']]);
  await page.until(() => fake.calls.some((c) => c.path === '/api/order/show' && c.query === '?show=running'), 'the POST');
  fake.snapshot = snap('running');
  await sleep(600);
  s = await page.sample();
  assert.deepEqual([s.endedRows.length, s.showSwitch], [0, 'running'], 'the snapshot agrees');
  await page.click('#showMode button[data-show="all"]');
  s = await page.until((x) => x.endedRows.length === 2, 'back');
  fake.snapshot = snap('all');
  await page.close();
});

test('page: typing filters running and ended rows and, after a pause, searches every session by title once; the results skip what the board shows; Enter adds the text', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Parser running', 'idle')], { ended: [ended(B, 'Parser ended'), ended(C, 'Unrelated')], order: { mode: 'activity', show: 'all' } });
  fake.search = { rows: [
    { sessionId: B, title: 'Parser ended', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\b.jsonl', ageMinutes: 60, snippets: [] },
    { sessionId: P, title: 'Parser from another repo', live: false, status: 'past', folder: 'y', cwd: 'C:\\y', path: 'C:\\t\\p.jsonl', ageMinutes: 5000, snippets: [] },
  ] };
  const page = await openPage();
  await page.until((x) => x.rows.length === 3, 'the rows');
  await page.type('P');
  await page.type('Pa');
  await page.type('Parser');
  let s = await page.until((x) => x.results.length === 1, 'the search results');
  assert.deepEqual(s.rows, [A, B], 'the filter keeps the running and the ended match');
  assert.deepEqual(s.results, [P], 'only what the board does not show');
  assert.deepEqual(searchCalls(), ['Parser:0'], 'one title search after the pause, none per keystroke, none for one letter');
  assert.match(s.filterline, /^Filter “Parser”: 2 of 3 sessions/);
  await page.eval('document.getElementById("q").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true');
  await page.until(() => searchCalls().length === 2, 'Enter');
  assert.deepEqual(searchCalls(), ['Parser:0', 'Parser:1'], 'Enter searches the text too');
  fake.search = { rows: [] };
  await page.close();
});

test('page: a row without a title shows its agent name once', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, null, 'idle', { name: 'cuvis-ai-37' })]);
  const page = await openPage();
  const s = await page.until((x) => x.rows.length === 1, 'the row');
  assert.deepEqual([s.agents, s.titles], [[], [A + '=cuvis-ai-37']]);
  await page.close();
});

// -- sections, badges and muting ------------------------------------------------------------

const C = 'dddddddd-4444-4444-8444-444444444444';
const D = 'eeeeeeee-5555-4555-8555-555555555555';
const E = 'ffffffff-6666-4666-8666-666666666666';
const win = (id, label) => ({ window: { id, label } });
const muteCalls = () => fake.calls.filter((c) => /^\/api\/(un)?mute\//.test(c.path)).map((c) => c.path);

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
  assert.deepEqual(s.sections.map((sec) => sec.groups), [0, 0, 0, 0], 'no nested groups');
  assert.equal(s.counts, '1 need you · 0 working · 1 unseen · 3 idle');
  assert.equal(s.title, '(1) Sessions');
  assert.equal(s.actionsOverflow, 0, 'five icons and the age fit the actions cell');
  await page.close();
});

test('page: the bell mutes a row in place at once and posts /api/mute; the struck bell unmutes it', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle'), row(B, 'Other', 'idle', { pid: 200 })]);
  const page = await openPage();
  await page.until((x) => x.rows.includes(A), 'the row');
  await page.click(rowSel(A) + ' .iconbtn.mute');
  let s = await page.until((x) => x.mutedRows.includes(A), 'muted at once');
  assert.deepEqual([s.sections[0].rows, s.mutedChips, s.sections[0].n, s.muteBusy], [[A, B], 1, '2', 1], 'still in its section, with the chip; the bell waits for the reply');
  await page.until(() => muteCalls().length === 1, 'the POST');
  assert.deepEqual(muteCalls(), ['/api/mute/' + A]);
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle', { muted: true }), row(B, 'Other', 'idle', { pid: 200 })]);
  s = await page.until((x) => x.muteBusy === 0, 'the snapshot agrees and the bell is free');
  assert.deepEqual([s.unmuteOn, s.mutedRows], [[A], [A]]);
  await page.click(rowSel(A) + ' .iconbtn.unmute');
  s = await page.until((x) => x.mutedRows.length === 0, 'unmuted at once');
  await page.until(() => muteCalls().length === 2, 'the second POST');
  assert.deepEqual(muteCalls(), ['/api/mute/' + A, '/api/unmute/' + A]);
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle'), row(B, 'Other', 'idle', { pid: 200 })]);
  await page.until((x) => x.muteBusy === 0 && x.mutedChips === 0, 'settled');
  await sleep(1800);                                         // the "unmuted" flash gives the age back
  s = await page.sample();
  assert.equal(s.actionsOverflow, 0, 'the bell, the other icons and the age fit the actions cell');
  await page.close();
});

test('page: a failed /api/mute drops the pending state, the flag returns and the notice says why', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle')]);
  fake.mute = () => ({ status: 500, body: { ok: false, error: 'EACCES: permission denied' } });
  const page = await openPage();
  await page.until((x) => x.rows.includes(A), 'the row');
  await page.click(rowSel(A) + ' .iconbtn.mute');
  const s = await page.until((x) => x.notice !== null && x.mutedRows.length === 0, 'unmuted again with the notice');
  assert.equal(s.notice, 'mute failed: EACCES: permission denied');
  assert.equal(s.muteBusy, 0);
  fake.mute = () => ({ status: 200, body: { ok: true, muted: true } });
  await page.close();
});

test('page: a waiting muted row stays in its section in the waiting colour but counts nowhere: not in the section badge, the strip or the title; an archived muted row stays under Archived', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'waiting', { muted: true }), row(B, 'Old', 'idle', { pid: 200, muted: true, archived: true, archivedBy: 'board' }), row(C, 'Plain', 'idle', { pid: 300 })]);
  const page = await openPage();
  const s = await page.until((x) => x.sections[0] && x.toggleArchived !== null, 'the section and the archived toggle');
  assert.deepEqual(s.sections[0].rows, [A, C], 'waiting first, in place');
  assert.deepEqual([s.sections[0].badge, s.sections[0].tone], [null, null], 'the section badge leaves the muted row out');
  assert.equal(s.toggleArchived, 'Show 1 archived', 'archived wins over muted');
  assert.equal(s.counts, '0 need you · 0 working · 1 idle', 'the waiting muted row counts nowhere');
  assert.equal(s.title, 'Sessions');
  assert.equal(s.statusWords.find((w) => w.startsWith(A)), A + '=permission prompt', 'it still says what it waits for');
  await page.close();
});

test('page: muted: no Notification for a muted row that starts waiting or finishes, none when it is unmuted, one for a new waiting row and one for a finished answer', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle'), row(B, 'Other', 'idle', { pid: 200 }), row(C, 'Third', 'busy', { pid: 300 })]);
  const page = await openPage();
  await page.until((x) => x.rows.includes(A) && x.rows.includes(B), 'the rows');
  await page.eval('window.__notes = []; window.Notification = function (t) { window.__notes.push(t); }; window.Notification.permission = "granted"; true');
  fake.snapshot = snapshotOf([row(A, 'Spike', 'waiting', { muted: true }), row(B, 'Other', 'idle', { pid: 200 }), row(C, 'Third', 'idle', { pid: 300, unseen: true, unseenAt: 5000, muted: true })]);
  let s = await page.until((x) => x.mutedRows.length === 2, 'the muted rows');
  await sleep(600);                                          // two more polls
  s = await page.sample();
  assert.deepEqual(s.notes, [], 'muted: silent');
  fake.snapshot = snapshotOf([row(A, 'Spike', 'waiting'), row(B, 'Other', 'idle', { pid: 200 }), row(C, 'Third', 'idle', { pid: 300, unseen: true, unseenAt: 5000 })]);
  s = await page.until((x) => x.mutedRows.length === 0, 'unmuted');
  await sleep(600);
  s = await page.sample();
  assert.deepEqual(s.notes, [], 'unmuted while waiting or unseen: still silent');
  fake.snapshot = snapshotOf([row(A, 'Spike', 'waiting'), row(B, 'Other', 'waiting', { pid: 200 }), row(C, 'Third', 'idle', { pid: 300, unseen: true, unseenAt: 6000 })]);
  s = await page.until((x) => x.notes && x.notes.length === 2, 'one Notification each');
  assert.deepEqual(s.notes.slice().sort(), ['Other needs you', 'Third is done']);
  await sleep(600);
  s = await page.sample();
  assert.equal(s.notes.length, 2, 'once each');
  await page.close();
});

test('page: a typed filter keeps the muted chip and unfolds a folded section for the match', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike muted', 'idle', { muted: true }), row(B, 'Other', 'idle', { pid: 200 })]);
  const page = await openPage();
  let s = await page.until((x) => x.rows.includes(A) && x.rows.includes(B), 'both rows in the section');
  await page.click('#sections > .section[data-section="w1"] > .section-head .fold');
  s = await page.until((x) => x.sections[0].folded, 'the section folded');
  assert.equal(s.sections[0].expanded, 'false');
  await page.type('muted');
  s = await page.until((x) => x.rows.length === 1 && !x.sections[0].folded, 'the match in its section');
  assert.deepEqual([s.sections[0].expanded, s.mutedChips, s.rows], ['true', 1, [A]]);
  await page.type('');
  s = await page.until((x) => x.sections[0] && x.sections[0].folded, 'folded again');
  assert.deepEqual(s.sections[0].rows.length, 2, 'the fold state survived the filter');
  await page.close();
});

test('page: every running row stays in its section however long it has been idle; only archived rows are put away; a header folds its section', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([
    row(A, 'Fresh', 'idle', win(1, 'alpha')),
    row(B, 'Idle three days', 'idle', Object.assign({ pid: 200, ageMinutes: 3 * 24 * 60 }, win(1, 'alpha'))),
    row(C, 'Older', 'idle', Object.assign({ pid: 300, ageMinutes: 400 }, win(2, 'beta'))),
    row(D, 'Archived', 'idle', Object.assign({ pid: 400, ageMinutes: 600, archived: true, archivedBy: 'claude-code' }, win(1, 'alpha'))),
  ]);
  const page = await openPage();
  let s = await page.until((x) => x.sections.length === 2, 'two sections');
  assert.deepEqual(s.sections.map((sec) => [sec.rows, sec.stale]), [[[A, B], null], [[C], null]], 'idle rows shown, no fold button');
  assert.equal(s.toggleArchived, 'Show 1 archived', 'the archived row is the only one put away');
  assert.equal(await page.eval('document.body.textContent.indexOf("idle over 2h") === -1'), true);
  await page.click('#sections > .section[data-section="w1"] > .section-head .fold');
  s = await page.until((x) => x.sections[0].folded, 'folded');
  assert.deepEqual([s.sections[0].expanded, s.sections[1].folded], ['false', false]);
  await page.close();
});

test('page: a typed filter says so above the sections with "n of N" and a clear button; clear and Esc bring every row back; zero matches keep the line', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle', { name: 'cuvis-ai-6c' }), row(B, 'Other', 'idle', { pid: 200, name: 'gymetiq-88' }), row(C, 'Put away', 'idle', { pid: 300, archived: true, archivedBy: 'board' })]);
  const page = await openPage();
  let s = await page.until((x) => x.rows.length === 2, 'two rows');
  assert.equal(s.filterline, null, 'no line without a query');
  await page.type('cuvis-ai-6c');
  s = await page.until((x) => x.rows.length === 1, 'filtered');
  assert.deepEqual([s.rows, s.filterline], [[A], 'Filter “cuvis-ai-6c”: 1 of 3 sessionsclear']);
  await page.click('#filterline button[data-act="clearfilter"]');
  s = await page.until((x) => x.rows.length === 2 && x.filterline === null, 'cleared by the button');
  assert.equal(await page.eval('document.getElementById("q").value'), '');
  await page.type('nothing <b>"here"</b>');
  s = await page.until((x) => x.filterline !== null && x.rows.length === 0, 'no match');
  assert.equal(s.filterline, 'Filter “nothing <b>"here"</b>”: 0 of 3 sessionsclear', 'the query shows as text');
  assert.equal(await page.eval('document.querySelectorAll("#filterline b").length'), 0);
  await page.eval('document.getElementById("q").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
  s = await page.until((x) => x.rows.length === 2 && x.filterline === null, 'cleared by Esc');
  await page.close();
});

test('page: the agent name other sessions use shows on the row and in the details; left out when it is the title or missing; HTML in it stays text', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([
    row(A, 'Lentils simple routes', 'idle', { name: 'cuvis-ai-6c' }),
    row(B, 'V2 WUR Presentation', 'idle', { pid: 200, name: 'V2 WUR Presentation' }),
    row(C, 'No name', 'idle', { pid: 300, name: null }),
    row(D, 'Odd', 'idle', { pid: 400, name: '<i>x</i>' }),
  ]);
  const page = await openPage();
  let s = await page.until((x) => x.rows.length === 4, 'the rows');
  assert.deepEqual(s.agents.sort(), [A + '=cuvis-ai-6c', D + '=<i>x</i>'].sort());
  assert.equal(await page.eval('document.querySelectorAll(".row .agent i").length'), 0, 'rendered as text');
  await page.click(rowSel(A) + ' .sid');
  s = await page.until((x) => x.details.length === 1, 'the details line');
  assert.ok(s.details[0].includes('agentcuvis-ai-6c⧉'), s.details[0]);
  await page.click(rowSel(A) + ' .details .copyval:nth-of-type(1)');
  await page.close();
});

// -- manual order -------------------------------------------------------------------------

const orderCalls = () => fake.calls.filter((c) => c.path === '/api/order').map((c) => decodeURIComponent(c.query.slice('?ids='.length)).split(','));
const modeCalls = () => fake.calls.filter((c) => c.path === '/api/order/mode').map((c) => c.query);
const manualRows = () => [
  row(A, 'Alpha ranked idle', 'idle', { rank: 2, ageMinutes: 10 }),
  row(B, 'Beta ranked waits', 'waiting', { pid: 200, rank: 0, ageMinutes: 20 }),
  row(C, 'Gamma new idle', 'idle', { pid: 300, ageMinutes: 5 }),
  row(D, 'Delta new busy', 'busy', { pid: 400, ageMinutes: 1 }),
];
const Q = '12121212-8888-4888-8888-888888888888';
const otherWindow = () => row(Q, 'Elsewhere idle', 'idle', Object.assign({ pid: 800, rank: 0, ageMinutes: 2 }, win(2, 'beta')));

test('page: the header switch posts /api/order/mode, the rows follow the pending mode at once, and the snapshot confirms it', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(manualRows(), { order: { mode: 'activity' } });
  const page = await openPage();
  let s = await page.until((x) => x.mode === 'activity', 'the switch');
  assert.deepEqual([s.sections[0].rows, s.handles], [[B, D, C, A], 0], 'by activity: waiting, busy, idle by age; no handles');
  await page.click('#sortMode button[data-mode="manual"]');
  s = await page.until((x) => x.mode === 'manual', 'manual at once');
  assert.deepEqual([s.sections[0].rows, s.handles], [[D, C, B, A], 4], 'manual: unranked on top newest first, then by rank, the waiting row stays put; a handle per live row');
  await page.until(() => modeCalls().length === 1, 'the POST');
  assert.deepEqual(modeCalls(), ['?mode=manual']);
  fake.snapshot = snapshotOf(manualRows(), { order: { mode: 'manual' } });
  await sleep(600);
  s = await page.sample();
  assert.deepEqual([s.mode, s.sections[0].rows], ['manual', [D, C, B, A]], 'the snapshot agrees');
  await page.click('#sortMode button[data-mode="activity"]');
  s = await page.until((x) => x.mode === 'activity', 'back to activity at once');
  assert.deepEqual([s.sections[0].rows, s.handles], [[B, D, C, A], 0]);
  await page.until(() => modeCalls().length === 2, 'the second POST');
  fake.snapshot = snapshotOf(manualRows(), { order: { mode: 'activity' } });
  await page.until((x) => x.mode === 'activity', 'settled');
  await page.close();
});

test('page: a failed /api/order/mode drops the pending mode, the order returns and the notice says why; an old server without order hides the switch', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(manualRows(), { order: { mode: 'activity' } });
  fake.mode = () => ({ status: 500, body: { ok: false, error: 'EACCES: permission denied' } });
  const page = await openPage();
  await page.until((x) => x.mode === 'activity', 'the switch');
  await page.click('#sortMode button[data-mode="manual"]');
  let s = await page.until((x) => x.notice !== null, 'the notice');
  assert.equal(s.notice, 'order mode failed: EACCES: permission denied');
  assert.deepEqual([s.mode, s.sections[0].rows, s.handles], ['activity', [B, D, C, A], 0]);
  fake.mode = (m) => ({ status: 200, body: { ok: true, mode: m } });
  const old = snapshotOf(manualRows());
  delete old.order;
  fake.snapshot = old;
  s = await page.until((x) => x.mode === null, 'no switch without an order field');
  assert.deepEqual(s.sections[0].rows, [B, D, C, A], 'activity order without the field');
  await page.close();
});

const F = '99999999-7777-4777-8777-777777777777';
const secOf = (s, key) => s.sections.find((sec) => sec.key === key);

test('page: Alt+Down on a focused row posts /api/order with the complete list of its group, the row moves at once and keeps focus; Alt+Up at the top is a no-op', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(manualRows().concat([row(F, 'Phi old idle', 'idle', { pid: 700, rank: 3, ageMinutes: 300 })]), { order: { mode: 'manual' } });
  const page = await openPage();
  let s = await page.until((x) => x.mode === 'manual' && x.sections[0].rows.length === 5, 'manual rows');
  assert.deepEqual([s.sections[0].rows, s.sections[0].stale], [[D, C, B, A, F], null], 'the row idle for 5 h is shown in its rank');
  await page.key(C, 'ArrowDown');
  s = await page.until((x) => x.sections[0].rows[1] === B, 'moved at once');
  assert.deepEqual([s.sections[0].rows, s.focused], [[D, B, C, A, F], C], 'the row moved and kept the focus');
  await page.until(() => orderCalls().length === 1, 'the POST');
  assert.deepEqual(orderCalls(), [[D, B, C, A, F]], 'the whole group in its new order');
  await page.key(D, 'ArrowUp');
  await sleep(300);
  s = await page.sample();
  assert.deepEqual([s.sections[0].rows, orderCalls().length], [[D, B, C, A, F], 1], 'the top row and Alt+Up: nothing happens');
  fake.snapshot = snapshotOf([
    row(D, 'Delta new busy', 'busy', { pid: 400, rank: 0, ageMinutes: 1 }), row(B, 'Beta ranked waits', 'waiting', { pid: 200, rank: 1, ageMinutes: 20 }),
    row(C, 'Gamma new idle', 'idle', { pid: 300, rank: 2, ageMinutes: 5 }), row(A, 'Alpha ranked idle', 'idle', { rank: 3, ageMinutes: 10 }),
    row(F, 'Phi old idle', 'idle', { pid: 700, rank: 4, ageMinutes: 300 }),
  ], { order: { mode: 'manual' } });
  await sleep(600);
  s = await page.sample();
  assert.deepEqual(s.sections[0].rows, [D, B, C, A, F], 'the snapshot agrees');
  await page.close();
});

test('page: a drag by the handle moves the row inside its group and posts the order; a drop on another group is refused', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(manualRows().concat([otherWindow()]), { order: { mode: 'manual' } });
  const page = await openPage();
  let s = await page.until((x) => x.mode === 'manual' && x.handles === 5, 'manual with handles');
  let r = await page.drag(A, D, true);
  assert.deepEqual([r.allowed, r.marks], [true, 1], 'the drop was allowed and the target marked');
  s = await page.until((x) => x.sections[0].rows[0] === A, 'moved at once');
  assert.deepEqual([s.sections[0].rows, s.dropMarks], [[A, D, C, B], 0]);
  await page.until(() => orderCalls().length === 1, 'the POST');
  assert.deepEqual(orderCalls(), [[A, D, C, B]]);
  r = await page.drag(B, Q, false);
  assert.deepEqual([r.allowed, r.marks], [false, 0], 'a row onto another window section: refused');
  await sleep(300);
  s = await page.sample();
  assert.deepEqual([secOf(s, 'w1').rows, secOf(s, 'w2').rows, orderCalls().length], [[A, D, C, B], [Q], 1]);
  await page.close();
});

test('page: a muted row (blinded under 0.10.0) keeps its rank and moves with the rest of its section', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(manualRows().concat([row(E, 'Eps muted', 'idle', { pid: 500, rank: 1, muted: true, ageMinutes: 3 })]), { order: { mode: 'manual' } });
  const page = await openPage();
  let s = await page.until((x) => x.mode === 'manual' && x.handles === 5, 'manual with the muted row');
  assert.deepEqual([s.sections[0].rows, s.mutedRows], [[D, C, B, E, A], [E]], 'ranked between B (0) and A (2)');
  await page.key(E, 'ArrowUp');
  s = await page.until((x) => x.sections[0].rows[2] === E, 'moved at once');
  assert.deepEqual([s.sections[0].rows, s.focused], [[D, C, E, B, A], E]);
  await page.until(() => orderCalls().length === 1, 'the POST');
  assert.deepEqual(orderCalls(), [[D, C, E, B, A]], 'one list for the whole section');
  await page.close();
});

test('page: a failed /api/order drops the pending order, the row returns and the notice says why', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(manualRows(), { order: { mode: 'manual' } });
  fake.order = () => ({ status: 500, body: { ok: false, error: 'EACCES: permission denied' } });
  const page = await openPage();
  await page.until((x) => x.mode === 'manual' && x.sections[0].rows.length === 4, 'manual rows');
  await page.key(C, 'ArrowDown');
  const s = await page.until((x) => x.notice !== null, 'the notice');
  assert.equal(s.notice, 'reorder failed: EACCES: permission denied');
  assert.deepEqual(s.sections[0].rows, [D, C, B, A], 'the row returned');
  fake.order = (ids) => ({ status: 200, body: { ok: true, count: ids ? ids.split(',').length : 0 } });
  await page.close();
});

test('page: a stale snapshot that lands before the /api/order reply does not snap the row back', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(manualRows(), { order: { mode: 'manual' } });
  fake.order = (ids) => ({ status: 200, body: { ok: true, count: ids ? ids.split(',').length : 0 }, delayMs: 900 });
  const page = await openPage();
  await page.until((x) => x.mode === 'manual' && x.sections[0].rows.length === 4, 'manual rows');
  await page.key(C, 'ArrowDown');
  let s = await page.until((x) => x.sections[0].rows[1] === B, 'moved at once');
  await sleep(700);                                          // two or three polls with the old ranks, the reply still pending
  s = await page.sample();
  assert.deepEqual(s.sections[0].rows, [D, B, C, A], 'the pending order holds under the stale polls');
  await page.until(() => orderCalls().length === 1, 'the POST');
  await sleep(400);
  s = await page.sample();
  assert.deepEqual(s.sections[0].rows, [D, B, C, A], 'and after the reply');
  fake.order = (ids) => ({ status: 200, body: { ok: true, count: ids ? ids.split(',').length : 0 } });
  await page.close();
});

test('page: two moves in two groups inside the guard both hold', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([
    row(A, 'A first', 'idle', { rank: 0, ageMinutes: 2 }), row(B, 'B second', 'idle', { pid: 200, rank: 1, ageMinutes: 3 }),
    row(C, 'C first', 'idle', Object.assign({ pid: 300, rank: 0, ageMinutes: 2 }, win(2, 'beta'))), row(D, 'D second', 'idle', Object.assign({ pid: 400, rank: 1, ageMinutes: 3 }, win(2, 'beta'))),
  ], { order: { mode: 'manual' } });
  const page = await openPage();
  let s = await page.until((x) => x.mode === 'manual' && x.sections.length === 2, 'two sections');
  await page.key(B, 'ArrowUp');
  s = await page.until((x) => secOf(x, 'w1').rows[0] === B, 'the first move');
  await page.key(D, 'ArrowUp');
  s = await page.until((x) => secOf(x, 'w2').rows[0] === D, 'the second move');
  await sleep(600);                                          // polls with the old ranks keep coming
  s = await page.sample();
  assert.deepEqual([secOf(s, 'w1').rows, secOf(s, 'w2').rows], [[B, A], [D, C]], 'both groups hold their new order');
  await page.until(() => orderCalls().length === 2, 'both POSTs');
  assert.deepEqual(orderCalls(), [[B, A], [D, C]]);
  await page.close();
});

test('page: in activity mode there are no handles and Alt+arrows do nothing; with a filter typed, moving is disabled', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(manualRows(), { order: { mode: 'activity' } });
  const page = await openPage();
  let s = await page.until((x) => x.mode === 'activity', 'activity');
  await page.key(C, 'ArrowDown');
  await sleep(300);
  s = await page.sample();
  assert.deepEqual([s.sections[0].rows, s.handles, orderCalls().length], [[B, D, C, A], 0, 0], 'inert in activity mode');
  fake.snapshot = snapshotOf(manualRows(), { order: { mode: 'manual' } });
  s = await page.until((x) => x.mode === 'manual', 'manual from the snapshot');
  await page.type('ranked');
  s = await page.until((x) => x.sections[0].rows.length === 2, 'the filter');
  assert.deepEqual([s.sections[0].rows, s.handles], [[B, A], 0], 'a filter: no handles');
  await page.key(B, 'ArrowDown');
  await sleep(300);
  assert.equal(orderCalls().length, 0, 'a filter: the keys do nothing');
  await page.type('');
  s = await page.until((x) => x.sections[0].rows.length === 4 && x.handles === 4, 'the filter cleared');
  await page.key(C, 'ArrowDown');
  await page.until(() => orderCalls().length === 1, 'moving works again');
  await page.close();
});
