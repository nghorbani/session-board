'use strict';
/*
 * The page's archive, section and Mute flows, driven in a headless Chromium over the
 * DevTools protocol against an in-test HTTP server that serves index.html and plays scripted
 * /api answers. Skipped with a reason when no Chromium is found (tools/chrome.cjs knows
 * the usual paths).
 *
 *   node:test ──▶ fake API (http) ◀── index.html in headless Chrome ◀── CDP over Node's WebSocket
 *                   scripted /api/sessions, /api/end, /api/unarchive, /api/mute, /api/unmute,
 *                   /api/search, /api/focus; every call except the poll is recorded for the assertions
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { browser, freePort, startChrome } = require('../../tools/chrome.cjs');
const chromeLock = require('./shim/chrome-lock.cjs');

let CHROME = null;
try { CHROME = browser(); } catch (_) { CHROME = null; }
const opts = { skip: CHROME ? false : 'no Chromium found; set SCREENSHOT_BROWSER to run the page suite', timeout: 60000 };

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const TOKEN = 'test-token';
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const P = 'cccccccc-3333-4333-8333-333333333333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ago = (minutes) => Date.now() - minutes * 60000;   // the time of a last message that many minutes back
function row(sessionId, title, status, extra) {
  const r = Object.assign({ sessionId, title, status, waitingFor: status === 'waiting' ? 'permission prompt' : null, name: null, lastPrompt: null, cwd: 'C:\\code\\x', window: { id: 1, label: 'x' }, activityAt: ago(1), workingSince: null, lockSlot: null, contextTokens: 1000, pct: 1, transcriptPath: null, kind: 'interactive', pid: 100, archived: false }, extra);
  if (r.status === 'busy' && r.workingSince == null) r.workingSince = r.activityAt;   // a busy row works since its last message unless the test says otherwise
  return r;
}
function snapshotOf(sessions, extra) {
  return Object.assign({ at: Date.now(), stale: false, error: null, limits: { compact: 100000, save: 90000 }, platform: 'win32', sessions, usage: { state: 'ok', at: Date.now(), ageSeconds: 0, subscriptionType: 'x', windows: { five_hour: { label: '5h', usedPct: 1, resetsAt: null, expired: false } }, account: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'dev@example.com', orgName: 'Example', subscriptionType: 'x' }, accountError: null } }, extra || {});
}

// -- fake API ----------------------------------------------------------------------------

const fake = { snapshot: snapshotOf([]), end: () => ({ status: 200, body: { ok: true, code: 'ended' } }), unarchive: () => ({ status: 200, body: { ok: true, restoredTo: null } }), suggest: () => ({ status: 200, body: { ok: true, title: 'Suggested by model' } }), title: (id, t) => ({ status: 200, body: { ok: true, title: t } }), mute: () => ({ status: 200, body: { ok: true, muted: true } }), unmute: () => ({ status: 200, body: { ok: true, muted: false } }), search: { rows: [] }, calls: [] };
const locksOk = () => ({ status: 200, body: { ok: true, set: 0, moved: 0, cleared: 0 } });
fake.locks = locksOk;
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
      .replace('<script>', '<script>' + (u.searchParams.get('webview') === '1' ? 'window.__posted = []; window.acquireVsCodeApi = function () { return { postMessage: function (m) { window.__posted.push(m); }, getState: function () { return null; }, setState: function () {} }; }; ' : '') + 'window.confirm = function () { return window.__confirmAnswer !== false; }; window.__prompts = []; window.prompt = function (m, v) { window.__prompts.push([m, v]); return window.__promptAnswer === undefined ? null : window.__promptAnswer; };'
        + ' Object.defineProperty(navigator, "clipboard", { value: { writeText: function (t) { window.__copied = t; return Promise.resolve(); } } }); window.Notification = undefined;</script>\n<script>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.headers['x-board-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
  if (u.pathname === '/api/sessions') { fake.polls = (fake.polls || 0) + 1; return json(res, 200, fake.snapshot); }
  if (u.pathname === '/api/locks' && req.method === 'POST') {
    let text = '';
    req.on('data', (d) => { text += d; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(text); } catch (_) { /* recorded as null */ }
      fake.calls.push({ method: req.method, path: u.pathname, query: u.search, body });
      const r = fake.locks(body || {});
      setTimeout(() => json(res, r.status, r.body), r.delayMs || 0);
    });
    return;
  }
  fake.calls.push({ method: req.method, path: u.pathname, query: u.search });
  if (u.pathname.startsWith('/api/end/')) { const r = fake.end(u.pathname.slice('/api/end/'.length), u.searchParams); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/unarchive/')) { const r = fake.unarchive(u.pathname.slice('/api/unarchive/'.length)); return setTimeout(() => json(res, r.status, r.body), r.delayMs || 0); }
  if (u.pathname.startsWith('/api/mute/')) { const r = fake.mute(u.pathname.slice('/api/mute/'.length)); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/unmute/')) { const r = fake.unmute(u.pathname.slice('/api/unmute/'.length)); return json(res, r.status, r.body); }
  if (u.pathname === '/api/order/show') { const r = fake.show(u.searchParams.get('show') || ''); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/archive/')) { const r = fake.archive(u.pathname.slice('/api/archive/'.length)); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/focus/')) return json(res, 200, { ok: true });
  if (u.pathname.startsWith('/api/seen/')) return json(res, 200, { ok: true });
  if (u.pathname.startsWith('/api/title/suggest/')) { const r = fake.suggest(u.pathname.slice('/api/title/suggest/'.length)); return json(res, r.status, r.body); }
  if (u.pathname.startsWith('/api/title/')) { const r = fake.title(u.pathname.slice('/api/title/'.length), u.searchParams.get('title')); return json(res, r.status, r.body); }
  if (u.pathname === '/api/search') {
    return json(res, 200, Object.assign({ requestId: u.searchParams.get('requestId'), query: u.searchParams.get('q'), content: true, total: fake.search.rows.length, shown: fake.search.rows.length, partial: false, skipped: 0, rgAvailable: true }, fake.search));
  }
  return json(res, 404, { error: 'not found' });
}

// -- Chrome over the DevTools protocol ----------------------------------------------------

let server = null;
let cdp = null;   // { send, close } of the browser started by tools/chrome.cjs

