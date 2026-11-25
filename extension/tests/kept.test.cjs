'use strict';
/*
 * Kept cards in core.cjs: the sessions that were running in a window when its extension host
 * went away stay on the board after the restart. While a window lives, its host writes one
 * record per running session under DATA_DIR/kept: the window's folder and the `run` of that
 * host lifetime (createKeptTracker). A session that ends while the window lives loses its
 * record a minute later. listedSessions() flags an ended row `kept` when its record names this
 * window's folder and a lifetime that is not alive; it adds no row and moves none. Records go
 * with an archive, with a transcript that is gone, and when the session runs again in a
 * process younger than the record. Temp dirs and env seams as in ended.test.cjs; the window
 * map marks two of the made-up hosts as dead.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-kept-'));
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
const NEW = 7001, OLD = 7002, OTHER = 7003, GONE = 7004;   // made-up extension hosts
process.env.SB_WINDOW_MAP = JSON.stringify({
  [process.pid]: { windowId: 7, exthostPid: NEW },          // the running session's window
  old: { windowId: 7, exthostPid: OLD, dead: true },        // the host of window 7 before its restart
  other: { windowId: 8, exthostPid: OTHER },                // a second window, on another folder
  gone: { windowId: 6, exthostPid: GONE, dead: true },      // a closed window with a lower number
});
process.env.SB_SHIM_AGENTS = '[]';
process.env.PATH = path.join(__dirname, 'shim') + path.delimiter + process.env.PATH;
const core = require('../core.cjs');

const EXT = 'nima-ghorbani.session-board-vscode';
const uuid = (n) => n.repeat(8) + '-2222-4222-8222-222222222222';
const [LIVE, K1, K2, E1, NOFILE, ARCH] = ['a', 'b', 'c', 'd', 'e', 'f'].map(uuid);
const [RUN_NEW, RUN_OLD, RUN_OTHER, RUN_GONE] = ['1', '2', '3', '4'].map((n) => n.repeat(8) + '-0000-4000-8000-000000000000');
const same = (p) => (core.IS_WINDOWS ? String(p).toLowerCase() : String(p));   // folder keys are lower case on Windows
const keyOf = (p) => same(core.projectFolderName(p));
const line = (o) => JSON.stringify(o) + '\n';
const user = (sid, text) => ({ type: 'user', parentUuid: null, cwd: 'x', sessionId: sid, message: { role: 'user', content: text } });

// the window folders exist, so their real paths can be read (a temp path may be a short 8.3 name)
const root = path.join(tmp, 'webapp');
const elsewhere = path.join(tmp, 'elsewhere');
fs.mkdirSync(root);
fs.mkdirSync(elsewhere);
const REAL = fs.realpathSync.native(root);
const REAL_ELSE = fs.realpathSync.native(elsewhere);
const link = path.join(tmp, 'link-webapp');
let linked = true;
try { fs.symlinkSync(root, link, 'junction'); } catch (_) { linked = false; }

// every transcript exists before the first call: the folder index is rebuilt at most once a minute
function transcript(folder, sessionId, ageMs) {
  const dir = path.join(projectsDir, core.projectFolderName(folder));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, line(user(sessionId, 'a prompt')));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return file;
}
transcript(REAL, LIVE, 1000);
transcript(REAL, K1, 60 * 1000);
transcript(REAL, K2, 2 * 60 * 1000);
transcript(REAL, ARCH, 3 * 60 * 1000);
transcript(REAL_ELSE, E1, 4 * 60 * 1000);

const file = (id) => path.join(core.KEPT_DIR, id + '.json');
const has = (id) => fs.existsSync(file(id));
const rec = (id) => JSON.parse(fs.readFileSync(file(id), 'utf8'));
const names = () => { try { return fs.readdirSync(core.KEPT_DIR).sort(); } catch (_) { return []; } };
function record(id, over) {
  fs.mkdirSync(core.KEPT_DIR, { recursive: true });
  fs.writeFileSync(file(id), JSON.stringify(Object.assign({ root: keyOf(REAL), run: RUN_OLD, at: Date.now() - 1000 }, over)));
}
const clearRecords = () => fs.rmSync(core.KEPT_DIR, { recursive: true, force: true });
function heartbeat(pid, folder, run) { core.writeHeartbeat(pid, EXT, 'win' + pid, false, '0.13.0', folder, run); }
const clearHeartbeats = () => fs.rmSync(heartbeatDir, { recursive: true, force: true });
const runRow = (id, exthostPid, extra) => Object.assign({ sessionId: id, window: { id: 7, exthostPid }, archived: false }, extra);
const list = (opts) => core.listedSessions(new Set(), new Set(), new Set(), opts);
const rowOf = (rows, id) => rows.find((r) => r.sessionId === id);
function agents(rows) { process.env.SB_SHIM_AGENTS = JSON.stringify(rows); }
const liveRow = (startedAt) => ({ sessionId: LIVE, pid: process.pid, status: 'idle', cwd: root, name: 'me', kind: 'interactive', startedAt });
function registry() { fs.writeFileSync(path.join(sessionsDir, process.pid + '.json'), JSON.stringify({ sessionId: LIVE, status: 'idle', statusUpdatedAt: Date.now() })); }

test('tracker: one record for a running row of its window; none for another window\'s row, an archived row or a window without a folder; a second poll writes nothing', () => {
  clearRecords();
  let clock = 1000000;
  const tracker = core.createKeptTracker(RUN_NEW, NEW, () => clock);
  const rows = [runRow(LIVE, NEW), runRow(K1, OTHER), runRow(K2, NEW, { archived: true }), { sessionId: E1, window: null, archived: false }];
  assert.deepEqual(tracker.observe(rows, root), { written: 1, removed: 0 });
  assert.deepEqual(names(), [LIVE + '.json'], 'no temp file left behind, no record for the other rows');
  assert.deepEqual(rec(LIVE), { root: keyOf(REAL), run: RUN_NEW, at: 1000000 }, 'the folder by its real path, the lifetime, the time');
  clock += 5000;
  assert.deepEqual(tracker.observe(rows, root), { written: 0, removed: 0 }, 'a running session costs one write per process and lifetime, not one per poll');
  assert.equal(rec(LIVE).at, 1000000);
  fs.unlinkSync(file(LIVE));                                // taken by something else while the session runs on
  clock += 5000;
  assert.deepEqual(tracker.observe(rows, root), { written: 1, removed: 0 }, 'the tracker reads the disk at every poll: a record that went missing is written again');
  assert.deepEqual(core.createKeptTracker(RUN_NEW, NEW, () => clock).observe([runRow(K1, NEW)], null), { written: 0, removed: 0 }, 'a window without a folder');
  assert.equal(has(K1), false);
});

test('tracker: a record of another lifetime or of another folder is rewritten', () => {
  clearRecords();
  const tracker = core.createKeptTracker(RUN_NEW, NEW, () => 2000000);
  record(LIVE, { run: RUN_OLD, at: 5 });
  assert.deepEqual(tracker.observe([runRow(LIVE, NEW)], root), { written: 1, removed: 0 });
  assert.deepEqual([rec(LIVE).run, rec(LIVE).at], [RUN_NEW, 2000000], 'the session runs in this lifetime now');
  record(LIVE, { run: RUN_NEW, root: 'another-folder' });
  tracker.observe([runRow(LIVE, NEW)], root);
  assert.equal(rec(LIVE).root, keyOf(REAL), 'the session runs in this window\'s folder now');
});

test('tracker: a session gone for 59 s keeps its record and one gone for 60 s loses it, but only a record this lifetime owns; a record never seen running stays', () => {
  clearRecords();
  let clock = 3000000;
  const tracker = core.createKeptTracker(RUN_NEW, NEW, () => clock);
  record(K1, { run: RUN_OLD });                             // a kept card of the lifetime before
  tracker.observe([runRow(LIVE, NEW)], root);
  clock += 59000;
  assert.deepEqual(tracker.observe([], root), { written: 0, removed: 0 });
  assert.ok(has(LIVE), 'gone for 59 s: the host may be shutting down, the record stays');
  clock += 1000;
  assert.deepEqual(tracker.observe([], root), { written: 0, removed: 1 });
  assert.equal(has(LIVE), false, 'gone for 60 s while the window lives: it ended on its own');
  assert.ok(has(K1), 'never seen running in this lifetime: a kept card, not touched');

  tracker.observe([runRow(LIVE, NEW)], root);
  record(LIVE, { run: RUN_OTHER });                         // another lifetime took the session over meanwhile
  clock += 60000;
  assert.deepEqual(tracker.observe([], root), { written: 0, removed: 0 });
  assert.ok(has(LIVE), 'a record that names another lifetime is not this one\'s to remove');
});

test('tracker: a session that runs again in a newer process within the same lifetime gets a fresh record, so a process that outlives the host keeps its card', () => {
  clearRecords();
  let clock = 5000000;
  const tracker = core.createKeptTracker(RUN_NEW, NEW, () => clock);
  tracker.observe([runRow(LIVE, NEW, { startedAt: clock - 1000 })], root);
  assert.deepEqual(rec(LIVE), { root: keyOf(REAL), run: RUN_NEW, at: 5000000, startedAt: 4999000 }, 'the record names its process by the time it started');
  clock += 20000;                                           // ended and resumed within the minute: the record is still there
  const resumedAt = clock - 5000;
  assert.deepEqual(tracker.observe([runRow(LIVE, NEW, { startedAt: resumedAt })], root), { written: 1, removed: 0 }, 'the record is for the process that runs now');
  assert.deepEqual([rec(LIVE).at, rec(LIVE).startedAt], [clock, resumedAt]);
  clock += 5000;
  assert.deepEqual(tracker.observe([runRow(LIVE, NEW, { startedAt: resumedAt })], root), { written: 0, removed: 0 }, 'and then once per process');
  const map = core.readKept();                              // the host is gone, the new process lives on: no lifetime is alive
  core.reconcileKept(map, [{ sessionId: LIVE, startedAt: resumedAt }], new Set(), new Set([LIVE]), new Set(), { known: true, ids: new Set() });
  assert.ok(has(LIVE), 'reconcile reads it as the process the record was written for, not as a resume elsewhere');
});

test('tracker: a row whose process is gone by now gets no record (a snapshot from before the session ended)', () => {
  clearRecords();
  const gone = require('child_process').spawnSync(process.execPath, ['-e', '']).pid;   // a pid that has just exited
  const tracker = core.createKeptTracker(RUN_NEW, NEW, () => 5500000);
  assert.deepEqual(tracker.observe([runRow(LIVE, NEW, { pid: gone })], root), { written: 0, removed: 0 });
  assert.equal(has(LIVE), false);
  assert.deepEqual(tracker.observe([runRow(LIVE, NEW, { pid: process.pid })], root), { written: 1, removed: 0 }, 'a process that lives');
});

test('tracker: a session it has seen in its window keeps its record while nothing says where it runs (the window lookup failed); one seen in another window loses it after the wait', () => {
  clearRecords();
  let clock = 5700000;
  const tracker = core.createKeptTracker(RUN_NEW, NEW, () => clock);
  tracker.observe([runRow(LIVE, NEW, { pid: process.pid }), runRow(K1, NEW, { pid: process.pid }), runRow(NOFILE, NEW, { pid: process.pid, startedAt: 1000 })], root);
  assert.deepEqual([has(LIVE), has(K1), has(NOFILE)], [true, true, true]);
  const lost = [{ sessionId: LIVE, window: null, archived: false, pid: process.pid }, runRow(K1, OTHER, { pid: process.pid }),
    { sessionId: NOFILE, window: null, archived: false, pid: process.pid, startedAt: 2000 }];   // ended here and resumed in a terminal: another process, and no window is its true state
  for (let i = 0; i < 13; i++) { clock += 5000; tracker.observe(lost, root); }   // 65 s without a window for LIVE; K1 runs in another window now
  assert.ok(has(LIVE), 'it still runs and was last seen here: the wait does not start');
  assert.equal(has(K1), false, 'seen in another window: no longer this window\'s card');
  assert.equal(has(NOFILE), false, 'another process of the session without a window is a resume elsewhere: the wait went on');
  assert.deepEqual(core.createKeptTracker(RUN_NEW, NEW, () => clock).observe([{ sessionId: K2, window: null, archived: false, pid: process.pid }], root), { written: 0, removed: 0 }, 'a session without a window that this lifetime never saw in its own gets no record');
  assert.equal(has(K2), false);
});

test('a record or a lock that cannot be read for a moment stays; one that is no record is removed', () => {
  clearRecords();
  record(K1, { run: RUN_OLD });
  record(K2, { run: RUN_OLD });
  fs.writeFileSync(file(K2), '{ no json');
  core.setLocks({ set: { [K1]: 4 } });
  const lock = path.join(core.LOCKS_DIR, K1 + '.json');
  const read = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === file(K1) || String(p) === lock) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return read(p, ...rest);
  };
  let kept, locks;
  try { kept = core.readKept(); locks = core.readLocks(); } finally { fs.readFileSync = read; }
  assert.deepEqual([kept.has(K1), locks.has(K1)], [false, false], 'not listed while it cannot be read');
  assert.deepEqual([has(K1), fs.existsSync(lock)], [true, true], 'and not deleted: a failed read says nothing about what the file holds');
  assert.equal(has(K2), false, 'a file that holds no record is removed, as before');
  assert.deepEqual([core.readKept().get(K1).run, core.readLocks().get(K1).slot], [RUN_OLD, 4], 'readable again: back as it was');
  core.setLocks({ clear: [K1] });
});

test('tracker: a record it cannot read when the wait is over is looked at again; one that cannot be written does not stop the others', () => {
  clearRecords();
  let clock = 5900000;
  const tracker = core.createKeptTracker(RUN_NEW, NEW, () => clock);
  tracker.observe([runRow(LIVE, NEW)], root);
  clock += 60000;
  const read = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => { if (String(p) === file(LIVE)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); return read(p, ...rest); };
  try { assert.deepEqual(tracker.observe([], root), { written: 0, removed: 0 }); } finally { fs.readFileSync = read; }
  assert.ok(has(LIVE), 'not readable at this poll: nothing says whose it is');
  clock += 5000;
  assert.deepEqual(tracker.observe([], root), { written: 0, removed: 1 }, 'readable again: it is this lifetime\'s and the session is gone, so it goes');

  tracker.observe([runRow(K2, NEW)], root);                 // K2 runs, then ends: its record is due when the next rows come
  clock += 60000;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to) === file(LIVE)) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); return rename(from, to); };
  try { assert.throws(() => tracker.observe([runRow(LIVE, NEW), runRow(K1, NEW)], root), /EPERM/, 'the failure is reported'); } finally { fs.renameSync = rename; }
  assert.deepEqual([has(LIVE), has(K1), has(K2)], [false, true, false], 'the session after the one that failed has its record, and the ended one lost its own');
  assert.deepEqual(names(), [K1 + '.json'], 'no temp file left behind');
});

test('tracker: a record that cannot be removed is tried again on the next poll', () => {
  clearRecords();
  let clock = 6000000;
  const tracker = core.createKeptTracker(RUN_NEW, NEW, () => clock);
  tracker.observe([runRow(LIVE, NEW)], root);
  clock += 60000;
  const unlink = fs.unlinkSync;
  let refused = 0;
  fs.unlinkSync = (p) => {
    if (String(p) === file(LIVE) && refused === 0) { refused += 1; throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); }
    return unlink(p);
  };
  try {
    assert.deepEqual(tracker.observe([], root), { written: 0, removed: 0 });
    assert.deepEqual([refused, has(LIVE)], [1, true], 'the file was held: the record is still there');
    clock += 5000;
    assert.deepEqual(tracker.observe([], root), { written: 0, removed: 1 }, 'not forgotten: the next poll removes it');
  } finally { fs.unlinkSync = unlink; }
  assert.equal(has(LIVE), false);
});

test('an explicit end drops the record at once: ended by hand and the window closed within the minute, the card does not come back', { skip: !core.IS_WINDOWS }, async () => {
  clearRecords(); clearHeartbeats();
  heartbeat(NEW, root, RUN_NEW);
  agents([]);
  record(K1, { run: RUN_NEW });                             // its window lives; the tracker would drop it only a minute after it went
  const r = await core.endSession(K1, {});
  assert.equal(r.code, 'unknown', 'the session is not running (any more)');
  assert.equal(has(K1), false, 'the end is the user\'s word: no card to keep');
  assert.equal('keptError' in r, false);

  // a record that cannot be removed: the end still succeeds and says so, instead of calling the card gone
  record(K1, { run: RUN_NEW });
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (p) => { if (String(p) === file(K1)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); return unlink(p); };
  let held;
  try { held = await core.endSession(K1, {}); } finally { fs.unlinkSync = unlink; }
  assert.deepEqual([held.code, has(K1)], ['unknown', true]);
  assert.match(held.keptError, /EPERM/, 'the result names what was left behind');
  await core.endSession(K1, {});
  assert.equal(has(K1), false, 'the next end removes it');
  // an end that is refused drops nothing: the session works and no force was given, so nothing is killed
  fs.writeFileSync(path.join(sessionsDir, process.pid + '.json'), JSON.stringify({ sessionId: LIVE, status: 'busy', statusUpdatedAt: Date.now() }));
  agents([Object.assign(liveRow(Date.now() - 1000), { status: 'busy' })]);
  await core.snapshot();
  record(LIVE, { run: RUN_NEW, at: Date.now() });
  const refused = await core.endSession(LIVE, {});
  assert.deepEqual([refused.code, has(LIVE)], ['needs-force', true], 'it still runs: its record stays');
  agents([]);
});

test('an end that cannot read the record leaves it and says so; a file that holds no record goes', { skip: !core.IS_WINDOWS }, async () => {
  clearRecords(); clearHeartbeats();
  heartbeat(NEW, root, RUN_NEW);
  agents([]);
  record(K1, { run: RUN_NEW, startedAt: Date.now() + 60000 });   // the record of a process started after this end is asked for: not this end's to take
  const read = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => { if (String(p) === file(K1)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); return read(p, ...rest); };
  let held;
  try { held = await core.endSession(K1, {}); } finally { fs.readFileSync = read; }
  assert.deepEqual([held.code, has(K1)], ['unknown', true], 'not readable at this moment: nothing says whose record it is, so it stays');
  assert.match(String(held.keptError), /EBUSY/, 'and the result says what was left behind');
  const again = await core.endSession(K1, {});
  assert.deepEqual([has(K1), 'keptError' in again], [true, false], 'readable again: the record of a process started after the end was asked for is left, without a complaint');
  fs.writeFileSync(file(K1), '{ no json');
  const gone = await core.endSession(K1, {});
  assert.deepEqual([has(K1), 'keptError' in gone], [false, false], 'a file that can be read and holds no record goes, as before');
});

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * End a session whose process really runs, and call `during` while that end is under way. The
 * session is a background job, so the end goes through the `claude stop` shim, and the shim is
 * told to wait at a gate: it says when it has reached it, `during` runs, then the gate opens and
 * the stop ends the process. `before` runs after the board has seen the session and before the
 * end is asked for. Both get the process of the session; `start` is the start time its row
 * carries (5 s ago when none is given).
 */
