'use strict';
/*
 * extension/steps.html driven in headless Chrome over the DevTools protocol, the same harness
 * tests/page.test.cjs uses, against an in-test HTTP server that plays scripted /api/steps and
 * /api/steps/poll answers (the browser transport: steps.html talks to the fake server exactly
 * as it would talk to server.cjs). Skipped with a reason when no Chromium is found.
 *
 *   node:test ──▶ fake API (http) ◀── steps.html in headless Chrome ◀── CDP over Node's WebSocket
 *                   scripted /api/steps (open/body/bodies/search/seen) and /api/steps/poll
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
const chromeLock = require('./shim/chrome-lock.cjs');

let CHROME = null;
try { CHROME = browser(); } catch (_) { CHROME = null; }
const opts = { skip: CHROME ? false : 'no Chromium found; set SCREENSHOT_BROWSER to run the page suite', timeout: 60000 };

const STEPS_HTML = fs.readFileSync(path.join(__dirname, '..', 'steps.html'), 'utf8');
const TOKEN = 'test-steps-token';
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(id, kind, extra) {
  return Object.assign({ id, kind, at: '2026-01-01T00:00:00.000Z', preview: '', generation: 1 }, extra);
}
function section(kind, heading, openerId, body, extra) {
  return Object.assign({ kind, heading, at: '2026-01-01T00:00:00.000Z', body: body || [], openerId: openerId || null }, extra);
}
function openReply(overrides) {
  return Object.assign({
    type: 'openResult', ok: true, title: 'Fixture session', generation: 1, indexing: false,
    seenStepId: null, counts: { byKind: {}, unreadable: 0 },
    steps: [], sections: [section('lead', 'Session start', null, [])],
    strip: { totalTimeMs: 60000, sections: 1, decisions: 0, filesChanged: 0 },
  }, overrides || {});
}

// -- fake API ------------------------------------------------------------------------------

const fake = {
  open: () => openReply(),
  body: (stepId) => ({ text: 'body of ' + stepId, truncated: false, size: 10 }),
  bodies: (ids) => ids.map((id) => Object.assign({ stepId: id }, fake.body(id))),
  search: () => ({ stepIds: [], capped: false }),
  seen: () => ({ ok: true }),
  calls: [],
  pushes: [], // queued push messages the poll route drains in order
};
let PORT = 0;

function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { resolve(null); } });
  });
}

async function serve(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (u.pathname === '/steps') {
    const sessionId = u.searchParams.get('session') || '';
    const html = STEPS_HTML
      .replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="board-token" content="' + TOKEN + '"><meta name="steps-session" content="' + sessionId + '">')
      .replace('var POLL_MS = 1200;', 'var POLL_MS = 120;')
      .replace('var SEEN_DEBOUNCE_MS = 1500;', 'var SEEN_DEBOUNCE_MS = 200;')
      .replace('var SEARCH_DEBOUNCE_MS = 150;', 'var SEARCH_DEBOUNCE_MS = 30;');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (u.pathname === '/api/steps/poll') {
    if (req.headers['x-board-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
    const after = Number(u.searchParams.get('after') || 0);
    const items = fake.pushes.slice(after);
    return json(res, 200, { seq: fake.pushes.length, pushes: items });
  }
  if (u.pathname === '/api/steps' && req.method === 'POST') {
    if (req.headers['x-board-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
    const msg = await readBody(req);
    fake.calls.push(msg);
    if (!msg) return json(res, 400, { error: 'bad json' });
    if (msg.type === 'open') return json(res, 200, Object.assign({ requestId: msg.requestId }, fake.open()));
    if (msg.type === 'body') return json(res, 200, Object.assign({ type: 'bodyResult', sessionId: msg.sessionId, stepId: msg.stepId }, fake.body(msg.stepId)));
    if (msg.type === 'bodies') return json(res, 200, { type: 'bodiesResult', sessionId: msg.sessionId, generation: msg.generation, items: fake.bodies(msg.stepIds || []) });
    if (msg.type === 'search') return json(res, 200, Object.assign({ type: 'searchResult', requestId: msg.requestId, query: msg.query }, fake.search(msg.query)));
    if (msg.type === 'seen') return json(res, 200, Object.assign({ type: 'seenResult' }, fake.seen(msg.stepId)));
    if (msg.type === 'openLink') return json(res, 200, { type: 'openLinkResult', ok: false, notAvailable: true });
    if (msg.type === 'openText') return json(res, 200, { type: 'openTextResult', notAvailable: true });
    return json(res, 200, { type: 'errorResult' });
  }
  return json(res, 404, { error: 'not found' });
}
function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

// -- Chrome over the DevTools protocol (same harness as page.test.cjs) ---------------------

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
  await chromeLock.acquire(); // page.test.cjs drives its own Chrome too; one at a time keeps both off a shared CPU budget
  PORT = await freePort();
  server = http.createServer((req, res) => { serve(req, res).catch((e) => json(res, 500, { error: String(e) })); });
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res));
  const cdpPort = await freePort();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-steps-page-chrome-'));
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
  if (userDataDir) {
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* leave it to the OS temp cleanup */ }
  }
  if (CHROME) chromeLock.release();
});

