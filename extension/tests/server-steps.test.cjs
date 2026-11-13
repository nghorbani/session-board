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

test.before(async () => {
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(transcript, [
    { type: 'user', uuid: uuid(1), parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello from the fixture transcript' } },
  ].map(line).join(''));
  fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });
  port = await freePort();
  child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.cjs')], {
    env: Object.assign({}, process.env, { SESSION_DASHBOARD_PORT: String(port), LOCALAPPDATA: tmp, XDG_DATA_HOME: tmp, SB_CODE_USER_DIR: path.join(tmp, 'User'), SB_SESSIONS_DIR: path.join(tmp, 'sessions'), SB_PROJECTS_DIR: projectsDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((res, rej) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (/Session Board: http/.test(out)) res(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => rej(new Error('server exited ' + code + ': ' + out)));
    setTimeout(() => rej(new Error('server did not start: ' + out)), 15000).unref();
  });
  const html = await (await fetch('http://127.0.0.1:' + port + '/')).text();
  token = (html.match(/name="board-token" content="([0-9a-f]+)"/) || [])[1] || '';
  assert.ok(token, 'the page carries the token');
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