async function endUnderWay(id, steps, start) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 60000)'], { stdio: 'ignore' });
  const reg = path.join(sessionsDir, child.pid + '.json');
  const gate = path.join(tmp, 'stop-gate-' + child.pid);
  const proc = { pid: child.pid, startedAt: start === undefined ? Date.now() - 5000 : start };
  try {
    fs.writeFileSync(reg, JSON.stringify({ sessionId: id, status: 'idle', procStart: '0' }));
    agents([Object.assign({ id: id.slice(0, 8), sessionId: id, status: 'idle', kind: 'background', cwd: root, name: 'bg' }, proc)]);
    process.env.SB_SHIM_STOP_KILL_PID = String(child.pid);
    process.env.SB_SHIM_STOP_GATE = gate;
    await core.snapshot();
    if (steps.before) steps.before(proc);
    const pending = core.endSession(id, {});
    for (let i = 0; i < 400 && !fs.existsSync(gate + '.reached'); i++) await sleep(25);
    assert.ok(fs.existsSync(gate + '.reached') && core.pidAlive(child.pid), 'the stop was asked for and waits: the end is under way and the session still runs');
    if (steps.during) steps.during(proc);
    fs.writeFileSync(gate, '');
    return await pending;
  } finally {
    delete process.env.SB_SHIM_STOP_KILL_PID;
    delete process.env.SB_SHIM_STOP_GATE;
    try { fs.writeFileSync(gate, ''); } catch (_) { /* the temp dir is gone */ }
    try { child.kill(); } catch (_) { /* the end stopped it */ }
    try { fs.unlinkSync(reg); } catch (_) { /* gone */ }
    agents([]);
  }
}

