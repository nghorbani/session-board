'use strict';
/*
 * The browser server's steps routes: POST /api/steps forwards a JSON body to
 * stepsService.handle (bounded reader: 64 KB, 413 above, 400 on invalid JSON), GET
 * /api/steps/poll?session=&after=<seq> drains the queued pushes for that session since seq,
 * and GET /steps serves the placeholder page (steps.html does not exist yet). Same token and
 * Host checks as every other route. server.cjs runs as a child on a free port with a temp
 * data dir and a real transcript file under SB_PROJECTS_DIR; the token comes from the served
 * page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const A = '11111111-2222-4333-8444-555555555555';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-server-steps-'));
const projectsDir = path.join(tmp, 'projects');
const slugDir = path.join(projectsDir, 'my-project');
const transcript = path.join(slugDir, A + '.jsonl');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

function uuid(n) { return '00000000-0000-4000-8000-' + String(n).padStart(12, '0'); }
function line(obj) { return JSON.stringify(obj) + '\n'; }

let child = null;
let port = 0;
let token = '';

async function call(method, route, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers);
  if (opts.withToken !== false) headers['x-board-token'] = token;
  const init = { method, headers };
  if (opts.body !== undefined) { init.body = opts.body; headers['content-type'] = 'application/json'; }
  const r = await fetch('http://127.0.0.1:' + port + route, init);
  let body;
  try { body = await r.json(); } catch (_) { body = await (async () => '')(); }
  return { status: r.status, body };
}

/** server.cjs as a child on a free port, with this suite's temp folders; resolves once it
    listens and has handed out its token. */
async function startServer(extraEnv) {
  const p = await freePort();
  const c = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.cjs')], {
    env: Object.assign({}, process.env, { SESSION_DASHBOARD_PORT: String(p), LOCALAPPDATA: tmp, XDG_DATA_HOME: tmp, SB_CODE_USER_DIR: path.join(tmp, 'User'), SB_SESSIONS_DIR: path.join(tmp, 'sessions'), SB_PROJECTS_DIR: projectsDir }, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((res, rej) => {
    let out = '';
    c.stdout.on('data', (d) => { out += d; if (/Session Board: http/.test(out)) res(); });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => rej(new Error('server exited ' + code + ': ' + out)));
    setTimeout(() => rej(new Error('server did not start: ' + out)), 15000).unref();
  });
  const html = await (await fetch('http://127.0.0.1:' + p + '/')).text();
  const t = (html.match(/name="board-token" content="([0-9a-f]+)"/) || [])[1] || '';
  assert.ok(t, 'the page carries the token');
  return { child: c, port: p, token: t };
}

test.before(async () => {
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(transcript, [
    { type: 'user', uuid: uuid(1), parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello from the fixture transcript' } },
  ].map(line).join(''));
  fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });
  const s = await startServer();
  child = s.child; port = s.port; token = s.token;
});

test.after(async () => {
  if (child) child.kill();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('POST /api/steps open forwards to the service and answers an openResult', async () => {
  const r = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'open', requestId: 'r1', sessionId: A }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.type, 'openResult');
  assert.equal(r.body.ok, true);
  assert.ok(Array.isArray(r.body.steps));
});

test('open answers the real session title read from the transcript when no live row names it', async () => {
  const other = uuid(9);
  const otherFile = path.join(slugDir, other + '.jsonl');
  fs.writeFileSync(otherFile, [
    { type: 'user', uuid: uuid(10), parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'plan the migration' } },
    { type: 'custom-title', sessionId: other, customTitle: 'Plan the migration' },
  ].map(line).join(''));
  const r = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'open', requestId: 'r1', sessionId: other }) });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.title, 'Plan the migration', 'the title comes from the transcript, not the session\'s id');
});

test('invalid JSON is a 400, a missing token is 403', async () => {
  let r = await call('POST', '/api/steps', { body: '{not json' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'open', sessionId: A }), withToken: false });
  assert.equal(r.status, 403);
});

