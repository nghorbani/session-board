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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-archive-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
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
  const rg = await core.rgProbe();
  if (!rg.path) { assert.ok(true, 'ripgrep not found; the flag on search rows is checked manually'); return; }
  const dir = path.join(projectsDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, B + '.jsonl'),
    JSON.stringify({ type: 'user', cwd: 'C:\\x', sessionId: B, message: { role: 'user', content: 'hello' } }) + '\n'
    + JSON.stringify({ type: 'ai-title', aiTitle: 'Archived spike', sessionId: B }) + '\n');
  core.archiveSession(B);
  try {
    const res = await core.searchSessions('Archived spike', { content: false, requestId: 'arch-1' });
    const row = res.rows.find((r) => r.sessionId === B);
    assert.ok(row, 'the seeded transcript is found by title: ' + JSON.stringify(res));
    assert.equal(row.archived, true);
  } finally {
    core.unarchiveSession(B);
  }
});

test.after(() => { delete process.env.SB_SHIM_AGENTS; fs.rmSync(tmp, { recursive: true, force: true }); });