test('an end takes the record of the process it was aimed at and leaves that of a process started later, whenever either was written', { skip: !core.IS_WINDOWS }, async () => {
  clearRecords(); clearHeartbeats();
  heartbeat(NEW, root, RUN_NEW);
  const tracker = core.createKeptTracker(RUN_NEW, NEW);
  const seen = (proc) => tracker.observe([runRow(K1, NEW, proc)], root);
  const one = { written: 1, removed: 0 };

  // the window sees the session for the first time while its end is already running
  let wrote = null;
  let out = await endUnderWay(K1, { during: (proc) => { wrote = seen(proc); assert.ok(has(K1)); } });
  assert.deepEqual([out.code, wrote], ['ended', one], JSON.stringify(out));
  assert.equal(has(K1), false, 'written after the end began, but for the process that was ended: no card to keep');

  // the session is resumed while the end of its old process is still running, and its window sees the new process
  out = await endUnderWay(K1, { during: () => { wrote = seen({ pid: process.pid, startedAt: Date.now() }); } });
  assert.deepEqual([out.code, wrote], ['ended', one], JSON.stringify(out));
  assert.ok(has(K1), 'the end of the old process does not take the record of the new one');

  // resumed before the end was asked for: the board that ends it still shows the old process, the record is the new one's already
  clearRecords();
  out = await endUnderWay(K1, { before: (proc) => { wrote = core.createKeptTracker(RUN_NEW, NEW).observe([runRow(K1, NEW, { pid: process.pid, startedAt: proc.startedAt + 2000 })], root); } });
  assert.deepEqual([out.code, wrote], ['ended', one], JSON.stringify(out));
  assert.ok(has(K1), 'a process started later than the one the end was aimed at, also when it started before the end was asked for');

  // a row without a start time (an older CLI): the time the end was asked for stands in for the start of its process
  out = await endUnderWay(K1, {}, null);
  assert.deepEqual([out.code, has(K1)], ['ended', false], 'the record names a process that ran before the end was asked for: it may be the one that was ended, so it goes');
  out = await endUnderWay(K1, { during: () => { wrote = seen({ pid: process.pid, startedAt: Date.now() }); } }, null);
  assert.deepEqual([out.code, wrote], ['ended', one], JSON.stringify(out));
  assert.ok(has(K1), 'a process started after the end was asked for is not the one that was ended, whatever is known of that one');
});

