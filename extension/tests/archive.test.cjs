'use strict';
/*
 * The board's archive flag in core.cjs: the marker store, applyArchive() on every end
 * outcome (including a marker write that fails after the kill), the "gone only when the
 * process is verifiably absent" rule of doEndSession, and the flag on snapshot and search
 * rows. The CLI is the shim (SB_SHIM_AGENTS seeds live rows), the session registry and the
 * projects dir are temp dirs, and SB_POWERSHELL simulates a failing process inspector.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');


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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-archive-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
process.env.SB_CODE_USER_DIR = path.join(tmp, "User");   // never the real state.vscdb
const sessionsDir = path.join(tmp, 'sessions');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(sessionsDir);
fs.mkdirSync(projectsDir);
process.env.SB_SESSIONS_DIR = sessionsDir;
process.env.SB_PROJECTS_DIR = projectsDir;
process.env.PATH = path.join(__dirname, 'shim') + path.delimiter + process.env.PATH;
const core = require('../core.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const marker = (id) => path.join(core.ARCHIVE_DIR, id + '.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('store: archive, list, unarchive; twice keeps one marker; unknown unarchive is a no-op', () => {
  assert.deepEqual(core.archivedIds(), []);
  core.archiveSession(A);
  core.archiveSession(A);
  assert.deepEqual(core.archivedIds(), [A]);
  assert.ok(fs.existsSync(marker(A)));
  assert.ok(Number(JSON.parse(fs.readFileSync(marker(A), 'utf8')).at) > 0);
  core.unarchiveSession(B);                                   // never archived: nothing happens
  core.unarchiveSession(A);
  assert.deepEqual(core.archivedIds(), []);
  assert.throws(() => core.archiveSession('not-an-id'), /not a session id/);
  assert.throws(() => core.unarchiveSession(''), /not a session id/);
});

test('store: only UUID-named markers count, whatever their content', () => {
  fs.mkdirSync(core.ARCHIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(core.ARCHIVE_DIR, 'notes.txt'), 'ignored');
  fs.writeFileSync(path.join(core.ARCHIVE_DIR, 'README.json'), '{}');
  fs.writeFileSync(marker(C), 'garbage, not json');
  assert.deepEqual(core.archivedIds(), [C]);
  core.unarchiveSession(C);
  fs.unlinkSync(path.join(core.ARCHIVE_DIR, 'notes.txt'));
  fs.unlinkSync(path.join(core.ARCHIVE_DIR, 'README.json'));
});

test('applyArchive: archive false leaves the result untouched', () => {
  const r = { ok: true, code: 'ended', pid: 5 };
  assert.equal(core.applyArchive(A, r, false), r);
  assert.equal(fs.existsSync(marker(A)), false);
});

test('applyArchive: ended, gone and unknown record the marker and succeed', () => {
  for (const code of ['ended', 'gone', 'unknown']) {
    const out = core.applyArchive(A, { ok: code === 'ended', code, message: 'm' }, true);
    assert.deepEqual(out, { ok: true, code, message: 'm', archived: true }, code);
    assert.ok(fs.existsSync(marker(A)), code + ' writes the marker');
    core.unarchiveSession(A);
  }
});

test('applyArchive: refused outcomes record nothing and say archived: false', () => {
  for (const code of ['needs-force', 'mismatch', 'denied', 'invalid', 'pending', 'partial', 'timeout', 'failed', 'unsupported']) {
    const out = core.applyArchive(A, { ok: false, code, status: 'busy' }, true);
    assert.deepEqual(out, { ok: false, code, status: 'busy', archived: false }, code);
    assert.equal(fs.existsSync(marker(A)), false, code + ' writes no marker');
  }
});

test('applyArchive: a marker write that fails still reports the end, with archiveError', () => {
  fs.rmSync(core.ARCHIVE_DIR, { recursive: true, force: true });
  fs.writeFileSync(core.ARCHIVE_DIR, 'a file where the directory should be');   // mkdir and write both fail
  try {
    const out = core.applyArchive(A, { ok: true, code: 'ended' }, true);
    assert.equal(out.ok, true);
    assert.equal(out.archived, false);
    assert.match(String(out.archiveError), /ENOTDIR|EEXIST|ENOENT|not a directory/i);
  } finally {
    fs.unlinkSync(core.ARCHIVE_DIR);
  }
});

test('endSession: an id the CLI does not list is unknown, and archives on request', async () => {
  const plain = await core.endSession(B, {});
  assert.equal(plain.code, 'unknown');
  assert.equal(plain.ok, false);
  const archived = await core.endSession(B, { archive: true });
  assert.deepEqual([archived.ok, archived.code, archived.archived], [true, 'unknown', true]);
  assert.ok(fs.existsSync(marker(B)));
  core.unarchiveSession(B);
});

test('endSession: an invalid id is refused and never archived', async () => {
  const out = await core.endSession('nope', { archive: true });
  assert.deepEqual([out.ok, out.code, out.archived], [false, 'invalid', false]);
});

const winOnly = { skip: core.IS_WINDOWS ? false : 'ending sessions is Windows-only' };

test('doEndSession: no registry record for a running pid is refused, not gone', winOnly, async () => {
  process.env.SB_SHIM_AGENTS = JSON.stringify([{ sessionId: A, pid: process.pid, status: 'idle', cwd: tmp, name: 'me', kind: 'interactive' }]);
  const snap = await core.snapshot();
  assert.ok(snap.sessions.some((s) => s.sessionId === A), 'the shim row is live');
  const out = await core.endSession(A, { archive: true });
  assert.deepEqual([out.ok, out.code, out.archived], [false, 'mismatch', false], JSON.stringify(out));
  assert.equal(fs.existsSync(marker(A)), false);
});

test('doEndSession: a running pid whose inspection fails is refused, not gone', winOnly, async () => {
  fs.writeFileSync(path.join(sessionsDir, process.pid + '.json'), JSON.stringify({ sessionId: A, status: 'idle', procStart: '0' }));
  process.env.SB_POWERSHELL = path.join(tmp, 'no-such-powershell.exe');
  try {
    const out = await core.endSession(A, { archive: true });
    assert.deepEqual([out.ok, out.code, out.archived], [false, 'failed', false], JSON.stringify(out));
    assert.equal(fs.existsSync(marker(A)), false);
  } finally {
    delete process.env.SB_POWERSHELL;
    fs.unlinkSync(path.join(sessionsDir, process.pid + '.json'));
  }
});

test('doEndSession: a pid that died after the snapshot is gone, and archives', winOnly, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 60000)'], { stdio: 'ignore' });
  try {
    process.env.SB_SHIM_AGENTS = JSON.stringify([{ sessionId: C, pid: child.pid, status: 'idle', cwd: tmp, name: 'child', kind: 'interactive' }]);
    const snap = await core.snapshot();
    assert.ok(snap.sessions.some((s) => s.sessionId === C), 'the child row is live');
    child.kill();
    for (let i = 0; i < 50 && core.pidAlive(child.pid); i++) await sleep(100);
    assert.equal(core.pidAlive(child.pid), false, 'the child is gone');
    const out = await core.endSession(C, { archive: true });
    assert.deepEqual([out.ok, out.code, out.archived], [true, 'gone', true], JSON.stringify(out));
    assert.ok(fs.existsSync(marker(C)));
  } finally {
    try { child.kill(); } catch (_) { /* already gone */ }
    core.unarchiveSession(C);
  }
});

