'use strict';
/*
 * Listed sessions in core.cjs: every board heartbeat that names its window's root folder turns
 * into the folders Claude Code's own list reads (the root's folder, and its real path's folder),
 * and listedSessions() sorts the transcripts there into ended (not running, not archived) and,
 * when asked, archived ones (Claude Code's archive, the board's, stowed transcripts), each with
 * its window. Programmatic sessions (sdk entrypoints, daemon kinds) are left out unless asked
 * for. Also the "running | open | all" store and archivePast() for ⤓ on an ended row. Temp dirs
 * and env seams: SB_PROJECTS_DIR (transcripts), SB_HEARTBEAT_DIR, SB_WINDOW_MAP (exthost pid to
 * window), SB_SESSIONS_DIR (the registry), SB_CODE_USER_DIR (VS Code's state database).
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
process.env.SB_SHIM_AGENTS = '[]';   // the CLI stand-in: no running sessions (a CI runner has no claude)
process.env.PATH = path.join(__dirname, 'shim') + path.delimiter + process.env.PATH;
const core = require('../core.cjs');

const id = (n) => n.repeat(8) + '-1111-4111-8111-111111111111';
const [A, B, C, D, E, F, G, H] = ['a', 'b', 'c', 'd', 'e', 'f', '9', '8'].map(id);
const [P1, P2, P3, P4, S, K] = ['1', '2', '3', '4', '5', '6'].map(id);
const DAY = 24 * 3600 * 1000;
const line = (o) => JSON.stringify(o) + '\n';
const folderOf = (p) => path.join(projectsDir, core.projectFolderName(p));
function transcript(dir, sessionId, lines, ageMs, pad) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, lines.map(line).join(''));
  if (pad) fs.appendFileSync(file, pad.map(line).join(''));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return file;
}
const user = (sid, text, extra) => Object.assign({ type: 'user', parentUuid: null, cwd: 'D:\\code\\repo', sessionId: sid, message: { role: 'user', content: text } }, extra);

// every fixture exists before the first call: the folder index is rebuilt at most once a minute
const upper = path.join(projectsDir, core.projectFolderName('D:/code/repo'));   // Claude Code writes either drive-letter case
transcript(core.IS_WINDOWS ? upper : folderOf(REPO), A, [user(A, 'fix the parser', { entrypoint: 'claude-vscode' }), { type: 'ai-title', aiTitle: 'Parser fix', sessionId: A }], 60 * 1000);
transcript(folderOf(REPO), B, [user(B, 'no title yet')], 2 * DAY);
transcript(folderOf(REPO), C, [{ type: 'summary', summary: 'x' }], 3 * DAY);                  // no user message: never listed
transcript(folderOf(REPO), D, [user(D, 'running one')], 5 * 1000);                            // live
transcript(folderOf(REPO), E, [user(E, 'archived in Claude')], 4 * DAY);
transcript(folderOf(REPO), F, [user(F, 'archived on the board')], 5 * DAY);
transcript(folderOf(WT), G, [user(G, 'in the worktree'), { type: 'custom-title', customTitle: 'Feature work', sessionId: G }], 10 * 60 * 1000);
transcript(folderOf(REPO), H, [user(H, 'old copy')], 6 * DAY);
transcript(folderOf(WT), H, [user(H, 'new copy')], 30 * 60 * 1000);                        // the worktree's copy: another window's
transcript(folderOf(REPO), P1, [user(P1, 'from a script', { entrypoint: 'sdk-py' })], 20 * 60 * 1000);
transcript(folderOf(REPO), P2, [{ type: 'system', parentUuid: null, sessionKind: 'daemon', sessionId: P2 }, user(P2, 'a daemon turn')], 25 * 60 * 1000);
// an sdk entrypoint only in the tail: the head (first 64 KB) carries none
const filler = Array.from({ length: 700 }, (_, i) => ({ type: 'assistant', sessionId: P3, message: { role: 'assistant', content: 'x'.repeat(100) + i } }));
transcript(folderOf(REPO), P3, [user(P3, 'resumed by a script')], 35 * 60 * 1000, filler.concat([{ type: 'user', entrypoint: 'sdk-cli', sessionId: P3, message: { role: 'user', content: 'tail' } }]));
{  // the spaced spelling of a key ("k": "v"), as some writers emit it
  const file = path.join(folderOf(REPO), P4 + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"type":"user", "entrypoint": "sdk-ts", "sessionId":"' + P4 + '", "message": {"role": "user", "content": "x"}}' + String.fromCharCode(10));
  const t = new Date(Date.now() - 40 * 60 * 1000);
  fs.utimesSync(file, t, t);
}
// stowed by the board: in the board archive's copy of the folder, its marker written below
const stowDir = path.join(core.ARCHIVE_TRANSCRIPTS_DIR, core.projectFolderName(REPO));
transcript(stowDir, S, [user(S, 'stowed one')], 7 * DAY);
// live and stowed at once: the newest file decides
transcript(folderOf(REPO), K, [user(K, 'back in the folder')], 3 * 60 * 1000);
transcript(stowDir, K, [user(K, 'older stowed copy')], 8 * DAY);
const OTHER = 'cccccccc-2222-4222-8222-222222222222';
transcript(folderOf('d:/elsewhere'), OTHER, [user(OTHER, 'another repo')], 60 * 1000);
// a root reached through a junction: Claude Code reads the real path's folder too
const realRoot = path.join(tmp, 'real-repo');
const linkRoot = path.join(tmp, 'link-repo');
fs.mkdirSync(realRoot, { recursive: true });
let linked = true;
try { fs.symlinkSync(realRoot, linkRoot, 'junction'); } catch (_) { linked = false; }
const [L1, L2] = ['7', '0'].map(id);
transcript(folderOf(linkRoot), L1, [user(L1, 'opened through the link')], 2 * 60 * 1000);
transcript(folderOf(linked ? fs.realpathSync.native(realRoot) : realRoot), L2, [user(L2, 'opened at the real path')], 4 * 60 * 1000);   // the long form of a short (8.3) temp path

function heartbeat(pid, root, ageMs) {
  core.writeHeartbeat(pid, 'nima-ghorbani.session-board-vscode', 'win' + pid, false, '0.11.3', root);
  if (ageMs) {
    const file = path.join(heartbeatDir, 'board-' + pid + '-nima-ghorbani.session-board-vscode.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.at = Date.now() - ageMs;
    fs.writeFileSync(file, JSON.stringify(rec));
  }
}
const clearHeartbeats = () => fs.rmSync(heartbeatDir, { recursive: true, force: true });
const ids = (rows) => rows.map((r) => r.sessionId);
const same = (p) => (core.IS_WINDOWS ? String(p).toLowerCase() : String(p));   // Windows keeps a folder's first case
const live = new Set([D]);
const claudeArchived = new Set([E]);
const boardArchived = new Set([F, S, K]);
const list = (opts) => core.listedSessions(live, claudeArchived, boardArchived, opts);

test('projectFolderName: every character outside A-Z, a-z, 0-9 becomes "-"', () => {
  assert.equal(core.projectFolderName('d:\\code-repos\\cuvis-ai\\cuvis-ai'), 'd--code-repos-cuvis-ai-cuvis-ai');
  assert.equal(core.projectFolderName('C:/Users/me/My Repo/ünï'), 'C--Users-me-My-Repo--n-', 'spaces and non-ASCII letters too');
});

test('an unreadable Claude Code archive before any good read: the snapshot lists no ended rows; a good read brings them back', async () => {
  clearHeartbeats();
  heartbeat(W1, REPO);
  const db = core.CLAUDE_CODE_STATE_DB;
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, 'not a database');
  try {
    const snap = await core.snapshot();
    assert.ok(snap.claudeArchiveError, 'the error travels to the notice');
    assert.deepEqual([snap.ended, snap.archivedEnded], [[], []], 'Claude-archived sessions would look ended');
  } finally { fs.rmSync(db, { force: true }); }
  const snap = await core.snapshot();                     // no state database at all: nothing archived, known
  assert.equal(snap.claudeArchiveError, null);
  assert.ok(snap.ended.length > 0);
});

test('no heartbeat with a root: nothing listed', () => {
  clearHeartbeats();
  assert.deepEqual(list({ withArchived: true }), { ended: [], archived: [] });
  core.writeHeartbeat(W1, 'nima-ghorbani.session-board-vscode', 'win', false, '0.11.1');   // a board without a root (older)
  assert.deepEqual(list({ withArchived: true }), { ended: [], archived: [] });
});

test('a window lists its own folder as Claude Code does: not running, not archived, not programmatic, with a user message; no worktree folders; newest first, untitled ones too', () => {
  clearHeartbeats();
  heartbeat(W1, REPO);
  const { ended, archived } = list();
  assert.deepEqual(ids(ended), [A, B, H], 'C (no user message), D (running), E, F, S, K (archived), G (worktree), P1 to P4 (programmatic) and the other repo left out');
  assert.deepEqual(archived, [], 'archived rows only when asked for');
  const a = ended[0];
  assert.deepEqual([a.status, a.live, a.window.id, a.title, a.cwd, a.archived, a.archivedBy], ['ended', false, 1, 'Parser fix', 'D:\\code\\repo', false, null]);
  assert.equal(ended.find((r) => r.sessionId === B).title, null, 'listed without a title (Untitled)');
  assert.equal(same(ended.find((r) => r.sessionId === H).folder), same(core.projectFolderName(REPO)),'the repository folder\'s own copy');
  if (core.IS_WINDOWS) assert.equal(a.folder, core.projectFolderName('D:/code/repo'), 'drive-letter case does not matter on Windows');
});

test('programmatic sessions: an sdk entrypoint in the head, one only in the tail, the spaced spelling and a daemon kind are left out unless asked for', () => {
  clearHeartbeats();
  heartbeat(W1, REPO);
  const { ended } = list({ includeProgrammatic: true });
  for (const sid of [P1, P2, P3, P4]) assert.ok(ids(ended).includes(sid), sid + ' listed with includeProgrammatic');
  assert.ok(fs.statSync(path.join(folderOf(REPO), P3 + '.jsonl')).size > 64 * 1024, 'the tail case really has a 64 KB head without an entrypoint');
});

test('withArchived: Claude-archived, board-archived and stowed sessions come apart, each marked by who archived it; an id live and stowed shows once from its newest file', () => {
  clearHeartbeats();
  heartbeat(W1, REPO);
  const { ended, archived } = list({ withArchived: true });
  assert.deepEqual(ids(ended), [A, B, H], 'the ended rows do not change');
  assert.deepEqual(ids(archived), [K, E, F, S], 'newest first');
  const by = Object.fromEntries(archived.map((r) => [r.sessionId, [r.archived, r.archivedBy]]));
  assert.deepEqual(by[E], [true, 'claude-code']);
  assert.deepEqual(by[F], [true, 'board']);
  assert.deepEqual(by[S], [true, 'board'], 'a stowed transcript');
  assert.equal(same(archived.find((r) => r.sessionId === K).path), same(path.join(folderOf(REPO), K + '.jsonl')), 'the newer live copy');
  assert.equal(archived.find((r) => r.sessionId === S).path, path.join(stowDir, S + '.jsonl'));
  const both = core.listedSessions(live, new Set([E, F]), boardArchived, { withArchived: true }).archived.find((r) => r.sessionId === F);
  assert.equal(both.archivedBy, 'both');
});

test('two windows: each lists its own folder; a worktree session shows in the worktree\'s window only; one root in two windows goes to the lower id', () => {
  clearHeartbeats();
  heartbeat(W1, REPO);
  heartbeat(W2, WT);
  const where = (rs) => Object.fromEntries(rs.map((r) => [r.sessionId, r.window.id]));
  assert.deepEqual(where(list().ended), { [A]: 1, [B]: 1, [H]: 2, [G]: 2 }, 'H in both folders is one id: its newest copy, the worktree one');
  assert.equal(list().ended.find((r) => r.sessionId === H).folder, core.projectFolderName(WT));
  heartbeat(W2, WT, 120000);                                           // the worktree window is gone
  assert.deepEqual(where(list().ended), { [A]: 1, [B]: 1, [H]: 1 }, 'G does not move to the repository window; H is that folder copy again');
  clearHeartbeats();
  heartbeat(W2, REPO);
  heartbeat(W1, REPO);
  assert.deepEqual([...new Set(Object.values(where(list().ended)))], [1], 'every row once, in the lower window');
});

test('a root reached through a junction lists the folders of both paths', { skip: !linked && 'no junction here' }, () => {
  clearHeartbeats();
  heartbeat(W1, linkRoot);
  assert.deepEqual(ids(list().ended), [L1, L2]);
});

test('the snapshot carries ended rows, archived rows only with "all", and the show mode; the store keeps running, open or all board-wide and reads 0.11.2\'s file', async () => {
  clearHeartbeats();
  heartbeat(W1, REPO);
  fs.rmSync(core.SHOW_FILE, { force: true });
  assert.equal(core.readShowMode(), 'open', 'default');
  let snap = await core.snapshot();
  assert.ok(Array.isArray(snap.ended) && snap.ended.length >= 4, JSON.stringify(snap.ended && snap.ended.length));
  assert.deepEqual([snap.order.show, snap.archivedEnded], ['open', []]);
  assert.ok(!ids(snap.ended).includes(P1), 'programmatic sessions stay out of the snapshot by default');
  snap = await core.snapshot({ includeProgrammatic: true });
  assert.ok(ids(snap.ended).includes(P1), 'the host passes Claude Code\'s setting through');
  core.archiveSession(F);                                   // the board's marker; S is stowed, which says the same
  core.setShowMode('all');
  assert.deepEqual(JSON.parse(fs.readFileSync(core.SHOW_FILE, 'utf8')).v, 2);
  snap = await core.snapshot();
  assert.equal(snap.order.show, 'all');
  assert.ok(ids(snap.archivedEnded).includes(F) && ids(snap.archivedEnded).includes(S), JSON.stringify(ids(snap.archivedEnded)));
  core.setShowMode('running');
  assert.equal(core.readShowMode(), 'running');
  snap = await core.snapshot();
  assert.deepEqual([snap.order.show, snap.archivedEnded], ['running', []], 'ended rows still travel; the page hides them');
  assert.throws(() => core.setShowMode('some'), /unknown show mode/);
  fs.writeFileSync(core.SHOW_FILE, JSON.stringify({ show: 'all', at: 1 }));
  assert.equal(core.readShowMode(), 'open', '0.11.2 wrote no version: its "all" is today\'s "open"');
  fs.writeFileSync(core.SHOW_FILE, JSON.stringify({ show: 'running', at: 1 }));
  assert.equal(core.readShowMode(), 'running');
  fs.writeFileSync(core.SHOW_FILE, JSON.stringify({ show: 'some', v: 2 }));
  assert.equal(core.readShowMode(), 'open', 'an unknown value');
  fs.writeFileSync(core.SHOW_FILE, 'garbage');
  assert.equal(core.readShowMode(), 'open', 'unreadable means open');
  assert.deepEqual(core.SHOW_MODES, ['running', 'open', 'all']);
  core.setShowMode('open');
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

test.after(() => {
  try { fs.unlinkSync(linkRoot); } catch (_) { /* no junction */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});