test('heartbeat: carries the run of its host; a value that is no run id is left out', () => {
  clearHeartbeats();
  heartbeat(NEW, root, RUN_NEW);
  const read = () => JSON.parse(fs.readFileSync(path.join(heartbeatDir, 'board-' + NEW + '-' + EXT + '.json'), 'utf8'));
  assert.equal(read().run, RUN_NEW);
  heartbeat(NEW, root, '../../x');
  assert.equal('run' in read(), false);
  heartbeat(NEW, root);
  assert.equal('run' in read(), false, 'a board before 0.13.0 passes none');
});

test('flag: an ended row is kept when its record names this folder and a lifetime that is not alive; a pid plays no part', () => {
  clearRecords(); clearHeartbeats();
  heartbeat(NEW, root, RUN_NEW);
  record(K1, { run: RUN_OLD });
  let { ended } = list({ kept: core.readKept() });
  assert.deepEqual([rowOf(ended, K1).kept, rowOf(ended, K2).kept], [true, false], 'a record of a dead lifetime; no record');
  assert.equal(rowOf(ended, K1).window.id, 7);

  record(K2, { run: RUN_NEW });
  ended = list({ kept: core.readKept() }).ended;
  assert.equal(rowOf(ended, K2).kept, false, 'the lifetime that saw it running is alive: it ended on its own a moment ago');

  heartbeat(OLD, root, RUN_OLD);                             // a fresh heartbeat of a host whose process is gone
  ended = list({ kept: core.readKept() }).ended;
  assert.equal(rowOf(ended, K1).kept, true, 'a heartbeat of a dead process keeps no lifetime alive');

  record(K1, { run: RUN_OLD, root: 'another-folder' });
  ended = list({ kept: core.readKept() }).ended;
  assert.equal(rowOf(ended, K1).kept, false, 'it ran in a window on another folder');
  assert.equal(rowOf(list().ended, K1).kept, false, 'without records: no flag');
});