test('doEndSession: a background job is stopped through claude stop, and archives', winOnly, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 60000)'], { stdio: 'ignore' });
  const record = path.join(sessionsDir, child.pid + '.json');
  try {
    fs.writeFileSync(record, JSON.stringify({ sessionId: C, status: 'idle', procStart: '0' }));
    process.env.SB_SHIM_AGENTS = JSON.stringify([{ id: C.slice(0, 8), sessionId: C, pid: child.pid, status: 'idle', kind: 'background', cwd: tmp, name: 'bg' }]);
    process.env.SB_SHIM_STOP_KILL_PID = String(child.pid);
    await core.snapshot();
    const out = await core.endSession(C, { archive: true });
    assert.deepEqual([out.ok, out.code, out.via, out.archived], [true, 'ended', 'claude stop', true], JSON.stringify(out));
    assert.equal(core.pidAlive(child.pid), false, 'the shim stopped the job process');
    assert.ok(fs.existsSync(marker(C)));
  } finally {
    delete process.env.SB_SHIM_STOP_KILL_PID;
    try { child.kill(); } catch (_) { /* gone */ }
    try { fs.unlinkSync(record); } catch (_) { /* gone */ }
    core.unarchiveSession(C);
  }
});

test('doEndSession: a background job the daemon does not know is refused while its process runs', winOnly, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 60000)'], { stdio: 'ignore' });
  const record = path.join(sessionsDir, child.pid + '.json');
  try {
    fs.writeFileSync(record, JSON.stringify({ sessionId: C, status: 'idle', procStart: '0' }));
    process.env.SB_SHIM_AGENTS = JSON.stringify([{ id: C.slice(0, 8), sessionId: C, pid: child.pid, status: 'idle', kind: 'background', cwd: tmp, name: 'bg' }]);
    process.env.SB_SHIM_STOP_FAIL = '1';
    await core.snapshot();
    const out = await core.endSession(C, { archive: true });
    assert.deepEqual([out.ok, out.code, out.archived], [false, 'failed', false], JSON.stringify(out));
    assert.match(out.message, /No job matching/);
    assert.equal(core.pidAlive(child.pid), true, 'nothing was killed');
    assert.equal(fs.existsSync(marker(C)), false);
  } finally {
    delete process.env.SB_SHIM_STOP_FAIL;
    try { child.kill(); } catch (_) { /* gone */ }
    try { fs.unlinkSync(record); } catch (_) { /* gone */ }
  }
});