test.before(async () => {
  if (!CHROME) return;
  await chromeLock.acquire(); // steps-page.test.cjs drives its own Chrome too; one at a time keeps both off a shared CPU budget
  PORT = await freePort();
  server = http.createServer(serve);
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res));
  cdp = await startChrome();
});

test.after(async () => {
  if (cdp) await cdp.close();
  if (server) await new Promise((res) => server.close(res));
  if (CHROME) chromeLock.release();
});

const SAMPLE = `(function () {
  var q = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var ids = function (sel) { return q(sel + ' .row[data-session]').map(function (r) { return r.getAttribute('data-session'); }); };
  var text = function (sel) { var e = document.querySelector(sel); return e ? e.textContent : null; };
  return {
    rows: ids('#sections'), archivedList: ids('#l-archived'), results: ids('#l-results'),
    sections: q('#sections > .section').map(function (sec) { var rowsOf = function (el) { return Array.prototype.slice.call(el.querySelectorAll(':scope > .section-body > .row[data-session]')).map(function (r) { return r.getAttribute('data-session'); }); }; var h = sec.querySelector(':scope > .section-head .fold'); var b = h.querySelector('.badge'); var t = sec.querySelector(':scope > .section-body > .empty > button[data-act="stale"]'); return { key: sec.getAttribute('data-section'), label: h.querySelector('.label').textContent, here: !!h.querySelector('.chip.here'), expanded: h.getAttribute('aria-expanded'), folded: sec.classList.contains('folded'), badge: b ? b.textContent : null, tone: b ? (b.classList.contains('wait') ? 'wait' : 'unseen') : null, n: h.querySelector('.n').textContent, rows: rowsOf(sec), stale: t ? t.textContent : null, groups: sec.querySelectorAll('.section .section').length }; }),
    title: document.title,
    locked: q('.row.locked[data-session]').map(function (r) { return r.getAttribute('data-session'); }),
    lockButtons: q('.row .lockbtn').length,
    pressedLocks: q('.row .lockbtn[aria-pressed="true"]').length,
    ages: q('#sections .row[data-session]').map(function (r) { var a = r.querySelector('.age'); return r.getAttribute('data-session') + '=' + (a ? a.textContent : ''); }),
    sortSwitch: document.getElementById('sortMode') !== null,
    posted: window.__posted || null,
    handles: q('.row .handle').length,
    focused: document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-session') : null,
    focusedIn: (function () { var e = document.activeElement; var r = e && e.closest ? e.closest('.row[data-session]') : null; return r ? r.getAttribute('data-session') : null; })(),
    focusedAct: document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-act') : null,
    dropMarks: q('.row.drop-before, .row.drop-after').length,
    muteBusy: q('.iconbtn.mute:disabled, .iconbtn.unmute:disabled').length,
    unmuteOn: q('.row[data-session]').filter(function (r) { return r.querySelector('.iconbtn.unmute'); }).map(function (r) { return r.getAttribute('data-session'); }),
    mutedRows: q('.row.muted[data-session]').map(function (r) { return r.getAttribute('data-session'); }),
    mutedChips: q('.row .chip.muted').length,
    actionsOverflow: q('.row .actions').filter(function (a) { return a.scrollWidth > a.clientWidth; }).length,
    actionKinds: q('.row[data-session]').map(function (r) { return r.getAttribute('data-session') + '=' + Array.prototype.slice.call(r.querySelectorAll('.actions button[data-act]')).map(function (b) { return b.getAttribute('data-act'); }).join(','); }),
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
    archivedInSections: q('#sections .row[data-archived="1"]').map(function (r) { return r.getAttribute('data-session'); }),
    archivedGroup: document.getElementById('g-archived').style.display !== 'none',
    copyButtons: q('.row .iconbtn.copy').length,
    heads: q('#sections > .section > .section-head .n').map(function (n) { return n.textContent; }),
    sids: q('.row[data-session] .sid').map(function (b) { return b.closest('.row').getAttribute('data-session') + '=' + b.textContent; }),
    details: q('.row[data-session] .details').map(function (d) { return d.closest('.row').getAttribute('data-session') + '=' + d.textContent; }),
    acct: text('.u-acct'),
    acctTitle: (function () { var e = document.querySelector('.u-acct'); return e ? e.getAttribute('title') : null; })()
  };
})()`;

/** One page of the board in the test Chrome: its target, its evaluator and what every kind of page needs. */
async function attachPage(query) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:' + PORT + '/' + (query || '') });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  };
  return {
    eval: ev,
    sample: () => ev(SAMPLE),
    click: (sel) => ev('(function () { var e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) throw new Error("no element " + ' + JSON.stringify(sel) + '); e.click(); return true; })()'),
    until: async (pred, what) => {
      const start = Date.now();
      let s = null;
      while (Date.now() - start < 20000) { try { s = await ev(SAMPLE); if (pred(s)) return s; } catch (_) { /* page still loading */ } await sleep(100); }
      throw new Error('timed out waiting for ' + what + '; last sample: ' + JSON.stringify(s));
    },
    close: () => cdp.send('Target.closeTarget', { targetId }),
  };
}

/** The page as the browser front end serves it: it polls the fake API. */
async function openPage() {
  const page = await attachPage('');
  const ev = page.eval;
  Object.assign(page, {
    search: (q) => ev('(function () { var q = document.getElementById("q"); q.value = ' + JSON.stringify(q) + '; q.dispatchEvent(new Event("input")); q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); return true; })()'),
    type: (q) => ev('(function () { var q = document.getElementById("q"); q.value = ' + JSON.stringify(q) + '; q.dispatchEvent(new Event("input")); return true; })()'),
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
  });
  await page.until((s) => s.counts.length > 0, 'the page to render');
  return page;
}