test('flag: with records and without, the lists hold the same ids in the same windows', () => {
  clearRecords(); clearHeartbeats();
  heartbeat(NEW, root, RUN_NEW);
  heartbeat(OTHER, elsewhere, RUN_OTHER);
  const board = new Set([ARCH]);
  const shape = (r) => ({ ended: r.ended.map((x) => [x.sessionId, x.window.id]), archived: r.archived.map((x) => [x.sessionId, x.window.id]) });
  const before = shape(core.listedSessions(new Set(), new Set(), board, { withArchived: true }));
  for (const id of [K1, K2, E1, ARCH]) record(id, { run: RUN_OLD });   // E1 lies in the other window's folder
  const after = core.listedSessions(new Set(), new Set(), board, { withArchived: true, kept: core.readKept() });
  assert.deepEqual(shape(after), before, 'no row added, none moved');
  assert.deepEqual(before.ended.map((x) => x[0]).sort(), [E1, K1, K2, LIVE].sort(), 'every transcript of the two folders that is not archived (no session is running here)');
  assert.deepEqual([rowOf(after.ended, K1).kept, rowOf(after.ended, E1).kept, rowOf(after.archived, ARCH).kept], [true, false, false],
    'only the flag differs: set in its own folder\'s window, not in another folder\'s, never on an archived row');
});