test('snapshot rows carry the archived flag', winOnly, async () => {
  core.archiveSession(A);
  process.env.SB_SHIM_AGENTS = JSON.stringify([{ sessionId: A, pid: process.pid, status: 'idle', cwd: tmp, name: 'me', kind: 'interactive' }]);
  const snap = await core.snapshot();
  const row = snap.sessions.find((s) => s.sessionId === A);
  assert.equal(row && row.archived, true);
  core.unarchiveSession(A);
  const again = await core.snapshot();
  assert.equal(again.sessions.find((s) => s.sessionId === A).archived, false);
});

test('search rows carry the archived flag', async () => {
  const rg = await core.rgProbe(APP_ROOT);
  if (!rg.path) { assert.ok(true, 'ripgrep not found; the flag on search rows is checked manually'); return; }
  const dir = path.join(projectsDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, B + '.jsonl'),
    JSON.stringify({ type: 'user', cwd: 'C:\\x', sessionId: B, message: { role: 'user', content: 'hello' } }) + '\n'
    + JSON.stringify({ type: 'ai-title', aiTitle: 'Archived spike', sessionId: B }) + '\n');
  core.archiveSession(B);
  try {
    const res = await core.searchSessions('Archived spike', { content: false, requestId: 'arch-1', appRoot: APP_ROOT });
    const row = res.rows.find((r) => r.sessionId === B);
    assert.ok(row, 'the seeded transcript is found by title: ' + JSON.stringify(res));
    assert.equal(row.archived, true);
  } finally {
    core.unarchiveSession(B);
  }
});

