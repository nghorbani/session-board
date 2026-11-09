'use strict';
/*
 * The browser server's mute routes: POST /api/mute/<id> writes the marker, POST
 * /api/unmute/<id> removes it, a bad id is 400 and a missing token 403; the old blind routes
 * are gone. server.cjs runs as
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
const marker = path.join(dataDir, 'muted', A + '.json');
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

test('POST /api/mute writes the marker and /api/unmute removes it', async () => {
  let r = await call('POST', '/api/mute/' + A);
  assert.deepEqual([r.status, r.body], [200, { ok: true, muted: true }]);
  assert.ok(fs.existsSync(marker), 'marker at ' + marker);
  r = await call('POST', '/api/unmute/' + A);
  assert.deepEqual([r.status, r.body], [200, { ok: true, muted: false }]);
  assert.equal(fs.existsSync(marker), false);
  r = await call('POST', '/api/unmute/' + A);
  assert.equal(r.status, 200, 'a second unmute is still fine');
});

test('a bad id is 400, a missing token 403, GET is not a route', async () => {
  let r = await call('POST', '/api/mute/nope');
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  r = await call('POST', '/api/mute/' + A, false);
  assert.equal(r.status, 403);
  r = await call('GET', '/api/mute/' + A);
  assert.equal(r.status, 404);
  r = await call('POST', '/api/blind/' + A);
  assert.equal(r.status, 404, 'the 0.10.0 route is gone');
});