test('a fresh heartbeat of a dead host owns no folder: the rows go to the window that lives', () => {
  clearRecords(); clearHeartbeats();
  heartbeat(GONE, root, RUN_GONE);                           // window 6 closed a moment ago; its heartbeat is still fresh
  heartbeat(NEW, root, RUN_NEW);                             // window 7 is open on the same folder
  record(K1, { run: RUN_GONE });
  const { ended } = list({ kept: core.readKept() });
  assert.deepEqual([rowOf(ended, K1).window.id, rowOf(ended, K1).kept], [7, true], 'the closed window\'s card shows in the open one');
});

test('a record written in a window opened through a junction flags the row in a window opened on the real path', { skip: !linked }, () => {
  clearRecords(); clearHeartbeats();
  assert.deepEqual(core.createKeptTracker(RUN_OLD, OLD, () => 4000000).observe([runRow(K1, OLD)], link), { written: 1, removed: 0 });
  assert.equal(rec(K1).root, keyOf(REAL), 'the folder by its real path, not by the junction');
  heartbeat(NEW, root, RUN_NEW);
  assert.equal(rowOf(list({ kept: core.readKept() }).ended, K1).kept, true);
});

test('snapshot: kept travels on the ended rows with their lock; a session that still runs under a dead lifetime\'s record is a running row and no ended row', async () => {
  clearRecords(); clearHeartbeats();
  heartbeat(NEW, root, RUN_NEW);
  registry();
  agents([liveRow(Date.now() - 3600 * 1000)]);               // the process is older than its record: it outlived its host
  record(LIVE, { run: RUN_OLD });
  record(K1, { run: RUN_OLD });
  core.setLocks({ set: { [K1]: 2 } });
  const snap = await core.snapshot();
  assert.deepEqual(snap.sessions.map((s) => s.sessionId), [LIVE]);
  assert.equal(rowOf(snap.ended, LIVE), undefined, 'running: not among the ended rows');
  assert.deepEqual([rowOf(snap.ended, K1).kept, rowOf(snap.ended, K1).lockSlot, rowOf(snap.ended, K2).kept], [true, 2, false]);
  assert.ok(has(LIVE), 'the old process still runs: its record stays for the day it ends');
  core.setLocks({ clear: [K1] });
});