test('a body over 64 KB is a 413', async () => {
  const big = JSON.stringify({ type: 'open', sessionId: A, pad: 'x'.repeat(70 * 1024) });
  const r = await call('POST', '/api/steps', { body: big });
  assert.equal(r.status, 413);
});

test('GET /api/steps/poll drains pushes queued for the session since a given seq', async () => {
  await call('POST', '/api/steps', { body: JSON.stringify({ type: 'open', requestId: 'r1', sessionId: A }) });
  fs.appendFileSync(transcript, line({ type: 'assistant', uuid: uuid(2), parentUuid: uuid(1), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'reply' }] }, timestamp: new Date().toISOString() }));
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const poll = await call('GET', '/api/steps/poll?session=' + A + '&after=0');
    if (poll.body.pushes && poll.body.pushes.some((p) => p.type === 'stepsChanged')) seen = true;
  }
  assert.ok(seen, 'a stepsChanged push arrived through the poll route');
});

test('GET /steps serves the page with the token and session id in their meta tags', async () => {
  const r = await fetch('http://127.0.0.1:' + port + '/steps?session=' + A);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(/Steps viewer coming soon/.test(text) || /<html/.test(text));
  assert.ok(text.indexOf('name="steps-session" content="' + A + '"') !== -1, 'a valid session id is passed through');
  assert.ok(text.indexOf('name="board-token"') !== -1);
});

test('GET /steps never injects markup from the session query, however it is crafted', async () => {
  const attempts = [
    '"><script>window.__pwned=1</script>',
    '$&$\'$`',   // String.replace's own special replacement patterns, passed as a session id
  ];
  for (const bad of attempts) {
    const r = await fetch('http://127.0.0.1:' + port + '/steps?session=' + encodeURIComponent(bad));
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.equal(/<script>window\.__pwned/.test(text), false, 'no injected script tag for ' + JSON.stringify(bad));
    assert.equal(text.indexOf('"><script>') !== -1, false, 'the raw attempt never lands verbatim in the page');
    // not a well-formed session id, so the page gets an empty value rather than attacker text
    assert.ok(text.indexOf('name="steps-session" content="">') !== -1, 'an invalid session id becomes an empty meta value for ' + JSON.stringify(bad));
  }
});

test('GET /steps lets the page script run: the policy names a nonce and the script tag carries it', async () => {
  const text = await (await fetch('http://127.0.0.1:' + port + '/steps?session=' + A)).text();
  const m = /script-src 'nonce-([A-Za-z0-9_-]{16,})'/.exec(text);
  assert.ok(m, 'the policy allows one nonce, not every inline script');
  if (/<script/.test(text)) {
    assert.ok(text.indexOf('<script nonce="' + m[1] + '">') !== -1, 'the page script carries that nonce');
    assert.equal(/<script>/.test(text), false, 'no script tag is left without a nonce');
  }
  const again = await (await fetch('http://127.0.0.1:' + port + '/steps?session=' + A)).text();
  assert.notEqual(/script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(again)[1], m[1], 'a fresh nonce for every response');
});

test('a bad session id on /api/steps/poll is a 400', async () => {
  const r = await call('GET', '/api/steps/poll?session=not-a-uuid&after=0');
  assert.equal(r.status, 400);
});

test('a note round trip over POST /api/steps: add, carried by open, edit, delete', async () => {
  const opened = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'open', requestId: 'r1', sessionId: A }) });
  const stepId = opened.body.steps[0].id;

  const added = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'noteAdd', sessionId: A, stepId, text: 'a browser-side note' }) });
  assert.equal(added.status, 200);
  assert.equal(added.body.ok, true);
  const noteId = added.body.note.id;

  const reopened = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'open', requestId: 'r2', sessionId: A }) });
  assert.ok(Array.isArray(reopened.body.notes));
  assert.ok(reopened.body.notes.some((n) => n.id === noteId && n.text === 'a browser-side note'));

  const edited = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'noteEdit', sessionId: A, noteId, text: 'edited over the wire' }) });
  assert.equal(edited.body.ok, true);
  assert.equal(edited.body.note.text, 'edited over the wire');

  const deleted = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'noteDelete', sessionId: A, noteId }) });
  assert.equal(deleted.body.ok, true);
  assert.equal(deleted.body.removed, true);
});