const SAMPLE = `(function () {
  var q = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var text = function (sel) { var e = document.querySelector(sel); return e ? e.textContent : null; };
  return {
    title: text('#title'),
    sub: text('#sub'),
    error: text('.error-state'),
    stripNums: q('.strip .item').map(function (i) { return (i.querySelector('.lbl') || {}).textContent + '=' + (i.querySelector('.num') || {}).textContent; }),
    sectionHeadings: q('.sec-entry .txt').map(function (e) { return e.textContent; }),
    rowKinds: q('.row[data-step]').map(function (r) { return r.className; }),
    youText: text('.row.k-you .you-msg'),
    qOptions: q('.qopt').map(function (o) { return { label: (o.querySelector('.qopt-label') || {}).textContent, chosen: o.classList.contains('chosen'), tag: !!o.querySelector('.qopt-tag') }; }),
    decisionsOn: !!document.getElementById('decisions').classList.contains('on'),
    filesTileNum: (function () { var t = q('.strip .item')[3]; return t ? t.querySelector('.num').textContent : null; })(),
    fileLinks: q('.fp, .filerow a.lnk').map(function (a) { return a.textContent; }),
    searchCount: text('#count'),
    curHitText: (function () { var e = document.querySelector('.cur-hit'); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })(),
    newMarker: !!document.querySelector('.new-marker'),
    atBottom: (function () { var r = document.getElementById('reader'); return r.scrollTop + r.clientHeight >= r.scrollHeight - 20; })(),
    scrollTop: document.getElementById('reader').scrollTop,
    imgCount: q('img').length,
    drawerVisible: (function () { var el = document.getElementById('railToggle'); return getComputedStyle(el).display !== 'none'; })(),
    railOpen: document.getElementById('rail').classList.contains('open'),
    domRowCount: q('.row, .sec-stub').length,
    openLinkCalls: window.__openLinkCalls || 0,
    lnkCount: q('a.lnk').length,
    workSums: q('.worksum').map(function (e) { return e.textContent; }),
    restateCount: q('.row.k-you .restate').length,
    youMsgCount: q('.row.k-you .you-msg').length,
    youMsgOpen: !!document.querySelector('.row.k-you .you-msg.open'),
    showAllYou: !!document.querySelector('.row.k-you .showall'),
    indexNoteShown: document.getElementById('indexnote').classList.contains('show'),
  };
})()`;