/** The page as a VS Code webview loads it: it posts messages to the host and hears from it; `host` plays the extension host. */
async function openWebviewPage(snapshot) {
  const page = await attachPage('?webview=1');
  page.host = (msg) => page.eval('window.postMessage(' + JSON.stringify(msg) + ', "*"); true');
  await page.until((s) => Array.isArray(s.posted) && s.posted.some((m) => m.type === 'refresh'), 'the webview page to ask for a snapshot');
  await page.host({ type: 'snapshot', data: snapshot });
  await page.until((s) => s.sections.length > 0, 'the snapshot to render');
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
  let s = await page.until((x) => x.confirmText === 'Archive?', 'the archive confirm to show');
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
  fake.search = { rows: [{ sessionId: P, title: 'Old spike', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\x\\p.jsonl', activityAt: ago(5000), archived: true, archivedBy: 'board', snippets: [] }] };
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
  fake.search = { rows: [{ sessionId: P, title: 'Old spike', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\x\\p.jsonl', activityAt: ago(5000), archived: true, archivedBy: 'board', snippets: [] }] };
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
  let s = await page.until((x) => x.confirmText === 'End?', 'the end confirm to show');
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
  fake.search = { rows: [{ sessionId: P, title: 'Old spike', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\x\\p.jsonl', activityAt: ago(5000), snippets: [] }] };
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

test('page: every row shows "Session <first 8>", and a click copies the full id without opening the row; ⓘ folds out the details (full id, start, pid, window, transcript), where a click on a value copies it; no ⧉ resume copy', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Spike', 'idle', { startedAt: new Date(2026, 10, 9, 13, 5).getTime(), transcriptPath: 'C:\\p\\x\\' + A + '.jsonl', window: { id: 4, label: 'webapp' } })]);
  const page = await openPage();
  let s = await page.until((x) => x.rows.includes(A), 'the row');
  assert.deepEqual([s.sids, s.details, s.copyButtons], [[A + '=Session ' + A.slice(0, 8)], [], 0]);
  await page.click(rowSel(A) + ' .sid');
  s = await page.until((x) => x.copied === A, 'the full id copied');
  assert.deepEqual(s.details, [], 'the id click folds out nothing');
  assert.equal(fake.calls.filter((c) => /^\/api\/(focus|seen)\//.test(c.path)).length, 0, 'the id click does not open the session');
  await page.click(rowSel(A) + ' .iconbtn.info');
  s = await page.until((x) => x.details.length === 1, 'the details line');
  assert.equal(s.details[0], A + '=id' + A + 'started2026-11-09 13:05 · pid100 · windowwebapptranscriptC:\\p\\x\\' + A + '.jsonl');
  await page.eval('window.__copied = null; true');
  await page.click(rowSel(A) + ' .details .copyval');
  s = await page.until((x) => x.copied === A, 'the id in the details copied');
  await page.click(rowSel(A) + ' .details div:last-child .copyval');
  s = await page.until((x) => x.copied === 'C:\\p\\x\\' + A + '.jsonl', 'the transcript path copied');
  assert.equal(fake.calls.filter((c) => /^\/api\/(focus|seen)\//.test(c.path)).length, 0, 'copying never opens the session');
  await page.click(rowSel(A) + ' .iconbtn.info');
  s = await page.until((x) => x.details.length === 0, 'folded again');
  await page.close();
});

test('page: a search row shows its id too, and its details carry the transcript path', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([]);
  fake.search = { rows: [{ sessionId: P, title: 'Old spike', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\x\\p.jsonl', activityAt: ago(5000), snippets: [] }] };
  const page = await openPage();
  await page.search('Old');
  let s = await page.until((x) => x.results.includes(P), 'the search row');
  assert.ok(s.sids.includes(P + '=Session ' + P.slice(0, 8)));
  assert.equal(s.copyButtons, 0, 'no resume copy on a search row either');
  await page.click(rowSel(P) + ' .iconbtn.info');
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

const ended = (sessionId, title, extra) => Object.assign({ sessionId, status: 'ended', live: false, title, lastPrompt: null, cwd: 'C:\\code\\x', transcriptPath: 'C:\\p\\x\\' + sessionId + '.jsonl', path: 'C:\\p\\x\\' + sessionId + '.jsonl', folder: 'C--code-x', activityAt: ago(60), workingSince: null, lockSlot: null, hasTranscript: true, archived: false, window: { id: 1, label: 'x' } }, extra);
const searchCalls = () => fake.calls.filter((c) => c.path === '/api/search').map((c) => new URLSearchParams(c.query).get('q') + ':' + new URLSearchParams(c.query).get('content'));

test('page: a window section shows its ended, unarchived sessions after the running ones, newest first, with "+ N ended" on the head; ⤓ archives one and it leaves', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, 'Running one', 'idle')], { ended: [ended(C, 'Older ended', { activityAt: ago(3000) }), ended(B, 'Recent ended', { activityAt: ago(25) }), ended(D, null, { activityAt: ago(90), lastPrompt: 'no title yet', window: { id: 2, label: 'other' } })], order: { show: 'all' }, thisWindowId: 1 });
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
  fake.snapshot = snapshotOf([row(A, 'Running one', 'idle')], { ended: [ended(C, 'Older ended', { activityAt: ago(3000) }), ended(D, null, { activityAt: ago(90), window: { id: 2, label: 'other' } })], order: { show: 'all' }, thisWindowId: 1 });
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
  const snap = (show) => snapshotOf([row(A, 'Running one', 'idle')], { ended: [ended(B, 'Recent ended'), ended(D, 'Other window', { window: { id: 2, label: 'other' } })], order: { show } });
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
  fake.snapshot = snapshotOf([row(A, 'Parser running', 'idle')], { ended: [ended(B, 'Parser ended'), ended(C, 'Unrelated')], order: { show: 'all' } });
  fake.search = { rows: [
    { sessionId: B, title: 'Parser ended', live: false, status: 'past', folder: 'x', cwd: 'C:\\x', path: 'C:\\t\\b.jsonl', activityAt: ago(60), snippets: [] },
    { sessionId: P, title: 'Parser from another repo', live: false, status: 'past', folder: 'y', cwd: 'C:\\y', path: 'C:\\t\\p.jsonl', activityAt: ago(5000), snippets: [] },
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

test('page: a row without a title is headed by its last prompt, else "Untitled"; its agent name sits on the sub line and a click copies it without opening the row', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([row(A, null, 'idle', { name: 'cuvis-ai-37' }), row(B, null, 'idle', { pid: 200, name: 'cuvis-ai-38', lastPrompt: 'fix the flaky test' })]);
  const page = await openPage();
  let s = await page.until((x) => x.rows.length === 2, 'the rows');
  assert.deepEqual(s.titles.sort(), [A + '=Untitled', B + '=fix the flaky test'].sort());
  assert.deepEqual(s.agents.sort(), [A + '=cuvis-ai-37', B + '=cuvis-ai-38'].sort());
  await page.click(rowSel(A) + ' .agent');
  s = await page.until((x) => x.copied === 'cuvis-ai-37', 'the name copied');
  assert.equal(fake.calls.filter((c) => /^\/api\/(focus|seen)\//.test(c.path)).length, 0, 'copying does not open the session');
  await page.close();
});

test('page: the switch offers auto, running and all; auto shows ended rows but no archived ones; all adds the archived ones after the placed rows (chips, ⤒ only where the board archived, no ⤓, no rail) and moves a running archived row into its section; the head counts all three', opts, async () => {
  fake.calls.length = 0;
  const runningArchived = row(C, 'Archived but running', 'idle', { pid: 300, archived: true, archivedBy: 'board' });
  const archivedEnded = [
    ended(D, 'Archived in Claude', { activityAt: ago(30), archived: true, archivedBy: 'claude-code' }),
    ended(E, 'Archived here', { activityAt: ago(90), archived: true, archivedBy: 'board' }),
  ];
  const snap = (show) => snapshotOf([row(A, 'Running one', 'idle'), runningArchived], { ended: [ended(B, 'Recent ended', { activityAt: ago(20) })], archivedEnded: show === 'all' ? archivedEnded : [], order: { show } });
  fake.snapshot = snap('auto');
  const page = await openPage();
  let s = await page.until((x) => x.endedRows.length === 1, 'the auto view');
  assert.deepEqual(await page.eval('Array.prototype.map.call(document.querySelectorAll("#showMode button"), function (b) { return b.getAttribute("data-show"); })'), ['auto', 'running', 'all']);
  assert.deepEqual([s.showSwitch, s.archivedInSections, s.archivedGroup, s.heads, s.sortSwitch], ['auto', [], true, ['1 + 1 ended'], false], 'the running archived row waits in the bottom group; the order switch is gone');
  await page.click('#showMode button[data-show="all"]');
  await page.until(() => fake.calls.some((c) => c.path === '/api/order/show' && c.query === '?show=all'), 'the POST');
  fake.snapshot = snap('all');
  s = await page.until((x) => x.archivedInSections.length === 3, 'the archived rows');
  assert.deepEqual(s.sections[0].rows, [A, B, C, D, E], 'the placed rows (running and ended), then archived newest first (the running archived row by its time)');
  assert.deepEqual([s.handles, s.lockButtons], [2, 2], 'only the two placed rows carry a rail: an archived row has no place');
  assert.deepEqual([s.showSwitch, s.archivedGroup, s.heads], ['all', false, ['1 + 1 ended + 3 archived']]);
  assert.equal(await page.eval('document.querySelectorAll(' + JSON.stringify(rowSel(D) + ' .iconbtn.unarchive') + ').length'), 0, 'Claude Code\'s archive is unarchived there');
  assert.equal(await page.eval('document.querySelectorAll(' + JSON.stringify(rowSel(E) + ' .iconbtn.unarchive') + ').length'), 1);
  assert.equal(await page.eval('document.querySelectorAll(' + JSON.stringify(rowSel(E) + ' .iconbtn.archive') + ').length'), 0, 'no ⤓ on an archived row');
  assert.ok(s.chips >= 3, 'each archived row carries its chip');
  await page.click('#showMode button[data-show="running"]');
  s = await page.until((x) => x.endedRows.length === 0 && x.archivedInSections.length === 0, 'running hides both at once');
  fake.snapshot = snapshotOf([]);
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
    row(E, 'Gamma old idle', 'idle', Object.assign({ activityAt: ago(30) }, win(3, 'gamma'))),
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
    row(B, 'Idle three days', 'idle', Object.assign({ pid: 200, activityAt: ago(3 * 24 * 60) }, win(1, 'alpha'))),
    row(C, 'Older', 'idle', Object.assign({ pid: 300, activityAt: ago(400) }, win(2, 'beta'))),
    row(D, 'Archived', 'idle', Object.assign({ pid: 400, activityAt: ago(600), archived: true, archivedBy: 'claude-code' }, win(1, 'alpha'))),
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
  await page.click(rowSel(A) + ' .agent');
  s = await page.until((x) => x.copied === 'cuvis-ai-6c', 'the name on the row copies');
  await page.click(rowSel(A) + ' .iconbtn.info');
  s = await page.until((x) => x.details.length === 1, 'the details line');
  assert.ok(s.details[0].includes('agentcuvis-ai-6c'), s.details[0]);
  await page.eval('window.__copied = null; true');
  await page.click(rowSel(A) + ' .details div:nth-child(2) .copyval');
  s = await page.until((x) => x.copied === 'cuvis-ai-6c', 'the name in the details copies');
  await page.close();
});

// -- order, locks and moves -----------------------------------------------------------------

const locksCalls = () => fake.calls.filter((c) => c.path === '/api/locks').map((c) => c.body);
const F = '99999999-7777-4777-8777-777777777777';
const G = '78787878-9999-4999-8999-999999999999';
const N = '34343434-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const Q = '12121212-8888-4888-8888-888888888888';
const secOf = (s, key) => s.sections.find((sec) => sec.key === key);
// Claude Code's order of these four: D works, then C (5 min), A (10 min), B (20 min)
const boardRows = (extra) => [
  row(A, 'Alpha idle', 'idle', Object.assign({ activityAt: ago(10) }, (extra || {})[A])),
  row(B, 'Beta waits vis', 'waiting', Object.assign({ pid: 200, activityAt: ago(20) }, (extra || {})[B])),
  row(C, 'Gamma idle vis', 'idle', Object.assign({ pid: 300, activityAt: ago(5) }, (extra || {})[C])),
  row(D, 'Delta works', 'busy', Object.assign({ pid: 400, activityAt: ago(30), workingSince: ago(2) }, (extra || {})[D])),
];
const otherWindow = () => row(Q, 'Elsewhere idle', 'idle', Object.assign({ pid: 800, activityAt: ago(2) }, win(2, 'beta')));
const auto = { order: { show: 'auto' } };

test('page: a section is one list in Claude Code\'s order: working sessions on top by their start, then running and ended rows together by their last message; every placed card has a rail', opts, async () => {
  fake.calls.length = 0;
  const rows = boardRows().concat([
    row(E, 'Eps works longer', 'busy', { pid: 500, activityAt: ago(50), workingSince: ago(1) }),
    row(N, 'Put away', 'idle', { pid: 600, archived: true, archivedBy: 'board' }),
  ]);
  fake.snapshot = snapshotOf(rows, Object.assign({ ended: [ended(F, 'Ended 7 min', { activityAt: ago(7) }), ended(G, 'Ended an hour', { activityAt: ago(60) })] }, auto));
  fake.search = { rows: [{ sessionId: Q, title: 'A past hit', live: false, cwd: 'C:\\code\\y', activityAt: ago(500), path: 'C:\\p\\y\\' + Q + '.jsonl', snippets: [] }] };
  const page = await openPage();
  let s = await page.until((x) => x.sections.length === 1 && x.sections[0].rows.length === 7, 'the rows');
  assert.deepEqual(s.sections[0].rows, [E, D, C, F, A, B, G], 'the two working rows by their start, then every other by its last message, ended ones among them');
  assert.deepEqual([s.handles, s.lockButtons, s.pressedLocks, s.locked, s.sortSwitch], [7, 7, 0, [], false], 'a grip and a lock on every placed card, none locked, no order switch');
  assert.deepEqual(s.ages, [E + '=1m', D + '=2m', C + '=5m', F + '=7m', A + '=10m', B + '=20m', G + '=1h'], 'a working card shows since when it works, every other the time since its last message');
  await page.click('#toggleArchived');
  s = await page.until((x) => x.archivedList.length === 1, 'the bottom group');
  assert.equal(s.handles, 7, 'no rail on a put away row');
  await page.search('past');
  await page.until((x) => x.results.length === 1, 'a search hit');
  assert.equal(await page.eval('document.querySelectorAll("#l-results .rail, #l-archived .rail").length'), 0, 'no rail on a search row');
  await page.search('');
  await page.until((x) => x.sections.length === 1 && x.sections[0].rows.length === 7, 'the board again');
  await page.click('#showMode button[data-show="running"]');
  s = await page.until((x) => x.endedRows.length === 0, 'running');
  assert.deepEqual(s.sections[0].rows, [E, D, C, A, B]);
  fake.search = { rows: [] };
  await page.close();
});

test('page: the lock button holds a card at its place number in the list the switch shows, while sessions start, end and get written in; unlock sends it back', opts, async () => {
  fake.calls.length = 0;
  const endedF = () => [ended(F, 'Ended 3 min', { activityAt: ago(3) })];
  fake.snapshot = snapshotOf(boardRows(), Object.assign({ ended: endedF() }, auto));
  const page = await openPage();
  let s = await page.until((x) => x.sections.length === 1 && x.sections[0].rows.length === 5, 'the rows');
  assert.deepEqual(s.sections[0].rows, [D, F, C, A, B]);
  await page.click(rowSel(A) + ' .lockbtn');
  s = await page.until((x) => x.locked.length === 1, 'locked at once');
  assert.deepEqual([s.locked, s.pressedLocks, s.sections[0].rows], [[A], 1, [D, F, C, A, B]], 'the card stays where it was');
  await page.until(() => locksCalls().length === 1, 'the POST');
  assert.deepEqual(locksCalls(), [{ set: { [A]: 3 }, move: {}, clear: [] }], 'locked at its index in the list');
  const lockedA = { [A]: { lockSlot: 3 } };
  fake.snapshot = snapshotOf(boardRows(lockedA).concat([row(N, 'New one works', 'busy', { pid: 600, workingSince: ago(0) })]), Object.assign({ ended: endedF() }, auto));
  s = await page.until((x) => x.sections[0].rows.length === 6, 'a session started');
  assert.deepEqual(s.sections[0].rows, [N, D, F, A, C, B], 'the new card is on top, the locked one is still fourth, the others moved around it');
  fake.snapshot = snapshotOf(boardRows({ [A]: { lockSlot: 3, activityAt: ago(0) } }), Object.assign({ ended: endedF() }, auto));
  s = await page.until((x) => x.sections[0].rows.length === 5, 'the new session is gone again');
  assert.deepEqual(s.sections[0].rows, [D, F, C, A, B], 'writing in the locked session does not move it');
  await page.click('#showMode button[data-show="running"]');
  s = await page.until((x) => x.endedRows.length === 0, 'running');
  assert.deepEqual(s.sections[0].rows, [D, C, B, A], 'in running the hidden ended row takes no place: the card is fourth among the rows shown');
  fake.snapshot = snapshotOf(boardRows(lockedA).concat([row(N, 'New one works', 'busy', { pid: 600, workingSince: ago(0) })]), Object.assign({ ended: endedF() }, { order: { show: 'running' } }));
  s = await page.until((x) => x.sections[0].rows.length === 5, 'a session started in running');
  assert.deepEqual(s.sections[0].rows, [N, D, C, A, B], 'still fourth on screen');
  await page.click(rowSel(A) + ' .lockbtn');
  s = await page.until((x) => x.locked.length === 0, 'unlocked at once');
  await page.until(() => locksCalls().length === 2, 'the second POST');
  assert.deepEqual(locksCalls()[1], { set: {}, move: {}, clear: [A] });
  fake.snapshot = snapshotOf(boardRows(), Object.assign({ ended: endedF() }, { order: { show: 'running' } }));
  s = await page.until((x) => x.sections[0].rows.length === 4 && x.sections[0].rows[2] === A, 'back in the order by time');
  assert.deepEqual(s.sections[0].rows, [D, C, A, B]);
  await page.close();
});

test('page: Alt+Down moves a card past its neighbour, locks it there and keeps the focus; a locked card it passes gets the place it now has; Alt+Up at the top is a no-op', opts, async () => {
  fake.calls.length = 0;
  // every row has a transcript, so each carries the Steps button: the keyboard order of the row must be what it was before that button came
  const rows = () => boardRows({ [B]: { lockSlot: 3 } }).map((r) => Object.assign(r, { transcriptPath: 'C:\\x\\' + r.sessionId + '.jsonl' }));
  fake.snapshot = snapshotOf(rows(), auto);
  const page = await openPage();
  let s = await page.until((x) => x.sections.length === 1 && x.sections[0].rows.length === 4, 'the rows');
  assert.ok(s.actionKinds.every((k) => k.split('=')[1].split(',')[0] === 'steps'), 'every row carries the Steps button: ' + JSON.stringify(s.actionKinds));
  assert.deepEqual([s.sections[0].rows, s.locked], [[D, C, A, B], [B]]);
  await page.key(C, 'ArrowDown');
  s = await page.until((x) => x.sections[0].rows[1] === A, 'moved at once');
  assert.deepEqual([s.sections[0].rows, s.focused, s.locked.slice().sort()], [[D, A, C, B], C, [B, C].sort()], 'the card moved one place, is locked there and kept the focus');
  await page.until(() => locksCalls().length === 1, 'the POST');
  assert.deepEqual(locksCalls()[0], { set: { [C]: 2 }, move: {}, clear: [] }, 'the locked card below did not change its place: nothing to move');
  await page.key(C, 'ArrowDown');
  s = await page.until((x) => x.sections[0].rows[3] === C, 'past the locked card');
  assert.deepEqual(s.sections[0].rows, [D, A, B, C]);
  await page.until(() => locksCalls().length === 2, 'the second POST');
  assert.deepEqual(locksCalls()[1], { set: { [C]: 3 }, move: { [B]: 2 }, clear: [] }, 'the card it passed is rewritten to the place it now has');
  await page.key(D, 'ArrowUp');
  await sleep(300);
  s = await page.sample();
  assert.deepEqual([s.sections[0].rows, locksCalls().length], [[D, A, B, C], 2], 'the top card and Alt+Up: nothing happens');
  fake.snapshot = snapshotOf(boardRows({ [B]: { lockSlot: 2 }, [C]: { lockSlot: 3 } }), auto);
  await sleep(600);
  s = await page.sample();
  assert.deepEqual(s.sections[0].rows, [D, A, B, C], 'the snapshot agrees');
  await page.close();
});

test('page: a drag by the grip drops a card next to another and locks it; an ended card moves like a running one; a drop on another section is refused', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(boardRows().concat([otherWindow()]), Object.assign({ ended: [ended(F, 'Ended 7 min', { activityAt: ago(7) })] }, auto));
  const page = await openPage();
  let s = await page.until((x) => x.sections.length === 2 && x.handles === 6, 'two sections with rails');
  assert.deepEqual(secOf(s, 'w1').rows, [D, C, F, A, B]);
  let r = await page.drag(B, D, true);
  assert.deepEqual([r.allowed, r.marks], [true, 1], 'the drop was allowed and the target marked');
  s = await page.until((x) => secOf(x, 'w1').rows[0] === B, 'moved at once');
  assert.deepEqual([secOf(s, 'w1').rows, s.dropMarks, s.locked], [[B, D, C, F, A], 0, [B]]);
  await page.until(() => locksCalls().length === 1, 'the POST');
  assert.deepEqual(locksCalls()[0], { set: { [B]: 0 }, move: {}, clear: [] });
  r = await page.drag(F, A, false);
  assert.equal(r.allowed, true, 'an ended card is dragged like any other');
  s = await page.until((x) => secOf(x, 'w1').rows[4] === F, 'the ended card moved');
  assert.deepEqual([secOf(s, 'w1').rows, s.locked.slice().sort()], [[B, D, C, A, F], [B, F].sort()]);
  await page.until(() => locksCalls().length === 2, 'the second POST');
  assert.deepEqual(locksCalls()[1], { set: { [F]: 4 }, move: {}, clear: [] });
  r = await page.drag(C, Q, false);
  assert.deepEqual([r.allowed, r.marks], [false, 0], 'a card onto another window section: refused');
  await sleep(300);
  s = await page.sample();
  assert.deepEqual([secOf(s, 'w1').rows, secOf(s, 'w2').rows, locksCalls().length], [[B, D, C, A, F], [Q], 2]);
  await page.close();
});

test('page: a failed /api/locks drops the pending lock, the card is free again and the notice says why; an older failure does not undo a newer change', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(boardRows(), auto);
  fake.locks = () => ({ status: 500, body: { ok: false, error: 'EACCES: permission denied' } });
  const page = await openPage();
  await page.until((x) => x.sections.length === 1 && x.sections[0].rows.length === 4, 'the rows');
  await page.key(C, 'ArrowDown');
  let s = await page.until((x) => x.notice !== null, 'the notice');
  assert.equal(s.notice, 'lock failed: EACCES: permission denied');
  assert.deepEqual([s.sections[0].rows, s.locked], [[D, C, A, B], []], 'the card returned and is not locked');
  // the first request fails late, the second succeeds at once: the late failure must leave the second lock alone
  fake.locks = (body) => (body.set && body.set[A] !== undefined ? { status: 500, body: { ok: false, error: 'late failure' }, delayMs: 700 } : locksOk());
  await page.click(rowSel(A) + ' .lockbtn');
  await page.click(rowSel(B) + ' .lockbtn');
  s = await page.until((x) => x.notice === 'lock failed: late failure', 'the late failure');
  assert.deepEqual(s.locked, [B], 'only the failed lock went');
  fake.locks = locksOk;
  await page.close();
});

test('page: a stale snapshot that lands before the /api/locks reply does not snap the card back', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(boardRows(), auto);
  fake.locks = () => Object.assign(locksOk(), { delayMs: 900 });
  const page = await openPage();
  await page.until((x) => x.sections.length === 1 && x.sections[0].rows.length === 4, 'the rows');
  await page.key(C, 'ArrowDown');
  let s = await page.until((x) => x.sections[0].rows[1] === A, 'moved at once');
  await sleep(700);                                          // two or three polls without the lock, the reply still pending
  s = await page.sample();
  assert.deepEqual(s.sections[0].rows, [D, A, C, B], 'the pending lock holds under the stale polls');
  await page.until(() => locksCalls().length === 1, 'the POST');
  await sleep(400);
  s = await page.sample();
  assert.deepEqual(s.sections[0].rows, [D, A, C, B], 'and after the reply');
  fake.locks = locksOk;
  await page.close();
});

test('page: two moves in two sections inside the guard both hold', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf([
    row(A, 'A first', 'idle', { activityAt: ago(2) }), row(B, 'B second', 'idle', { pid: 200, activityAt: ago(3) }),
    row(C, 'C first', 'idle', Object.assign({ pid: 300, activityAt: ago(2) }, win(2, 'beta'))), row(D, 'D second', 'idle', Object.assign({ pid: 400, activityAt: ago(3) }, win(2, 'beta'))),
  ], auto);
  const page = await openPage();
  let s = await page.until((x) => x.sections.length === 2, 'two sections');
  await page.key(B, 'ArrowUp');
  s = await page.until((x) => secOf(x, 'w1').rows[0] === B, 'the first move');
  await page.key(D, 'ArrowUp');
  s = await page.until((x) => secOf(x, 'w2').rows[0] === D, 'the second move');
  await sleep(600);                                          // polls without the locks keep coming
  s = await page.sample();
  assert.deepEqual([secOf(s, 'w1').rows, secOf(s, 'w2').rows], [[B, A], [D, C]], 'both sections hold their new order');
  await page.until(() => locksCalls().length === 2, 'both POSTs');
  assert.deepEqual(locksCalls(), [{ set: { [B]: 0 }, move: {}, clear: [] }, { set: { [D]: 0 }, move: {}, clear: [] }]);
  await page.close();
});

test('page: with a filter typed the grip stays and Alt+Down goes past the next card the filter shows; locks past the end of a short list sit at its end in their order', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(boardRows(), auto);
  const page = await openPage();
  await page.until((x) => x.sections.length === 1 && x.sections[0].rows.length === 4, 'the rows');
  await page.type('vis');
  let s = await page.until((x) => x.sections[0].rows.length === 2, 'the filter');
  assert.deepEqual([s.sections[0].rows, s.handles], [[C, B], 2], 'the filter hides two cards; the grip stays on the others');
  await page.key(C, 'ArrowDown');
  await page.until(() => locksCalls().length === 1, 'the POST');
  assert.deepEqual(locksCalls()[0], { set: { [C]: 3 }, move: {}, clear: [] }, 'past B, the next card shown, and past the hidden card between them: the last place of the whole list');
  await page.type('');
  s = await page.until((x) => x.sections[0].rows.length === 4, 'the filter cleared');
  assert.deepEqual(s.sections[0].rows, [D, A, B, C]);
  fake.snapshot = snapshotOf(boardRows({ [A]: { lockSlot: 9 }, [B]: { lockSlot: 7 } }), auto);
  s = await page.until((x) => x.locked.length === 2 && x.sections[0].rows[3] === A, 'two locks past the end');
  assert.deepEqual(s.sections[0].rows, [D, C, B, A], 'both at the end, the lower slot first; the free cards fill the places before them');
  await page.close();
});

test('page: placeRows puts every row once whatever the order it gets them in: all rows locked, one slot twice, and the same list for the same rows shuffled', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(boardRows(), auto);
  const page = await openPage();
  await page.until((x) => x.sections.length === 1, 'the page');
  const place = (rows) => page.eval('placeRows(' + JSON.stringify(rows) + ').map(function (s) { return s.sessionId; })');
  const r = (id, extra) => Object.assign({ sessionId: id, status: 'idle', activityAt: 1000, workingSince: null, lockSlot: null }, extra);
  assert.deepEqual(await place([r(C, { lockSlot: 1 }), r(A, { lockSlot: 1 }), r(B, { lockSlot: 0 })]), [B, A, C], 'all locked and one slot twice: by slot, then by id, no row lost');
  const mixed = [r(A, { activityAt: 3000 }), r(B, { lockSlot: 1 }), r(C, { status: 'busy', workingSince: 500 }), r(D, { activityAt: 2000 }), r(E, { lockSlot: 0 })];
  assert.deepEqual(await place(mixed), [E, B, C, A, D], 'the locks at their slots, then the working row, then by the last message');
  assert.deepEqual(await place(mixed.slice().reverse()), [E, B, C, A, D], 'the same list for the same rows in another order');
  assert.deepEqual(await place([]), []);
  await page.close();
});

test('page: the keyboard keeps its place across a render: a focused lock button can be pressed twice, a focused card keeps the focus through the polls, and of three copy buttons the same one gets it back', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(boardRows({ [A]: { name: 'agent-a', transcriptPath: 'C:\\x\\a.jsonl' } }), auto);
  const page = await openPage();
  await page.until((x) => x.sections.length === 1 && x.sections[0].rows.length === 4, 'the rows');
  await page.eval('document.querySelector(' + JSON.stringify(rowSel(A) + ' .lockbtn') + ').focus(); document.activeElement.click(); true');
  let s = await page.until((x) => x.locked.length === 1, 'locked');
  assert.deepEqual([s.focusedIn, s.focusedAct], [A, 'lock'], 'the new lock button of the same card holds the focus');
  await page.eval('document.activeElement.click(); true');
  s = await page.until((x) => x.locked.length === 0, 'unlocked by the second press, without focusing again');
  assert.deepEqual([s.focusedIn, s.focusedAct], [A, 'lock']);
  await page.eval('document.querySelector(' + JSON.stringify(rowSel(C)) + ').focus(); true');
  await sleep(700);                                          // two or three polls, each one a render
  s = await page.sample();
  assert.deepEqual([s.focusedIn, s.focusedAct], [C, null], 'a focused card keeps the focus through the polls');
  // the agent name, the id and the transcript path of a row are three buttons with the action "copyval"
  await page.click(rowSel(A) + ' .iconbtn.info');
  await page.until((x) => x.details.some((d) => d.indexOf(A + '=') === 0 && /transcript/.test(d)), 'the details');
  const pathButton = 'Array.prototype.slice.call(document.querySelectorAll(' + JSON.stringify(rowSel(A) + ' .details .copyval') + ')).pop()';
  assert.ok(await page.eval('document.querySelectorAll(' + JSON.stringify(rowSel(A) + ' [data-act="copyval"]') + ').length') >= 3, 'three or more copy buttons on the row');
  await page.eval('window.__copied = null; ' + pathButton + '.focus(); document.activeElement.click(); true');
  s = await page.until((x) => x.copied !== null, 'the first copy');
  assert.match(s.copied, /a\.jsonl$/, 'the transcript path');
  await page.eval('window.__copied = null; document.activeElement.click(); true');
  s = await page.until((x) => x.copied !== null, 'the second copy');
  assert.match(s.copied, /a\.jsonl$/, 'the second press copies the path again: the focus came back to the same button, not to the first of the three');
  await page.close();
});

test('page: the focus follows the id button when the agent name before it goes and comes back: a press copies the id both times', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(boardRows({ [A]: { name: 'agent-a' } }), auto);
  const page = await openPage();
  await page.until((x) => x.agents.length === 1, 'the agent name on the card');
  await page.eval('window.__copied = null; document.querySelector(' + JSON.stringify(rowSel(A) + ' .sid') + ').focus(); true');
  fake.snapshot = snapshotOf(boardRows(), auto);             // the name is gone: the id button is now the first copy button of the row
  await page.until((x) => x.agents.length === 0, 'the card without the agent name');
  await page.eval('document.activeElement.click(); true');
  let s = await page.until((x) => x.copied !== null, 'a copy after the agent name went');
  assert.equal(s.copied, A, 'the id: the focus stayed on the id button, it did not fall back to the card');
  fake.snapshot = snapshotOf(boardRows({ [A]: { name: 'agent-a' } }), auto);   // the name is back: the id button is the second again
  await page.until((x) => x.agents.length === 1, 'the agent name is back');
  await page.eval('window.__copied = null; document.activeElement.click(); true');
  s = await page.until((x) => x.copied !== null, 'a copy after the agent name came back');
  assert.equal(s.copied, A, 'the id again, not the agent name that now stands before it');
  await page.close();
});

test('page: lock then unlock in a row: a snapshot that knows only the first write does not show the card locked again', opts, async () => {
  fake.calls.length = 0;
  fake.snapshot = snapshotOf(boardRows(), auto);
  fake.locks = () => Object.assign(locksOk(), { delayMs: 1500 });
  const page = await openPage();
  await page.until((x) => x.sections.length === 1 && x.sections[0].rows.length === 4, 'the rows');
  await page.click(rowSel(A) + ' .lockbtn');
  await page.until((x) => x.locked.length === 1, 'locked');
  await page.click(rowSel(A) + ' .lockbtn');
  await page.until((x) => x.locked.length === 0, 'unlocked');
  const polled = async (count) => { const from = fake.polls; while (fake.polls < from + count) await sleep(20); await sleep(80); };   // that many polls answered, and rendered
  await polled(2);                                           // polls from before both writes: they agree with "unlocked" by chance
  fake.snapshot = snapshotOf(boardRows({ [A]: { lockSlot: 2 } }), auto);   // the next polls know the first write only
  await polled(2);
  let s = await page.sample();
  assert.deepEqual(s.locked, [], 'the unlock holds: its own reply is still out');
  fake.snapshot = snapshotOf(boardRows(), auto);
  await page.until(() => locksCalls().length === 2, 'both POSTs');
  await sleep(1700);                                         // both replies are in
  await polled(2);
  s = await page.sample();
  assert.deepEqual(s.locked, [], 'and after the replies');
  fake.locks = locksOk;
  await page.close();
});

test('page (webview): the lock button posts a locks message with a seq; a failed locksResult for that seq frees the card and shows the notice; a good one holds until the snapshot agrees', opts, async () => {
  const page = await openWebviewPage(snapshotOf(boardRows(), auto));
  const locksPosted = (s) => s.posted.filter((m) => m.type === 'locks');
  await page.click(rowSel(A) + ' .lockbtn');
  let s = await page.until((x) => locksPosted(x).length === 1, 'the locks message');
  assert.deepEqual(locksPosted(s)[0], { type: 'locks', set: { [A]: 2 }, move: {}, clear: [], seq: 1 });
  assert.deepEqual(s.locked, [A], 'locked at once');
  await page.host({ type: 'locksResult', ok: false, seq: 1, message: 'EACCES: permission denied' });
  s = await page.until((x) => x.notice !== null, 'the notice');
  assert.deepEqual([s.notice, s.locked], ['lock failed: EACCES: permission denied', []], 'the reply reached the page over the message path');
  await page.click(rowSel(A) + ' .lockbtn');
  s = await page.until((x) => locksPosted(x).length === 2, 'the second message');
  assert.equal(locksPosted(s)[1].seq, 2);
  await page.host({ type: 'locksResult', ok: true, seq: 2, message: '' });
  await page.host({ type: 'snapshot', data: snapshotOf(boardRows(), auto) });   // a snapshot from before the write
  await sleep(200);
  s = await page.sample();
  assert.deepEqual(s.locked, [A], 'held under a snapshot that does not know the lock yet');
  await page.host({ type: 'snapshot', data: snapshotOf(boardRows({ [A]: { lockSlot: 2 } }), auto) });
  await sleep(200);
  s = await page.sample();
  assert.deepEqual([s.locked, s.sections[0].rows], [[A], [D, C, A, B]]);
  assert.equal(s.posted.some((m) => m.type === 'order' || m.type === 'sortMode'), false, 'the retired messages are never sent');
  await page.close();
});

test('page: rows still render their buttons, with Steps in place for a session that has a transcript (regression)', opts, async () => {
  fake.snapshot = snapshotOf([
    row(A, 'With transcript', 'idle', { transcriptPath: 'C:\\x\\a.jsonl' }),
    row(B, 'No transcript', 'idle', { pid: 200, transcriptPath: null }),
  ]);
  const page = await openPage();
  const s = await page.until((x) => x.rows.includes(A) && x.rows.includes(B), 'both rows');
  const kindsOf = (sid) => (s.actionKinds.find((x) => x.indexOf(sid + '=') === 0) || '').split('=')[1].split(',');
  assert.deepEqual(kindsOf(A), ['steps', 'details', 'retitle', 'mute', 'archive', 'end'], 'the row with a transcript carries Steps ahead of the other buttons, order otherwise unchanged');
  assert.deepEqual(kindsOf(B), ['details', 'retitle', 'mute', 'archive', 'end'], 'no transcript: no Steps button, the rest unchanged');
  const title = await page.eval('document.querySelector(' + JSON.stringify(rowSel(A) + ' .iconbtn.steps') + ').title');
  assert.equal(title, 'Steps', 'the row button\'s tooltip is just Steps');
  await page.click(rowSel(A) + ' .iconbtn.steps');
  await page.close();
});