test('search finds a past session by its id, bare or the way Claude Code shows it ("Session <8 hex>"); idQuery leaves other text alone', async () => {
  assert.deepEqual([core.idQuery('Session f8005c0d'), core.idQuery(' session F8005C0D-4e69 '), core.idQuery('Session board'), core.idQuery('plain')], ['f8005c0d', 'F8005C0D-4e69', 'Session board', 'plain']);
  const rg = await core.rgProbe(APP_ROOT);
  if (!rg.path) { assert.ok(true, 'ripgrep not found; id search is checked manually'); return; }
  const dir = path.join(projectsDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, B + '.jsonl'),
    JSON.stringify({ type: 'user', cwd: 'C:\\x', sessionId: B, message: { role: 'user', content: 'hello' } }) + '\n'
    + JSON.stringify({ type: 'ai-title', aiTitle: 'By id', sessionId: B }) + '\n');
  for (const q of [B.slice(0, 8), 'Session ' + B.slice(0, 8), B.toUpperCase()]) {
    const res = await core.searchSessions(q, { content: false, requestId: 'id-' + q, appRoot: APP_ROOT });
    assert.ok(res.rows.some((r) => r.sessionId === B), q + ': ' + JSON.stringify(res.rows.map((r) => r.sessionId)));
  }
});

// The transcript moves with the archive: stow on ⤓, restore on ⤒, and the recovery paths.

const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const live = (slug, id) => path.join(projectsDir, slug, id + '.jsonl');
const stowed = (slug, id) => path.join(core.ARCHIVE_TRANSCRIPTS_DIR, slug, id + '.jsonl');
const seed = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text || ('{"type":"user","sessionId":"' + path.basename(file, '.jsonl') + '"}\n')); };
const errWith = (code) => async () => { throw Object.assign(new Error(code + ' injected'), { code }); };