async function openPage(sessionId, path) {
  path = path || ('/steps?session=' + sessionId);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:' + PORT + path });
  const { sessionId: cdpSessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, cdpSessionId);
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, cdpSessionId);
    if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  };
  const page = {
    sample: () => ev(SAMPLE),
    click: (sel) => ev('(function () { var e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) throw new Error("no element " + ' + JSON.stringify(sel) + '); e.click(); return true; })()'),
    search: (q) => ev('(function () { var i = document.getElementById("q"); i.value = ' + JSON.stringify(q) + '; i.dispatchEvent(new Event("input")); return true; })()'),
    scroll: (top) => ev('(function () { document.getElementById("reader").scrollTop = ' + Number(top) + '; document.getElementById("reader").dispatchEvent(new Event("scroll")); return true; })()'),
    eval: (expr) => ev(expr),
    until: async (pred, what) => {
      const start = Date.now();
      let s = null;
      while (Date.now() - start < 8000) { try { s = await ev(SAMPLE); if (pred(s)) return s; } catch (_) { /* page still loading */ } await sleep(100); }
      throw new Error('timed out waiting for ' + what + '; last sample: ' + JSON.stringify(s));
    },
    close: () => cdp.send('Target.closeTarget', { targetId }),
  };
  return page;
}

test.beforeEach(() => { fake.calls.length = 0; fake.pushes.length = 0; fake.open = () => openReply(); fake.search = () => ({ stepIds: [], capped: false }); });

// -- first paint ----------------------------------------------------------------------------

test('page: first paint from an open reply shows the title and the strip', opts, async () => {
  fake.open = () => openReply({
    title: 'My plan session',
    steps: [step('u1:0', 'you', { preview: 'please build the thing' })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'please build the thing', 'u1:0', []),
    ],
    strip: { totalTimeMs: 125000, sections: 2, decisions: 1, filesChanged: 0 },
  });
  const page = await openPage(A);
  const s = await page.until((x) => x.title === 'My plan session', 'the title to render');
  assert.ok(s.stripNums.some((n) => n.indexOf('Sections=2') !== -1));
  assert.ok(s.sectionHeadings.some((h) => h.indexOf('please build the thing') !== -1));
  await page.close();
});

test('page: a question card shows every option and marks the chosen ones', opts, async () => {
  fake.open = () => openReply({
    steps: [step('q1:0', 'question')],
    sections: [
      section('lead', 'Session start', null, []),
      section('qa', 'Option A', 'q1:0', []),
    ],
  });
  fake.body = (stepId) => {
    if (stepId === 'q1:0') {
      return {
        questions: [{
          header: 'Pick an approach', question: 'Which way should we go?', multiSelect: false, answered: true, other: '',
          options: [
            { label: 'Option A', description: 'the simple route', chosen: true },
            { label: 'Option B', description: 'the thorough route', chosen: false },
          ],
        }],
      };
    }
    return { text: 'body of ' + stepId, truncated: false, size: 10 };
  };
  const page = await openPage(A);
  const s = await page.until((x) => x.qOptions.length === 2, 'the question card to render');
  const chosen = s.qOptions.find((o) => o.label === 'Option A');
  const other = s.qOptions.find((o) => o.label === 'Option B');
  assert.equal(chosen.chosen, true);
  assert.equal(chosen.tag, true);
  assert.equal(other.chosen, false);
  assert.equal(other.tag, false);
  await page.close();
});

// -- strip switches ---------------------------------------------------------------------

test('page: the Decisions switch narrows the outline to you/question/plan sections', opts, async () => {
  fake.open = () => openReply({
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'first message', 'u1:0', []),
      section('approve', 'Plan approved', 'p1:0', []),
    ],
    strip: { totalTimeMs: 1000, sections: 3, decisions: 2, filesChanged: 0 },
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 2, 'the outline to render');
  await page.click('#decisions');
  const s = await page.until((x) => x.decisionsOn === true, 'the decisions lens to switch on');
  assert.ok(s.sectionHeadings.every((h) => h !== 'Session start'));
  await page.close();
});

