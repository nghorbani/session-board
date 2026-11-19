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
const host = require('./shim/host.cjs');   // first: it points `vscode` at the stub before the host loads
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { browser, freePort, startChrome } = require('../../tools/chrome.cjs');
const chromeLock = require('./shim/chrome-lock.cjs');
const { createStepsService } = require('../steps-service.cjs');

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
    strip: { activeTimeMs: 60000, sections: 1, decisions: 0, filesChanged: 0 },
    notes: [],
  }, overrides || {});
}

// -- fake API ------------------------------------------------------------------------------

let noteSeq = 0;
const fake = {
  open: () => openReply(),
  body: (stepId) => ({ text: 'body of ' + stepId, truncated: false, size: 10 }),
  bodies: (ids) => ids.map((id) => Object.assign({ stepId: id }, fake.body(id))),
  search: () => ({ stepIds: [], capped: false }),
  seen: () => ({ ok: true }),
  // a scripted deliver outcome for noteSend/notesSendAll: { ok, message, text } the same shape
  // steps-service answers with, so the page suite can drive both a successful hand-over and the
  // browser's own copy-only reply without a real transport.
  deliver: () => ({ ok: true, message: 'In the chat box and on the clipboard.' }),
  calls: [],
  pushes: [], // queued push messages the poll route drains in order
  notes: new Map(), // noteId -> { id, stepId, at, text, sent: [] }
};

/* A minimal in-memory stand-in for notes.cjs, just enough for the page suite to drive a real
   add/edit/delete round trip the way the real service answers it (typed result plus the open
   reply and notesChanged carrying the full list), without touching a real data directory. */
function noteList() { return [...fake.notes.values()].sort((a, b) => a.at - b.at); }
function handleNoteMessage(msg) {
  // a scripted refusal of a save, with the reason the real store would give
  if (fake.noteReject && (msg.type === 'noteAdd' || msg.type === 'noteEdit')) return { type: msg.type + 'Result', ok: false, message: fake.noteReject };
  if (msg.type === 'noteAdd') {
    const id = 'note-' + (++noteSeq);
    const note = { id, stepId: msg.stepId, at: Date.now(), text: msg.text, sent: [] };
    fake.notes.set(id, note);
    return { type: 'noteAddResult', ok: true, note };
  }
  if (msg.type === 'noteEdit') {
    const note = fake.notes.get(msg.noteId);
    if (!note) return { type: 'noteEditResult', ok: false, message: 'that note is gone' };
    note.text = msg.text;
    return { type: 'noteEditResult', ok: true, note };
  }
  if (msg.type === 'noteDelete') {
    const removed = fake.notes.delete(msg.noteId);
    return { type: 'noteDeleteResult', ok: true, removed };
  }
  if (msg.type === 'noteSend') {
    const note = fake.notes.get(msg.noteId);
    if (!note) return { type: 'noteSendResult', ok: false, message: 'that note is gone' };
    const d = fake.deliver();
    const text = 'About your step at 00:00 ("x"): ' + note.text;
    if (d.ok) note.sent = (note.sent || []).concat([{ kind: 'steer', at: Date.now() }]);
    return { type: 'noteSendResult', ok: d.ok, noteId: note.id, text, message: d.message };
  }
  if (msg.type === 'notesSendAll') {
    const list = noteList();
    if (!list.length) return { type: 'notesSendAllResult', ok: false, message: 'no notes to send' };
    const d = fake.deliver();
    const text = list.map((n) => 'About your step at 00:00 ("x"): ' + n.text).join('\n\n');
    if (d.ok) for (const n of list) n.sent = (n.sent || []).concat([{ kind: 'steer', at: Date.now() }]);
    return { type: 'notesSendAllResult', ok: d.ok, text, message: d.message };
  }
  return null;
}
let PORT = 0;

function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { resolve(null); } });
  });
}

// The page as VS Code serves it (the panel's own html), with a stand-in for acquireVsCodeApi
// that carries postMessage both ways over HTTP: what the page posts reaches the panel's
// message handler in extension.js, and what the host posts to the panel reaches the page.
// The panel's content policy is left out, since it allows no connection at all.
const WEBVIEW_BRIDGE = '<script>'
  + 'window.acquireVsCodeApi = function () { return { postMessage: function (m) { fetch("/api/webview", { method: "POST", body: JSON.stringify(m) }); } }; };'
  + 'var __wvAfter = 0; setInterval(function () { fetch("/api/webview/poll?after=" + __wvAfter).then(function (r) { return r.json(); }).then(function (res) {'
  + ' __wvAfter = res.seq; res.messages.forEach(function (m) { window.postMessage(m, "*"); }); }).catch(function () {}); }, 60);'
  + '</scr' + 'ipt>';

async function serve(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (fake.panel && u.pathname === '/steps-webview') {
    const html = fake.panel.webview.html
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
      .replace('<meta charset="utf-8">', '<meta charset="utf-8">' + WEBVIEW_BRIDGE)
      .replace('function flashNotice(text) {', 'function flashNotice(text) { (window.__notices = window.__notices || []).push(text);');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (fake.panel && u.pathname === '/api/webview' && req.method === 'POST') {
    fake.panel.__fireMessage(await readBody(req));
    return json(res, 200, {});
  }
  if (fake.panel && u.pathname === '/api/webview/poll') {
    const after = Number(u.searchParams.get('after') || 0);
    return json(res, 200, { seq: fake.panel.__posted.length, messages: fake.panel.__posted.slice(after) });
  }
  if (u.pathname === '/steps') {
    const sessionId = u.searchParams.get('session') || '';
    const html = STEPS_HTML
      .replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="board-token" content="' + TOKEN + '"><meta name="steps-session" content="' + sessionId + '">')
      .replace('var POLL_MS = 1200;', 'var POLL_MS = 120;')
      .replace('var SEEN_DEBOUNCE_MS = 1500;', 'var SEEN_DEBOUNCE_MS = 200;')
      .replace('var SEARCH_DEBOUNCE_MS = 150;', 'var SEARCH_DEBOUNCE_MS = 30;')
      .replace('var BODY_RETRY_MS = 2000;', 'var BODY_RETRY_MS = 250;')
      // every notice the page showed, kept for the sampler: a timeout then says what the page saw
      .replace('function flashNotice(text) {', 'function flashNotice(text) { (window.__notices = window.__notices || []).push(text);');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (u.pathname === '/api/steps/poll') {
    if (req.headers['x-board-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
    // what server.cjs answers once it has let go of a viewer that stopped asking
    if (fake.expireOnce) { fake.expireOnce = false; return json(res, 200, { expired: true, seq: 0, pushes: [] }); }
    const after = Number(u.searchParams.get('after') || 0);
    const items = fake.pushes.slice(after);
    return json(res, 200, { seq: fake.pushes.length, pushes: items });
  }
  if (u.pathname === '/api/steps' && req.method === 'POST') {
    if (req.headers['x-board-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
    const msg = await readBody(req);
    fake.calls.push(msg);
    if (!msg) return json(res, 400, { error: 'bad json' });
    // a connection that dies under a request: what a browser sees when it reuses an idle
    // socket the server is closing at that moment
    if (fake.dropOnce && fake.dropOnce === msg.type) { fake.dropOnce = null; req.socket.destroy(); return; }
    // the same, for as long as a test leaves it set: a server that is away for a while
    if (fake.dropAll && fake.dropAll === msg.type) { req.socket.destroy(); return; }
    // a test may put the real steps service behind this transport, so the page is fed by the
    // real reader and not by a scripted reply
    if (fake.service) return json(res, 200, await fake.service.handle(msg));
    if (msg.type === 'open') {
      const base = fake.open();
      const notes = base.notes && base.notes.length ? base.notes : noteList();
      return json(res, 200, Object.assign({ requestId: msg.requestId }, base, { notes }));
    }
    if (msg.type === 'body') return json(res, 200, Object.assign({ type: 'bodyResult', sessionId: msg.sessionId, stepId: msg.stepId }, fake.body(msg.stepId)));
    if (msg.type === 'bodies') return json(res, 200, { type: 'bodiesResult', sessionId: msg.sessionId, generation: msg.generation, items: await fake.bodies(msg.stepIds || [], msg) });
    if (msg.type === 'search') return json(res, 200, Object.assign({ type: 'searchResult', requestId: msg.requestId, query: msg.query }, await fake.search(msg.query)));
    if (msg.type === 'seen') return json(res, 200, Object.assign({ type: 'seenResult' }, fake.seen(msg.stepId)));
    if (msg.type === 'openLink') return json(res, 200, { type: 'openLinkResult', ok: false, notAvailable: true });
    if (msg.type === 'openText') {
      // a test may let something happen between this request and its answer
      if (fake.beforeOpenTextReply) await fake.beforeOpenTextReply();
      return json(res, 200, { type: 'openTextResult', notAvailable: true });
    }
    if (msg.type === 'fullText') return json(res, 200, Object.assign({ type: 'fullTextResult', stepId: msg.stepId }, fake.fullText(msg.stepId, msg)));
    if (msg.type === 'noteAdd' || msg.type === 'noteEdit' || msg.type === 'noteDelete' || msg.type === 'noteSend' || msg.type === 'notesSendAll') {
      const reply = handleNoteMessage(msg);
      fake.pushes.push({ type: 'notesChanged', sessionId: msg.sessionId, notes: noteList() });
      return json(res, 200, reply);
    }
    return json(res, 200, { type: 'errorResult' });
  }
  return json(res, 404, { error: 'not found' });
}

// -- Chrome over the DevTools protocol (same harness as page.test.cjs) ---------------------

let server = null;
let cdp = null;   // { send, close } of the browser started by tools/chrome.cjs

test.before(async () => {
  if (!CHROME) return;
  await chromeLock.acquire(); // page.test.cjs drives its own Chrome too; one at a time keeps both off a shared CPU budget
  PORT = await freePort();
  server = http.createServer((req, res) => { serve(req, res).catch((e) => json(res, 500, { error: String(e) })); });
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
  var text = function (sel) { var e = document.querySelector(sel); return e ? e.textContent : null; };
  return {
    title: text('#title'),
    sub: text('#sub'),
    error: text('.error-state'),
    stripNums: q('.strip .item').map(function (i) { return (i.querySelector('.lbl') || {}).textContent + '=' + (i.querySelector('.num') || {}).textContent; }),
    timeTileTitle: (function () { var t = q('.strip .item')[0]; return t ? t.getAttribute('title') : null; })(),
    sectionHeadings: q('.sec-entry .txt').map(function (e) { return e.textContent; }),
    rowKinds: q('.row[data-step]').map(function (r) { return r.className; }),
    youText: text('.row.k-you .you-msg'),
    qOptions: q('.qopt').map(function (o) { return { label: (o.querySelector('.qopt-label') || {}).textContent, chosen: o.classList.contains('chosen'), tag: !!o.querySelector('.qopt-tag') }; }),
    decisionsOn: !!document.getElementById('decisions').classList.contains('on'),
    filesTileNum: (function () { var t = q('.strip .item')[3]; return t ? t.querySelector('.num').textContent : null; })(),
    fileLinks: q('.fp, .filerow a.lnk').map(function (a) { return a.textContent; }),
    searchCount: text('#count'),
    curHitText: (function () { var e = document.querySelector('.cur-hit'); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })(),
    curHitId: (function () { var e = document.querySelector('.cur-hit'); return e ? e.id : null; })(),
    newMarker: !!document.querySelector('.new-marker'),
    atBottom: (function () { var r = document.getElementById('reader'); return r.scrollTop + r.clientHeight >= r.scrollHeight - 20; })(),
    scrollTop: document.getElementById('reader').scrollTop,
    imgCount: q('img').length,
    drawerVisible: (function () { var el = document.getElementById('railToggle'); return getComputedStyle(el).display !== 'none'; })(),
    railOpen: document.getElementById('rail').classList.contains('open'),
    jumpToStartButtons: q('button').filter(function (b) { return b.textContent === 'Jump to the start'; }).length,
    jumpToStartInRail: q('#rail button').filter(function (b) { return b.textContent === 'Jump to the start'; }).length,
    domRowCount: q('.row, .sec-stub').length,
    openLinkCalls: window.__openLinkCalls || 0,
    lnkCount: q('a.lnk').length,
    workSums: q('.worksum').map(function (e) { return e.textContent; }),
    notices: window.__notices || [],
    secLabels: q('.sec-head .lbl').map(function (e) { return e.textContent; }),
    rowTimes: q('.row .meta .time').map(function (e) { return e.textContent; }),
    bodyTexts: q('.row .body.md').map(function (e) { return e.textContent; }),
    // rows of the story that the reader's viewport shows at least a part of
    rowsInView: (function () {
      var r = document.getElementById('reader').getBoundingClientRect();
      return q('.row[data-step]').filter(function (row) { var b = row.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; }).length;
    })(),
    // the text rows inside the reader's viewport, and how many of them hold their full text
    textsInView: (function () {
      var r = document.getElementById('reader').getBoundingClientRect();
      var total = 0, loaded = 0;
      q('.row.k-claude [data-step-body]').forEach(function (node) {
        var b = node.getBoundingClientRect();
        if (b.bottom <= r.top || b.top >= r.bottom) return;
        total++;
        if (state.bodies[node.getAttribute('data-step-body')]) loaded++;
      });
      return { total: total, loaded: loaded };
    })(),
    mdMarks: q('.row .body.md b, .row .body.md .li').length,
    facts: q('.facts').map(function (e) { return e.textContent; }),
    restateCount: q('.row.k-you .restate').length,
    youMsgCount: q('.row.k-you .you-msg').length,
    youMsgOpen: !!document.querySelector('.row.k-you .you-msg.open'),
    showAllYou: !!document.querySelector('.row.k-you .showall'),
    indexNoteShown: document.getElementById('indexnote').classList.contains('show'),
    notesTileNum: (function () { var t = q('.strip .item')[4]; return t ? t.querySelector('.num').textContent : null; })(),
    notesTileOn: (function () { var t = q('.strip .item')[4]; return t ? t.classList.contains('on') : false; })(),
    notesJumpLabel: text('#notesJump'),
    addNoteButtons: q('.add-note').map(function (b) { return b.textContent; }),
    notedRows: q('.row.noted').length,
    noteBoxOpen: !!document.querySelector('.notebox'),
    noteBoxText: (function () { var t = document.querySelector('.notebox textarea'); return t ? t.value : null; })(),
    savedNoteText: (function () { var e = document.querySelector('.saved-note'); return e ? e.textContent : null; })(),
    savedNoteOffPath: !!document.querySelector('.saved-note .off-path'),
    savedNoteSentText: (function () { var e = document.querySelector('.saved-note .sent-mark'); return e ? e.textContent : null; })(),
    noteMarkCount: q('.sec-entry .note-mark').length,
    allNotesBarShown: document.getElementById('allNotesBar').classList.contains('show'),
    noticeText: (function () { var e = document.getElementById('indexnote'); return e && e.classList.contains('show') ? e.textContent : null; })(),
    sendAllBusy: (function () { var b = document.getElementById('sendAllNotes'); return b ? b.disabled : null; })(),
    sendButtonDisabled: (function () { var b = document.querySelector('.notebox .row2 button.primary'); return b ? b.disabled : null; })(),
    allNotesBarText: text('#allNotesN'),
    emptyStateText: text('.empty-state'),
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
      while (Date.now() - start < 20000) { try { s = await ev(SAMPLE); if (pred(s)) return s; } catch (_) { /* page still loading */ } await sleep(100); }
      throw new Error('timed out waiting for ' + what + '; last sample: ' + JSON.stringify(s));
    },
    close: () => cdp.send('Target.closeTarget', { targetId }),
  };
  return page;
}

test.beforeEach(() => {
  fake.calls.length = 0; fake.pushes.length = 0;
  fake.open = () => openReply();
  fake.body = (stepId) => ({ text: 'body of ' + stepId, truncated: false, size: 10 });
  fake.bodies = (ids) => ids.map((id) => Object.assign({ stepId: id }, fake.body(id)));
  fake.search = () => ({ stepIds: [], capped: false });
  fake.deliver = () => ({ ok: true, message: 'In the chat box and on the clipboard.' });
  fake.notes.clear();
  fake.dropOnce = null;
  fake.dropAll = null;
  fake.fullText = (stepId) => ({ ok: true, text: 'the whole text of ' + stepId });
  fake.beforeOpenTextReply = null;
  fake.noteReject = null;
  fake.expireOnce = false;
});

// -- transport ------------------------------------------------------------------------------

test('page: a read request whose connection dies is sent once more, so the first paint still arrives', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', [])],
  });
  fake.dropOnce = 'open';
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 2, 'first paint after one dropped request');
  assert.equal(fake.calls.filter((m) => m && m.type === 'open').length, 2, 'open went out twice: the dropped one and the retry');
  await page.close();
});

// -- first paint ----------------------------------------------------------------------------

test('page: first paint from an open reply shows the title and the strip', opts, async () => {
  fake.open = () => openReply({
    title: 'My plan session',
    steps: [step('u1:0', 'you', { preview: 'please build the thing' })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'please build the thing', 'u1:0', []),
    ],
    strip: { activeTimeMs: 125000, sections: 2, decisions: 1, filesChanged: 0 },
  });
  const page = await openPage(A);
  const s = await page.until((x) => x.title === 'My plan session', 'the title to render');
  assert.ok(s.stripNums.some((n) => n.indexOf('Sections=2') !== -1));
  assert.ok(s.sectionHeadings.some((h) => h.indexOf('please build the thing') !== -1));
  assert.equal(s.jumpToStartButtons, 1, 'one "Jump to the start" control, no floating pill over the search box');
  assert.equal(s.jumpToStartInRail, 1, 'it lives in the outline');
  await page.close();
});

test('page: the first tile is labelled Active time, with a tooltip explaining the 10-minute cap', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first', 'u1:0', [])],
    strip: { activeTimeMs: 3600000, wallClockMs: 7200000, sections: 1, decisions: 0, filesChanged: 0 },
  });
  const page = await openPage(A);
  const s = await page.until((x) => x.stripNums.length > 0, 'the strip to render');
  assert.ok(s.stripNums.some((n) => n.indexOf('Active time=') !== -1), 'the tile reads "Active time": ' + JSON.stringify(s.stripNums));
  assert.equal(s.stripNums.some((n) => n.indexOf('Total time=') !== -1), false, 'the old "Total time" label is gone');
  assert.ok(s.timeTileTitle && s.timeTileTitle.indexOf('each pause counted up to 10 minutes') !== -1, 'the tooltip states the cap: ' + s.timeTileTitle);
  assert.ok(s.timeTileTitle && s.timeTileTitle.indexOf('From first to last step') !== -1, 'the tooltip still gives the wall-clock span: ' + s.timeTileTitle);
  await page.close();
});