test('stow: ⤓ moves the transcript under the slug folder, keeps the marker shape, and the file stays listed', async () => {
  seed(live('proj', D), 'line one\n');
  const out = await core.endSession(D, { archive: true });
  assert.deepEqual([out.ok, out.code, out.archived, out.moved, out.from, out.to], [true, 'unknown', true, true, live('proj', D), stowed('proj', D)], JSON.stringify(out));
  assert.equal(fs.existsSync(live('proj', D)), false);
  assert.equal(fs.readFileSync(stowed('proj', D), 'utf8'), 'line one\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker(D), 'utf8')).transcript, undefined, 'the marker carries no paths');
  assert.deepEqual(core.liveTranscripts(D), []);
  assert.deepEqual(core.stowedTranscripts(D), [stowed('proj', D)]);
  assert.ok(core.transcriptRoots().includes(core.ARCHIVE_TRANSCRIPTS_DIR));
});

test('stow: a second ⤓ on a stowed session moves nothing and reports no error', async () => {
  const out = await core.endSession(D, { archive: true });
  assert.deepEqual([out.archived, out.moved, out.moveError], [true, false, undefined], JSON.stringify(out));
  assert.equal(fs.readFileSync(stowed('proj', D), 'utf8'), 'line one\n');
});

test('restore: ⤒ moves the transcript back by slug, unlinks the marker after, and says where it went', async () => {
  const r = await core.unarchiveSession(D);
  assert.deepEqual(r, { restoredTo: live('proj', D) });
  assert.equal(fs.readFileSync(live('proj', D), 'utf8'), 'line one\n');
  assert.equal(fs.existsSync(stowed('proj', D)), false);
  assert.equal(fs.existsSync(marker(D)), false);
});

test('restore: a stowed file whose marker was deleted by hand is still restored', async () => {
  await core.endSession(D, { archive: true });
  fs.unlinkSync(marker(D));
  assert.ok(fs.existsSync(stowed('proj', D)));
  const r = await core.unarchiveSession(D);
  assert.deepEqual(r, { restoredTo: live('proj', D) });
  assert.ok(fs.existsSync(live('proj', D)));
});

test('restore: a marker without a stowed file only unlinks, synchronously', () => {
  core.archiveSession(E);
  const p = core.unarchiveSession(E);
  assert.equal(fs.existsSync(marker(E)), false, 'gone before the promise settles');
  return p.then((r) => assert.deepEqual(r, { restoredTo: null }));
});

test('stow: the same id in two project folders is refused, the files stay', async () => {
  seed(live('proj', E));
  seed(live('proj2', E));
  const out = await core.endSession(E, { archive: true });
  assert.deepEqual([out.archived, out.moved], [true, false]);
  assert.match(String(out.moveError), /2 project folders/);
  assert.ok(fs.existsSync(live('proj', E)) && fs.existsSync(live('proj2', E)));
  fs.unlinkSync(live('proj2', E));
  await core.unarchiveSession(E);
});

test('stow: a session running again under a live pid is refused', async () => {
  const record = path.join(sessionsDir, process.pid + '.json');
  fs.writeFileSync(record, JSON.stringify({ sessionId: E, status: 'idle', pid: process.pid }));
  try {
    const out = await core.endSession(E, { archive: true });
    assert.deepEqual([out.archived, out.moved], [true, false]);
    assert.match(String(out.moveError), /running again under pid \d+/);
    assert.ok(fs.existsSync(live('proj', E)));
  } finally {
    fs.unlinkSync(record);
    await core.unarchiveSession(E);
  }
});

test('stow: a marker that vanished before the move (a concurrent unarchive) skips the move', async () => {
  const out = await core.stowTranscript(E);
  assert.deepEqual([out.moved, out.moveError], [false, 'unarchived before the move']);
  assert.ok(fs.existsSync(live('proj', E)));
});

test('stow: a different file already at the archived path is refused, both stay', async () => {
  seed(stowed('proj', E), 'older copy\n');
  const out = await core.endSession(E, { archive: true });
  assert.deepEqual([out.archived, out.moved], [true, false]);
  assert.match(String(out.moveError), /archived copy already exists/);
  assert.ok(fs.existsSync(live('proj', E)));
  assert.equal(fs.readFileSync(stowed('proj', E), 'utf8'), 'older copy\n');
  fs.unlinkSync(stowed('proj', E));
  await core.unarchiveSession(E);
});

test('restore: a different file already back at the live path throws, marker and stowed copy stay', async () => {
  await core.endSession(E, { archive: true });
  assert.ok(fs.existsSync(stowed('proj', E)));
  seed(live('proj', E), 'a new session wrote this\n');
  await assert.rejects(core.unarchiveSession(E), /a different file is already at/);
  assert.ok(fs.existsSync(marker(E)), 'marker kept');
  assert.ok(fs.existsSync(stowed('proj', E)), 'stowed copy kept');
  fs.unlinkSync(live('proj', E));
  await core.unarchiveSession(E);
  assert.equal(fs.existsSync(marker(E)), false);
});

test('recovery: an interrupted move (both names, one file) is completed by the next stow and the next restore', async () => {
  core.archiveSession(E);
  fs.mkdirSync(path.dirname(stowed('proj', E)), { recursive: true });
  fs.linkSync(live('proj', E), stowed('proj', E));              // crashed after the link, before the unlink
  let out = await core.stowTranscript(E);
  assert.deepEqual([out.moved, out.to], [true, stowed('proj', E)], JSON.stringify(out));
  assert.equal(fs.existsSync(live('proj', E)), false);
  fs.linkSync(stowed('proj', E), live('proj', E));              // the same on the way back
  const r = await core.unarchiveSession(E);
  assert.deepEqual(r, { restoredTo: live('proj', E) });
  assert.equal(fs.existsSync(stowed('proj', E)), false);
});

test('linkMove: a conflict refuses, no hard links refuses, a failed unlink after the link undoes the link', async () => {
  const from = live('proj', E);
  const other = path.join(tmp, 'elsewhere.jsonl');
  seed(other, 'different\n');
  await assert.rejects(core.linkMove(from, other), (e) => e.code === 'conflict');
  assert.ok(fs.existsSync(from) && fs.readFileSync(other, 'utf8') === 'different\n');
  fs.unlinkSync(other);
  await assert.rejects(core.linkMove(from, other, { link: errWith('EXDEV') }), (e) => e.code === 'no-hardlink');
  assert.ok(fs.existsSync(from) && !fs.existsSync(other));
  await assert.rejects(core.linkMove(from, other, { unlink: errWith('EPERM') }), (e) => e.code === 'EPERM');
  assert.ok(fs.existsSync(from), 'the source stays');
  assert.equal(fs.existsSync(other), false, 'the new name was undone');
});

test('stow across volumes is refused with the file in place; restore copies via .part instead', async () => {
  core.archiveSession(E);
  let out = await core.stowTranscript(E, { link: errWith('EXDEV') });
  assert.deepEqual(out.moved, false);
  assert.match(String(out.moveError), /another volume/);
  assert.ok(fs.existsSync(live('proj', E)));
  out = await core.stowTranscript(E);
  assert.equal(out.moved, true);
  seed(live('proj', E) + '.part', 'stale partial copy\n');
  const r = await core.unarchiveSession(E, { link: errWith('EXDEV') });
  assert.deepEqual(r, { restoredTo: live('proj', E) });
  assert.equal(fs.existsSync(live('proj', E) + '.part'), false, 'no .part left');
  assert.equal(fs.existsSync(stowed('proj', E)), false);
  assert.equal(fs.readFileSync(live('proj', E), 'utf8'), '{"type":"user","sessionId":"' + E + '"}\n');
});

test('stow: a marker removed while the link was being made is honoured; the file goes back and the move says so', async () => {
  core.archiveSession(E);
  let fired = false;                                           // the other window's unarchive, once, during the first link
  const out = await core.stowTranscript(E, { link: async (from, to) => { if (!fired) { fired = true; await core.unarchiveSession(E); } await fs.promises.link(from, to); } });
  assert.deepEqual([out.moved, out.moveError], [false, 'unarchived during the move'], JSON.stringify(out));
  assert.ok(fs.existsSync(live('proj', E)), 'the transcript is live again');
  assert.equal(fs.existsSync(stowed('proj', E)), false);
  assert.equal(fs.existsSync(marker(E)), false);
});

test('search: a stowed transcript is found once, under its session id, with the archived chip', async () => {
  const rg = await core.rgProbe(APP_ROOT);
  if (!rg.path) { assert.ok(true, 'ripgrep not found; the search of stowed transcripts is checked manually'); return; }
  seed(live('proj', D), JSON.stringify({ type: 'user', cwd: 'C:\\x', sessionId: D, message: { role: 'user', content: 'hello' } }) + '\n'
    + JSON.stringify({ type: 'ai-title', aiTitle: 'Stowed spike', sessionId: D }) + '\n');
  process.env.SB_SHIM_AGENTS = JSON.stringify([{ sessionId: D, pid: process.pid, status: 'idle', cwd: tmp, name: 'd', kind: 'interactive' }]);
  await core.snapshot();                                      // a live row whose transcriptPath is the live path
  core.archiveSession(D);
  const out = await core.stowTranscript(D);                   // stowed while the snapshot still names the old path
  assert.equal(out.moved, true, JSON.stringify(out));
  try {
    const res = await core.searchSessions('Stowed spike', { content: false, requestId: 'arch-2', appRoot: APP_ROOT });
    const rows = res.rows.filter((r) => r.sessionId === D);
    assert.equal(rows.length, 1, 'one row for the id, not one per path: ' + JSON.stringify(res.rows));
    assert.deepEqual([rows[0].archived, rows[0].archivedBy, rows[0].path], [true, 'board', stowed('proj', D)]);
  } finally {
    delete process.env.SB_SHIM_AGENTS;
    await core.snapshot();                                    // no live rows again
    await core.unarchiveSession(D);
  }
});

test('unarchive waits for a pending end of the same id, so the file ends up live and unmarked', async () => {
  const [end, un] = await Promise.all([core.endSession(E, { archive: true }), core.unarchiveSession(E)]);
  assert.equal(end.moved, true, JSON.stringify(end));
  assert.deepEqual(un, { restoredTo: live('proj', E) });
  assert.ok(fs.existsSync(live('proj', E)));
  assert.equal(fs.existsSync(stowed('proj', E)), false);
  assert.equal(fs.existsSync(marker(E)), false);
});

test.after(() => { delete process.env.SB_SHIM_AGENTS; fs.rmSync(tmp, { recursive: true, force: true }); });