test('page: the Files changed tile shows clickable names that send openLink', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('t1:0', 'tool', { title: 'Edit' })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'edit the file', 'u1:0', [{ kind: 'work', items: ['t1:0'] }]),
    ],
    strip: { totalTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 1 },
  });
  fake.body = (stepId) => {
    if (stepId === 't1:0') return { title: 'Edit', input: 'C:\\\\proj\\\\foo.py', result: 'ok', path: 'C:\\\\proj\\\\foo.py' };
    return { text: 'body of ' + stepId, truncated: false, size: 10 };
  };
  const page = await openPage(A);
  await page.until((x) => x.filesTileNum === '1', 'the files tile to carry the count');
  await page.eval('window.__openLinkCalls = 0; var orig = dispatchLink; dispatchLink = function (k, t) { window.__openLinkCalls++; return orig(k, t); };');
  await page.click('.strip .item:nth-child(4)');
  const s = await page.until((x) => x.fileLinks.length > 0, 'the files view to list a path');
  assert.ok(s.fileLinks.some((f) => f.indexOf('foo.py') !== -1));
  await page.click('.fp');
  await page.until((x) => x.openLinkCalls > 0, 'the click to call dispatchLink');
  await page.close();
});

test('page: a Work line says in words what was done, never "N tool calls: Bash, Edit"', opts, async () => {
  fake.open = () => openReply({
    steps: [
      step('u1:0', 'you'),
      step('t1:0', 'tool', { title: 'Edit' }),
      step('t2:0', 'tool', { title: 'Bash' }),
      step('t3:0', 'tool', { title: 'Bash' }),
    ],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'fix the bug', 'u1:0', [{ kind: 'work', items: ['t1:0', 't2:0', 't3:0'] }]),
    ],
    strip: { totalTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 1 },
  });
  fake.body = (stepId) => {
    if (stepId === 't1:0') return { title: 'Edit', input: 'C:\\proj\\foo.py', result: 'ok', path: 'C:\\proj\\foo.py' };
    if (stepId === 't2:0' || stepId === 't3:0') return { title: 'Bash', input: 'run tests\n$ npm test', result: 'ok' };
    return { text: 'body of ' + stepId, truncated: false, size: 10 };
  };
  const page = await openPage(A);
  const s = await page.until((x) => x.workSums.length > 0 && /edited/i.test(x.workSums[0]), 'the Work line to settle once bodies load');
  assert.ok(/edited/i.test(s.workSums[0]), 'names the edit in words: ' + s.workSums[0]);
  assert.ok(/ran 2 commands/i.test(s.workSums[0]), 'names the commands in words: ' + s.workSums[0]);
  assert.equal(/\d+ tool calls?:/i.test(s.workSums[0]), false, 'never the bare "N tool calls: Bash, Edit" phrasing: ' + s.workSums[0]);
  await page.close();
});

test('page: a single command Work line names it by its own description', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('t1:0', 'tool', { title: 'Bash' })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'run the tests', 'u1:0', [{ kind: 'work', items: ['t1:0'] }]),
    ],
    strip: { totalTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 0 },
  });
  fake.body = (stepId) => {
    if (stepId === 't1:0') return { title: 'Bash', input: 'run the test suite\n$ npm test', result: 'ok' };
    return { text: 'body of ' + stepId, truncated: false, size: 10 };
  };
  const page = await openPage(A);
  const s = await page.until((x) => x.workSums.length > 0 && x.workSums[0].indexOf('run the test suite') !== -1, 'the Work line to settle once the body loads');
  assert.ok(s.workSums[0].indexOf('run the test suite') !== -1, 'a single command is named by its own description: ' + s.workSums[0]);
  await page.close();
});