test('page: a question card shows every option and marks the chosen ones', opts, async () => {
  fake.open = () => openReply({
    steps: [step('q1:0', 'question')],
    sections: [
      section('lead', 'Session start', null, []),
      section('question', 'Option A', 'q1:0', []),
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

test('page: fed by the real reader and service, an answered question is a "Question and answer" section with its full card, and the Decisions switch keeps it', opts, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-steps-real-'));
  const file = path.join(dir, 'real.jsonl');
  const u = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const at = (sec) => new Date(2026, 0, 1, 10, 0, sec).toISOString();
  const lines = [
    { type: 'user', uuid: u(1), parentUuid: null, timestamp: at(1), message: { role: 'user', content: 'please build the thing' } },
    { type: 'assistant', uuid: u(2), parentUuid: u(1), timestamp: at(2), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'ask1', name: 'AskUserQuestion',
      input: { questions: [{ header: 'Approach', question: 'Which way should we go?', multiSelect: false,
        options: [{ label: 'Option A', description: 'the simple route' }, { label: 'Option B', description: 'the thorough route' }] }] } }] } },
    { type: 'user', uuid: u(3), parentUuid: u(2), timestamp: at(3), toolUseResult: {}, sourceToolAssistantUUID: u(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask1', content: 'Your questions have been answered: "Which way should we go?"="Option A". You can now continue.' }] } },
    { type: 'assistant', uuid: u(4), parentUuid: u(3), timestamp: at(4), message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Going with A.' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
  fake.service = createStepsService({ resolveTranscript: () => file, sessionTitle: () => 'Real reader', dataDir: dir, setInterval: () => 0, clearInterval: () => {} });
  try {
    const page = await openPage(A);
    const s = await page.until((x) => x.qOptions.length === 2, 'the question card to render in the section its answer opened');
    assert.equal(s.qOptions.find((o) => o.label === 'Option A').chosen, true, 'the chosen option is marked');
    assert.ok(s.secLabels.some((l) => l.indexOf('Question and answer') === 0), 'the section is labelled Question and answer: ' + JSON.stringify(s.secLabels));
    assert.ok(s.stripNums.includes('Decisions=2'), 'the message and the answer both count as decisions: ' + JSON.stringify(s.stripNums));
    await page.click('.strip .item:nth-child(3)');
    const d = await page.until((x) => x.decisionsOn, 'the Decisions switch to turn on');
    assert.ok(d.sectionHeadings.some((h) => h.indexOf('Option A') !== -1), 'the answered question stays under Decisions: ' + JSON.stringify(d.sectionHeadings));
    assert.ok(d.sectionHeadings.some((h) => h.indexOf('please build the thing') !== -1));
    await page.close();
  } finally {
    fake.service = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A transcript written to a temp dir and the real steps service over it, put behind the fake
// transport: the page is fed by the real reader, and the service's pushes reach the poll route.
function realService(lines, extraDeps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-steps-real-'));
  const file = path.join(dir, 'real.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
  const ticks = [];
  const svc = createStepsService(Object.assign({
    resolveTranscript: () => file, sessionTitle: () => 'Real reader', dataDir: dir,
    setInterval: (fn) => { ticks.push(fn); return ticks.length; }, clearInterval: () => {},
  }, extraDeps));
  svc.subscribe(A, (msg) => fake.pushes.push(msg));
  fake.service = svc;
  return {
    file,
    tick: async () => { for (const fn of ticks) await fn(); },
    done: () => { fake.service = null; fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const ru = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const rat = (sec) => new Date(2026, 0, 1, 10, Math.floor(sec / 60), sec % 60).toISOString();
const rUser = (n, text) => ({ type: 'user', uuid: ru(n), parentUuid: n === 1 ? null : ru(n - 1), timestamp: rat(n), message: { role: 'user', content: text } });
const rText = (n, text) => ({ type: 'assistant', uuid: ru(n), parentUuid: ru(n - 1), timestamp: rat(n), message: { id: 'm' + n, role: 'assistant', content: [{ type: 'text', text }] } });
const rBash = (n, id) => ({ type: 'assistant', uuid: ru(n), parentUuid: ru(n - 1), timestamp: rat(n), message: { id: 'm' + n, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', description: 'run the tests' } }] } });
const rResult = (n, id) => ({ type: 'user', uuid: ru(n), parentUuid: ru(n - 1), timestamp: rat(n), toolUseResult: {}, sourceToolAssistantUUID: ru(n - 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('page: sections the index reaches after the first paint show in the outline, their rows drawn with time and Work text (real reader, small chunks)', opts, async () => {
  const lines = [];
  for (let turn = 0; turn < 10; turn++) {
    const n = turn * 4 + 1;
    lines.push(rUser(n, 'turn ' + (turn + 1)), rBash(n + 1, 'b' + turn), rResult(n + 2, 'b' + turn), rText(n + 3, 'answer ' + (turn + 1) + ' '.repeat(1500)));
  }
  const real = realService(lines, { chunkBytes: 4096, tailBytes: 4096, progressIntervalMs: 0 });
  try {
    const page = await openPage(A, '/steps?session=' + A + '&top=1');
    const s = await page.until((x) => x.sectionHeadings.length === 10 && x.workSums.length === 10, 'all ten sections in the outline and in the reader');
    assert.equal(s.sectionHeadings[0], 'turn 1', 'the earliest section leads the outline');
    assert.ok(s.rowTimes.length >= 10 && s.rowTimes.every((t) => /^\d\d:\d\d:\d\d$/.test(t)), 'every text row carries its time: ' + JSON.stringify(s.rowTimes));
    assert.ok(s.workSums.every((w) => w.indexOf('run the tests') !== -1), 'every Work line says what was done: ' + JSON.stringify(s.workSums));
    await page.close();
  } finally { real.done(); }
});

test('page: a step that arrives while following is drawn with its time and its Work text (real reader)', opts, async () => {
  const real = realService([rUser(1, 'start'), rText(2, 'first answer')]);
  try {
    const page = await openPage(A);
    await page.until((x) => x.rowTimes.length === 1, 'first paint');
    fs.appendFileSync(real.file, [rBash(3, 'b1'), rResult(4, 'b1'), rText(5, 'second answer')].map((l) => JSON.stringify(l) + '\n').join(''));
    await real.tick();
    const s = await page.until((x) => x.rowTimes.length === 3 && x.workSums.length === 1, 'the appended Work line and text (two text rows and the Work line carry a time)');
    assert.ok(s.rowTimes.every((t) => /^\d\d:\d\d:\d\d$/.test(t)), 'the new text row carries its time: ' + JSON.stringify(s.rowTimes));
    assert.ok(s.workSums[0].indexOf('run the tests') !== -1, 'the new Work line says what was done: ' + JSON.stringify(s.workSums));
    await page.close();
  } finally { real.done(); }
});

test('page: an answer that arrives for a question already on screen is marked on its card, without a reload (real reader)', opts, async () => {
  const ask = { type: 'assistant', uuid: ru(2), parentUuid: ru(1), timestamp: rat(2), message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'ask1', name: 'AskUserQuestion',
    input: { questions: [{ header: 'Approach', question: 'Which way should we go?', multiSelect: false, options: [{ label: 'Option A', description: 'the simple route' }, { label: 'Option B', description: 'the thorough route' }] }] } }] } };
  const answer = { type: 'user', uuid: ru(3), parentUuid: ru(2), timestamp: rat(3), toolUseResult: {}, sourceToolAssistantUUID: ru(2),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask1', content: 'Your questions have been answered: "Which way should we go?"="Option B". You can now continue.' }] } };
  const real = realService([rUser(1, 'start'), ask]);
  try {
    const page = await openPage(A);
    let s = await page.until((x) => x.qOptions.length === 2, 'the open question with both options');
    assert.equal(s.qOptions.some((o) => o.chosen), false, 'nothing is chosen while the question waits');
    fs.appendFileSync(real.file, JSON.stringify(answer) + '\n');
    await real.tick();
    s = await page.until((x) => x.qOptions.some((o) => o.label === 'Option B' && o.chosen), 'the answer marked on the card');
    assert.ok(s.secLabels.some((l) => l.indexOf('Question and answer') === 0), 'the answer opens its section: ' + JSON.stringify(s.secLabels));
    assert.ok(s.stripNums.indexOf('Decisions=2') !== -1, 'and counts as a decision: ' + JSON.stringify(s.stripNums));
    await page.close();
  } finally { real.done(); }
});

const rEdit = (n, id, file) => ({ type: 'assistant', uuid: ru(n), parentUuid: ru(n - 1), timestamp: rat(n), message: { id: 'm' + n, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] } });

test('page: a live update refreshes the tiles, and with Files changed open it adds to the file list instead of drawing the story over it (real reader)', opts, async () => {
  const real = realService([rUser(1, 'start'), rEdit(2, 'e1', 'C:\\proj\\first.js'), rResult(3, 'e1'), rText(4, 'first answer')]);
  try {
    const page = await openPage(A);
    let s = await page.until((x) => x.stripNums.indexOf('Sections=1') !== -1 && x.stripNums.indexOf('Files changed=1') !== -1, 'the tiles of the first paint');
    await page.click('.strip .item:nth-child(4)');
    s = await page.until((x) => x.fileLinks.length === 1 && x.rowKinds.length === 0, 'the Files changed view');
    fs.appendFileSync(real.file, [rUser(5, 'next'), rEdit(6, 'e2', 'C:\\proj\\second.js'), rResult(7, 'e2'), rText(8, 'second answer')].map((l) => JSON.stringify(l) + '\n').join(''));
    await real.tick();
    s = await page.until((x) => x.stripNums.indexOf('Sections=2') !== -1, 'the Sections tile to count the new section');
    assert.ok(s.stripNums.indexOf('Files changed=2') !== -1, 'the Files changed tile counts the new file: ' + JSON.stringify(s.stripNums));
    s = await page.until((x) => x.fileLinks.length === 2, 'the new file in the list');
    assert.equal(s.rowKinds.length, 0, 'the story is not drawn over the file list');
    assert.ok(s.fileLinks.some((f) => f.indexOf('second.js') !== -1), JSON.stringify(s.fileLinks));
    await page.close();
  } finally { real.done(); }
});

test('page: scrolled to the middle of a long session, the texts in view load in full (real reader)', opts, async () => {
  const lines = [];
  for (let turn = 0; turn < 150; turn++) {
    const n = turn * 4 + 1;
    lines.push(rUser(n, 'turn ' + (turn + 1)), rBash(n + 1, 'b' + turn), rResult(n + 2, 'b' + turn),
      rText(n + 3, '**Answer ' + (turn + 1) + '.** ' + 'More words of this answer, well past a preview. '.repeat(12)));
  }
  const real = realService(lines);
  try {
    const page = await openPage(A);
    await page.until((x) => x.sectionHeadings.length === 150, 'the whole outline');
    const height = await page.eval('document.getElementById("reader").scrollHeight');
    await page.scroll(Math.floor(height / 2));
    const s = await page.until((x) => x.textsInView.total > 0 && x.textsInView.loaded === x.textsInView.total, 'every text in view to hold its full text');
    assert.ok(s.scrollTop > 2000, 'the reader is far from the top: ' + s.scrollTop);
    assert.ok(s.bodyTexts.some((t) => t.length > 400), 'a text in the page is longer than a preview');
    await page.close();
  } finally { real.done(); }
});

// -- the VS Code transport: page, host code, service and reader together --------------------

const LONG_ANSWER = 'Yes. The workflow is running again.\n\n**Done:**\n\n- The classifier spec is written.\n- The detector spec got its fix.\n\n'
  + 'Still to come: the overview, then the critic. '.repeat(6) + 'That is the end of the answer.';

test('page in the VS Code panel: texts load in full and formatted, question cards fill, a note is kept and sent, and a step that arrives while following loads too', opts, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-steps-webview-'));
  const file = path.join(dir, A + '.jsonl');
  const ask = { type: 'assistant', uuid: ru(3), parentUuid: ru(2), timestamp: rat(3), message: { id: 'm3', role: 'assistant', content: [{ type: 'tool_use', id: 'ask1', name: 'AskUserQuestion',
    input: { questions: [{ header: 'Approach', question: 'Which way should we go?', multiSelect: false, options: [{ label: 'Option A', description: 'the simple route' }, { label: 'Option B', description: 'the thorough route' }] }] } }] } };
  const answer = { type: 'user', uuid: ru(4), parentUuid: ru(3), timestamp: rat(4), toolUseResult: {}, sourceToolAssistantUUID: ru(3),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask1', content: 'Your questions have been answered: "Which way should we go?"="Option A". You can now continue.' }] } };
  const withLink = LONG_ANSWER + '\n\nThe notes are on [the share](//fileserver/share/notes.md).';
  fs.writeFileSync(file, [rUser(1, 'how is it going?'), rText(2, withLink), ask, answer, rText(5, 'Going with A.')].map((l) => JSON.stringify(l) + '\n').join(''));
  const { provider } = host.boot({
    transcriptIndex: () => new Map([[A, file]]),
    transcriptFacts: () => ({ tokens: null, title: 'Webview session', customTitle: null, lastPrompt: null }),
  }, { last: { sessions: [], ended: [], limits: {}, usage: null } });
  await provider.onMessage({ type: 'steps', sessionId: A });
  fake.panel = host.vscode.__panels[0];
  try {
    assert.ok(LONG_ANSWER.length > 300, 'the answer is longer than a preview');
    const page = await openPage(A, '/steps-webview');
    // texts: the whole answer, rendered, not the first 200 characters of its source
    let s = await page.until((x) => x.bodyTexts.some((t) => t.indexOf('That is the end of the answer.') !== -1), 'the long answer in full');
    assert.ok(s.mdMarks >= 3, 'bold and list items are rendered: ' + s.mdMarks);
    assert.equal(s.bodyTexts.some((t) => t.indexOf('**Done:**') !== -1), false, 'no raw Markdown left in the row');
    // the question as it was asked
    s = await page.until((x) => x.qOptions.length === 2, 'the question card with both options');
    assert.equal(s.qOptions.find((o) => o.label === 'Option A').chosen, true);
    // a link the host will not open: the page shows the reason the host gave
    await page.eval('(function () { var a = Array.prototype.filter.call(document.querySelectorAll("a.lnk"), function (e) { return e.textContent === "the share"; })[0]; a.click(); })()');
    s = await page.until((x) => x.notices.some((n) => n.indexOf('Network paths are not opened from here') !== -1), 'the reason the host gave for not opening the link');
    assert.ok(host.vscode.__clipboard.some((t) => t.indexOf('fileserver') !== -1), 'the refused path is on the clipboard');
    // a note: Keep note closes the box and shows the note
    const firstText = await page.eval('document.querySelector(".row.k-claude").getAttribute("data-step")');
    await page.eval('(function () { document.getElementById("step-' + firstText + '").querySelector(".add-note").click(); })()');
    await page.until((x) => x.noteBoxOpen, 'the note box');
    await page.eval('(function () { var ta = document.querySelector(".notebox textarea"); ta.value = "check this"; ta.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await page.click('.notebox .row2 button:first-child');
    s = await page.until((x) => !x.noteBoxOpen && x.savedNoteText && x.savedNoteText.indexOf('check this') !== -1, 'the kept note under its step');
    // Send to session: the text reaches the clipboard and the page says what happened
    await page.eval('(function () { document.getElementById("step-' + firstText + '").querySelector(".add-note").click(); })()');
    await page.until((x) => x.noteBoxOpen, 'the note box again');
    const noticesBefore = s.notices.length;
    await page.click('.notebox .row2 button.primary');
    s = await page.until((x) => x.notices.length > noticesBefore, 'the line that says where the note went');
    assert.ok(host.vscode.__clipboard.some((t) => t.indexOf('About your step at') === 0 && t.indexOf('check this') !== -1), 'the hand-over text is on the clipboard');
    // follow: with Follow on, a long answer that arrives now is brought into view and loads in
    // full, without a scroll by hand
    await page.eval('(function () { var f = document.getElementById("follow"); if (!f.checked) f.click(); return true; })()');
    fs.appendFileSync(file, [rUser(6, 'and now?'), rText(7, LONG_ANSWER.replace('That is the end of the answer.', 'That is the end of the second answer.'))].map((l) => JSON.stringify(l) + '\n').join(''));
    s = await page.until((x) => x.bodyTexts.some((t) => t.indexOf('That is the end of the second answer.') !== -1), 'the answer that arrived while following, in full');
    await page.close();
  } finally {
    fake.panel.dispose();
    fake.panel = null;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('page: a cancelled-turn marker shows as a quiet line inside its section, not a you row', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('u2:0', 'interrupted'), step('u3:0', 'you')],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'start the long task', 'u1:0', [{ kind: 'interrupted', stepId: 'u2:0' }]),
      section('you', 'actually do something else', 'u3:0', []),
    ],
  });
  const page = await openPage(A);
  const s = await page.until((x) => x.sectionHeadings.length >= 2, 'the outline to render');
  assert.equal(s.sectionHeadings.some((h) => h.indexOf('Interrupted') !== -1), false, 'the marker never becomes a section heading');
  const row = await page.eval('(function () { var r = document.getElementById("step-u2:0"); return r ? r.className : null; })()');
  assert.equal(row, 'row k-interrupted', 'rendered as its own quiet kind, not a you row');
  const text = await page.eval('(function () { var r = document.getElementById("step-u2:0"); return r ? r.textContent.trim() : null; })()');
  assert.equal(text, 'Interrupted');
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
    strip: { activeTimeMs: 1000, sections: 3, decisions: 2, filesChanged: 0 },
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 2, 'the outline to render');
  await page.click('#decisions');
  const s = await page.until((x) => x.decisionsOn === true, 'the decisions lens to switch on');
  assert.ok(s.sectionHeadings.every((h) => h !== 'Session start'));
  await page.close();
});

test('page: under Decisions a section shows what you said and decided (the message, questions, plans), not the texts and Work lines between', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('x1:0', 'text'), step('t1:0', 'tool', { title: 'Bash' }), step('p1:0', 'plan'), step('x2:0', 'text')],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'make a plan', 'u1:0', [{ kind: 'text', stepId: 'x1:0' }, { kind: 'work', items: ['t1:0'] }, { kind: 'plan', stepId: 'p1:0' }, { kind: 'text', stepId: 'x2:0' }],
        { activeTimeMs: 120000, toolCalls: 1, filesChanged: 0 }),
    ],
    strip: { activeTimeMs: 120000, sections: 2, decisions: 1, filesChanged: 0 },
  });
  const page = await openPage(A);
  const all = await page.until((x) => x.workSums.length === 1 && x.facts.length === 1, 'the whole story first');
  assert.deepEqual(all.rowKinds.map((k) => k.replace(/^row /, '').split(' ')[0]), ['k-you', 'k-claude', 'k-plan', 'k-claude'], 'message, text, plan, text (the Work line is counted by workSums)');
  await page.click('#decisions');
  const s = await page.until((x) => x.decisionsOn === true && x.workSums.length === 0, 'the decisions view');
  assert.deepEqual(s.rowKinds.map((k) => k.replace(/^row /, '').split(' ')[0]), ['k-you', 'k-plan'], 'the message and the plan stay');
  assert.equal(s.facts.length, 0, 'no facts line in the reduced view');
  await page.click('#decisions');
  await page.until((x) => x.decisionsOn === false && x.workSums.length === 1, 'the whole story again');
  await page.close();
});

test('page: a block of a kind the reader does not know is named in its Work line, never dropped', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('o1:0', 'other', { blockType: 'server_tool_use' }), step('o1:1', 'other', { blockType: 'server_tool_use' }), step('t1:0', 'tool', { title: 'Read' })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'look it up', 'u1:0', [{ kind: 'work', items: ['o1:0', 'o1:1', 't1:0'] }]),
    ],
  });
  const page = await openPage(A);
  const s = await page.until((x) => x.workSums.length === 1, 'the Work line');
  assert.ok(/read 1 file/i.test(s.workSums[0]), s.workSums[0]);
  assert.ok(s.workSums[0].indexOf('2 blocks of a kind this board does not know (server_tool_use)') !== -1, s.workSums[0]);
  await page.close();
});

test('page: the Files changed tile shows clickable names that send openLink', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('t1:0', 'tool', { title: 'Edit' })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'edit the file', 'u1:0', [{ kind: 'work', items: ['t1:0'] }]),
    ],
    strip: { activeTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 1 },
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

