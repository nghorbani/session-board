'use strict';
/*
 * Claude Code's own archive, read from VS Code's state database: readClaudeArchived() over a
 * state.vscdb built here with node:sqlite (SB_CODE_USER_DIR points at a temp user dir), its
 * stat-keyed cache and TTL, the failure paths (missing, corrupt, then valid again), and the
 * archived / archivedBy fields on snapshot and search rows. The CLI is the shim.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');


// ripgrep for the search cases: VS Code's bundled copy, looked up before LOCALAPPDATA is
// pointed at the temp dir; without a VS Code install the search cases skip with a reason.
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA;
function vscodeAppRoot() {
  if (!REAL_LOCALAPPDATA) return undefined;
  const base = path.join(REAL_LOCALAPPDATA, 'Programs', 'Microsoft VS Code');
  const direct = path.join(base, 'resources', 'app');
  if (fs.existsSync(direct)) return direct;
  try { for (const d of fs.readdirSync(base)) { const nested = path.join(base, d, 'resources', 'app'); if (fs.existsSync(nested)) return nested; } } catch (_) { /* no install */ }
  return undefined;
}
const APP_ROOT = vscodeAppRoot();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cc-archive-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
const sessionsDir = path.join(tmp, 'sessions');
const projectsDir = path.join(tmp, 'projects');
const userDir = path.join(tmp, 'User');
fs.mkdirSync(sessionsDir);
fs.mkdirSync(projectsDir);
process.env.SB_SESSIONS_DIR = sessionsDir;
process.env.SB_PROJECTS_DIR = projectsDir;
process.env.SB_CODE_USER_DIR = userDir;
process.env.SB_CLAUDE_ARCHIVE_TTL_MS = '2000';   // wide enough for a loaded runner between two reads; the TTL case sleeps past it
process.env.PATH = path.join(__dirname, 'shim') + path.delimiter + process.env.PATH;
const core = require('../core.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DB = path.join(userDir, 'globalStorage', 'state.vscdb');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One state.vscdb with the Claude Code row, the way VS Code lays it out. */
function writeDb(hiddenSessionIds, opts) {
  opts = opts || {};
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  try { fs.unlinkSync(DB); } catch (_) { /* first write */ }
  const db = new DatabaseSync(DB);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const blob = JSON.stringify(Object.assign({ settingsMigrated20251024: true, sessionUnarchivedAt: {} }, opts.extra || {}, { hiddenSessionIds }));
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(opts.key || 'Anthropic.claude-code', blob);
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('someone.else', '{"hiddenSessionIds":["' + C + '"]}');
  db.close();
}

const ids = (r) => [...r.ids].sort();

test('readClaudeArchived: the hidden ids of the Claude Code row, UUIDs only; other rows are ignored', () => {
  writeDb([A, 'not-a-uuid', B, 42]);
  const r = core.readClaudeArchived();
  assert.deepEqual(ids(r), [A, B].sort());
  assert.equal(r.error, null);
});

test('readClaudeArchived: the lowercase row key is accepted too', () => {
  writeDb([B], { key: 'anthropic.claude-code' });
  assert.deepEqual(ids(core.readClaudeArchived()), [B]);
});

test('readClaudeArchived: unchanged stat within the TTL is served from cache; a bumped mtime or the TTL re-reads', async () => {
  // utimes takes whole milliseconds while stat reports finer, so the mtime is pinned before the
  // first read; a rewrite with the same page count keeps the size, and the cache cannot tell.
  const pinned = new Date(Date.now() - 10000);
  writeDb([A]);
  fs.utimesSync(DB, pinned, pinned);
  assert.deepEqual(ids(core.readClaudeArchived()), [A]);
  const size = fs.statSync(DB).size;
  writeDb([B]);
  fs.utimesSync(DB, pinned, pinned);
  assert.equal(fs.statSync(DB).size, size, 'the rewrite keeps the file size');
  assert.deepEqual(ids(core.readClaudeArchived()), [A], 'served from cache');
  fs.utimesSync(DB, pinned, new Date(pinned.getTime() + 5000));
  assert.deepEqual(ids(core.readClaudeArchived()), [B], 'a newer mtime re-reads');
  const later = new Date(pinned.getTime() + 5000);
  writeDb([C]);
  fs.utimesSync(DB, later, later);
  assert.deepEqual(ids(core.readClaudeArchived()), [B], 'cached again');
  await sleep(2200);                                        // past SB_CLAUDE_ARCHIVE_TTL_MS
  assert.deepEqual(ids(core.readClaudeArchived()), [C], 'the TTL forces a read');
});

test('readClaudeArchived: a missing database is an empty set without error', () => {
  fs.unlinkSync(DB);
  const r = core.readClaudeArchived();
  assert.deepEqual(ids(r), []);
  assert.equal(r.error, null);
});

test('readClaudeArchived: a corrupt database keeps the previous ids and reports; valid again clears the error', () => {
  writeDb([A, B]);
  assert.deepEqual(ids(core.readClaudeArchived()), [A, B].sort());
  fs.writeFileSync(DB, 'this is not a database file, and it is a different size now');
  let r = core.readClaudeArchived();
  assert.deepEqual(ids(r), [A, B].sort(), 'previous ids kept');
  assert.ok(r.error, 'the failure is reported: ' + r.error);
  r = core.readClaudeArchived();
  assert.ok(r.error, 'a failed read is not cached as fresh; the next call retries and fails again');
  writeDb([B]);
  r = core.readClaudeArchived();
  assert.deepEqual(ids(r), [B]);
  assert.equal(r.error, null);
});

test('archiveSource: the union flag and where it comes from', () => {
  const board = new Set([A, C]);
  const cc = new Set([B, C]);
  assert.deepEqual(core.archiveSource(A, board, cc), { archived: true, archivedBy: 'board' });
  assert.deepEqual(core.archiveSource(B, board, cc), { archived: true, archivedBy: 'claude-code' });
  assert.deepEqual(core.archiveSource(C, board, cc), { archived: true, archivedBy: 'both' });
  assert.deepEqual(core.archiveSource('99999999-9999-4999-8999-999999999999', board, cc), { archived: false, archivedBy: null });
});

const winOnly = { skip: core.IS_WINDOWS ? false : 'the shim rows need a live pid of this process' };

test('snapshot rows: archived and archivedBy from both stores, and claudeArchiveError on the snapshot', winOnly, async () => {
  writeDb([A, C]);
  core.archiveSession(B);
  core.archiveSession(C);
  process.env.SB_SHIM_AGENTS = JSON.stringify([A, B, C, '99999999-9999-4999-8999-999999999999'].map((id) => ({ sessionId: id, pid: process.pid, status: 'idle', cwd: tmp, name: id.slice(0, 4), kind: 'interactive' })));
  try {
    const snap = await core.snapshot();
    const by = (id) => { const s = snap.sessions.find((x) => x.sessionId === id); return [s.archived, s.archivedBy]; };
    assert.deepEqual(by(A), [true, 'claude-code']);
    assert.deepEqual(by(B), [true, 'board']);
    assert.deepEqual(by(C), [true, 'both']);
    assert.deepEqual(by('99999999-9999-4999-8999-999999999999'), [false, null]);
    assert.equal(snap.claudeArchiveError, null);
    fs.writeFileSync(DB, 'corrupt now');
    const again = await core.snapshot();
    assert.deepEqual([again.sessions.find((x) => x.sessionId === A).archivedBy, typeof again.claudeArchiveError], ['claude-code', 'string']);
  } finally {
    delete process.env.SB_SHIM_AGENTS;
    await core.unarchiveSession(B);
    await core.unarchiveSession(C);
  }
});

test('search rows carry archivedBy', async () => {
  const rg = await core.rgProbe(APP_ROOT);
  if (!rg.path) { assert.ok(true, 'ripgrep not found; archivedBy on search rows is checked manually'); return; }
  writeDb([A]);
  const dir = path.join(projectsDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, title] of [[A, 'Hidden in Claude Code'], [B, 'Hidden on the board']]) {
    fs.writeFileSync(path.join(dir, id + '.jsonl'),
      JSON.stringify({ type: 'user', cwd: 'C:\\x', sessionId: id, message: { role: 'user', content: 'hello' } }) + '\n'
      + JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id }) + '\n');
  }
  core.archiveSession(B);
  try {
    const res = await core.searchSessions('Hidden', { content: false, requestId: 'cc-1', appRoot: APP_ROOT });
    const by = (id) => { const r = res.rows.find((x) => x.sessionId === id); return r ? [r.archived, r.archivedBy] : null; };
    assert.deepEqual(by(A), [true, 'claude-code'], JSON.stringify(res.rows));
    assert.deepEqual(by(B), [true, 'board']);
  } finally {
    await core.unarchiveSession(B);
  }
});

test.after(() => { delete process.env.SB_SHIM_AGENTS; fs.rmSync(tmp, { recursive: true, force: true }); });
