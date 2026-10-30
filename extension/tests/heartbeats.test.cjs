'use strict';
/*
 * The heartbeat readers in core.cjs delete what no board will read again: a record older than a
 * day (by its `at`, else by its mtime) and a `.tmp.<pid>` file a writer left behind when it died
 * between write and rename. A fresh record stays; a record over 45 s but under a day old is stale
 * (ignored by the readers) yet kept, since the window that wrote it may only be slow. The dir is
 * a temp dir through SB_HEARTBEAT_DIR; the installed-extension list is a temp file through
 * SB_VSCODE_EXTENSIONS_JSON, so boardAlive() answers the same on every machine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-heartbeats-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
process.env.SB_CODE_USER_DIR = path.join(tmp, 'User');
const heartbeatDir = path.join(tmp, 'heartbeats');
process.env.SB_HEARTBEAT_DIR = heartbeatDir;
const EXT_ID = 'nima-ghorbani.session-board-vscode';
const OTHER_ID = 'someone.other-board';
process.env.SB_VSCODE_EXTENSIONS_JSON = path.join(tmp, 'extensions.json');
fs.writeFileSync(process.env.SB_VSCODE_EXTENSIONS_JSON, JSON.stringify([{ identifier: { id: EXT_ID } }]));
const core = require('../core.cjs');

const DAY = 24 * 60 * 60 * 1000;
const file = (pid, id) => path.join(heartbeatDir, 'board-' + pid + '-' + (id || EXT_ID) + '.json');
function record(pid, ageMs, extra, id) {
  fs.mkdirSync(heartbeatDir, { recursive: true });
  const rec = Object.assign({ pid, at: Date.now() - ageMs, id: id || EXT_ID }, extra || {});
  if (extra && extra.at === undefined && 'at' in extra) delete rec.at;
  fs.writeFileSync(file(pid, id), JSON.stringify(rec));
}
function aged(p, ageMs) {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
}
const exists = (p) => fs.existsSync(p);

test('heartbeatNames: records older than a day and leftover tmp files are deleted; fresh and merely stale ones stay', () => {
  record(1, 0, { name: 'fresh' });
  record(2, 120000, { name: 'stale' });
  record(3, DAY + 60000, { name: 'old' });
  record(4, DAY + 60000);
  record(5, 0, { name: 'no at', at: undefined });
  record(6, 0, { name: 'no at, old file', at: undefined });
  aged(file(6), 2 * DAY);
  fs.writeFileSync(file(7), 'not json');
  fs.writeFileSync(file(8), 'not json');
  aged(file(8), 2 * DAY);
  const tmpFresh = file(9) + '.tmp.111';
  const tmpOld = file(10) + '.tmp.222';
  fs.writeFileSync(tmpFresh, '{}');
  fs.writeFileSync(tmpOld, '{}');
  aged(tmpOld, 2 * DAY);
  const foreign = path.join(heartbeatDir, 'other.json');
  fs.writeFileSync(foreign, JSON.stringify({ pid: 11, at: 0, name: 'x' }));
  aged(foreign, 2 * DAY);

  const names = core.heartbeatNames();
  assert.equal(names.get(1), 'fresh');
  assert.equal(names.has(2), false, 'a stale record is ignored');
  assert.equal(names.has(3), false, 'an old record is ignored');
  assert.equal(names.has(5), false, 'a record without at is never fresh');

  assert.ok(exists(file(1)), 'fresh stays');
  assert.ok(exists(file(2)), 'stale under a day stays');
  assert.equal(exists(file(3)), false, 'a day-old named record is deleted');
  assert.equal(exists(file(4)), false, 'a day-old nameless record is deleted');
  assert.ok(exists(file(5)), 'no at, fresh file: kept');
  assert.equal(exists(file(6)), false, 'no at, old file: deleted by mtime');
  assert.ok(exists(file(7)), 'unparseable but fresh: kept');
  assert.equal(exists(file(8)), false, 'unparseable and old: deleted by mtime');
  assert.ok(exists(tmpFresh), 'a fresh tmp file may still be renamed');
  assert.equal(exists(tmpOld), false, 'a day-old tmp file is deleted');
  assert.ok(exists(foreign), 'a file that is not board-* is never touched');
});

test('boardAlive: prunes the same way and answers for the freshest fresh installed record', () => {
  fs.rmSync(heartbeatDir, { recursive: true, force: true });
  record(20, DAY + 60000);
  assert.equal(core.boardAlive(20), null, 'a day-old record names no live board');
  assert.equal(exists(file(20)), false, 'and it is deleted');
  record(21, 0);
  assert.equal(core.boardAlive(21), EXT_ID, 'a fresh installed record answers');
  assert.ok(exists(file(21)));
  record(22, 0, null, OTHER_ID);
  assert.equal(core.boardAlive(22), null, 'an id VS Code does not list as installed does not count');
  assert.ok(exists(file(22, OTHER_ID)), 'but its fresh record stays');
  record(23, 120000);
  assert.equal(core.boardAlive(23), null, 'a stale record is ignored');
  assert.ok(exists(file(23)), 'and kept');
  core.writeHeartbeat(24, EXT_ID, 'w');
  assert.equal(core.boardAlive(24), EXT_ID, 'what writeHeartbeat writes is read back');
});

test('readers on a missing heartbeat dir: empty answers, nothing created', () => {
  fs.rmSync(heartbeatDir, { recursive: true, force: true });
  assert.equal(core.heartbeatNames().size, 0);
  assert.equal(core.boardAlive(1), null);
  assert.equal(exists(heartbeatDir), false);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