test('page: with Files changed open, a request for the file names that failed is made again, and the names appear without leaving the view', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('t1:0', 'tool', { title: 'Edit' })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'edit the file', 'u1:0', [{ kind: 'work', items: ['t1:0'] }]),
    ],
    strip: { activeTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 1 },
  });
  fake.body = (stepId) => {
    if (stepId === 't1:0') return { title: 'Edit', input: 'C:\\\\proj\\\\foo.py', result: 'ok', path: 'C:\\\\proj\\\\foo.py' };
    return { text: 'body of ' + stepId, truncated: false, size: 10 };
  };
  fake.dropAll = 'bodies';   // the server does not answer any request for bodies
  const page = await openPage(A);
  await page.until((x) => x.filesTileNum === '1', 'the files tile to carry the count');
  await page.click('.strip .item:nth-child(4)');
  await sleep(900);   // several failed requests and pauses
  let s = await page.sample();
  assert.equal(s.fileLinks.length, 0, 'no names while the requests fail');
  fake.dropAll = null;       // the server is back
  s = await page.until((x) => x.fileLinks.length === 1, 'the file name to appear by itself');
  assert.ok(s.fileLinks[0].indexOf('foo.py') !== -1);
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
    strip: { activeTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 1 },
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

test('page: a section that did work ends in a facts line with its time, tool calls and files changed; one without work has none', opts, async () => {
  fake.open = () => openReply({
    steps: [
      step('u1:0', 'you'), step('t1:0', 'tool', { title: 'Edit' }), step('t2:0', 'tool', { title: 'Bash' }), step('t3:0', 'tool', { title: 'Bash' }),
      step('u2:0', 'you'), step('x1:0', 'text'),
      step('u3:0', 'you'), step('t4:0', 'tool', { title: 'Bash' }),
    ],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'fix the bug', 'u1:0', [{ kind: 'work', items: ['t1:0', 't2:0', 't3:0'] }], { activeTimeMs: 4 * 60000, toolCalls: 3, filesChanged: 1 }),
      section('you', 'explain it', 'u2:0', [{ kind: 'text', stepId: 'x1:0' }], { activeTimeMs: 2 * 60000, toolCalls: 0, filesChanged: 0 }),
      section('you', 'list the folder', 'u3:0', [{ kind: 'work', items: ['t4:0'] }], { activeTimeMs: 5000, toolCalls: 1, filesChanged: 0 }),
    ],
    strip: { activeTimeMs: 6 * 60000, sections: 4, decisions: 3, filesChanged: 1 },
  });
  const page = await openPage(A);
  const s = await page.until((x) => x.facts.length === 2, 'a facts line under each of the two sections that did work');
  assert.deepEqual(s.facts, ['4m · 3 tool calls · 1 file changed', '1 tool call'], 'time is left out under a minute, files when none changed');
  await page.close();
});

