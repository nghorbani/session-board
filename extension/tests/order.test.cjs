'use strict';
/*
 * The order store in core.cjs: rank markers under DATA_DIR/order written as one complete list
 * (setOrder checks every id before the first write), the sort mode in DATA_DIR/sort.json,
 * pruning shared with the blinded store (a marker goes when its session is neither live nor
 * has a transcript), and the rank and order.mode fields on the snapshot. The fixture is the
 * one of blinded.test.cjs: temp dirs, the CLI shim, the window map.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-order-'));
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
fs.writeFileSync(path.join(projectsDir, 'proj', A + '.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Live one', sessionId: A }) + NL);
fs.writeFileSync(path.join(projectsDir, 'proj', B + '.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Ended one', sessionId: B }) + NL);

const marker = (id) => path.join(core.ORDER_DIR, id + '.json');
function agents(status) { process.env.SB_SHIM_AGENTS = JSON.stringify([{ sessionId: A, pid: process.pid, status, cwd: path.join(tmp, 'webapp'), name: 'me', kind: 'interactive' }]); }
function registry(status) { fs.writeFileSync(path.join(sessionsDir, process.pid + '.json'), JSON.stringify({ sessionId: A, status, statusUpdatedAt: Date.now() })); }
async function rowA() { const snap = await core.snapshot(); return snap.sessions.find((s) => s.sessionId === A); }

test('store: setOrder ranks every id by its position; an id outside the list keeps its rank', () => {
  assert.equal(core.setOrder([B, A]), 2);
  assert.equal(core.readOrder().get(B).rank, 0);
  assert.equal(core.readOrder().get(A).rank, 1);
  assert.ok(Number(core.readOrder().get(A).at) > 0, 'a record carries at');
  core.setOrder([A]);
  assert.equal(core.readOrder().get(A).rank, 0);
  assert.equal(core.readOrder().get(B).rank, 0, 'an id outside the list keeps its rank');
  assert.equal(fs.readdirSync(core.ORDER_DIR).length, 2);
});

test('store: a bad id, an empty list, a non-list or more than 500 ids throw before any write', () => {
  const before = fs.readdirSync(core.ORDER_DIR).length;
  assert.throws(() => core.setOrder([A, 'nope']), /not a session id/);
  assert.throws(() => core.setOrder([]), /empty/);
  assert.throws(() => core.setOrder('x'), /list/);
  const many = Array.from({ length: 501 }, (_, i) => 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(i).padStart(12, '0'));
  assert.throws(() => core.setOrder(many), /too many/);
  assert.equal(fs.readdirSync(core.ORDER_DIR).length, before, 'nothing was written');
});

test('sort mode: activity without a file, with an unreadable file and with an unknown mode; manual round-trips; a bad mode throws', () => {
  assert.equal(core.readSortMode(), 'activity');
  fs.mkdirSync(path.dirname(core.SORT_FILE), { recursive: true });
  fs.writeFileSync(core.SORT_FILE, 'garb');
  assert.equal(core.readSortMode(), 'activity');
  fs.writeFileSync(core.SORT_FILE, JSON.stringify({ mode: 'sideways' }));
  assert.equal(core.readSortMode(), 'activity');
  assert.equal(core.setSortMode('manual'), 'manual');
  assert.equal(core.readSortMode(), 'manual');
  assert.equal(JSON.parse(fs.readFileSync(core.SORT_FILE, 'utf8')).mode, 'manual');
  core.setSortMode('activity');
  assert.equal(core.readSortMode(), 'activity');
  assert.throws(() => core.setSortMode('x'), /mode/);
  assert.equal(fs.readdirSync(path.dirname(core.SORT_FILE)).filter((n) => n.startsWith('sort.json.tmp')).length, 0, 'no tmp file left behind');
});

test('snapshot: rank on every row (null without a record or a finite rank), order.mode, pruning by liveness and transcript', async () => {
  registry('idle'); agents('idle');
  core.setOrder([A, B, C]);
  core.setSortMode('manual');
  let snap = await core.snapshot();
  assert.equal(snap.order.mode, 'manual');
  let a = snap.sessions.find((s) => s.sessionId === A);
  assert.equal(a.rank, 0);
  assert.ok(fs.existsSync(marker(A)), 'live: kept');
  assert.ok(fs.existsSync(marker(B)), 'ended with a transcript: kept for a resume');
  assert.equal(fs.existsSync(marker(C)), false, 'ended without a transcript: dropped');
  fs.unlinkSync(marker(A));
  a = await rowA();
  assert.equal(a.rank, null, 'no record: null');
  fs.writeFileSync(marker(A), JSON.stringify({ at: Date.now() }));
  a = await rowA();
  assert.equal(a.rank, null, 'a record without a finite rank: null');
  core.setSortMode('activity');
  snap = await core.snapshot();
  assert.equal(snap.order.mode, 'activity');
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
