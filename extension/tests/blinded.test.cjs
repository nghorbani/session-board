'use strict';
/*
 * The Blinded store in core.cjs: existence markers under DATA_DIR/blinded, pruning by
 * liveness and transcript presence (no clock), the `blinded` flag on snapshot rows, and the
 * window label from a board heartbeat's workspace name. The CLI is the shim (SB_SHIM_AGENTS
 * seeds live rows); the registry, the projects dir, the heartbeat dir and the window map are
 * temp dirs or env seams, so no PowerShell and no exthost.log are read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-blinded-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
process.env.SB_CODE_USER_DIR = path.join(tmp, 'User');   // never the real state.vscdb
const sessionsDir = path.join(tmp, 'sessions');
const projectsDir = path.join(tmp, 'projects');
const heartbeatDir = path.join(tmp, 'heartbeats');
fs.mkdirSync(sessionsDir);
fs.mkdirSync(path.join(projectsDir, 'proj'), { recursive: true });
process.env.SB_SESSIONS_DIR = sessionsDir;
process.env.SB_PROJECTS_DIR = projectsDir;
process.env.SB_HEARTBEAT_DIR = heartbeatDir;
const EXTHOST = 4242;
process.env.SB_WINDOW_MAP = JSON.stringify({ [process.pid]: { windowId: 7, exthostPid: EXTHOST } });
process.env.PATH = path.join(__dirname, 'shim') + path.delimiter + process.env.PATH;
const core = require('../core.cjs');

const A = '11111111-2222-4333-8444-555555555555';   // live: the shim row runs under this process's pid
const B = '66666666-7777-4888-9999-000000000000';   // ended, transcript still on disk
const C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';   // ended, no transcript anywhere
// the transcripts exist before the first snapshot: the filename index is cached for a minute
fs.writeFileSync(path.join(projectsDir, 'proj', A + '.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Live one', sessionId: A }) + '\n');
fs.writeFileSync(path.join(projectsDir, 'proj', B + '.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Ended one', sessionId: B }) + '\n');

const EXT_ID = 'nima-ghorbani.session-board-vscode';
const marker = (id) => path.join(core.BLINDED_DIR, id + '.json');

function agents(status, cwd) { process.env.SB_SHIM_AGENTS = JSON.stringify([{ sessionId: A, pid: process.pid, status, cwd: cwd || path.join(tmp, 'webapp'), name: 'me', kind: 'interactive' }]); }
function registry(status) { fs.writeFileSync(path.join(sessionsDir, process.pid + '.json'), JSON.stringify({ sessionId: A, status, statusUpdatedAt: Date.now() })); }
async function rowA() { const snap = await core.snapshot(); return snap.sessions.find((s) => s.sessionId === A); }

test('store: blind writes a UUID-named marker, unblind removes it, a missing marker is a no-op, bad ids throw', () => {
  core.blindSession(A);
  assert.ok(fs.existsSync(marker(A)));
  assert.ok(core.readBlinded().has(A));
  core.blindSession(A);                                   // twice keeps one marker
  assert.equal(fs.readdirSync(core.BLINDED_DIR).length, 1);
  core.unblindSession(A);
  assert.equal(fs.existsSync(marker(A)), false);
  assert.doesNotThrow(() => core.unblindSession(A), 'a second unblind finds nothing and says nothing');
  assert.throws(() => core.blindSession('nope'), /not a session id/);
  assert.throws(() => core.unblindSession(''), /not a session id/);
  assert.equal(core.readBlinded().size, 0);
});

test('store: existence is the flag; unreadable content still counts and the file stays', () => {
  fs.mkdirSync(core.BLINDED_DIR, { recursive: true });
  fs.writeFileSync(marker(B), 'garb');
  fs.writeFileSync(path.join(core.BLINDED_DIR, 'notes.txt'), 'ignored');
  const ids = core.readBlinded();
  assert.ok(ids.has(B), 'a half-written marker is still a blind');
  assert.equal(ids.size, 1);
  assert.ok(fs.existsSync(marker(B)), 'nothing was deleted on read');
  fs.unlinkSync(marker(B));
  fs.unlinkSync(path.join(core.BLINDED_DIR, 'notes.txt'));
});

test('snapshot: the row carries blinded; a marker survives while the session is live or its transcript exists, and goes with neither', async () => {
  registry('idle'); agents('idle');
  core.blindSession(A); core.blindSession(B); core.blindSession(C);
  let a = await rowA();
  assert.equal(a.blinded, true);
  assert.ok(fs.existsSync(marker(A)), 'live: kept');
  assert.ok(fs.existsSync(marker(B)), 'ended with a transcript: kept for a resume');
  assert.equal(fs.existsSync(marker(C)), false, 'ended without a transcript: dropped');
  core.unblindSession(A);
  a = await rowA();
  assert.equal(a.blinded, false);
  core.unblindSession(B);
});

test('heartbeat names: a fresh heartbeat names its extension host; nameless, stale and foreign records do not', () => {
  core.writeHeartbeat(EXTHOST, EXT_ID, 'cuvis (Workspace)');
  assert.equal(core.heartbeatNames().get(EXTHOST), 'cuvis (Workspace)');
  core.writeHeartbeat(EXTHOST + 1, EXT_ID, null);
  assert.equal(core.heartbeatNames().has(EXTHOST + 1), false, 'no name, no entry');
  fs.writeFileSync(path.join(heartbeatDir, 'board-' + (EXTHOST + 2) + '-' + EXT_ID + '.json'), JSON.stringify({ pid: EXTHOST + 2, at: Date.now() - 120000, id: EXT_ID, name: 'old' }));
  assert.equal(core.heartbeatNames().has(EXTHOST + 2), false, 'a stale heartbeat is ignored');
  fs.writeFileSync(path.join(heartbeatDir, 'other.json'), JSON.stringify({ pid: EXTHOST + 3, at: Date.now(), name: 'x' }));
  assert.equal(core.heartbeatNames().has(EXTHOST + 3), false, 'only board-* files count');
  assert.equal(core.windowIdForExthost(EXTHOST), 7, 'the window map answers for the host pid');
  assert.equal(core.windowIdForExthost(1), null);
});

test('snapshot: the window label is the heartbeat name, else the folder vote; an Untitled workspace name is skipped', async () => {
  registry('idle'); agents('idle', path.join(tmp, 'webapp'));
  core.writeHeartbeat(EXTHOST, EXT_ID, 'cuvis (Workspace)');
  let a = await rowA();
  assert.deepEqual(a.window, { id: 7, exthostPid: EXTHOST, label: 'cuvis (Workspace)' });
  core.writeHeartbeat(EXTHOST, EXT_ID, 'Untitled (Workspace)');
  a = await rowA();
  assert.equal(a.window.label, 'webapp', 'an unsaved multi-root window falls back to the folder vote');
  fs.rmSync(heartbeatDir, { recursive: true, force: true });
  a = await rowA();
  assert.equal(a.window.label, 'webapp', 'no heartbeat: the vote');
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