test('page: a single command Work line names it by its own description', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('t1:0', 'tool', { title: 'Bash' })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'run the tests', 'u1:0', [{ kind: 'work', items: ['t1:0'] }]),
    ],
    strip: { activeTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 0 },
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

test('page: a Work line holding only empty reasoning reads "Thought for Ns", never "1 step"', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('r1:0', 'reasoning', { durationMs: 12000 })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'think about it', 'u1:0', [{ kind: 'work', items: ['r1:0'] }]),
    ],
    strip: { activeTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 0 },
  });
  const page = await openPage(A);
  const s = await page.until((x) => x.workSums.length > 0 && x.workSums[0] !== '1 step', 'the Work line to settle');
  assert.equal(s.workSums[0], 'Thought for 12 s', 'names the pause in words: ' + s.workSums[0]);
  await page.close();
});

test('page: a Work line holding reasoning with no stored duration reads "Thought", never "1 step"', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('r1:0', 'reasoning', { durationMs: 0 })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'think about it', 'u1:0', [{ kind: 'work', items: ['r1:0'] }]),
    ],
    strip: { activeTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 0 },
  });
  const page = await openPage(A);
  const s = await page.until((x) => x.workSums.length > 0 && x.workSums[0] !== '1 step', 'the Work line to settle');
  assert.equal(s.workSums[0], 'Thought', 'no duration: still says what happened, not a step count: ' + s.workSums[0]);
  await page.close();
});

test('page: a Work line holding one tool the summary has no dedicated phrasing for names the tool', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('t1:0', 'tool', { title: 'ToolSearch' })],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'find the right tool', 'u1:0', [{ kind: 'work', items: ['t1:0'] }]),
    ],
    strip: { activeTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 0 },
  });
  fake.body = (stepId) => {
    if (stepId === 't1:0') return { title: 'ToolSearch', input: 'select:Read', result: 'ok' };
    return { text: 'body of ' + stepId, truncated: false, size: 10 };
  };
  const page = await openPage(A);
  const s = await page.until((x) => x.workSums.length > 0 && x.workSums[0] !== '1 step', 'the Work line to settle once the body loads');
  assert.equal(s.workSums[0], 'Used ToolSearch', 'names the unrecognised tool rather than folding it into a step count: ' + s.workSums[0]);
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
    strip: { activeTimeMs: 1000, sections: 1, decisions: 1, filesChanged: 0 },
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

function searchFixture() {
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
}

test('page: Enter pressed right after typing runs that search, it does not drop it', opts, async () => {
  searchFixture();
  fake.search = (q) => (q === 'needle' ? { stepIds: ['t1:0'], capped: false } : { stepIds: [], capped: false });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'the page to render');
  await page.eval('(function () { var i = document.getElementById("q"); i.value = "needle"; i.dispatchEvent(new Event("input")); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); return true; })()');
  await page.until((x) => x.searchCount === '1 of 1', 'the search typed before Enter to run');
  await page.close();
});

test('page: a search reply that arrives after the box was cleared is dropped', opts, async () => {
  searchFixture();
  fake.search = (q) => new Promise((resolve) => setTimeout(() => resolve(q === 'needle' ? { stepIds: ['t1:0'], capped: false } : { stepIds: [], capped: false }), 700));
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'the page to render');
  await page.search('needle');
  await sleep(250);   // past the debounce: the search is on its way
  await page.search('');
  await sleep(1100);  // the slow reply has landed by now
  const s = await page.sample();
  assert.equal(s.searchCount, '', 'no count for an empty box');
  assert.equal(s.curHitId, null, 'and no jump to a hit of the old search');
  await page.close();
});

test('page: a search without hits takes the mark off the hit of the search before it', opts, async () => {
  searchFixture();
  fake.search = (q) => (q === 'needle' ? { stepIds: ['t1:0'], capped: false } : { stepIds: [], capped: false });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'the page to render');
  await page.search('needle');
  await page.until((x) => x.searchCount === '1 of 1' && x.curHitText !== null, 'the hit of the first search, marked');
  await page.search('a word the story does not hold');
  const s = await page.until((x) => x.searchCount === 'no hits', 'the second search to come back empty');
  assert.equal(s.curHitText, null, 'no row is marked as the current hit');
  // and a redraw (every live update makes one) does not bring the old mark back
  fake.pushes.push({ type: 'notesChanged', sessionId: A, notes: [] });
  await sleep(400);
  assert.equal((await page.sample()).curHitText, null, 'still none after a redraw');
  await page.close();
});

test('page: a hit whose text arrives only after the next search has come back is not jumped to any more', opts, async () => {
  searchFixture();
  fake.search = (q) => (q === 'needle' ? { stepIds: ['t1:0'], capped: false } : { stepIds: [], capped: false });
  // the text of the hit is slow: every request that asks for it waits until the test lets go
  let letGo = null;
  const held = new Promise((resolve) => { letGo = resolve; });
  fake.bodies = async (ids) => {
    if (ids.indexOf('t1:0') !== -1) await held;
    return ids.map((id) => Object.assign({ stepId: id }, fake.body(id)));
  };
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'the page to render');
  await page.search('needle');
  const first = await page.until((x) => x.searchCount === '1 of 1', 'the first search to come back');
  assert.equal(first.curHitText, null, 'its hit is not marked yet: the text is still on its way');
  await page.search('a word the story does not hold');
  await page.until((x) => x.searchCount === 'no hits', 'the second search to come back empty');
  letGo();
  for (let i = 0; i < 100 && !(await page.eval('Boolean(state.bodies["t1:0"])')); i++) await sleep(50);
  assert.equal(await page.eval('Boolean(state.bodies["t1:0"])'), true, 'the slow text has arrived');
  await sleep(300);
  const s = await page.sample();
  assert.equal(s.searchCount, 'no hits');
  assert.equal(s.curHitText, null, 'the hit of the search before is not marked after all');
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
    strip: { activeTimeMs: 2000, sections: 3, decisions: 2, filesChanged: 0 },
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
    strip: { activeTimeMs: 2000, sections: 3, decisions: 2, filesChanged: 0 },
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

test('page: "Open full text" on a cut text asks for the step, and a browser copies the whole text it then fetches', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('t1:0', 'text', { preview: 'the start of a very long answer' })],
    sections: [section('lead', 'Session start', null, []), section('you', 'tell me everything', 'u1:0', [{ kind: 'text', stepId: 't1:0' }])],
  });
  fake.body = (stepId) => (stepId === 't1:0' ? { text: 'the start of a very long answer', truncated: true, size: 300000 } : { text: 'body of ' + stepId, truncated: false, size: 10 });
  const page = await openPage(A);
  await page.until((x) => x.bodyTexts.some((t) => t.indexOf('Open full text') !== -1), 'the cut text with its button');
  // what the page hands to the clipboard, kept for the assertions
  await page.eval('window.__copied = []; copyToClipboard = function (t) { window.__copied.push(t); }; true');
  await page.click('.row.k-claude .showall');
  const s = await page.until((x) => x.notices.some((n) => n.indexOf('text copied') !== -1), 'the line that says the text was copied');
  const sent = fake.calls.filter((m) => m && (m.type === 'openText' || m.type === 'fullText'));
  assert.deepEqual(sent.map((m) => [m.type, m.stepId]), [['openText', 't1:0'], ['fullText', 't1:0']], 'the step is named, its text is not sent back and forth');
  assert.equal(sent[0].text, undefined, 'the page does not send the cut text as if it were the whole');
  assert.ok(s.notices.length >= 1);
  assert.deepEqual(await page.eval('window.__copied'), ['the whole text of t1:0'], 'the whole text is what was copied');
  // the whole text cannot be read: nothing is copied, and the page says so
  fake.fullText = () => ({ ok: false, message: 'that step is no longer in the transcript' });
  await page.click('.row.k-claude .showall');
  const failed = await page.until((x) => x.notices.some((n) => n.indexOf('could not be read') !== -1), 'the line that says the full text could not be read');
  assert.ok(failed.notices.some((n) => n.indexOf('no longer in the transcript') !== -1), 'with the reason: ' + JSON.stringify(failed.notices));
  assert.deepEqual(await page.eval('window.__copied'), ['the whole text of t1:0'], 'the cut text is not copied in its place');
  await page.close();
});

test('page: "Open full text" asks for the text of the transcript the click was made on, also when that transcript is replaced before the answer', opts, async () => {
  const story = (generation) => ({
    steps: [step('u1:0', 'you', { generation }), step('t1:0', 'text', { preview: 'the start of a very long answer', generation })],
    sections: [section('lead', 'Session start', null, []), section('you', 'tell me everything', 'u1:0', [{ kind: 'text', stepId: 't1:0' }])],
  });
  fake.open = () => openReply(story(1));
  fake.body = (stepId) => (stepId === 't1:0' ? { text: 'the start of a very long answer', truncated: true, size: 300000 } : { text: 'body of ' + stepId, truncated: false, size: 10 });
  // what the service does once it holds the new transcript: a request that names the old one is
  // refused, one that names the new one gets the step that now carries that id
  fake.fullText = (stepId, msg) => (msg.generation === 2 ? { ok: true, text: 'the text of the step that took its place' } : { ok: false, message: 'the transcript was replaced' });
  const page = await openPage(A);
  await page.until((x) => x.bodyTexts.some((t) => t.indexOf('Open full text') !== -1), 'the cut text with its button');
  await page.eval('window.__copied = []; copyToClipboard = function (t) { window.__copied.push(t); }; true');
  // between the request and its answer the transcript is replaced; the new one has a step of the same id
  fake.beforeOpenTextReply = async () => {
    fake.beforeOpenTextReply = null;
    fake.pushes.push(Object.assign({ type: 'stepsChanged', sessionId: A, generation: 2, strip: { activeTimeMs: 60000, sections: 2, decisions: 1, filesChanged: 0 } }, story(2)));
    for (let i = 0; i < 100; i++) { if ((await page.eval('state.generation')) === 2) return; await sleep(50); }
    throw new Error('the page did not take the new generation');
  };
  await page.click('.row.k-claude .showall');
  const s = await page.until((x) => x.notices.some((n) => n.indexOf('could not be read') !== -1 || n.indexOf('text copied') !== -1), 'the answer to the click');
  const asked = fake.calls.filter((m) => m && m.type === 'fullText');
  assert.deepEqual(asked.map((m) => [m.stepId, m.generation]), [['t1:0', 1]], 'the full text is asked for with the generation of the click');
  assert.deepEqual(await page.eval('window.__copied'), [], 'the text of the step that took its place is not copied');
  assert.ok(s.notices.some((n) => n.indexOf('the transcript was replaced') !== -1), 'the page says why: ' + JSON.stringify(s.notices));
  await page.close();
});

