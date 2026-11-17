#!/usr/bin/env node
/**
 * Renders the README screenshots with example data, in a headless Chromium (Chrome or Edge).
 * No real session data is read.
 *
 *   node tools/screenshot.cjs          -> extension/media/board.png, search.png and steps.png
 *   node tools/screenshot.cjs steps    -> only the pictures named
 *
 * board and search come from extension/index.html, with the page's fetch calls answered from
 * the fixtures below. steps comes from extension/steps.html over the real steps service
 * (extension/steps-service.cjs) reading an example transcript written to a temp folder, so
 * the picture shows what the reader makes of a transcript, not a reply written by hand.
 *
 * Set SCREENSHOT_BROWSER to a Chromium executable when none of the usual paths exist
 * (tools/chrome.cjs holds them).
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { browser, freePort, startChrome } = require('./chrome.cjs');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'extension', 'index.html');
const STEPS = path.join(ROOT, 'extension', 'steps.html');
const OUT_DIR = path.join(ROOT, 'extension', 'media');
const WIDTH = 440;
const STEPS_WIDTH = 1100;

// -- fixtures ----------------------------------------------------------------------------

const now = Date.now();
const HOUR = 3600 * 1000;

function session(sessionId, title, status, extra) {
  return Object.assign({
    sessionId, title, status, waitingFor: null, name: null, lastPrompt: null,
    cwd: 'C:\\code\\acme\\webapp', window: { id: 1, label: 'webapp' }, ageMinutes: 0,
    contextTokens: 120000, pct: 13, transcriptPath: null, kind: 'interactive',
  }, extra);
}

const sessions = [
  session('57f9950b-6af0-43b1-8cf6-df44231415d6', 'Fix flaky upload test', 'waiting', { waitingFor: 'permission prompt', ageMinutes: 4, contextTokens: 168000, pct: 18 }),
  session('9c6e6599-150d-4902-86d7-0912fb739fb2', 'Release notes for 2.4', 'waiting', { waitingFor: 'input needed', ageMinutes: 22, contextTokens: 94000, pct: 10, cwd: 'C:\\code\\acme\\docs', window: { id: 2, label: 'docs' } }),
  session('8de2ac3e-106d-4060-8465-ad7df94a6f7c', 'Migrate auth to OAuth', 'busy', { contextTokens: 611000, pct: 66 }),
  session('8ea18419-65ce-4e4d-800a-fc1766733b8e', 'Refactor CSV importer', 'busy', { contextTokens: 872000, pct: 95, cwd: 'C:\\code\\acme\\api', window: { id: 3, label: 'api' } }),
  session('06011aa6-f5ad-4143-81a7-ec8d73d905d6', 'Explore vector databases', 'idle', { ageMinutes: 48, contextTokens: 42000, pct: 5, cwd: 'C:\\code\\acme\\research', window: { id: 2, label: 'docs' }, unseen: true }),
  session('f012f188-e632-41b8-82a0-99a8e5855280', 'Spike: streaming parser', 'idle', { ageMinutes: 95, contextTokens: 210000, pct: 23, archived: true }),
  session('5ec9d000-209b-466d-8118-6f18417f7a92', 'Nightly dependency bump', 'idle', { ageMinutes: 35, contextTokens: 76000, pct: 8, cwd: 'C:\\code\\acme\\api', window: { id: 3, label: 'api' }, muted: true }),
];

const snapshot = {
  at: now, stale: false, error: null, limits: { compact: 920000, save: 846400 }, platform: 'win32', sessions, thisWindowId: 1, order: { mode: 'activity', show: 'open' },
  ended: [
    { sessionId: '3f1c9a20-7b44-4c1e-9d2a-5e8f0b6a1c33', status: 'ended', live: false, title: 'Upload retry policy review', lastPrompt: null, cwd: 'C:/code/acme/webapp', transcriptPath: 'C:/Users/dev/.claude/projects/C--code-acme-webapp/3f1c9a20.jsonl', path: 'C:/Users/dev/.claude/projects/C--code-acme-webapp/3f1c9a20.jsonl', folder: 'C--code-acme-webapp', ageMinutes: 190, hasTranscript: true, archived: false, window: { id: 1, label: 'webapp' } },
    { sessionId: '8b7e2d41-1a90-4f3b-8c6d-2e4a9f0c7b15', status: 'ended', live: false, title: 'Login page copy changes', lastPrompt: null, cwd: 'C:/code/acme/webapp', transcriptPath: 'C:/Users/dev/.claude/projects/C--code-acme-webapp/8b7e2d41.jsonl', path: 'C:/Users/dev/.claude/projects/C--code-acme-webapp/8b7e2d41.jsonl', folder: 'C--code-acme-webapp', ageMinutes: 1500, hasTranscript: true, archived: false, window: { id: 1, label: 'webapp' } },
  ],
  usage: {
    state: 'ok', at: now - 2 * 60000, ageSeconds: 120, subscriptionType: 'max', available: true,
    windows: {
      five_hour: { label: '5h', usedPct: 42, resetsAt: now + 2 * HOUR + 10 * 60000, expired: false },
      seven_day: { label: '7d', usedPct: 18, resetsAt: now + 3 * 24 * HOUR, expired: false },
      seven_day_opus: { label: '7d Opus', usedPct: 61, resetsAt: now + 3 * 24 * HOUR, expired: false },
    },
    extraUsage: null, error: null, cacheError: null,
    account: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'dev@example.com', orgName: 'Example', subscriptionType: 'max' }, accountError: null,
  },
};

const searchRows = [
  { sessionId: '8ea18419-65ce-4e4d-800a-fc1766733b8e', title: 'Refactor CSV importer', live: true, status: 'busy', folder: 'acme/api', cwd: 'C:\\code\\acme\\api', ageMinutes: 0, window: { id: 3, label: 'api' },
    snippets: ['…the CSV importer chokes on quoted newlines; the new parser streams rows instead…'] },
  { sessionId: '96655b25-aa6f-4954-8905-59d65d781f9a', title: 'CSV importer v1', live: false, folder: 'acme/api', cwd: 'C:\\code\\acme\\api', ageMinutes: 60 * 24 * 12,
    snippets: ['…wrote the first CSV importer with a fixed delimiter; header row optional…', '…the CSV files from the ERP export use semicolons…'] },
  { sessionId: '51f0fe27-2fba-40e5-89d8-62b248fa5239', title: 'Invoice export cleanup', live: false, folder: 'acme/webapp', cwd: 'C:\\code\\acme\\webapp', ageMinutes: 60 * 24 * 40,
    snippets: ['…export invoices as CSV instead of XLSX for the accounting hand-off…'] },
];

// -- the example session of the Steps picture ------------------------------------------------

const STEPS_SESSION = '57f9950b-6af0-43b1-8cf6-df44231415d6';
const STEPS_TITLE = 'Fix flaky upload test';
const NOTE_TEXT = 'Ask the team whether 5 seconds is the right cap before this merges.';

/** The lines of an invented transcript, in the shape Claude Code stores them. */
function stepsTranscript() {
  const lines = [];
  let prev = null;
  let clock = new Date(2026, 0, 15, 14, 2, 0).getTime();   // fixed, so the times in the picture stay the same
  const add = (o, seconds) => {
    clock += seconds * 1000;
    const uuid = '00000000-0000-4000-8000-' + String(lines.length + 1).padStart(12, '0');
    lines.push(Object.assign({ uuid, parentUuid: prev, timestamp: new Date(clock).toISOString() }, o));
    prev = uuid;
  };
  const you = (text, s) => add({ type: 'user', message: { role: 'user', content: text } }, s);
  const says = (block, s) => add({ type: 'assistant', message: { id: 'msg' + lines.length, role: 'assistant', content: [block] } }, s);
  const text = (t, s) => says({ type: 'text', text: t }, s);
  const update = (t, s) => says({ type: 'thinking', thinking: t, signature: 'example' }, s);
  const tool = (id, name, input, s, result, took) => {
    says({ type: 'tool_use', id, name, input }, s);
    add({ type: 'user', toolUseResult: {}, sourceToolAssistantUUID: prev, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } }, took);
  };
  const SRC = 'C:\\code\\acme\\webapp\\src\\upload\\retry.ts';
  const TEST = 'C:\\code\\acme\\webapp\\tests\\upload.test.ts';
  const QUESTION = 'The test waits a fixed 200 ms, but the retry backs off for up to 400 ms. How should I fix it?';

  you('The upload test fails about one run in five on CI. Find out why and fix it.', 0);
  text('I will reproduce the failure first, then read the retry code the test exercises.', 6);
  tool('t1', 'Bash', { command: 'npx vitest run tests/upload.test.ts --repeat 20', description: 'Run the upload test 20 times' }, 4, '16 passed, 4 failed (20)', 48);
  update('4 of 20 runs fail, all on the retry assertion. Reading the retry code.', 3);
  tool('t2', 'Read', { file_path: SRC }, 2, 'export async function retry(fn, attempts) { /* ... */ }', 1);
  tool('t3', 'Read', { file_path: TEST }, 2, 'it("retries a failed chunk", async () => { /* ... */ });', 1);
  tool('q1', 'AskUserQuestion', { questions: [{
    header: 'Fix', question: QUESTION, multiSelect: false,
    options: [
      { label: 'Fake timers in the test', description: 'The test drives the clock itself and no longer depends on real time. No change to the product code.' },
      { label: 'Wait longer', description: 'Raise the wait to 600 ms. The smallest change, but the test stays slow and can still fail on a loaded runner.' },
      { label: 'Pass the delay in', description: 'Make the back-off a parameter of the uploader. Cleanest to test, but it changes the public options.' },
    ],
  }] }, 20, 'Your questions have been answered: "' + QUESTION + '"="Fake timers in the test". You can now continue.', 95);
  update('Switching the test to fake timers.', 4);
  tool('t4', 'Edit', { file_path: TEST, old_string: 'await sleep(200);', new_string: 'await vi.advanceTimersByTimeAsync(400);' }, 9, 'The file has been updated.', 1);
  tool('t5', 'Bash', { command: 'npx vitest run tests/upload.test.ts --repeat 50', description: 'Run the upload test 50 times' }, 3, '50 passed (50)', 61);
  text('**Fixed.** The test no longer waits on real time.\n\n'
    + '- `tests/upload.test.ts` uses fake timers and moves the clock past each back-off step.\n'
    + '- 50 runs in a row pass. Before the change, 4 of 20 failed.\n\n'
    + 'The retry code is unchanged. One thing I noticed in [src/upload/retry.ts](src/upload/retry.ts): '
    + 'the back-off has no upper limit after the fifth attempt.', 8);
  you('Cap the back-off at 5 seconds and add a test for it.', 140);
  update('Adding the cap, then a test for the sixth attempt.', 5);
  tool('t6', 'Edit', { file_path: SRC, old_string: 'const wait = base * 2 ** attempt;', new_string: 'const wait = Math.min(base * 2 ** attempt, 5000);' }, 12, 'The file has been updated.', 1);
  tool('t7', 'Edit', { file_path: TEST, old_string: '});', new_string: 'it("caps the back-off at 5 seconds", async () => { /* ... */ });\n});' }, 15, 'The file has been updated.', 1);
  tool('t8', 'Bash', { command: 'npx vitest run tests/upload.test.ts', description: 'Run the upload tests' }, 3, '7 passed (7)', 9);
  text('The back-off is capped at 5 seconds, and `caps the back-off at 5 seconds` checks the sixth attempt. All 7 upload tests pass.', 6);
  return lines;
}

