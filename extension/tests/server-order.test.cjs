'use strict';
/*
 * The browser server's order routes: POST /api/order?ids=<comma-joined ids> writes one rank
 * marker per id (nothing on a bad list, 400 over 8000 characters), POST /api/order/mode?mode=
 * writes sort.json (400 on an unknown mode), a missing token is 403. server.cjs runs as a
 * child on a free port with a temp data dir; the token comes from the served page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-server-order-'));
const dataDir = process.platform === 'win32' ? path.join(tmp, 'SessionBoard') : path.join(tmp, 'session-board');
const marker = (id) => path.join(dataDir, 'order', id + '.json');
const rankOf = (id) => JSON.parse(fs.readFileSync(marker(id), 'utf8')).rank;
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
  fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.cjs')], {
    env: Object.assign({}, process.env, { SESSION_DASHBOARD_PORT: String(port), LOCALAPPDATA: tmp, XDG_DATA_HOME: tmp, SB_CODE_USER_DIR: path.join(tmp, 'User'), SB_SESSIONS_DIR: path.join(tmp, 'sessions'), SB_PROJECTS_DIR: path.join(tmp, 'projects'), SB_HEARTBEAT_DIR: path.join(tmp, 'heartbeats') }),
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

test('POST /api/order?ids= writes rank markers; a bad id, an empty list or an oversized list is 400 and writes nothing', async () => {
  let r = await call('POST', '/api/order?ids=' + B + ',' + A);
  assert.deepEqual([r.status, r.body], [200, { ok: true, count: 2 }]);
  assert.equal(rankOf(B), 0);
  assert.equal(rankOf(A), 1);
  r = await call('POST', '/api/order?ids=' + A + ',nope');
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(rankOf(A), 1, 'nothing written on a bad list');
  r = await call('POST', '/api/order?ids=');
  assert.equal(r.status, 400);
  r = await call('POST', '/api/order');
  assert.equal(r.status, 400);
  const big = Array.from({ length: 230 }, (_, i) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(i).padStart(12, '0')).join(',');
  assert.ok(big.length > 8000);
  r = await call('POST', '/api/order?ids=' + big);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /too many/);
  assert.equal(fs.readdirSync(path.join(dataDir, 'order')).length, 2);
});

test('POST /api/order/mode?mode= writes sort.json; an unknown or missing mode is 400; a missing token is 403; GET is not a route', async () => {
  let r = await call('POST', '/api/order/mode?mode=manual');
  assert.deepEqual([r.status, r.body], [200, { ok: true, mode: 'manual' }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'sort.json'), 'utf8')).mode, 'manual');
  r = await call('POST', '/api/order/mode?mode=activity');
  assert.deepEqual([r.status, r.body], [200, { ok: true, mode: 'activity' }]);
  r = await call('POST', '/api/order/mode?mode=x');
  assert.equal(r.status, 400);
  r = await call('POST', '/api/order/mode');
  assert.equal(r.status, 400);
  r = await call('POST', '/api/order/mode?mode=manual', false);
  assert.equal(r.status, 403);
  r = await call('GET', '/api/order?ids=' + A);
  assert.equal(r.status, 404);
});