test('page: told by its poll that the server let go of it, the page opens the session again and stays where the reader was', opts, async () => {
  const steps = [];
  const sections = [section('lead', 'Session start', null, [])];
  for (let i = 0; i < 200; i++) {
    const id = 'u' + i + ':0';
    steps.push(step(id, 'you'));
    sections.push(section('you', 'turn ' + i, id, []));
  }
  fake.open = () => openReply({ steps, sections, strip: { activeTimeMs: 600000, sections: 200, decisions: 200, filesChanged: 0 } });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 200, 'first paint');
  await page.scroll(4000);
  await page.until((x) => x.scrollTop > 500 && !x.atBottom, 'the reader somewhere in the middle');
  await sleep(300);   // the window of drawn sections settles around the new place
  const before = await page.sample();
  // the row at the top of the reader: the place is that row, not a scroll offset, since the
  // heights of the sections that are not drawn are estimates
  const topRow = '(function () { var r = document.getElementById("reader"); var top = r.getBoundingClientRect().top; var rows = r.querySelectorAll("[data-step]");'
    + ' for (var i = 0; i < rows.length; i++) { if (rows[i].getBoundingClientRect().bottom > top) return rows[i].getAttribute("data-step"); } return null; })()';
  const rowBefore = await page.eval(topRow);
  assert.equal(fake.calls.filter((m) => m && m.type === 'open').length, 1);
  fake.expireOnce = true;
  await page.until(() => fake.calls.filter((m) => m && m.type === 'open').length === 2, 'the page to open again');
  await sleep(400);
  const after = await page.sample();
  assert.equal(after.error, null);
  assert.equal(after.sectionHeadings.length, before.sectionHeadings.length, 'the outline is whole again');
  assert.ok(rowBefore, 'a row was at the top before');
  assert.equal(await page.eval(topRow), rowBefore, 'the same row is at the top of the reader');
  assert.equal(after.atBottom, false, 'and the reader did not jump to the end');
  await page.close();
});

test('page: a jump with the scrollbar in a long session lands on rows of the story, up as well as down, never on an empty stretch', opts, async () => {
  const steps = [];
  const sections = [section('lead', 'Session start', null, [])];
  for (let i = 0; i < 400; i++) {
    const id = 'u' + i + ':0';
    steps.push(step(id, 'you'));
    sections.push(section('you', 'turn ' + i, id, []));
  }
  fake.open = () => openReply({ steps, sections, strip: { activeTimeMs: 600000, sections: 400, decisions: 400, filesChanged: 0 } });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 400 && x.rowsInView > 0, 'first paint, at the end');
  // far up: a place whose sections are not drawn
  await page.scroll(3000);
  await sleep(700);
  let s = await page.sample();
  assert.ok(s.rowsInView > 0, 'rows are in view after the jump up, at scroll position ' + s.scrollTop);
  assert.equal(s.atBottom, false);
  const first = s.youText;
  // and back down to the very end
  await page.eval('(function () { var r = document.getElementById("reader"); r.scrollTop = r.scrollHeight; r.dispatchEvent(new Event("scroll")); return true; })()');
  await sleep(700);
  s = await page.sample();
  assert.ok(s.rowsInView > 0, 'rows are in view after the jump down, at scroll position ' + s.scrollTop);
  assert.notEqual(s.youText, first, 'another part of the story is drawn');
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
  fake.open = () => openReply({ steps, sections, strip: { activeTimeMs: 600000, sections: sections.length, decisions: sections.length - 1, filesChanged: 0 } });
  const page = await openPage(A);
  const s = await page.until((x) => x.sectionHeadings.length > 0, 'the rail to render');
  assert.ok(s.domRowCount < 500, 'only sections near the anchor hold full row DOM, got ' + s.domRowCount);
  await page.close();
}, { timeout: 30000 });

test('page: a session of long sections keeps the number of drawn rows bounded, and scrolling through it, in jumps and in small steps, always shows rows', opts, async () => {
  const steps = [];
  const sections = [section('lead', 'Session start', null, [])];
  for (let i = 0; i < 40; i++) {
    const you = 'u' + i + ':0';
    steps.push(step(you, 'you'));
    const body = [];
    for (let j = 0; j < 60; j++) {
      const id = 't' + i + 'x' + j + ':0';
      steps.push(step(id, 'text', { preview: 'text ' + j + ' of turn ' + i }));
      body.push({ kind: 'text', stepId: id });
    }
    sections.push(section('you', 'turn ' + i, you, body));
  }
  fake.open = () => openReply({ steps, sections, strip: { activeTimeMs: 600000, sections: 40, decisions: 40, filesChanged: 0 } });
  const page = await openPage(A);
  let s = await page.until((x) => x.sectionHeadings.length >= 40 && x.rowsInView > 0, 'first paint, at the end');
  const LIMIT = 700;   // 2,440 rows in the story; about 400 are drawn, a few sections more at most
  assert.ok(s.domRowCount < LIMIT, 'rows drawn at the end: ' + s.domRowCount);
  const height = await page.eval('document.getElementById("reader").scrollHeight');
  // jumps, as with the scrollbar
  for (const frac of [0.5, 0.1, 0.8, 0.3, 0.95, 0]) {
    await page.eval('(function () { var r = document.getElementById("reader"); r.scrollTop = Math.floor(r.scrollHeight * ' + frac + '); r.dispatchEvent(new Event("scroll")); return true; })()');
    await sleep(350);
    s = await page.sample();
    assert.ok(s.rowsInView > 0, 'rows in view after a jump to ' + frac + ' of the story');
    assert.ok(s.domRowCount < LIMIT, 'rows drawn after a jump to ' + frac + ': ' + s.domRowCount);
  }
  // small steps down from the top, as with the wheel: the window follows, no row is lost
  let seen = 0;
  for (let k = 0; k < 60; k++) {
    await page.eval('(function () { var r = document.getElementById("reader"); r.scrollTop += 700; r.dispatchEvent(new Event("scroll")); return true; })()');
    await sleep(60);
    if (k % 10 === 9) {
      s = await page.sample();
      assert.ok(s.rowsInView > 0, 'rows in view while scrolling, step ' + k);
      assert.ok(s.domRowCount < LIMIT, 'rows drawn while scrolling: ' + s.domRowCount);
      seen += 1;
    }
  }
  assert.equal(seen, 6);
  assert.ok(height > 0);
  await page.close();
}, { timeout: 60000 });

test('page: under Decisions a session of long sections is measured by what Decisions draws: the reader fills with decisions, and the story is as long as they are', opts, async () => {
  const steps = [];
  const sections = [section('lead', 'Session start', null, [])];
  for (let i = 0; i < 70; i++) {
    const you = 'u' + i + ':0';
    steps.push(step(you, 'you'));
    const body = [];
    for (let j = 0; j < 110; j++) {
      const id = 't' + i + 'x' + j + ':0';
      steps.push(step(id, 'text', { preview: 'text ' + j + ' of turn ' + i }));
      body.push({ kind: 'text', stepId: id });
    }
    sections.push(section('you', 'turn ' + i, you, body));
  }
  fake.open = () => openReply({ steps, sections, strip: { activeTimeMs: 600000, sections: 70, decisions: 70, filesChanged: 0 } });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 70 && x.rowsInView > 0, 'first paint, at the end');
  await page.click('#decisions');
  await page.until((x) => x.decisionsOn === true, 'the decisions view');
  // what the reader holds and shows: sections drawn, whether a spacer shows inside the viewport, how long the story is
  const view = '(function () { var r = document.getElementById("reader"); var box = r.getBoundingClientRect();'
    + ' var spacer = Array.prototype.some.call(r.querySelectorAll(".sec-stub"), function (n) { var b = n.getBoundingClientRect(); return b.bottom > box.top + 1 && b.top < box.bottom - 1; });'
    + ' var first = r.querySelector(".section");'
    + ' return { drawn: r.querySelectorAll(".section").length, first: first ? first.getAttribute("data-sec-index") : null, spacerInView: spacer, scrollHeight: r.scrollHeight }; })()';
  await page.eval('(function () { var b = Array.prototype.filter.call(document.querySelectorAll("#rail button"), function (x) { return x.textContent === "Jump to the start"; })[0]; b.click(); return true; })()');
  await sleep(400);
  let s = await page.sample();
  let v = await page.eval(view);
  assert.equal(v.first, '0', 'the first decision is drawn');
  assert.ok(s.rowsInView > 0, 'rows in view at the start');
  // one row a section here, so the row budget takes in far more than the few sections it
  // would hold if the 110 texts each of them hides were counted
  assert.ok(v.drawn >= 30, 'sections drawn at the start: ' + v.drawn);
  assert.equal(v.spacerInView, false, 'no empty stretch in the viewport');
  // 70 decisions of one row each: a few thousand pixels, not the height of the 7,700 texts left out
  assert.ok(v.scrollHeight < 30000, 'the height of the story under Decisions: ' + v.scrollHeight);
  // a jump to the end lands on decisions as well
  await page.eval('(function () { var r = document.getElementById("reader"); r.scrollTop = r.scrollHeight; r.dispatchEvent(new Event("scroll")); return true; })()');
  await sleep(400);
  s = await page.sample();
  v = await page.eval(view);
  assert.ok(s.rowsInView > 0, 'rows in view at the end');
  assert.equal(v.spacerInView, false, 'no empty stretch in the viewport at the end');
  await page.close();
}, { timeout: 60000 });

// -- export ----------------------------------------------------------------------------------

const LONG_TEXT = 'A long answer. '.repeat(40);

/* A story longer than the reader draws (30 turns of 20 texts in front), ending in a turn with
   a text that the page shows cut, a Work line, an answered question, a plan and its approval,
   and one note. Bodies are served the way the service serves them: for an export every text
   comes whole and a tool call comes without its result. */
function exportFixture() {
  const steps = [];
  const sections = [section('lead', 'Session start', null, [])];
  for (let i = 0; i < 30; i++) {
    const you = 'u' + i + ':0';
    steps.push(step(you, 'you'));
    const body = [];
    for (let j = 0; j < 20; j++) {
      const id = 't' + i + 'x' + j + ':0';
      steps.push(step(id, 'text', { preview: 'text ' + j + ' of turn ' + i }));
      body.push({ kind: 'text', stepId: id });
    }
    sections.push(section('you', 'turn ' + i, you, body));
  }
  steps.push(step('u30:0', 'you'), step('x1:0', 'text'), step('e1:0', 'tool', { title: 'Edit' }), step('b1:0', 'tool', { title: 'Bash' }),
    step('r1:0', 'reasoning', { durationMs: 3000 }), step('q1:0', 'question'), step('x2:0', 'text'), step('p1:0', 'plan', { approved: true }), step('x3:0', 'text'));
  sections.push(section('you', 'plan and build', 'u30:0', [{ kind: 'text', stepId: 'x1:0' }, { kind: 'work', items: ['e1:0', 'b1:0', 'r1:0'] }], { activeTimeMs: 120000, toolCalls: 2, filesChanged: 1 }));
  sections.push(section('question', 'Option A', 'q1:0', [{ kind: 'text', stepId: 'x2:0' }, { kind: 'plan', stepId: 'p1:0' }]));
  sections.push(section('approve', 'Plan approved', 'p1:0', [{ kind: 'text', stepId: 'x3:0' }]));
  fake.open = () => openReply({ steps, sections, strip: { activeTimeMs: 3600000, sections: sections.length, decisions: 33, filesChanged: 1 } });
  const bodyOf = (id, forExport) => {
    if (id === 'x1:0') return forExport ? { text: LONG_TEXT + 'END OF THE LONG ANSWER', truncated: false, size: LONG_TEXT.length + 22 } : { text: LONG_TEXT.slice(0, 80), truncated: true, size: LONG_TEXT.length + 22 };
    if (id === 'e1:0') return Object.assign({ title: 'Edit', input: 'C:/proj/a.txt', path: 'C:/proj/a.txt' }, forExport ? {} : { result: 'the file was changed' });
    if (id === 'b1:0') return Object.assign({ title: 'Bash', input: '$ npm test' }, forExport ? {} : { result: 'all green' });
    if (id === 'q1:0') return { questions: [{ header: 'Approach', question: 'Which way should we go?', multiSelect: false, answered: true,
      options: [{ label: 'Option A', description: 'the simple route', chosen: true }, { label: 'Option B', description: 'the thorough route', chosen: false }] }] };
    if (id === 'p1:0') return { text: '# The plan\n\n1. do it', approved: true, truncated: false, size: 20 };
    if (id === 'x2:0') return { text: '## Result\n\nSee https://example.com/doc and `C:/proj/a.txt`.\n\n```\n# not a heading\n```', truncated: false, size: 80 };
    // a code block that shows a code block: the inner fence is shorter than the outer one
    if (id === 'x3:0') return { text: '````md\n```\n# Example title\n```\n````\n\n~~~\n# in tildes\n```\n# still in tildes\n~~~\n\n# After the blocks', truncated: false, size: 90 };
    return { text: 'body of ' + id, truncated: false, size: 10 };
  };
  fake.bodies = (ids, msg) => ids.map((id) => Object.assign({ stepId: id }, bodyOf(id, Boolean(msg && msg.forExport))));
  fake.notes.set('n1', { id: 'n1', stepId: 'x2:0', at: 1, text: 'check this claim', sent: [] });
  return sections;
}