// -- rendering ---------------------------------------------------------------------------

function mock(mode) {
  return `
window.Notification = undefined;
document.body.classList.add('vscode');
var __snapshot = ${JSON.stringify(snapshot)};
var __rows = ${JSON.stringify(searchRows)};
window.fetch = function (url) {
  var u = String(url);
  var body = {};
  if (u.indexOf('/api/sessions') === 0) body = __snapshot;
  else if (u.indexOf('/api/search') === 0) {
    var m = u.match(/requestId=([^&]+)/);
    body = { requestId: m ? decodeURIComponent(m[1]) : '', query: 'csv', content: true, total: 3, shown: 3, partial: false, skipped: 0, rgAvailable: true, rows: __rows };
  }
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
};
${mode === 'search' ? `
setTimeout(function () {
  var q = document.getElementById('q');
  q.value = 'csv';
  q.dispatchEvent(new Event('input'));
  q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
}, 400);` : ''}
`;
}

function render(mode, out, height) {
  // Chromium will not shrink its window below roughly 500 px, so the page is pinned to the
  // sidebar width and the capture is cropped to it.
  const html = fs.readFileSync(INDEX, 'utf8')
    .replace('</head>', '<style>html, body { width: ' + WIDTH + 'px !important; }</style></head>')
    .replace('<script>', '<script>' + mock(mode) + '</script>\n<script>');
  const tmp = path.join(os.tmpdir(), 'session-board-demo-' + mode + '.html');
  fs.writeFileSync(tmp, html);
  try {
    execFileSync(browser(), [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
      '--window-size=' + WIDTH + ',' + height, '--virtual-time-budget=3000',
      '--screenshot=' + out, 'file:///' + tmp.replace(/\\/g, '/'),
    ], { stdio: 'ignore', timeout: 60000 });
  } finally {
    fs.unlinkSync(tmp);
  }
  console.log('wrote ' + out);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Steps page over the real steps service, the way server.cjs serves it (without the
    content policy, so the page can be given the VS Code colours). */
async function renderSteps(out, width, height) {
  const { createStepsService } = require(path.join(ROOT, 'extension', 'steps-service.cjs'));
  // The browser first: when none is found this throws before anything else is started, so
  // no server and no follow timer are left to keep the process alive.
  const chrome = await startChrome(['--hide-scrollbars']);
  const send = chrome.send;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-board-demo-steps-'));
  let server = null;
  let unsubscribe = null;
  try {
    const file = path.join(dir, STEPS_SESSION + '.jsonl');
    fs.writeFileSync(file, stepsTranscript().map((l) => JSON.stringify(l) + '\n').join(''));
    const service = createStepsService({ resolveTranscript: () => file, sessionTitle: () => STEPS_TITLE, dataDir: dir });
    const pushes = [];
    unsubscribe = service.subscribe(STEPS_SESSION, (msg) => pushes.push(msg));

    // what the owner did before the picture: read up to the first answer, and kept a note there
    const opened = await service.handle({ type: 'open', sessionId: STEPS_SESSION });
    const fixed = opened.steps.find((s) => s.kind === 'text' && s.preview.indexOf('Fixed.') !== -1);
    await service.handle({ type: 'noteAdd', sessionId: STEPS_SESSION, stepId: fixed.id, text: NOTE_TEXT });
    await service.handle({ type: 'seen', sessionId: STEPS_SESSION, stepId: fixed.id });

    const token = 'example';
    const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/steps') {
        const html = fs.readFileSync(STEPS, 'utf8')
          .replace('<meta charset="utf-8">', () => '<meta charset="utf-8"><meta name="board-token" content="' + token + '"><meta name="steps-session" content="' + STEPS_SESSION + '">')
          .replace('<script>', () => '<script>document.body.classList.add("vscode");</script>\n<script>');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } else if (u.pathname === '/api/steps' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let msg = null;
          try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* answered below */ }
          if (!msg) return json(res, 400, { error: 'invalid JSON' });
          if (msg.type === 'seen') return json(res, 200, { type: 'seenResult', ok: true });   // the picture keeps the marker where the fixture put it
          service.handle(msg).then((reply) => json(res, 200, reply), (e) => json(res, 500, { error: String(e) }));
        });
      } else if (u.pathname === '/api/steps/poll') {
        const after = Number(u.searchParams.get('after') || 0) || 0;
        json(res, 200, { seq: pushes.length, pushes: pushes.slice(after) });
      } else {
        json(res, 404, { error: 'not found' });
      }
    });
    const port = await freePort();
    await new Promise((res) => server.listen(port, '127.0.0.1', res));

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/steps?session=' + STEPS_SESSION }, sessionId);
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    };
    const until = async (expression, what) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(150); }
      throw new Error('the Steps page did not show ' + what);
    };
    // drawn means: the texts are in as formatted text, the question shows its options, the
    // note and the marker are there, and the last text of the story has loaded
    const drawn = 'document.querySelectorAll(".row .body.md b").length > 0 && document.querySelectorAll(".qopt").length === 3'
      + ' && !!document.querySelector(".saved-note") && !!document.querySelector(".new-marker")'
      + ' && Array.prototype.some.call(document.querySelectorAll(".row .body.md code"), function (e) { return e.textContent.indexOf("caps the back-off") !== -1; })';
    const toEnd = '(function () { var r = document.getElementById("reader"); r.scrollTop = r.scrollHeight; r.dispatchEvent(new Event("scroll")); return true; })()';
    // how far the second section's heading sits below the top of the reader
    const gap = '(function () { var r = document.getElementById("reader"); var h = document.querySelectorAll(".sec-head")[1]; return Math.round(h.getBoundingClientRect().top - r.getBoundingClientRect().top); })()';
    await until('document.querySelectorAll(".section").length > 0', 'its sections');
    await evaluate(toEnd);
    await until(drawn, 'the whole example story');
    // The picture runs from the second section to the end of the story: with the reader at its
    // end, the window is made as tall as it takes to put that section's heading at the top.
    const fitted = height - (await evaluate(gap)) + 18;
    await send('Emulation.setDeviceMetricsOverride', { width, height: fitted, deviceScaleFactor: 2, mobile: false }, sessionId);
    await evaluate(toEnd);
    await until(drawn, 'the whole example story at its final size');
    // Scrolling by script can leave the Follow switch either way. At the end of the story it
    // is on, as it is for someone who opens the tab; set here so every run draws the same.
    await evaluate('(function () { var f = document.getElementById("follow"); if (!f.checked) f.click(); return true; })()');
    await until(drawn, 'the whole example story with Follow on');
    // Two frames and a pause, so the picture is taken of the final layout: a browser that
    // has just started can still be showing the frame from before the window was resized.
    await send('Runtime.evaluate', { expression: 'new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(true); }); }); })', awaitPromise: true }, sessionId);
    await sleep(800);
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  } finally {
    await chrome.close();
    if (server) await new Promise((res) => server.close(res));
    if (unsubscribe) unsubscribe();   // the last subscriber gone, the service drops its follow timer and this process can end
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* left to the temp cleanup */ }
  }
  console.log('wrote ' + out);
}

if (require.main === module) {
  const known = ['board', 'search', 'steps'];
  const asked = process.argv.slice(2);
  const unknown = asked.filter((n) => known.indexOf(n) === -1);
  if (unknown.length) {
    console.error('unknown picture: ' + unknown.join(', ') + ' (known: ' + known.join(', ') + ')');
    process.exit(2);
  }
  const names = asked.length ? asked : known;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Heights fit the fixtures above; adjust when they change (SCREENSHOT_*_HEIGHT override).
  // The Steps picture starts from its height and then fits itself to the example story.
  const heights = {
    board: Number(process.env.SCREENSHOT_BOARD_HEIGHT) || 1000,
    search: Number(process.env.SCREENSHOT_SEARCH_HEIGHT) || 870,
    steps: Number(process.env.SCREENSHOT_STEPS_HEIGHT) || 1200,
  };
  (async () => {
    if (names.indexOf('board') !== -1) render('board', path.join(OUT_DIR, 'board.png'), heights.board);
    if (names.indexOf('search') !== -1) render('search', path.join(OUT_DIR, 'search.png'), heights.search);
    if (names.indexOf('steps') !== -1) await renderSteps(path.join(OUT_DIR, 'steps.png'), STEPS_WIDTH, heights.steps);
  })().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