test('page: the owner\'s message appears once per section, in the heading card, never a second time below it', opts, async () => {
  const longMsg = 'line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight';
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'line one', 'u1:0', [])],
  });
  fake.body = () => ({ text: longMsg, truncated: false, size: longMsg.length });
  const page = await openPage(A);
  const s = await page.until((x) => x.showAllYou, 'the you message body to load and offer Show all');
  assert.equal(s.restateCount, 1, 'one heading card for the you step');
  assert.equal(s.youMsgCount, 1, 'the full message lives in that one card, not a second block');
  assert.ok(s.showAllYou, 'a message past about six lines offers Show all rather than showing unfolded');
  await page.click('.row.k-you .showall');
  const s2 = await page.until((x) => x.youMsgOpen === true, 'the message to unfold on Show all');
  assert.equal(s2.youMsgCount, 1, 'still one card after unfolding');
  await page.close();
});

test('page: the "still indexing" line shows while indexing and disappears once it completes', opts, async () => {
  fake.open = () => openReply({
    indexing: true,
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first', 'u1:0', [])],
  });
  const page = await openPage(A);
  const s1 = await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  assert.equal(s1.indexNoteShown, true, 'shown while the backward pass is still running');
  fake.pushes.push({
    type: 'stepsProgress', sessionId: A, fraction: 1, done: true,
    sections: [section('lead', 'Session start', null, []), section('you', 'first', 'u1:0', [])],
    strip: { totalTimeMs: 1000, sections: 1, decisions: 1, filesChanged: 0 },
  });
  const s2 = await page.until((x) => x.indexNoteShown === false, 'the note to clear once indexing finishes');
  assert.equal(s2.indexNoteShown, false);
  await page.close();
});

// -- search ----------------------------------------------------------------------------

test('page: search next and previous land on a hit inside a folded Work line', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('t1:0', 'tool', { title: 'Bash' })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'run a command', 'u1:0', [{ kind: 'work', items: ['t1:0'] }]),
    ],
  });
  fake.body = (stepId) => {
    if (stepId === 't1:0') return { title: 'Bash', input: '$ grep needle file.txt', result: 'needle found here', path: '' };
    return { text: 'body of ' + stepId, truncated: false, size: 10 };
  };
  fake.search = (q) => (q === 'needle' ? { stepIds: ['t1:0'], capped: false } : { stepIds: [], capped: false });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'the page to render');
  await page.search('needle');
  const s = await page.until((x) => x.searchCount === '1 of 1', 'the search count to update');
  assert.ok(s.curHitText && s.curHitText.length >= 0);
  await page.close();
});

// -- follow / live push -------------------------------------------------------------------

test('page: a follow push appends steps without jumping when scrolled up', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first', 'u1:0', [])],
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  await page.click('#follow'); // turn follow off
  await page.scroll(0);
  const before = await page.sample();
  fake.pushes.push({
    type: 'stepsChanged', sessionId: A, appended: ['u2:0'],
    sections: [section('lead', 'Session start', null, []), section('you', 'first', 'u1:0', []), section('you', 'second', 'u2:0', [])],
    strip: { totalTimeMs: 2000, sections: 3, decisions: 2, filesChanged: 0 },
  });
  const s = await page.until((x) => x.sectionHeadings.length === 3, 'the appended section to arrive');
  assert.equal(s.scrollTop, before.scrollTop, 'the scroll position does not jump while scrolled away from the bottom');
  await page.close();
});

test('page: with Follow on and the reader at the end, a push keeps it at the end', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first', 'u1:0', [])],
  });
  const page = await openPage(A);
  await page.until((x) => x.atBottom === true, 'first paint lands at the end');
  fake.pushes.push({
    type: 'stepsChanged', sessionId: A, appended: ['u2:0'],
    sections: [section('lead', 'Session start', null, []), section('you', 'first', 'u1:0', []), section('you', 'second', 'u2:0', [])],
    strip: { totalTimeMs: 2000, sections: 3, decisions: 2, filesChanged: 0 },
  });
  const s = await page.until((x) => x.sectionHeadings.length === 3, 'the appended section to arrive');
  assert.equal(s.atBottom, true, 'follow keeps the reader pinned to the end');
  await page.close();
});