/** Opens the fixture and catches what the page would download or print. */
async function exportPage(ready) {
  const page = await openPage(A);
  await page.until(ready || ((x) => x.sectionHeadings.length >= 33 && x.rowsInView > 0), 'first paint, at the end');
  await page.eval('window.__saved = []; saveInBrowser = function (name, text) { window.__saved.push({ name: name, text: text }); };'
    + ' window.__printed = []; window.__printCalls = 0;'
    + ' window.open = function () { return { document: { open: function () {}, write: function (h) { window.__printed.push(h); }, close: function () {} }, focus: function () {}, print: function () { window.__printCalls += 1; }, close: function () {} }; }; true');
  page.exportAs = async (format) => {
    const before = await page.eval('window.__saved.length + window.__printed.length');
    await page.click('#exportBtn');
    await page.click('#exportMenu [data-export="' + format + '"]');
    for (let i = 0; i < 200; i++) { if ((await page.eval('window.__saved.length + window.__printed.length')) > before) break; await sleep(50); }
    return page.eval(format === 'pdf' ? 'window.__printed[window.__printed.length - 1]' : 'window.__saved[window.__saved.length - 1]');
  };
  return page;
}

test('page: Export as Markdown writes out the whole story, also the sections the reader has not drawn, with every text whole', opts, async () => {
  exportFixture();
  const page = await exportPage();
  // the reader holds the cut text of the long answer, as it shows it
  await page.eval('(function () { document.getElementById("step-x1:0").scrollIntoView(); document.getElementById("reader").dispatchEvent(new Event("scroll")); return true; })()');
  for (let i = 0; i < 100 && !(await page.eval('Boolean(state.bodies["x1:0"])')); i++) await sleep(50);
  const saved = await page.exportAs('md');
  assert.ok(saved, 'a file was handed to the browser');
  assert.equal(saved.name, 'Fixture session.md');
  const text = saved.text;
  assert.ok(text.indexOf('# Fixture session\n') === 0, 'the title heads the file');
  assert.ok(/the whole story/.test(text.split('\n')[2]), 'the line under the title says what the file holds: ' + text.split('\n')[2]);
  assert.equal(text.split('\n').filter((l) => /^## /.test(l)).length, 33, 'one heading per section that holds something (the empty start of the session has none)');
  assert.ok(text.indexOf('body of t0x0:0') !== -1, 'a text of the first turn, far from what the reader drew');
  assert.ok(text.indexOf('END OF THE LONG ANSWER') !== -1, 'a text the page shows cut is written whole');
  assert.ok(text.indexOf('> body of u30:0') !== -1, 'your message, quoted');
  assert.ok(text.indexOf('Edited a.txt, ran a command ($ npm test)') !== -1, 'the Work line in words');
  assert.ok(text.indexOf('2m · 2 tool calls · 1 file changed') !== -1, 'the facts line of the section');
  assert.ok(text.indexOf('- [x] **Option A** (your choice): the simple route') !== -1 && text.indexOf('- [ ] **Option B**: the thorough route') !== -1, 'the question as asked, your choice marked');
  assert.ok(text.indexOf('\n#### Result\n') !== -1 && text.indexOf('\n### The plan\n') !== -1, 'headings inside a text are made smaller than the headings of the file');
  assert.ok(text.indexOf('\n# not a heading\n') !== -1, 'a line inside a code block is left as it is');
  assert.ok(text.indexOf('````md\n```\n# Example title\n```\n````') !== -1, 'also inside a block that holds a shorter fence');
  assert.ok(text.indexOf('~~~\n# in tildes\n```\n# still in tildes\n~~~') !== -1, 'and in a block a fence of the other kind does not close');
  assert.ok(text.indexOf('\n### After the blocks') !== -1, 'the heading after the blocks is still made smaller');
  assert.ok(text.indexOf('*You approved this plan.*') !== -1);
  assert.ok(text.indexOf('> Note: check this claim') !== -1, 'the note under its step');
  assert.equal(text.indexOf('- `Bash`'), -1, 'no list of tool calls while Tool calls is off');
  assert.equal(text.indexOf('all green'), -1, 'and never a tool result');
  // what the export asked the service for
  const asked = fake.calls.filter((m) => m && m.type === 'bodies' && m.forExport);
  const ids = [].concat(...asked.map((m) => m.stepIds));
  assert.ok(asked.length >= 2, 'the texts are collected in more than one request: ' + asked.length);
  assert.ok(ids.indexOf('u0:0') !== -1 && ids.indexOf('t29x19:0') !== -1 && ids.indexOf('e1:0') !== -1);
  assert.equal(ids.indexOf('r1:0'), -1, 'a reasoning step has no text to read');
  assert.equal(new Set(ids).size, ids.length, 'no step is asked for twice');
  // the reader still shows the cut text with its button: the export did not touch what the page holds
  assert.equal(await page.eval('Boolean(state.bodies["x1:0"] && state.bodies["x1:0"].truncated)'), true);
  // with Tool calls on, the calls are listed with what they ran
  await page.click('#allTools');
  const withTools = (await page.exportAs('md')).text;
  assert.ok(withTools.indexOf('- `Bash`\n  ~~~\n  $ npm test\n  ~~~') !== -1, 'the call and its command: ' + withTools.slice(withTools.indexOf('Edited a.txt'), withTools.indexOf('Edited a.txt') + 300));
  assert.equal(withTools.indexOf('all green'), -1, 'still no tool result');
  await page.close();
}, { timeout: 60000 });

test('page: an export is of the view it was started in, also when the view is switched while its texts are read', opts, async () => {
  exportFixture();
  const served = fake.bodies;
  let letGo = null;
  const held = new Promise((resolve) => { letGo = resolve; });
  // the texts of an export are slow, until the test lets go
  fake.bodies = async (ids, msg) => { if (msg && msg.forExport) await held; return served(ids, msg); };
  const page = await exportPage();
  await page.click('#exportBtn');
  await page.click('#exportMenu [data-export="md"]');
  for (let i = 0; i < 100 && !fake.calls.some((m) => m && m.type === 'bodies' && m.forExport); i++) await sleep(50);
  await page.click('#decisions');
  await page.click('#allTools');
  await page.until((x) => x.decisionsOn === true, 'the view switched while the export reads');
  letGo();
  for (let i = 0; i < 200 && (await page.eval('window.__saved.length')) === 0; i++) await sleep(50);
  const saved = await page.eval('window.__saved[0]');
  assert.ok(saved, 'the export came out');
  assert.equal(saved.name, 'Fixture session.md', 'named after the view it was started in');
  assert.ok(/the whole story/.test(saved.text.split('\n')[2]), saved.text.split('\n')[2]);
  assert.ok(saved.text.indexOf('body of t0x0:0') !== -1 && saved.text.indexOf('END OF THE LONG ANSWER') !== -1, 'the whole story, with its texts whole');
  assert.equal(saved.text.indexOf('- `Bash`'), -1, 'and without the list of calls that was switched on later');
  assert.equal((await page.sample()).decisionsOn, true, 'the tab is in the view it was switched to');
  await page.close();
}, { timeout: 60000 });

test('page: an export is refused while the transcript is still being indexed, since it would not hold the whole story', opts, async () => {
  exportFixture();
  const whole = fake.open;
  fake.open = () => Object.assign(whole(), { indexing: true });
  const page = await exportPage();
  await page.click('#exportBtn');
  await page.click('#exportMenu [data-export="md"]');
  const s = await page.until((x) => x.notices.some((n) => /indexing/i.test(n) && /export/i.test(n)), 'the line that says why');
  assert.ok(s.notices.length >= 1);
  await sleep(300);
  assert.equal(fake.calls.some((m) => m && m.type === 'bodies' && m.forExport), false, 'no text is read for it');
  assert.equal(await page.eval('window.__saved.length'), 0);
  await page.close();
}, { timeout: 60000 });

test('page: an export of Notes holds the notes whose step is no longer on the current path, as the view does', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('t1:0', 'text')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first', 'u1:0', [{ kind: 'text', stepId: 't1:0' }])],
  });
  fake.notes.set('n-gone', { id: 'n-gone', stepId: 'gone:0', at: 1, text: 'a note on a step of an abandoned try', sent: [] });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1 && x.notesTileNum === '1', 'the page with its one note');
  await page.eval('window.__saved = []; saveInBrowser = function (name, text) { window.__saved.push({ name: name, text: text }); };'
    + ' window.__printed = []; window.open = function () { return { document: { open: function () {}, write: function (h) { window.__printed.push(h); }, close: function () {} }, focus: function () {}, print: function () {}, close: function () {} }; }; true');
  await page.click('.strip .item:nth-child(5)');
  await page.until((x) => x.notesTileOn === true && x.savedNoteOffPath === true, 'the Notes view with the note off the path');
  // the only note is one without a section: there is still something to export
  await page.click('#exportBtn');
  await page.click('#exportMenu [data-export="md"]');
  for (let i = 0; i < 100 && (await page.eval('window.__saved.length')) === 0; i++) await sleep(50);
  const saved = await page.eval('window.__saved[0]');
  assert.ok(saved, 'the export came out: ' + JSON.stringify((await page.sample()).notices));
  assert.equal(saved.name, 'Fixture session (notes).md');
  assert.ok(saved.text.indexOf('> Note: a note on a step of an abandoned try') !== -1 && saved.text.indexOf('step not on the current path') !== -1, saved.text);
  await page.click('#exportBtn');
  await page.click('#exportMenu [data-export="pdf"]');
  for (let i = 0; i < 100 && (await page.eval('window.__printed.length')) === 0; i++) await sleep(50);
  const html = await page.eval('window.__printed[0]');
  assert.ok(html && html.indexOf('a note on a step of an abandoned try') !== -1 && html.indexOf('step not on the current path') !== -1, 'the page for the PDF holds it too');
  await page.close();
}, { timeout: 60000 });

