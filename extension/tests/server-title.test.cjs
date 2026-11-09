'use strict';
/*
 * The browser server's title routes: POST /api/title/<id>?title= writes Claude Code's title of a
 * session that is not running (the custom-title line and the sidecar), bad input is 400, a
 * missing transcript 404, a missing token 403, and the old /api/retitle route is gone. The
 * suggestion route is covered through suggestTitle in title.test.cjs (it runs the CLI). server.cjs runs as
 * a child on a free port with a temp data dir; the token comes from the served page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const A = '11111111-2222-4333-8444-555555555555';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-server-'));
const dataDir = process.platform === 'win32' ? path.join(tmp, 'SessionBoard') : path.join(tmp, 'session-board');
const projects = path.join(tmp, 'projects', 'proj');
fs.mkdirSync(projects, { recursive: true });
const transcript = path.join(projects, A + '.jsonl');
fs.writeFileSync(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'Generated', sessionId: A }) + String.fromCharCode(10));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let child = null;
let port = 0;
let token = '';

async function call(method, route, withToken) {
  const headers = {};
  if (withToken !== false) headers['x-board-token'] = token;
  const r = await fetch('http://127.0.0.1:' + port + route, { method, headers });
  return { status: r.status, body: await r.json() };
}

test.before(async () => {
  port = await freePort();
  child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.cjs')], {
    env: Object.assign({}, process.env, { SESSION_DASHBOARD_PORT: String(port), LOCALAPPDATA: tmp, XDG_DATA_HOME: tmp, SB_CODE_USER_DIR: path.join(tmp, 'User'), SB_SESSIONS_DIR: path.join(tmp, 'sessions'), SB_PROJECTS_DIR: path.join(tmp, 'projects') }),
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

test('POST /api/title writes the custom-title line and the sidecar of an ended session', async () => {
  const r = await call('POST', '/api/title/' + A + '?title=' + encodeURIComponent('From the browser'));
  assert.deepEqual([r.status, r.body], [200, { ok: true, title: 'From the browser' }]);
  const last = fs.readFileSync(transcript, 'utf8').trim().split(String.fromCharCode(10)).pop();
  assert.deepEqual(JSON.parse(last), { type: 'custom-title', sessionId: A, customTitle: 'From the browser' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(projects, A, 'custom-title.json'), 'utf8')), { customTitle: 'From the browser' });
});

test('bad id or empty or long title is 400, no transcript 404, no token 403; /api/retitle is gone', async () => {
  let r = await call('POST', '/api/title/nope?title=x');
  assert.equal(r.status, 400);
  r = await call('POST', '/api/title/' + A + '?title=');
  assert.deepEqual([r.status, r.body.code], [400, 'empty']);
  r = await call('POST', '/api/title/' + A + '?title=' + 'x'.repeat(201));
  assert.equal(r.status, 400);
  r = await call('POST', '/api/title/cccccccc-3333-4333-8333-333333333333?title=x');
  assert.deepEqual([r.status, r.body.code], [404, 'no-transcript']);
  r = await call('POST', '/api/title/' + A + '?title=x', false);
  assert.equal(r.status, 403);
  r = await call('POST', '/api/retitle/' + A);
  assert.equal(r.status, 404);
});
