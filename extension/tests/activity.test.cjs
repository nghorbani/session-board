'use strict';
/*
 * The times the board orders by, in core.cjs. lastMessageAt() finds the time of the last
 * message in a transcript tail the way Claude Code does: the last line whose top-level type is
 * user or assistant and whose top-level timestamp is a date. The snapshot puts activityAt on
 * every running row (that time, else the transcript's file time, else the status time) and
 * workingSince on a row that is busy (the moment it turned busy). ageMinutes is gone. The
 * fixture is the one of muted.test.cjs: temp dirs, the CLI shim, the window map.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-activity-'));
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
const A = '11111111-2222-4333-8444-555555555555';   // live, with a transcript
const E = 'eeeeeeee-1111-4222-8333-444444444444';   // live, no transcript yet
const T1 = '2026-11-19T08:00:00.000Z';
const T2 = '2026-11-19T09:30:00.000Z';
const at = (iso) => Date.parse(iso);
const line = (o) => JSON.stringify(o) + NL;
const user = (iso, text) => line({ type: 'user', timestamp: iso, sessionId: A, message: { role: 'user', content: text || 'hello' } });
const assistant = (iso, text) => line({ type: 'assistant', timestamp: iso, sessionId: A, message: { role: 'assistant', content: [{ type: 'text', text: text || 'hi' }] } });
const title = line({ type: 'ai-title', aiTitle: 'A title', sessionId: A });
const transcript = path.join(projectsDir, 'proj', A + '.jsonl');

function agents(status) {
  process.env.SB_SHIM_AGENTS = JSON.stringify([
    { sessionId: A, pid: process.pid, status, cwd: path.join(tmp, 'webapp'), name: 'a', kind: 'interactive' },
    { sessionId: E, pid: process.pid, status: 'idle', cwd: path.join(tmp, 'webapp'), name: 'e', kind: 'interactive' },
  ]);
}
function registry(status, statusUpdatedAt) {
  fs.writeFileSync(path.join(sessionsDir, process.pid + '.json'), JSON.stringify({ sessionId: A, status, statusUpdatedAt }));
  fs.writeFileSync(path.join(sessionsDir, 'e.json'), JSON.stringify({ sessionId: E, status: 'idle', statusUpdatedAt: 1111 }));
}
async function row(id) { const snap = await core.snapshot(); return snap.sessions.find((s) => s.sessionId === id); }

test('lastMessageAt: the last user or assistant line with a timestamp, whatever follows it', () => {
  assert.equal(core.lastMessageAt(user(T1) + assistant(T2) + title + line({ type: 'last-prompt', lastPrompt: 'p', sessionId: A })), at(T2));
  assert.equal(core.lastMessageAt(assistant(T1) + user(T2)), at(T2), 'a user line counts like an assistant line');
  assert.equal(core.lastMessageAt(title), null, 'no message line');
  assert.equal(core.lastMessageAt(''), null);
  assert.equal(core.lastMessageAt(null), null);
});

test('lastMessageAt: only the top level of a line counts; cut lines and bad dates are skipped', () => {
  const nested = line({ type: 'progress', sessionId: A, data: { type: 'user', timestamp: T2 } });
  assert.equal(core.lastMessageAt(user(T1) + nested), at(T1), 'a nested type and timestamp are not a message');
  const other = line({ type: 'attachment', timestamp: T2, attachment: { type: 'user' } });
  assert.equal(core.lastMessageAt(user(T1) + other), at(T1), 'a top-level timestamp on another kind of line is not a message');
  assert.equal(core.lastMessageAt(user(T1) + assistant(T2).slice(0, 60) + NL), at(T1), 'a line that is not whole JSON');
  assert.equal(core.lastMessageAt(user(T1) + line({ type: 'assistant', timestamp: 'soon' })), at(T1), 'a timestamp that is no date');
  assert.equal(core.lastMessageAt(user(T1) + line({ type: 'assistant', timestamp: 1795000000000 })), at(T1), 'a timestamp that is no text');
});

test('titleFromTranscript: the message time comes with the titles; a last message larger than the tail is found by a second read', () => {
  fs.writeFileSync(transcript, user(T1) + assistant(T2) + title);
  let facts = core.titleFromTranscript(transcript);
  assert.deepEqual([facts.title, facts.lastMessageAt], ['A title', at(T2)]);
  const big = 'x'.repeat(300 * 1024);                        // one line larger than the 256 KB tail
  fs.writeFileSync(transcript, user(T1) + assistant(T2, big) + title);
  facts = core.titleFromTranscript(transcript);
  assert.equal(facts.lastMessageAt, at(T2), 'the tail holds no whole message line; the larger read does');
  fs.writeFileSync(transcript, title);
  assert.equal(core.titleFromTranscript(transcript).lastMessageAt, null, 'a transcript without a message');
  assert.equal(core.titleFromTranscript(path.join(tmp, 'missing.jsonl')).lastMessageAt, null);
});

test('snapshot: activityAt is the last message time; workingSince only while the session is busy', async () => {
  fs.writeFileSync(transcript, user(T1) + assistant(T2) + title + NL);
  agents('idle'); registry('idle', 5000);
  let a = await row(A);
  assert.equal(a.activityAt, at(T2), 'idle: the last message, not the status time');
  assert.equal(a.workingSince, null);
  assert.equal('ageMinutes' in a, false, 'ageMinutes is gone from the row');

  agents('busy'); registry('busy', 7000);
  a = await row(A);
  assert.deepEqual([a.workingSince, a.activityAt], [7000, at(T2)], 'busy: working since the status change');

  agents('waiting'); registry('waiting', 8000);
  a = await row(A);
  assert.deepEqual([a.workingSince, a.activityAt], [null, at(T2)], 'waiting for him is not working');

  agents('busy'); registry('busy', 9000);
  a = await row(A);
  assert.equal(a.workingSince, 9000, 'his answer starts the next working stretch');

  agents('idle'); registry('idle', 9500);
  fs.writeFileSync(transcript, user(T1) + assistant(T2) + user(T2) + assistant('2026-11-19T09:45:00.000Z') + title);
  a = await row(A);
  assert.deepEqual([a.workingSince, a.activityAt], [null, at('2026-11-19T09:45:00.000Z')], 'done: the time of the answer');
});

test('snapshot: without a message the file time stands in, without a transcript the status time', async () => {
  fs.writeFileSync(transcript, title);
  agents('idle'); registry('idle', 5000);
  const a = await row(A);
  assert.equal(a.activityAt, fs.statSync(transcript).mtimeMs, 'no message line: the transcript\'s file time');
  const e = await row(E);
  assert.equal(e.activityAt, 1111, 'no transcript: the status time');
  assert.equal(e.workingSince, null);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