test('reconcile: a kept session that runs again in a process younger than its record, with the record\'s lifetime dead, loses the record; a live lifetime keeps it', async () => {
  clearRecords(); clearHeartbeats();
  heartbeat(NEW, root, RUN_NEW);
  registry();
  agents([liveRow(Date.now())]);                             // resumed just now, in a terminal: no tracker owns it
  record(LIVE, { run: RUN_OLD, at: Date.now() - 60000 });
  await core.snapshot();
  assert.equal(has(LIVE), false, 'the card is spent: it must not come back when the session ends there');
  record(LIVE, { run: RUN_NEW, at: Date.now() - 60000 });
  await core.snapshot();
  assert.ok(has(LIVE), 'the lifetime that wrote the record is alive: the record is its own');
  const map = core.readKept();                              // a row without a start time (an older CLI): nothing can be told, the record stays
  core.reconcileKept(map, [{ sessionId: LIVE }, { sessionId: LIVE, startedAt: 'soon' }], new Set(), new Set([LIVE]), new Set(), { known: true, ids: new Set() });
  assert.ok(has(LIVE));
  agents([]);
});

test('reconcile: a record goes with an archive (on the board at once, in Claude Code once its archive has been read) and with a transcript that is gone', async () => {
  clearRecords(); clearHeartbeats();
  heartbeat(NEW, root, RUN_NEW);
  agents([]);
  record(ARCH); record(K1); record(NOFILE);
  const r = await core.archivePast(ARCH);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(has(ARCH), false, 'the record went with the archive, before any snapshot');
  await core.snapshot();
  assert.equal(has(NOFILE), false, 'not running and no transcript anywhere: dropped');
  assert.ok(has(K1), 'ended with a transcript: kept');

  let map = core.readKept();
  core.reconcileKept(map, [], new Set(), new Set(), new Set(), { known: false, ids: new Set([K1]) });
  assert.deepEqual([map.has(K1), has(K1)], [true, true], 'Claude Code\'s archive not read yet: nothing is dropped on its word');
  core.reconcileKept(map, [], new Set(), new Set(), new Set(), { known: true, error: 'database is locked', ids: new Set([K1]) });
  assert.deepEqual([map.has(K1), has(K1)], [true, true], 'the last read of the archive failed and the ids are those of an earlier read: nothing is dropped on their word either');
  core.reconcileKept(map, [], new Set(), new Set(), new Set(), { known: true, ids: new Set([K1]) });
  assert.deepEqual([map.has(K1), has(K1)], [false, false], 'archived in Claude Code');
  await core.unarchiveSession(ARCH);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
