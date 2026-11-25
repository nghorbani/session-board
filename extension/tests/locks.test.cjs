'use strict';
/*
 * The lock store in core.cjs: one marker per locked session under DATA_DIR/locks holding the
 * place number (slot) of its card. setLocks checks a whole request before the first write;
 * `set` locks an id, `move` changes only a lock that exists, `clear` unlocks. The snapshot puts
 * lockSlot on running and ended rows after one reconcile step: a session archived on the board
 * or in Claude Code loses its lock (on the board at once, with the archive), and so does one
 * that is not running and has no transcript left. The old order store (order/, sort.json) is never read or written. The fixture is the
 * one of muted.test.cjs: temp dirs, the CLI shim, the window map.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-locks-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
process.env.SB_CODE_USER_DIR = path.join(tmp, 'User');
const sessionsDir = path.join(tmp, 'sessions');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(sessionsDir);
fs.mkdirSync(path.join(projectsDir, 'proj'), { recursive: true });
process.env.SB_SESSIONS_DIR = sessionsDir;
process.env.SB_PROJECTS_DIR = projectsDir;
process.env.SB_HEARTBEAT_DIR = path.join(tmp, 'heartbeats');
process.env.SB_WINDOW_MAP = JSON.stringify({ [process.pid]: { windowId: 7, exthostPid: 4242 } });
process.env.PATH = path.join(__dirname, 'shim') + path.delimiter + process.env.PATH;
const core = require('../core.cjs');

const NL = String.fromCharCode(10);
const A = '11111111-2222-4333-8444-555555555555';   // live: the shim row runs under this process's pid
const B = '66666666-7777-4888-9999-000000000000';   // ended, transcript still on disk
const C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';   // ended, no transcript anywhere
const D = 'dddddddd-1111-4222-8333-444444444444';   // ended, its transcript appears after the file index was built
const transcript = (id) => path.join(projectsDir, 'proj', id + '.jsonl');
fs.writeFileSync(transcript(A), JSON.stringify({ type: 'ai-title', aiTitle: 'Live one', sessionId: A }) + NL);
fs.writeFileSync(transcript(B), JSON.stringify({ type: 'ai-title', aiTitle: 'Ended one', sessionId: B }) + NL);

const dataDir = path.dirname(core.LOCKS_DIR);
const lock = (id) => path.join(core.LOCKS_DIR, id + '.json');
const slot = (id) => JSON.parse(fs.readFileSync(lock(id), 'utf8')).slot;
const names = () => { try { return fs.readdirSync(core.LOCKS_DIR).sort(); } catch (_) { return []; } };
function agents(status) { process.env.SB_SHIM_AGENTS = JSON.stringify([{ sessionId: A, pid: process.pid, status, cwd: path.join(tmp, 'webapp'), name: 'me', kind: 'interactive' }]); }
function registry(status) { fs.writeFileSync(path.join(sessionsDir, process.pid + '.json'), JSON.stringify({ sessionId: A, status, statusUpdatedAt: Date.now() })); }
async function rowA() { const snap = await core.snapshot(); return snap.sessions.find((s) => s.sessionId === A); }

test('store: set locks an id at a slot, move changes only a lock that exists, clear unlocks', () => {
  assert.deepEqual(core.setLocks({ set: { [A]: 2 } }), { set: 1, moved: 0, cleared: 0 });
  assert.equal(slot(A), 2);
  assert.ok(Number(core.readLocks().get(A).at) > 0, 'a record carries at');
  assert.deepEqual(core.setLocks({ move: { [A]: 0, [B]: 4 } }), { set: 0, moved: 1, cleared: 0 });
  assert.equal(slot(A), 0);
  assert.equal(fs.existsSync(lock(B)), false, 'move never creates a lock: a stale page cannot bring one back');
  assert.deepEqual(core.setLocks({ set: { [B]: 1 }, clear: [A] }), { set: 1, moved: 0, cleared: 1 });
  assert.equal(fs.existsSync(lock(A)), false);
  assert.equal(slot(B), 1);
  assert.deepEqual(core.setLocks({ clear: [A] }), { set: 0, moved: 0, cleared: 0 }, 'clearing an unlocked id is not an error');
  assert.deepEqual(names(), [B + '.json'], 'no temp file left behind');
});

test('store: one bad entry refuses the whole request before any write', () => {
  const before = names();
  const many = {};
  for (let i = 0; i < 501; i++) many['aaaaaaaa-bbbb-4ccc-8ddd-' + String(i).padStart(12, '0')] = i;
  assert.throws(() => core.setLocks({ set: { [A]: 1, nope: 2 } }), /not a session id/);
  assert.throws(() => core.setLocks({ set: { [A]: -1 } }), /not a slot/);
  assert.throws(() => core.setLocks({ set: { [A]: 1.5 } }), /not a slot/);
  assert.throws(() => core.setLocks({ set: { [A]: 10000 } }), /not a slot/);
  assert.throws(() => core.setLocks({ set: { [A]: '3' } }), /not a slot/);
  assert.throws(() => core.setLocks({ move: { [A]: null } }), /not a slot/);
  assert.throws(() => core.setLocks({ set: { [A]: 1 }, clear: [A] }), /twice/);
  assert.throws(() => core.setLocks({ set: { [A]: 1 }, move: { [A]: 2 } }), /twice/);
  assert.throws(() => core.setLocks({ clear: [A, A] }), /twice/);
  assert.throws(() => core.setLocks({ set: { [C]: 1 }, clear: [C.toUpperCase()] }), /twice/, 'an id in lower and in upper case is one file on a file system that ignores case');
  assert.throws(() => core.setLocks({ set: { [A]: { toString: null } } }), (e) => e.code === 'invalid' && /not a slot/.test(e.message), 'a value that cannot even be printed is refused like any other');
  assert.throws(() => core.setLocks({ clear: 'x' }), /list/);
  assert.throws(() => core.setLocks({ clear: [A, 'nope'] }), /not a session id/);
  assert.throws(() => core.setLocks({ set: [A] }), /object/);
  assert.throws(() => core.setLocks('x'), /object/);
  assert.throws(() => core.setLocks(null), /object/);
  assert.throws(() => core.setLocks({}), /nothing/);
  assert.throws(() => core.setLocks({ set: many }), /too many/);
  assert.deepEqual(names(), before, 'nothing was written');
});

test('snapshot: lockSlot on a running row, null without a lock or with a record that holds no slot', async () => {
  registry('idle'); agents('idle');
  core.setLocks({ set: { [A]: 3 } });
  let a = await rowA();
  assert.equal(a.lockSlot, 3);
  core.setLocks({ clear: [A] });
  a = await rowA();
  assert.equal(a.lockSlot, null, 'no lock: null');
  fs.writeFileSync(lock(A), JSON.stringify({ at: Date.now() }));
  a = await rowA();
  assert.equal(a.lockSlot, null, 'a record without a slot: null');
  assert.equal('rank' in a, false, 'the manual rank is gone from the row');
  const snap = await core.snapshot();
  assert.equal('mode' in snap.order, false, 'the sort mode is gone from the snapshot');
});

test('reconcile: a lock goes when its session is not running and has no transcript; a transcript newer than the file index keeps it', async () => {
  registry('idle'); agents('idle');
  await core.snapshot();                                   // the file index is built here and kept for a minute
  fs.writeFileSync(transcript(D), JSON.stringify({ type: 'ai-title', aiTitle: 'Late one', sessionId: D }) + NL);
  core.setLocks({ set: { [A]: 0, [B]: 1, [C]: 2, [D]: 3 } });
  await core.snapshot();
  assert.ok(fs.existsSync(lock(A)), 'running: kept');
  assert.ok(fs.existsSync(lock(B)), 'ended with a transcript: kept');
  assert.equal(fs.existsSync(lock(C)), false, 'ended without a transcript: dropped');
  assert.ok(fs.existsSync(lock(D)), 'its transcript is on disk though the minute-old index does not list it: kept');
});

test('reconcile: an archived session loses its lock, on the board at once, in Claude Code only once its archive has been read', () => {
  const locks = () => { core.setLocks({ set: { [A]: 0, [B]: 1 } }); return core.readLocks(); };
  const live = new Set([A]);
  let map = locks();
  core.reconcileLocks(map, live, new Set([B]), { known: true, ids: new Set() });
  assert.deepEqual([map.has(A), map.has(B), fs.existsSync(lock(B))], [true, false, false], 'archived on the board');
  map = locks();
  core.reconcileLocks(map, live, new Set(), { known: true, ids: new Set([A]) });
  assert.deepEqual([map.has(A), fs.existsSync(lock(A)), map.has(B)], [false, false, true], 'archived in Claude Code, running or not');
  map = locks();
  core.reconcileLocks(map, live, new Set(), { known: false, ids: new Set([A, B]) });
  assert.deepEqual([map.has(A), map.has(B)], [true, true], 'Claude Code\'s archive not read yet: nothing is dropped on its word');
  core.setLocks({ clear: [A, B] });
});

test('a board archive drops the lock at once: archived and restored before any snapshot, the session comes back without it', async () => {
  core.setLocks({ set: { [B]: 1 } });
  const r = await core.archivePast(B);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.existsSync(lock(B)), false, 'the lock went with the archive, before any snapshot');
  await core.unarchiveSession(B);
  registry('idle'); agents('idle');
  await core.snapshot();
  assert.equal(core.readLocks().has(B), false, 'restored: not locked');
  assert.ok(fs.existsSync(transcript(B)), 'the transcript is back, so only the archive took the lock');
});

test('the old order store is left alone: order/ and sort.json are neither read, written nor removed', async () => {
  const orderDir = path.join(dataDir, 'order');
  const sortFile = path.join(dataDir, 'sort.json');
  fs.mkdirSync(orderDir, { recursive: true });
  fs.writeFileSync(path.join(orderDir, A + '.json'), JSON.stringify({ rank: 0, at: 1 }));
  fs.writeFileSync(sortFile, JSON.stringify({ mode: 'manual', at: 1 }));
  registry('idle'); agents('idle');
  core.setLocks({ set: { [A]: 5 } });
  const a = await rowA();
  assert.equal(a.lockSlot, 5);
  assert.equal(JSON.parse(fs.readFileSync(path.join(orderDir, A + '.json'), 'utf8')).rank, 0, 'the rank file is untouched');
  assert.equal(JSON.parse(fs.readFileSync(sortFile, 'utf8')).mode, 'manual', 'sort.json is untouched');
  for (const name of ['setOrder', 'readOrder', 'readSortMode', 'setSortMode', 'ORDER_DIR', 'SORT_FILE']) assert.equal(name in core, false, name + ' is gone from core');
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