test('page: under Decisions the export holds what Decisions shows: your messages, the questions and the plans', opts, async () => {
  exportFixture();
  const page = await exportPage();
  await page.click('#decisions');
  await page.until((x) => x.decisionsOn === true, 'the decisions view');
  const saved = await page.exportAs('md');
  assert.equal(saved.name, 'Fixture session (decisions).md');
  const text = saved.text;
  assert.ok(/decisions only/.test(text.split('\n')[2]), text.split('\n')[2]);
  assert.equal(text.split('\n').filter((l) => /^## /.test(l)).length, 33, 'the sections Decisions lists, without the start of the session');
  assert.ok(text.indexOf('> body of u0:0') !== -1 && text.indexOf('- [x] **Option A**') !== -1 && text.indexOf('### The plan') !== -1);
  assert.equal(text.indexOf('body of t0x0:0'), -1, 'no text of Claude');
  assert.equal(text.indexOf('Edited a.txt'), -1, 'no Work line');
  const asked = [].concat(...fake.calls.filter((m) => m && m.type === 'bodies' && m.forExport).map((m) => m.stepIds));
  assert.equal(asked.indexOf('t0x0:0'), -1, 'and the texts it leaves out are not read');
  await page.close();
}, { timeout: 60000 });

test('page: Export as PDF in a browser opens the story as a page of its own and prints it: every section, formatted, nothing to click and no script', opts, async () => {
  const sections = exportFixture();
  const page = await exportPage();
  const html = await page.exportAs('pdf');
  assert.ok(html, 'a page was written into the window that was opened');
  assert.equal(await page.eval('window.__printCalls'), 1, 'and printed');
  assert.ok(/^<!DOCTYPE html>\s*<html[^>]*class="export"/.test(html), html.slice(0, 120));
  assert.equal((html.match(/data-sec-index="/g) || []).length, sections.length, 'every section is in the page');
  assert.ok(html.indexOf('END OF THE LONG ANSWER') !== -1, 'with the texts whole');
  assert.ok(html.indexOf('<title>Fixture session</title>') !== -1);
  assert.equal(/<script/i.test(html), false, 'no script');
  assert.equal(/<button/i.test(html), false, 'no button');
  assert.equal(/<textarea|<input/i.test(html), false);
  assert.ok(html.indexOf('<style>') !== -1 && html.indexOf('html.export') !== -1, 'it carries its own style, with the rules for paper');
  assert.ok(/<a [^>]*href="https:\/\/example\.com\/doc"/.test(html), 'a web link stays a link');
  assert.ok(/<a class="lnk code"[^>]*title="C:\/proj\/a\.txt"/.test(html) && !/href="#"/.test(html), 'a path is shown, and no link leads nowhere');
  assert.ok(html.indexOf('class="qopt chosen"') !== -1 && html.indexOf('check this claim') !== -1, 'the question card and the note are there');
  // the page parses back to what it shows: the rows of the last turns, drawn as in the tab
  const rows = await page.eval('(function () { var d = new DOMParser().parseFromString(window.__printed[0], "text/html"); return { rows: d.querySelectorAll(".row").length, bold: d.querySelectorAll(".md .h").length, sub: (d.querySelector(".sub") || {}).textContent }; })()');
  assert.ok(rows.rows > 600, 'rows in the page: ' + rows.rows);
  assert.ok(rows.bold >= 2, 'headings inside the texts are rendered');
  assert.ok(/the whole story/.test(rows.sub), rows.sub);
  await page.close();
}, { timeout: 60000 });

/** Loads a page written for the PDF into a tab of its own and evaluates expr in it. */
async function inExportedPage(html, expr) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  try {
    const { sessionId: cdpSessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const run = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, cdpSessionId);
      if (r.exceptionDetails) throw new Error('exported page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    };
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, cdpSessionId);
    await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, cdpSessionId);
    return await run(expr);
  } finally {
    await cdp.send('Target.closeTarget', { targetId });
  }
}

test('page: the page for the PDF is in colour: your messages, Claude, work, errors, questions, plans and notes each have a colour of their own, and printing keeps them', opts, async () => {
  const steps = [step('u1:0', 'you'), step('x1:0', 'text'), step('e1:0', 'tool', { title: 'Edit' }), step('er1:0', 'error'),
    step('q1:0', 'question'), step('p1:0', 'plan', { approved: true })];
  const sections = [section('lead', 'Session start', null, []),
    section('you', 'first', 'u1:0', [{ kind: 'text', stepId: 'x1:0' }, { kind: 'work', items: ['e1:0'] }, { kind: 'error', stepId: 'er1:0' }]),
    section('question', 'Option A', 'q1:0', [{ kind: 'plan', stepId: 'p1:0' }])];
  fake.open = () => openReply({ steps, sections });
  fake.bodies = (ids) => ids.map((id) => {
    if (id === 'e1:0') return { stepId: id, title: 'Edit', input: 'C:/proj/a.txt', path: 'C:/proj/a.txt' };
    if (id === 'q1:0') return { stepId: id, questions: [{ header: 'Approach', question: 'Which way?', multiSelect: false, answered: true,
      options: [{ label: 'Option A', description: 'simple', chosen: true }, { label: 'Option B', description: 'thorough', chosen: false }] }] };
    if (id === 'p1:0') return { stepId: id, text: '# The plan\n\n1. do it', approved: true, truncated: false, size: 20 };
    if (id === 'x1:0') return { stepId: id, text: '## Found\n\n- one\n\nUse `retry.js`.', truncated: false, size: 30 };
    return { stepId: id, text: 'body of ' + id, truncated: false, size: 10 };
  });
  fake.notes.set('n1', { id: 'n1', stepId: 'x1:0', at: 1, text: 'check this claim', sent: [] });
  const page = await exportPage((x) => x.sectionHeadings.length >= 2 && x.rowsInView > 0);
  const html = await page.exportAs('pdf');
  await page.close();
  assert.ok(html, 'the page for the PDF');
  const c = await inExportedPage(html, `(function () {
    var of = function (sel, prop) { var e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : 'no element ' + sel; };
    var root = getComputedStyle(document.documentElement);
    return {
      adjust: root.printColorAdjust || root.webkitPrintColorAdjust,
      paper: of('body', 'backgroundColor'),
      headYou: of('.sec-head.k-you', 'backgroundColor'), headQuestion: of('.sec-head.k-question', 'backgroundColor'),
      you: of('.row.k-you .you-msg', 'backgroundColor'), youBar: of('.row.k-you .you-msg', 'borderLeftColor'),
      chipClaude: of('.row.k-claude:not(.k-error) .chip', 'backgroundColor'), chipWork: of('.row.k-work .chip', 'backgroundColor'),
      chipError: of('.row.k-error .chip', 'backgroundColor'), chipPlan: of('.row.k-plan .chip', 'backgroundColor'),
      chipInk: of('.row.k-claude .chip', 'color'),
      barClaude: of('.row.k-claude:not(.k-error) .body', 'borderLeftColor'), barClaudeWidth: of('.row.k-claude:not(.k-error) .body', 'borderLeftWidth'),
      work: of('.row.k-work .body', 'backgroundColor'), plan: of('.row.k-plan .body', 'backgroundColor'),
      chosen: of('.qopt.chosen', 'backgroundColor'), note: of('.saved-note', 'backgroundColor'),
      heading: of('.row.k-claude .md .h', 'color'), text: of('.row.k-claude .md p', 'color'),
    };
  })()`);
  const clear = 'rgba(0, 0, 0, 0)';
  const grey = 'rgb(245, 246, 248)';   // the one panel grey everything had before
  assert.equal(c.adjust, 'exact', 'a print dialog keeps the colours');
  assert.equal(c.paper, 'rgb(255, 255, 255)', 'on a white page');
  const chips = [c.chipClaude, c.chipWork, c.chipError, c.chipPlan];
  chips.forEach((v) => assert.ok(/^rgb\(/.test(v) && v !== grey, 'a chip is filled with the colour of its kind: ' + JSON.stringify(c)));
  assert.equal(new Set(chips).size, 4, 'Claude, Work, Error and Plan each have their own: ' + JSON.stringify(chips));
  assert.equal(c.chipInk, 'rgb(255, 255, 255)', 'with white letters');
  const fills = [c.you, c.work, c.plan, c.note];
  fills.forEach((v) => assert.ok(/^rgb\(/.test(v) && v !== grey && v !== c.paper, 'a tinted part: ' + JSON.stringify(c)));
  assert.equal(new Set(fills).size, 4, 'your message, the work, a plan and a note are told apart by their tint: ' + JSON.stringify(fills));
  assert.ok(c.headYou !== clear && c.headQuestion !== clear && c.headYou !== c.headQuestion, 'the head of a section has the colour of what opened it: ' + c.headYou + ' / ' + c.headQuestion);
  assert.equal(c.youBar, 'rgb(11, 98, 196)', 'your message carries your colour on its edge');
  assert.equal(c.barClaude, c.chipClaude, 'a text of Claude has the edge of its chip');
  assert.ok(parseFloat(c.barClaudeWidth) >= 2, c.barClaudeWidth);
  assert.ok(c.chosen !== grey && c.chosen !== clear, 'your choice is tinted: ' + c.chosen);
  assert.ok(c.heading !== c.text, 'a heading inside a text is in colour: ' + c.heading);
});

test('page in the VS Code panel: Export hands the story to the host, which saves the Markdown where the dialog says and prints a real PDF', opts, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-steps-export-'));
  const file = path.join(dir, A + '.jsonl');
  fs.writeFileSync(file, [rUser(1, 'how is it going?'), rText(2, LONG_ANSWER), rUser(3, 'and the rest?'), rText(4, 'All of it is done.')].map((l) => JSON.stringify(l) + '\n').join(''));
  const { provider } = host.boot({
    transcriptIndex: () => new Map([[A, file]]),
    transcriptFacts: () => ({ tokens: null, title: 'Webview session', customTitle: null, lastPrompt: null }),
  }, { last: { sessions: [], ended: [], limits: {}, usage: null } });
  await provider.onMessage({ type: 'steps', sessionId: A });
  fake.panel = host.vscode.__panels[0];
  try {
    const page = await openPage(A, '/steps-webview');
    await page.until((x) => x.bodyTexts.some((t) => t.indexOf('All of it is done.') !== -1), 'the story');
    const mdFile = path.join(dir, 'out.md');
    host.vscode.__saveTarget = host.vscode.Uri.file(mdFile);
    await page.click('#exportBtn');
    await page.click('#exportMenu [data-export="md"]');
    let s = await page.until((x) => x.notices.some((n) => n.indexOf('Saved ') === 0), 'the line that says where the file went');
    assert.ok(s.notices.some((n) => n.indexOf(mdFile) !== -1), JSON.stringify(s.notices));
    const text = fs.readFileSync(mdFile, 'utf8');
    assert.ok(text.indexOf('# Webview session\n') === 0 && text.indexOf('That is the end of the answer.') !== -1 && text.indexOf('> and the rest?') !== -1, text.slice(0, 300));
    assert.equal(path.basename(host.vscode.__saveDialogs[0].defaultUri.fsPath), 'Webview session.md');
    // the PDF: the page's own rendering, printed by a browser of this machine
    const pdfFile = path.join(dir, 'out.pdf');
    host.vscode.__saveTarget = host.vscode.Uri.file(pdfFile);
    const noticesBefore = s.notices.length;
    await page.click('#exportBtn');
    await page.click('#exportMenu [data-export="pdf"]');
    s = await page.until((x) => x.notices.length > noticesBefore && x.notices.slice(noticesBefore).some((n) => n.indexOf('Saved ') === 0 || n.indexOf('failed') !== -1), 'the answer to the PDF export');
    assert.ok(s.notices.slice(noticesBefore).some((n) => n.indexOf(pdfFile) !== -1), JSON.stringify(s.notices.slice(noticesBefore)));
    const bytes = fs.readFileSync(pdfFile);
    assert.equal(bytes.slice(0, 5).toString('latin1'), '%PDF-');
    assert.ok(/\/Title\s*\(Webview session\)/.test(bytes.toString('latin1')), 'the PDF carries the title of the session');
    await page.close();
  } finally {
    fake.panel.dispose();
    fake.panel = null;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, { timeout: 120000 });

// -- narrow layout -------------------------------------------------------------------------

test('page: the narrow layout (520px) shows the outline drawer toggle, and "Jump to the start" lives inside the drawer', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first', 'u1:0', [])],
  });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:' + PORT + '/steps?session=' + A });
  const { sessionId: cdpSessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, cdpSessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 800, deviceScaleFactor: 1, mobile: true }, cdpSessionId);
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, cdpSessionId);
    if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  };
  let sample = null;
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { sample = await ev(SAMPLE); if (sample.drawerVisible && sample.jumpToStartButtons > 0) break; } catch (_) { /* page still loading */ }
    await sleep(150);
  }
  assert.ok(sample, 'the page rendered within the timeout');
  assert.equal(sample.drawerVisible, true, 'the rail-toggle bar is visible at a narrow width');
  assert.equal(sample.jumpToStartButtons, 1, 'exactly one "Jump to the start" control, no floating pill');
  assert.equal(sample.jumpToStartInRail, 1, 'it lives inside the outline drawer');
  await cdp.send('Target.closeTarget', { targetId });
});

// -- notes -----------------------------------------------------------------------------------

test('page: adding a note through the box shows it under the step and makes the Notes tile live', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', [])],
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  assert.deepEqual((await page.sample()).addNoteButtons.filter(Boolean).length > 0, true, 'every step offers Add note');
  await page.click('.row.k-you .add-note');
  const opened = await page.until((x) => x.noteBoxOpen, 'the note box to open');
  assert.equal(opened.noteBoxText, '', 'an empty box for a fresh note');
  await page.eval('(function () { var t = document.querySelector(".notebox textarea"); t.value = "why this step?"; })()');
  await page.click('.notebox .row2 button:first-child'); // Keep note
  const kept = await page.until((x) => x.savedNoteText, 'the note to show under the step');
  assert.ok(kept.savedNoteText.indexOf('why this step?') !== -1);
  assert.equal(kept.notedRows, 1);
  assert.equal(kept.notesTileNum, '1');
  assert.equal(kept.notesJumpLabel, 'Notes 1');
  await page.close();
});

test('page: an open note box keeps what was typed, and stays open, when pushes redraw the page', opts, async () => {
  const sections = [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', []), section('you', 'second message', 'u2:0', [])];
  fake.open = () => openReply({ steps: [step('u1:0', 'you'), step('u2:0', 'you')], sections });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 2, 'first paint');
  await page.eval('(function () { document.getElementById("step-u2:0").querySelector(".add-note").click(); })()');
  await page.until((x) => x.noteBoxOpen, 'the note box to open');
  await page.eval('(function () { var ta = document.querySelector(".notebox textarea"); ta.value = "half a thought"; ta.dispatchEvent(new Event("input", { bubbles: true })); })()');
  // the session goes on (a new section arrives) and another window keeps a note on another step
  fake.pushes.push({
    type: 'stepsChanged', sessionId: A, appended: ['u3:0'], steps: [step('u3:0', 'you')],
    sections: sections.concat([section('you', 'third message', 'u3:0', [])]),
    strip: { activeTimeMs: 2000, sections: 4, decisions: 3, filesChanged: 0 },
  });
  fake.pushes.push({ type: 'notesChanged', sessionId: A, notes: [{ id: 'n-other', stepId: 'u1:0', at: 1, text: 'from another window', sent: [] }] });
  const s = await page.until((x) => x.sectionHeadings.length === 4 && x.notesTileNum === '1', 'both pushes to land');
  assert.equal(s.noteBoxOpen, true, 'the box on a step without a note stays open');
  assert.equal(s.noteBoxText, 'half a thought', 'and keeps what was typed');
  await page.close();
});

test('page: a note that cannot be kept stays in its box with the reason shown, and is kept on the next try', opts, async () => {
  const sections = [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', [])];
  fake.open = () => openReply({ steps: [step('u1:0', 'you')], sections });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  await page.eval('(function () { document.getElementById("step-u1:0").querySelector(".add-note").click(); })()');
  await page.until((x) => x.noteBoxOpen, 'the note box to open');
  await page.eval('(function () { var ta = document.querySelector(".notebox textarea"); ta.value = "a long thought"; ta.dispatchEvent(new Event("input", { bubbles: true })); })()');
  fake.noteReject = 'a note is 16 KB at most';
  await page.click('.notebox .row2 button:first-child');
  let s = await page.until((x) => x.notices.some((n) => n.indexOf('16 KB') !== -1), 'the reason the note was not kept');
  assert.equal(s.noteBoxOpen, true, 'the box stays open');
  assert.equal(s.noteBoxText, 'a long thought', 'with what was typed');
  assert.equal(s.notesTileNum, '0', 'nothing was kept');
  fake.noteReject = null;
  await page.click('.notebox .row2 button:first-child');
  s = await page.until((x) => !x.noteBoxOpen && x.savedNoteText && x.savedNoteText.indexOf('a long thought') !== -1, 'the note kept on the second try');
  await page.close();
});

test('page: switching to Notes from the end of a long session shows the noted section, not an empty reader', opts, async () => {
  const steps = [];
  const sections = [section('lead', 'Session start', null, [])];
  for (let i = 0; i < 300; i++) {
    const id = 'u' + i + ':0';
    steps.push(step(id, 'you'));
    sections.push(section('you', 'turn ' + i, id, []));
  }
  fake.notes.set('n1', { id: 'n1', stepId: 'u5:0', at: 1, text: 'look here', sent: [] });
  fake.open = () => openReply({ steps, sections, strip: { activeTimeMs: 600000, sections: 300, decisions: 300, filesChanged: 0 } });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length > 0 && x.notesTileNum === '1', 'first paint, at the end of the story');
  // read in the same turn as the click: the first draw must hold the note, not a spacer that
  // only a later scroll event turns into rows
  const drawnAtOnce = await page.eval('(function () { document.querySelector(".strip .item:nth-child(5)").click(); return !!document.querySelector(".saved-note"); })()');
  assert.equal(drawnAtOnce, true, 'the noted section is drawn by the switch itself');
  const s = await page.until((x) => x.notesTileOn && x.savedNoteText && x.savedNoteText.indexOf('look here') !== -1, 'the noted section in the Notes view');
  assert.deepEqual(s.sectionHeadings, ['turn 5'], 'the outline holds the one section with a note');
  await page.close();
});

