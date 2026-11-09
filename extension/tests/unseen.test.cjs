'use strict';
/*
 * The Unseen state in core.cjs: the marker store, noteAnswer() (a turn that ended since this
 * process last looked writes the shared marker), the flag on snapshot rows and how a board
 * title ranks against the generated and the renamed title. The CLI is the shim
 * (SB_SHIM_AGENTS seeds live rows), the registry and the projects dir are temp dirs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-unseen-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
process.env.SB_CODE_USER_DIR = path.join(tmp, "User");   // never the real state.vscdb
const sessionsDir = path.join(tmp, 'sessions');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(sessionsDir);
fs.mkdirSync(path.join(projectsDir, 'proj'), { recursive: true });
process.env.SB_SESSIONS_DIR = sessionsDir;
process.env.SB_PROJECTS_DIR = projectsDir;
process.env.PATH = path.join(__dirname, 'shim') + path.delimiter + process.env.PATH;
const core = require('../core.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const transcript = path.join(projectsDir, 'proj', A + '.jsonl');
// the transcript exists before the first snapshot: the filename index is cached for a minute
fs.writeFileSync(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'Generated', sessionId: A }) + '\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;

test('markers: unseen and seen are UUID-named files under the data dir; stale ones are dropped on read', () => {
  const at = Date.now() - 1000;
  core.markUnseen(A, at);
  core.markSeen(A);
  assert.ok(fs.existsSync(path.join(core.UNSEEN_DIR, A + '.json')));
  assert.equal(core.readUnseen().get(A).at, at);
  assert.ok(core.readSeen().get(A).at >= at);
  assert.throws(() => core.markSeen('nope'), /not a session id/);
  assert.throws(() => core.markUnseen('', 1), /not a session id/);
  fs.writeFileSync(path.join(core.UNSEEN_DIR, B + '.json'), JSON.stringify({ at: Date.now() - 15 * DAY }));
  fs.writeFileSync(path.join(core.UNSEEN_DIR, 'notes.txt'), 'ignored');
  fs.writeFileSync(path.join(core.UNSEEN_DIR, C + '.json'), 'garbage');
  const unseen = core.readUnseen();
  assert.equal(unseen.has(B), false, 'a two-week-old marker is dropped');
  assert.equal(unseen.has(C), false, 'an unreadable marker is dropped');
  assert.equal(fs.existsSync(path.join(core.UNSEEN_DIR, B + '.json')), false);
  assert.ok(unseen.has(A));
  fs.unlinkSync(path.join(core.UNSEEN_DIR, 'notes.txt'));
  fs.unlinkSync(path.join(core.UNSEEN_DIR, A + '.json'));
  fs.unlinkSync(path.join(core.SEEN_DIR, A + '.json'));
});

test('noteAnswer: only a turn that ended since this process last looked writes a marker, and returns its time', () => {
  const t1 = Date.now() - 60000;
  assert.equal(core.noteAnswer(C, 'idle', t1), 0, 'first observation');
  assert.equal(core.noteAnswer(C, 'idle', t1), 0, 'nothing changed');
  assert.equal(core.noteAnswer(C, 'busy', t1 + 1000), 0, 'working');
  assert.equal(core.noteAnswer(C, 'idle', t1 + 2000), t1 + 2000, 'the answer ended');
  assert.equal(core.readUnseen().get(C).at, t1 + 2000, 'the marker carries the registry time');
  assert.equal(core.noteAnswer(C, 'idle', t1 + 2000), 0, 'the same answer');
  assert.equal(core.noteAnswer(C, 'idle', t1 + 2500), t1 + 2500, 'a turn shorter than one poll interval');
  assert.equal(core.noteAnswer(C, 'waiting', t1 + 3000), 0, 'a permission prompt is not an answer');
  const at = core.noteAnswer(C, 'idle', null);
  assert.ok(at > 0, 'without a registry time the transition itself counts');
  assert.equal(core.readUnseen().get(C).at, at, 'and the time returned is the one in the marker');
  fs.unlinkSync(path.join(core.UNSEEN_DIR, C + '.json'));
});

const winOnly = { skip: core.IS_WINDOWS ? false : 'the snapshot window mapping is Windows-only' };
function agents(status) { process.env.SB_SHIM_AGENTS = JSON.stringify([{ sessionId: A, pid: process.pid, status, cwd: tmp, name: 'me', kind: 'interactive' }]); }
function registry(status) { fs.writeFileSync(path.join(sessionsDir, process.pid + '.json'), JSON.stringify({ sessionId: A, status, statusUpdatedAt: Date.now() })); }
async function rowA() { const snap = await core.snapshot(); return snap.sessions.find((s) => s.sessionId === A); }

test('snapshot: a session is unseen after an answer ends while the board watches, until it is opened', winOnly, async () => {
  registry('idle'); agents('idle');
  assert.equal((await rowA()).unseen, false, 'first seen idle: not flagged');
  await sleep(5); registry('busy'); agents('busy');
  assert.equal((await rowA()).unseen, false, 'working');
  await sleep(5); registry('idle'); agents('idle');
  let row = await rowA();
  assert.equal(row.unseen, true, 'the answer ended');
  assert.equal(row.status, 'idle');
  assert.ok(row.unseenAt > 0, 'with the time of the answer');
  const next = await rowA();
  assert.deepEqual([next.unseen, next.unseenAt], [true, row.unseenAt], 'still unseen on the next poll, the same time');
  await sleep(5); core.markSeen(A);
  row = await rowA();
  assert.deepEqual([row.unseen, row.unseenAt], [false, null], 'opened from the board');
  await sleep(5); registry('idle'); agents('idle');
  assert.equal((await rowA()).unseen, true, 'a new answer after the open');
  await sleep(5); registry('busy'); agents('busy');
  assert.equal((await rowA()).unseen, false, 'a new prompt clears it');
  await sleep(5); registry('idle'); agents('idle');
  assert.equal((await rowA()).unseen, true, 'and the next answer flags it again');
});

test('snapshot: the title is Claude Code\'s: a custom-title line, else the sidecar, else the generated title; old board titles are ignored', winOnly, async () => {
  registry('idle'); agents('idle');
  let row = await rowA();
  assert.deepEqual([row.title, row.renamedTitle, 'boardTitle' in row], ['Generated', null, false]);
  fs.mkdirSync(path.join(core.DATA_DIR, 'titles'), { recursive: true });
  fs.writeFileSync(path.join(core.DATA_DIR, 'titles', A + '.json'), JSON.stringify({ title: 'Old board title', at: Date.now(), seenCustomTitle: null }));
  row = await rowA();
  assert.equal(row.title, 'Generated', 'a 0.10.0 board title is no longer read');
  await sleep(20);
  fs.mkdirSync(path.join(path.dirname(transcript), A), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(transcript), A, 'custom-title.json'), JSON.stringify({ customTitle: 'From the sidecar' }));
  row = await rowA();
  assert.deepEqual([row.title, row.renamedTitle, row.generatedTitle], ['From the sidecar', 'From the sidecar', 'Generated'], 'a sidecar-only change is seen');
  await sleep(20);
  fs.appendFileSync(transcript, JSON.stringify({ type: 'custom-title', customTitle: 'From the line', sessionId: A }) + '\n');
  row = await rowA();
  assert.equal(row.title, 'From the line', 'the line in the tail wins over the sidecar');
  assert.ok(fs.existsSync(path.join(core.DATA_DIR, 'titles', A + '.json')), 'the old store is left on disk');
});

test('snapshot: without a registry time the writing process reports the marker time on every poll (one done event, not two)', winOnly, async () => {
  const noTime = (status) => fs.writeFileSync(path.join(sessionsDir, process.pid + '.json'), JSON.stringify({ sessionId: A, status }));
  noTime('busy'); agents('busy');
  await rowA();
  await sleep(5); noTime('idle'); agents('idle');
  const first = await rowA();
  assert.equal(first.unseen, true);
  await sleep(5);
  const second = await rowA();
  assert.equal(second.unseenAt, first.unseenAt, 'the same time from the marker');
  assert.equal(core.readUnseen().get(A).at, first.unseenAt);
});

test.after(() => { delete process.env.SB_SHIM_AGENTS; fs.rmSync(tmp, { recursive: true, force: true }); });
