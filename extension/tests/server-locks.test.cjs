'use strict';
/*
 * The browser server's lock and show routes: POST /api/locks takes a JSON body { set, move,
 * clear } and writes one lock marker per id (nothing on a bad entry, 400; malformed JSON 400; a
 * body over the limit 413), POST /api/order/show?show= writes show.json in its old format, the
 * retired order routes are 404, a missing token is 403. server.cjs runs as a child on a free
 * port with a temp data dir; the token comes from the served page.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-server-locks-'));
const dataDir = process.platform === 'win32' ? path.join(tmp, 'SessionBoard') : path.join(tmp, 'session-board');
const marker = (id) => path.join(dataDir, 'locks', id + '.json');
const slotOf = (id) => JSON.parse(fs.readFileSync(marker(id), 'utf8')).slot;
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let child = null;
let port = 0;
let token = '';

async function call(method, route, withToken, body) {
  const headers = {};
  if (withToken !== false) headers['x-board-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch('http://127.0.0.1:' + port + route, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
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

test('POST /api/locks writes lock markers from a JSON body; move never creates one; clear removes', async () => {
  let r = await call('POST', '/api/locks', true, { set: { [A]: 2 } });
  assert.deepEqual([r.status, r.body], [200, { ok: true, set: 1, moved: 0, cleared: 0 }]);
  assert.equal(slotOf(A), 2);
  r = await call('POST', '/api/locks', true, { set: { [B]: 0 }, move: { [A]: 1 } });
  assert.deepEqual([r.status, r.body], [200, { ok: true, set: 1, moved: 1, cleared: 0 }]);
  assert.deepEqual([slotOf(A), slotOf(B)], [1, 0]);
  r = await call('POST', '/api/locks', true, { clear: [B], move: { 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': 4 } });
  assert.deepEqual([r.status, r.body], [200, { ok: true, set: 0, moved: 0, cleared: 1 }]);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'locks')), [A + '.json'], 'B cleared, the unlocked id not created');
});

test('POST /api/locks: a bad entry, malformed JSON or an empty request is 400 and writes nothing; an oversized body is 413; no token is 403; GET is not a route', async () => {
  let r = await call('POST', '/api/locks', true, { set: { [A]: 5, nope: 1 } });
  assert.deepEqual([r.status, r.body.ok], [400, false]);
  assert.match(r.body.error, /not a session id/);
  r = await call('POST', '/api/locks', true, { set: { [A]: -1 } });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/locks', true, '{"set":{"' + A + '":{"toString":null}}}');
  assert.deepEqual([r.status, /not a slot/.test(r.body.error)], [400, true], 'a slot that cannot be printed is a bad request, not a server error');
  r = await call('POST', '/api/locks', true, '{"set":');
  assert.deepEqual([r.status, r.body.error], [400, 'invalid JSON']);
  r = await call('POST', '/api/locks', true, {});
  assert.equal(r.status, 400);
  r = await call('POST', '/api/locks', true, '"x"');
  assert.equal(r.status, 400);
  assert.equal(slotOf(A), 1, 'nothing written by a refused request');
  r = await call('POST', '/api/locks', true, JSON.stringify({ clear: [], pad: 'x'.repeat(70 * 1024) }));
  assert.equal(r.status, 413);
  r = await call('POST', '/api/locks', false, { set: { [A]: 0 } });
  assert.equal(r.status, 403);
  r = await call('GET', '/api/locks');
  assert.equal(r.status, 404);
  assert.equal(slotOf(A), 1);
});

test('the retired order routes are gone: POST /api/order and POST /api/order/mode are 404 and write nothing', async () => {
  let r = await call('POST', '/api/order?ids=' + B + ',' + A);
  assert.equal(r.status, 404);
  r = await call('POST', '/api/order/mode?mode=manual');
  assert.equal(r.status, 404);
  assert.equal(fs.existsSync(path.join(dataDir, 'order')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'sort.json')), false);
});

test('POST /api/order/show?show= takes auto, running or all and keeps the file format older boards read; an unknown show is 400', async () => {
  const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'show.json'), 'utf8'));
  let r = await call('POST', '/api/order/show?show=running');
  assert.deepEqual([r.status, r.body], [200, { ok: true, show: 'running' }]);
  assert.deepEqual([stored().show, stored().v], ['running', 2]);
  r = await call('POST', '/api/order/show?show=all');
  assert.deepEqual([r.status, r.body], [200, { ok: true, show: 'all' }]);
  assert.deepEqual([stored().show, stored().v], ['all', 2]);
  r = await call('POST', '/api/order/show?show=auto');
  assert.deepEqual([r.status, r.body], [200, { ok: true, show: 'auto' }]);
  assert.deepEqual([stored().show, stored().v], ['open', 2], 'auto is stored as open, version 2: a board of 0.12.0 reads it as its open');
  r = await call('POST', '/api/order/show?show=open');
  assert.deepEqual([r.status, r.body.error], [400, 'show must be one of auto, running, all']);
  r = await call('POST', '/api/order/show?show=all', false);
  assert.equal(r.status, 403);
});

test('POST /api/archive/<id> archives an ended session (marker and transcript move); a bad id is 400', async () => {
  const sid = 'eeeeeeee-1111-4111-8111-111111111111';
  const dir = path.join(tmp, 'projects', 'd--code-repo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ type: 'user', sessionId: sid, message: { role: 'user', content: 'x' } }) + String.fromCharCode(10));
  let r = await call('POST', '/api/archive/' + sid);
  assert.deepEqual([r.status, r.body.ok, r.body.moved], [200, true, true], JSON.stringify(r.body));
  assert.ok(fs.existsSync(path.join(dataDir, 'archived', sid + '.json')), 'the marker');
  assert.equal(fs.existsSync(path.join(dir, sid + '.jsonl')), false, 'moved');
  r = await call('POST', '/api/archive/nope');
  assert.equal(r.status, 400);
});