test('page: a quick reply prefills the note text', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', [])],
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  await page.click('.row.k-you .add-note');
  await page.until((x) => x.noteBoxOpen, 'the note box to open');
  await page.click('.notebox .quick button'); // "Why this?"
  const s = await page.until((x) => x.noteBoxText, 'the quick reply to land in the box');
  assert.ok(s.noteBoxText.indexOf('Why this?') !== -1);
  await page.close();
});

test('page: "Send to session" shows the reply line and "Sent HH:MM" under the note', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', [])],
  });
  fake.deliver = () => ({ ok: true, message: 'In the chat box and on the clipboard.' });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  await page.click('.row.k-you .add-note');
  await page.until((x) => x.noteBoxOpen, 'the note box to open');
  await page.eval('(function () { document.querySelector(".notebox textarea").value = "why this approach?"; })()');
  await page.click('.notebox .row2 button.primary'); // Send to session
  const s = await page.until((x) => x.noticeText === 'In the chat box and on the clipboard.', 'the reply line to show');
  const kept = await page.until((x) => x.savedNoteSentText, 'the Sent mark to show under the note');
  assert.ok(kept.savedNoteSentText.indexOf('Sent ') === 0, kept.savedNoteSentText);
  assert.equal(s.notedRows >= 1, true);
  await page.close();
});

test('page: a copy-only reply from "Send to session" shows that line instead, with no Sent mark', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', [])],
  });
  fake.deliver = () => ({ ok: false, message: 'On the clipboard. Paste it into the session.' });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  await page.click('.row.k-you .add-note');
  await page.until((x) => x.noteBoxOpen, 'the note box to open');
  await page.eval('(function () { document.querySelector(".notebox textarea").value = "a note"; })()');
  await page.click('.notebox .row2 button.primary');
  const s = await page.until((x) => x.noticeText === 'On the clipboard. Paste it into the session.', 'the copy-only line to show');
  assert.equal(s.savedNoteSentText, null, 'not recorded as sent on a copy-only reply');
  await page.close();
});

test('page: "Send all notes" sends every kept note in one call and shows the reply line', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('u2:0', 'you')],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'first message', 'u1:0', []),
      section('you', 'second message', 'u2:0', []),
    ],
  });
  fake.deliver = () => ({ ok: true, message: 'In the chat box and on the clipboard.' });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 2, 'first paint');
  for (const sid of ['u1:0', 'u2:0']) {
    await page.eval('(function () { document.getElementById("step-' + sid + '").querySelector(".add-note").click(); })()');
    await page.until((x) => x.noteBoxOpen, 'a note box to open for ' + sid);
    await page.eval('(function () { document.querySelector(".notebox textarea").value = "note on ' + sid + '"; })()');
    await page.click('.notebox .row2 button:first-child'); // Keep note
    await page.until((x) => !x.noteBoxOpen, 'the box to close after keeping');
  }
  await page.until((x) => x.notesJumpLabel === 'Notes 2', 'both notes counted');
  await page.click('#sendAllNotes');
  const s = await page.until((x) => x.noticeText === 'In the chat box and on the clipboard.', 'the reply line after sending all');
  assert.equal(fake.calls.filter((c) => c.type === 'notesSendAll').length, 1, 'one message for all notes');
  void s;
  await page.close();
});

test('page: editing a kept note changes its text in place', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', [])],
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  await page.click('.row.k-you .add-note');
  await page.until((x) => x.noteBoxOpen, 'the note box to open');
  await page.eval('(function () { document.querySelector(".notebox textarea").value = "first version"; })()');
  await page.click('.notebox .row2 button:first-child');
  await page.until((x) => x.savedNoteText && x.savedNoteText.indexOf('first version') !== -1, 'the first version to show');
  await page.click('.add-note'); // reopen, now showing "Note" since one exists
  const reopened = await page.until((x) => x.noteBoxOpen, 'the box to reopen with the existing text');
  assert.ok(reopened.noteBoxText.indexOf('first version') !== -1);
  await page.eval('(function () { document.querySelector(".notebox textarea").value = "edited version"; })()');
  await page.click('.notebox .row2 button:first-child');
  const edited = await page.until((x) => x.savedNoteText && x.savedNoteText.indexOf('edited version') !== -1, 'the edit to land');
  assert.equal(edited.notedRows, 1, 'still one note, not a second one added');
  await page.close();
});

test('page: deleting a note clears it from the step and the tile', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', [])],
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  await page.click('.row.k-you .add-note');
  await page.until((x) => x.noteBoxOpen, 'the note box to open');
  await page.eval('(function () { document.querySelector(".notebox textarea").value = "to be deleted"; })()');
  await page.click('.notebox .row2 button:first-child');
  await page.until((x) => x.savedNoteText, 'the note to be kept first');
  await page.click('.add-note');
  await page.until((x) => x.noteBoxOpen, 'the box to reopen');
  const sample = await page.sample();
  const buttons = await page.eval('Array.prototype.map.call(document.querySelectorAll(".notebox .row2 button"), function (b) { return b.textContent; })');
  assert.ok(buttons.indexOf('Delete') !== -1, 'a Delete button appears for an existing note');
  void sample;
  await page.click('.notebox .row2 button:last-child'); // Delete is appended last
  const after = await page.until((x) => x.notesTileNum === '0', 'the tile to drop back to zero');
  assert.equal(after.savedNoteText, null);
  assert.equal(after.notedRows, 0);
  await page.close();
});

test('page: the Notes switch narrows the outline to sections with a note, with its own empty state', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('u2:0', 'you')],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'first message', 'u1:0', []),
      section('you', 'second message', 'u2:0', []),
    ],
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 2, 'first paint');
  const beforeNotes = await page.sample();
  assert.equal(beforeNotes.emptyStateText, null);
  // switching to the notes lens with no notes yet shows the stated empty state
  await page.click('.strip .item:nth-child(5)');
  const empty = await page.until((x) => x.emptyStateText, 'the notes-empty state to show');
  assert.equal(empty.emptyStateText, 'No sections carry a note yet.');
  await page.click('.strip .item:nth-child(5)'); // back to the full story
  await page.until((x) => x.sectionHeadings.length >= 2, 'back to the full story');

  // now add a note on the second message only, then switch to the notes lens
  await page.eval('(function () { document.getElementById("step-u2:0").querySelector(".add-note").click(); })()');
  await page.until((x) => x.noteBoxOpen, 'the note box on the second message to open');
  await page.eval('(function () { document.querySelector(".notebox textarea").value = "note on the second one"; })()');
  await page.click('.notebox .row2 button:first-child');
  await page.until((x) => x.notesTileNum === '1', 'the tile to count the new note');
  await page.click('.strip .item:nth-child(5)');
  const narrowed = await page.until((x) => x.notesTileOn, 'the notes lens to switch on');
  assert.deepEqual(narrowed.sectionHeadings, ['second message']);
  assert.equal(narrowed.noteMarkCount >= 1, true, 'the outline marks the section carrying a note');
  await page.close();
});

test('page: the notes counter in the header jumps between notes', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('u2:0', 'you')],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'first message', 'u1:0', []),
      section('you', 'second message', 'u2:0', []),
    ],
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 2, 'first paint');
  for (const sid of ['u1:0', 'u2:0']) {
    await page.eval('(function () { document.getElementById("step-' + sid + '").querySelector(".add-note").click(); })()');
    await page.until((x) => x.noteBoxOpen, 'a note box to open for ' + sid);
    await page.eval('(function () { document.querySelector(".notebox textarea").value = "note on ' + sid + '"; })()');
    // a notesChanged push for an earlier note in this same loop can land mid-click and redraw
    // the reader (rebuilding the open box's own DOM in the process); retry the click rather than
    // assume the button found a moment ago by page.until is still the one attached to the page.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await page.click('.notebox .row2 button:first-child'); break; } catch (_) { await sleep(100); }
    }
    await page.until((x) => !x.noteBoxOpen, 'the box to close after keeping');
  }
  await page.until((x) => x.notesJumpLabel === 'Notes 2', 'both notes counted');
  await page.click('#notesJump');
  const first = await page.until((x) => x.curHitId === 'step-u1:0' || x.curHitId === 'step-u2:0', 'the jump to land on one of the noted steps');
  const scrolledOnce = first.curHitId;
  // a push redraws the reader (here: the list of notes again, as from another window); the
  // mark on the current note has to be there afterwards
  fake.pushes.push({ type: 'notesChanged', sessionId: A, notes: noteList() });
  await sleep(500);
  assert.equal((await page.sample()).curHitId, scrolledOnce, 'the mark survives a redraw');
  await page.click('#notesJump');
  const second = await page.until((x) => x.curHitId !== null && x.curHitId !== scrolledOnce, 'a second click to move to the other note');
  assert.notEqual(second.curHitId, scrolledOnce, 'a second click moves to the other note');
  await page.close();
});

test('page: a note on a step off the current path stays listed, marked accordingly', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you'), step('u2:0', 'you')],
    sections: [
      section('lead', 'Session start', null, []),
      section('you', 'first message', 'u1:0', []),
      section('you', 'second message', 'u2:0', []),
    ],
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 2, 'first paint');
  await page.eval('(function () { document.getElementById("step-u1:0").querySelector(".add-note").click(); })()');
  await page.until((x) => x.noteBoxOpen, 'the note box on the first message to open');
  await page.eval('(function () { document.querySelector(".notebox textarea").value = "note before the retry"; })()');
  await page.click('.notebox .row2 button:first-child');
  await page.until((x) => x.savedNoteText, 'the note to be kept while the step is still on the path');
  const onPath = await page.sample();
  assert.equal(onPath.savedNoteOffPath, false, 'the note shows no warning while its step is on the path');

  // a retry drops the first message from the active path: the service sends a reset with a
  // shorter section list that no longer carries u1:0 anywhere, the note itself is untouched.
  fake.pushes.push({
    type: 'stepsChanged', sessionId: A, reset: 'u1:0',
    sections: [section('lead', 'Session start', null, []), section('you', 'retried message', 'u3:0', [])],
    strip: { activeTimeMs: 1000, sections: 2, decisions: 1, filesChanged: 0 },
  });
  await page.until((x) => x.sectionHeadings.indexOf('retried message') !== -1, 'the reset to land');
  const s = await page.sample();
  assert.equal(s.notesTileNum, '1', 'the note survives the reset, it is not deleted by a path change');
  await page.click('.strip .item:nth-child(5)');
  const narrowed = await page.until((x) => x.notesTileOn, 'the notes lens to switch on');
  assert.equal(narrowed.savedNoteOffPath, true, 'the orphaned note is listed with its off-path warning in the notes lens');
  assert.ok((await page.sample()).savedNoteText.indexOf('note before the retry') !== -1);
  await page.close();
});

test('page: a note containing markup renders as text, not as an element', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', [])],
    notes: [{ id: 'n1', stepId: 'u1:0', at: 1, text: '<img src=x onerror=alert(1)>', sent: [] }],
  });
  const page = await openPage(A);
  const s = await page.until((x) => x.savedNoteText, 'the note to render');
  assert.ok(s.savedNoteText.indexOf('<img') !== -1, 'the tag shows as literal text');
  assert.equal(s.imgCount, 0, 'no element was created from the note text');
  await page.close();
});

test('page: a note arriving by push from another viewer shows up without a reload', opts, async () => {
  fake.open = () => openReply({
    steps: [step('u1:0', 'you')],
    sections: [section('lead', 'Session start', null, []), section('you', 'first message', 'u1:0', [])],
  });
  const page = await openPage(A);
  await page.until((x) => x.sectionHeadings.length >= 1, 'first paint');
  fake.notes.set('pushed-note', { id: 'pushed-note', stepId: 'u1:0', at: Date.now(), text: 'added from another window' });
  fake.pushes.push({ type: 'notesChanged', sessionId: A, notes: noteList() });
  const s = await page.until((x) => x.savedNoteText, 'the pushed note to appear');
  assert.ok(s.savedNoteText.indexOf('added from another window') !== -1);
  assert.equal(s.notesTileNum, '1');
  await page.close();
});

test.after(() => {});
