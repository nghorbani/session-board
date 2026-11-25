'use strict';
/*
 * Host side of the kept cards: one run id per activation, written into every heartbeat and given
 * to the tracker of that lifetime; after every poll that is not stale the host hands the tracker
 * the running rows and its first workspace folder, and nothing once the provider has stopped; a
 * tracker that throws leaves the poll and the push to the page intact and is logged once per
 * change. The host is booted by tests/shim/host.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, cleanup, vscode, core } = require('./shim/host.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const snapshotOf = (extra) => Object.assign({ sessions: [], ended: [], order: { show: 'auto' }, limits: {}, usage: null }, extra);
const quiet = { windowIdForExthost: () => 1, refreshUsageIfStale: () => null };
function drive(provider) { provider.stopped = false; provider.schedule = () => {}; }   // boot() stops the provider; these tests call refresh() themselves

test('one run per activation: every heartbeat carries it and the tracker of this lifetime writes under it', () => {
  const beats = [];
  const made = [];
  core.createKeptTracker = (run, pid) => { made.push([run, pid]); return { observe: () => ({ written: 0, removed: 0 }) }; };   // the provider makes its tracker at activation
  const first = boot({ writeHeartbeat: (...args) => { beats.push(args); } });
  first.provider.beat();
  first.provider.beat();
  assert.match(beats[0][6], RUN, 'a random id');
  assert.equal(beats[1][6], beats[0][6], 'the same on every beat of this lifetime');
  assert.deepEqual(made, [[beats[0][6], process.pid]]);
  const second = boot({ writeHeartbeat: (...args) => { beats.push(args); } });
  second.provider.beat();
  assert.notEqual(beats[2][6], beats[0][6], 'the next activation is another lifetime');
});

test('a poll hands the tracker the running rows and the first workspace folder; a stale snapshot and a stopped provider hand it nothing', async () => {
  let stale = false;
  const rows = [{ sessionId: A, status: 'idle', window: { id: 1, exthostPid: process.pid } }];
  const { provider } = boot(Object.assign({ snapshot: async () => snapshotOf({ sessions: rows, stale }) }, quiet));
  drive(provider);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: 'D:\\code\\repo' } }, { uri: { fsPath: 'D:\\code\\second' } }];
  const seen = [];
  provider.keptTracker = { observe: (r, folder) => { seen.push([r, folder]); return { written: 0, removed: 0 }; } };
  await provider.refresh();
  assert.deepEqual(seen, [[rows, 'D:\\code\\repo']]);
  stale = true;
  await provider.refresh();
  assert.equal(seen.length, 1, 'rows from the cache after a failed poll say nothing about what runs');
  stale = false;
  provider.stopped = true;
  await provider.refresh();
  assert.equal(seen.length, 1, 'the extension is going down: a poll that was under way hands nothing over');
  provider.stopped = false;
  vscode.workspace.workspaceFolders = [];
  await provider.refresh();
  assert.deepEqual(seen[1], [rows, null], 'a window without a folder: the tracker is told so and keeps nothing');
});

test('a tracker that throws leaves the poll and the push to the page intact, and is logged once per change', async () => {
  const { provider, posted } = boot(Object.assign({ snapshot: async () => snapshotOf() }, quiet));
  drive(provider);
  let message = 'EACCES: permission denied';
  provider.keptTracker = { observe: () => { if (message) throw new Error(message); return { written: 0, removed: 0 }; } };
  const said = () => vscode.__log.filter(([lvl, m]) => lvl === 'warn' && /cards of this window/.test(m));
  await assert.doesNotReject(provider.refresh());
  await provider.refresh();
  assert.equal(posted.filter((m) => m.type === 'snapshot').length, 2, 'both polls reached the page');
  assert.equal(said().length, 1, 'the same failure is said once');
  assert.match(said()[0][1], /EACCES/);
  assert.equal(vscode.__log.some(([lvl, m]) => lvl === 'error' && /poll failed/.test(m)), false, 'it is not a failed poll');
  message = 'ENOSPC: no space left on device';
  await provider.refresh();
  assert.equal(said().length, 2, 'another failure is said');
  message = null;
  await provider.refresh();
  message = 'ENOSPC: no space left on device';
  await provider.refresh();
  assert.equal(said().length, 3, 'gone and back: said again');
});

test('an end that left the card\'s record behind says so in the log', async () => {
  const { provider } = boot({ endSession: async () => ({ ok: true, code: 'ended', keptError: 'EPERM: operation not permitted' }) }, { last: { sessions: [{ sessionId: A, title: 'Spike', status: 'idle' }], limits: {}, usage: null } });
  provider.schedule = () => {};
  await provider.endSession(A, false, false);
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'info' && /end .*ended.*card record not removed: EPERM/.test(m)), JSON.stringify(vscode.__log));
});

test.after(() => cleanup());