test('a note just under the 16 KB cap is accepted over the 64 KB body limit', async () => {
  const opened = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'open', requestId: 'r1', sessionId: A }) });
  const stepId = opened.body.steps[0].id;
  const text = 'x'.repeat(16 * 1024 - 1);
  const r = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'noteAdd', sessionId: A, stepId, text }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
});

// -- the browser transport's deliver (copy only) ---------------------------------------

test('noteSend over the browser transport always answers copy-only: ok false, the clipboard line, no sent record', async () => {
  const opened = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'open', requestId: 'r1', sessionId: A }) });
  const stepId = opened.body.steps[0].id;
  const added = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'noteAdd', sessionId: A, stepId, text: 'why this approach?' }) });
  const noteId = added.body.note.id;

  const sent = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'noteSend', sessionId: A, noteId }) });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.type, 'noteSendResult');
  assert.equal(sent.body.ok, false, 'the server never delivers into a chat box');
  assert.equal(sent.body.message, 'On the clipboard. Paste it into the session.');

  const reopened = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'open', requestId: 'r2', sessionId: A }) });
  const note = reopened.body.notes.find((n) => n.id === noteId);
  assert.deepEqual(note.sent, [], 'a copy-only reply is not recorded as sent');
});

test('notesSendAll over the browser transport answers copy-only the same way', async () => {
  const opened = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'open', requestId: 'r1', sessionId: A }) });
  const stepId = opened.body.steps[0].id;
  await call('POST', '/api/steps', { body: JSON.stringify({ type: 'noteAdd', sessionId: A, stepId, text: 'a note' }) });

  const result = await call('POST', '/api/steps', { body: JSON.stringify({ type: 'notesSendAll', sessionId: A }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.type, 'notesSendAllResult');
  assert.equal(result.body.ok, false);
  assert.equal(result.body.message, 'On the clipboard. Paste it into the session.');
});

test('a browser viewer that stops polling is released: its next poll says so, and a new open starts over', async () => {
  // a server of its own with a short idle limit: three ticks of 60 ms without a request
  const srv = await startServer({ SB_STEPS_VIEWER_TICK_MS: '60', SB_STEPS_VIEWER_IDLE_TICKS: '3' });
  const base = 'http://127.0.0.1:' + srv.port;
  const headers = { 'x-board-token': srv.token, 'content-type': 'application/json' };
  const post = async (msg) => (await fetch(base + '/api/steps', { method: 'POST', headers, body: JSON.stringify(msg) })).json();
  const poll = async () => (await fetch(base + '/api/steps/poll?session=' + A + '&after=0', { headers })).json();
  try {
    const opened = await post({ type: 'open', requestId: 'r1', sessionId: A });
    assert.equal(opened.ok, true);
    // a viewer that keeps polling stays, well past the idle limit
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 60)); assert.equal((await poll()).expired, undefined, 'still polling, still served'); }
    await new Promise((r) => setTimeout(r, 600));   // the tab is closed: no request for ten ticks
    const late = await poll();
    assert.equal(late.expired, true, 'the poll of a released viewer says so');
    const body = await post({ type: 'bodies', sessionId: A, stepIds: [opened.steps[0].id], generation: opened.generation });
    assert.equal(body.items[0].stale, true, 'the index went with the viewer');
    const again = await post({ type: 'open', requestId: 'r2', sessionId: A });
    assert.equal(again.ok, true, 'a new open reads the transcript again');
    assert.equal((await poll()).expired, undefined);
  } finally {
    srv.child.kill();
  }
});
