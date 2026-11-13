'use strict';
/*
 * Ended sessions in core.cjs: every board heartbeat that names its window's root folder turns
 * into the folder set Claude Code's list uses (the root plus the repository's worktrees), and
 * endedSessions() returns the transcripts there that are not running and not archived, each with
 * its window; the "all | running" store; archivePast() for ⤓ on an ended row. Temp dirs and env
 * seams: SB_PROJECTS_DIR (transcripts), SB_HEARTBEAT_DIR, SB_WINDOW_MAP (exthost pid to window),
 * SB_WORKTREES (what git worktree list would answer), SB_SESSIONS_DIR (the registry).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ended-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
process.env.SB_CODE_USER_DIR = path.join(tmp, 'User');   // never the real state.vscdb
const projectsDir = path.join(tmp, 'projects');
const sessionsDir = path.join(tmp, 'sessions');
const heartbeatDir = path.join(tmp, 'heartbeats');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });
process.env.SB_PROJECTS_DIR = projectsDir;
process.env.SB_SESSIONS_DIR = sessionsDir;
process.env.SB_HEARTBEAT_DIR = heartbeatDir;
const W1 = 5001, W2 = 5002;
process.env.SB_WINDOW_MAP = JSON.stringify({ 1: { windowId: 1, exthostPid: W1 }, 2: { windowId: 2, exthostPid: W2 } });
const REPO = 'd:/code/repo';
const WT = 'd:/code/wt-feature';
process.env.SB_WORKTREES = JSON.stringify({ [REPO]: [REPO, WT], [WT]: [REPO, WT] });
process.env.SB_SHIM_AGENTS = '[]';   // the CLI stand-in: no running sessions (a CI runner has no claude)
process.env.PATH = path.join(__dirname, 'shim') + path.delimiter + process.env.PATH;
const core = require('../core.cjs');

const id = (n) => n.repeat(8) + '-1111-4111-8111-111111111111';
const [A, B, C, D, E, F, G, H] = ['a', 'b', 'c', 'd', 'e', 'f', '9', '8'].map(id);
const DAY = 24 * 3600 * 1000;
const line = (o) => JSON.stringify(o) + '\n';
const folderOf = (p) => path.join(projectsDir, core.projectFolderName(p));
function transcript(dir, sessionId, lines, ageMs) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, lines.map(line).join(''));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return file;
}
const user = (sid, text) => ({ type: 'user', cwd: 'D:\\code\\repo', sessionId: sid, message: { role: 'user', content: text } });

// every fixture exists before the first call: the folder index is rebuilt at most once a minute
const upper = path.join(projectsDir, core.projectFolderName('D:/code/repo'));   // Claude Code writes either drive-letter case
transcript(core.IS_WINDOWS ? upper : folderOf(REPO), A, [user(A, 'fix the parser'), { type: 'ai-title', aiTitle: 'Parser fix', sessionId: A }], 60 * 1000);
transcript(folderOf(REPO), B, [user(B, 'no title yet')], 2 * DAY);
transcript(folderOf(REPO), C, [{ type: 'summary', summary: 'x' }], 3 * DAY);                  // no user message: not listed
transcript(folderOf(REPO), D, [user(D, 'running one')], 5 * 1000);                            // live
transcript(folderOf(REPO), E, [user(E, 'archived in Claude')], 4 * DAY);
transcript(folderOf(REPO), F, [user(F, 'archived on the board')], 5 * DAY);
transcript(folderOf(WT), G, [user(G, 'in the worktree'), { type: 'custom-title', customTitle: 'Feature work', sessionId: G }], 10 * 60 * 1000);
transcript(folderOf(REPO), H, [user(H, 'old copy')], 6 * DAY);
transcript(folderOf(WT), H, [user(H, 'new copy')], 30 * 60 * 1000);                        // one id in two folders: the newest wins
const OTHER = 'cccccccc-2222-4222-8222-222222222222';
transcript(folderOf('d:/elsewhere'), OTHER, [user(OTHER, 'another repo')], 60 * 1000);

function heartbeat(pid, root, ageMs) {
  core.writeHeartbeat(pid, 'nima-ghorbani.session-board-vscode', 'win' + pid, false, '0.11.2', root);
  if (ageMs) {
    const file = path.join(heartbeatDir, 'board-' + pid + '-nima-ghorbani.session-board-vscode.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.at = Date.now() - ageMs;
    fs.writeFileSync(file, JSON.stringify(rec));
  }
}
const clearHeartbeats = () => fs.rmSync(heartbeatDir, { recursive: true, force: true });
const ids = (rows) => rows.map((r) => r.sessionId);

test('projectFolderName: every character outside A-Z, a-z, 0-9 becomes "-"', () => {
  assert.equal(core.projectFolderName('d:\\code-repos\\cuvis-ai\\cuvis-ai'), 'd--code-repos-cuvis-ai-cuvis-ai');
  assert.equal(core.projectFolderName('C:/Users/me/My Repo/ünï'), 'C--Users-me-My-Repo--n-', 'spaces and non-ASCII letters too');
});

test('no heartbeat with a root: no ended rows', () => {
  clearHeartbeats();
  assert.deepEqual(core.endedSessions(new Set(), new Set(), new Set()), []);
  core.writeHeartbeat(W1, 'nima-ghorbani.session-board-vscode', 'win', false, '0.11.1');   // a board without a root (older)
  assert.deepEqual(core.endedSessions(new Set(), new Set(), new Set()), []);
});

test('a window lists its folder and its worktrees: not running, not archived, with a user message; newest first, untitled ones too', () => {
  clearHeartbeats();
  heartbeat(W1, REPO);
  const rows = core.endedSessions(new Set([D]), new Set([E]), new Set([F]));
  assert.deepEqual(ids(rows), [A, G, H, B], 'newest first; C (no user message), D (running), E and F (archived) and the other repo left out');
  const a = rows[0];
  assert.deepEqual([a.status, a.live, a.window.id, a.title, a.cwd, a.archived], ['ended', false, 1, 'Parser fix', 'D:\\code\\repo', false]);
  assert.equal(rows.find((r) => r.sessionId === B).title, null, 'listed without a title (Untitled)');
  assert.equal(rows.find((r) => r.sessionId === G).title, 'Feature work', 'a rename wins');
  assert.equal(rows.find((r) => r.sessionId === H).folder, core.projectFolderName(WT), 'one id in two folders: the newest file');
  if (core.IS_WINDOWS) assert.equal(a.folder, core.projectFolderName('D:/code/repo'), 'drive-letter case does not matter on Windows');
});

test('two windows: a worktree session goes to the window of its own folder, the rest to the repository window; a closed window hands its sessions back', () => {
  clearHeartbeats();
  heartbeat(W1, REPO);
  heartbeat(W2, WT);
  let rows = core.endedSessions(new Set([D]), new Set([E]), new Set([F]));
  const where = (rs) => Object.fromEntries(rs.map((r) => [r.sessionId, r.window.id]));
  assert.deepEqual(where(rows), { [A]: 1, [B]: 1, [G]: 2, [H]: 2 }, 'each session once');
  heartbeat(W2, WT, 120000);                                           // the worktree window is gone
  rows = core.endedSessions(new Set([D]), new Set([E]), new Set([F]));
  assert.deepEqual(where(rows), { [A]: 1, [B]: 1, [G]: 1, [H]: 1 });
});

test('a root git has not answered for (or not a repository) lists its own folder alone', () => {
  clearHeartbeats();
  const saved = process.env.SB_WORKTREES;
  process.env.SB_WORKTREES = JSON.stringify({});
  try {
    heartbeat(W1, REPO);
    assert.deepEqual(ids(core.endedSessions(new Set([D]), new Set([E]), new Set([F]))), [A, B, H], 'the worktree session G is not listed; H from its older copy here');
  } finally { process.env.SB_WORKTREES = saved; }
});

test('the snapshot carries ended rows and the show mode; the store keeps all or running board-wide', async () => {
  clearHeartbeats();
  heartbeat(W1, REPO);
  assert.equal(core.readShowMode(), 'all', 'default');
  let snap = await core.snapshot();
  assert.ok(Array.isArray(snap.ended) && snap.ended.length >= 4, JSON.stringify(snap.ended && snap.ended.length));
  assert.equal(snap.order.show, 'all');
  core.setShowMode('running');
  assert.equal(core.readShowMode(), 'running');
  snap = await core.snapshot();
  assert.equal(snap.order.show, 'running', 'rows still travel; the page hides them');
  assert.throws(() => core.setShowMode('some'), /unknown show mode/);
  fs.writeFileSync(core.SHOW_FILE, 'garbage');
  assert.equal(core.readShowMode(), 'all', 'unreadable means all');
  core.setShowMode('all');
});

test('archivePast: the marker, then the transcript moves to the board archive; a second archive is a no-op; a running session and a bad id are refused', async () => {
  let r = await core.archivePast('nope');
  assert.deepEqual([r.ok, r.code], [false, 'invalid']);
  fs.writeFileSync(path.join(sessionsDir, process.pid + '.json'), JSON.stringify({ sessionId: D, pid: process.pid, status: 'idle' }));
  r = await core.archivePast(D);
  assert.deepEqual([r.ok, r.code], [false, 'running']);
  assert.equal(core.readArchived().has(D), false, 'nothing written for a running session');
  fs.rmSync(path.join(sessionsDir, process.pid + '.json'));
  r = await core.archivePast(B);
  assert.deepEqual([r.ok, r.moved], [true, true], JSON.stringify(r));
  assert.ok(core.readArchived().has(B));
  assert.equal(fs.existsSync(path.join(folderOf(REPO), B + '.jsonl')), false, 'moved out of Claude Code\'s folder');
  assert.equal(core.stowedTranscripts(B).length, 1, 'into the board archive');
  r = await core.archivePast(B);
  assert.deepEqual([r.ok, r.moved], [true, false], 'again: nothing left to move, still fine');
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