test('page: "new since you last looked" shows at the seen marker', opts, async () => {
  fake.open = () => openReply({
    seenStepId: 'u1:0',
    steps: [step('u1:0', 'you'), step('u2:0', 'you')],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'first', 'u1:0', []),
      section('you', 'second', 'u2:0', []),
    ],
  });
  const page = await openPage(A);
  const s = await page.until((x) => x.newMarker === true, 'the marker to render after the seen step');
  assert.equal(s.newMarker, true);
  await page.close();
});

// -- untrusted content -------------------------------------------------------------------

test('page: a body with an img onerror tag renders as text, no element created', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'look at this', 'u1:0', [])],
  });
  fake.body = (stepId) => ({ text: '<img src=x onerror=alert(1)>', truncated: false, size: 10 });
  const page = await openPage(A);
  const s = await page.until((x) => x.youText && x.youText.length > 0, 'the you message to render');
  assert.ok(s.youText.indexOf('<img') !== -1, 'the tag shows as literal text');
  assert.equal(s.imgCount, 0, 'no img element was created from the body text');
  await page.close();
});

test('page: a markdown link click sends openLink, never navigates', opts, async () => {
  fake.open = () => openReply({
    steps: [step('a1:0', 'text')],
    sections: [section('lead', 'Session start', null, [{ kind: 'text', stepId: 'a1:0' }])],
  });
  fake.body = (stepId) => ({ text: 'see [the doc](https://example.invalid/doc) for details', truncated: false, size: 10 });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  await page.eval('window.__openLinkCalls = 0; var orig = dispatchLink; dispatchLink = function (k, t) { window.__openLinkCalls++; return orig(k, t); };');
  await page.until((x) => x.lnkCount > 0, 'the markdown link to render once the body batch lands');
  await page.click('a.lnk');
  const s = await page.until((x) => x.openLinkCalls > 0, 'the link click to call dispatchLink');
  assert.ok(s.openLinkCalls > 0);
  await page.close();
});

// -- large session responsiveness ---------------------------------------------------------

test('page: a 3,000-step fake session stays responsive with a bounded DOM node count', opts, async () => {
  const steps = [];
  const sections = [section('lead', 'Session start', null, [])];
  for (let i = 0; i < 3000; i++) {
    const id = 'u' + i + ':0';
    steps.push(step(id, 'you'));
    sections.push(section('you', 'turn ' + i, id, []));
  }
  fake.open = () => openReply({ steps, sections, strip: { totalTimeMs: 600000, sections: sections.length, decisions: sections.length - 1, filesChanged: 0 } });
  const page = await openPage(A);
  const s = await page.until((x) => x.sectionHeadings.length > 0, 'the rail to render');
  assert.ok(s.domRowCount < 500, 'only sections near the anchor hold full row DOM, got ' + s.domRowCount);
  await page.close();
}, { timeout: 30000 });

// -- narrow layout -------------------------------------------------------------------------

test('page: the narrow layout shows the outline drawer toggle', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first', 'u1:0', [])],
  });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:' + PORT + '/steps?session=' + A });
  const { sessionId: cdpSessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, cdpSessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: true }, cdpSessionId);
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, cdpSessionId);
    if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  };
  let sample = null;
  const start = Date.now();
  while (Date.now() - start < 8000) {
    try { sample = await ev(SAMPLE); if (sample.drawerVisible) break; } catch (_) { /* page still loading */ }
    await sleep(150);
  }
  assert.ok(sample, 'the page rendered within the timeout');
  assert.equal(sample.drawerVisible, true, 'the rail-toggle bar is visible at a narrow width');
  await cdp.send('Target.closeTarget', { targetId });
});

test.after(() => {});
