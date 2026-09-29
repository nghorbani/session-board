'use strict';
/*
 * Host side of ⤓: endSession(sid, force, archive) forwards `archive` to core, retries with
 * force after the modal, reports `archived` and `archiveError` in endResult, never lets a
 * rejection escape onMessage, answers `unarchive`, and unarchives a picked archived row.
 * The host is booted by tests/shim/host.cjs; core.endSession is scripted per case.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, cleanup, vscode } = require('./shim/host.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const LAST = { sessions: [{ sessionId: A, pid: 100, title: 'Spike', name: 'spike', status: 'idle', cwd: 'C:\\x', window: null, archived: false }], limits: {}, usage: null };
const last = () => JSON.parse(JSON.stringify(LAST));
const lastMsg = (posted, type) => posted.filter((m) => m.type === type).pop();

test('archive ok: endResult carries archived, the status bar says Archived', async () => {
  const calls = [];
  const { provider, posted } = boot({ endSession: async (id, opts) => { calls.push(opts); return { ok: true, code: 'ended', pid: 100, archived: true }; } }, { last: last() });
  await provider.endSession(A, false, true);
  assert.deepEqual(calls, [{ force: false, archive: true }]);
  assert.deepEqual(lastMsg(posted, 'endResult'), { type: 'endResult', sessionId: A, ok: true, code: 'ended', message: '', archived: true, archiveError: null });
  assert.ok(vscode.__status.some((t) => t === 'Archived: Spike'));
});

test('archive needs-force: the modal offers Archive session and the retry keeps archive', async () => {
  const calls = [];
  const { provider, posted } = boot({ endSession: async (id, opts) => { calls.push(opts); return calls.length === 1 ? { ok: false, code: 'needs-force', status: 'busy' } : { ok: true, code: 'ended', archived: true }; } }, { last: last() });
  vscode.__answer = 'Archive session';
  await provider.endSession(A, false, true);
  assert.deepEqual(calls, [{ force: false, archive: true }, { force: true, archive: true }]);
  assert.match(vscode.__warnings[0], /Archive it\? This ends it and everything it started/);
  assert.equal(lastMsg(posted, 'endResult').archived, true);
});

test('archive cancelled at the modal: no retry, endResult cancelled, no marker call', async () => {
  const calls = [];
  const { provider, posted } = boot({ endSession: async (id, opts) => { calls.push(opts); return { ok: false, code: 'needs-force', status: 'waiting' }; } }, { last: last() });
  vscode.__answer = undefined;
  await provider.endSession(A, false, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(lastMsg(posted, 'endResult'), { type: 'endResult', sessionId: A, ok: false, code: 'cancelled', message: 'cancelled' });
});

test('archive with a failed marker write: ended, not archived, and the user is told', async () => {
  const { provider, posted } = boot({ endSession: async () => ({ ok: true, code: 'ended', archived: false, archiveError: 'EACCES: permission denied' }) }, { last: last() });
  await provider.endSession(A, false, true);
  const r = lastMsg(posted, 'endResult');
  assert.deepEqual([r.ok, r.archived, r.archiveError], [true, false, 'EACCES: permission denied']);
  assert.ok(vscode.__warnings.some((t) => /^Ended, not archived: Spike/.test(t)));
  assert.ok(!vscode.__status.some((t) => /^Archived:/.test(t)));
});

test('plain end still works: archive false, status bar says Ended', async () => {
  const calls = [];
  const { provider, posted } = boot({ endSession: async (id, opts) => { calls.push(opts); return { ok: true, code: 'ended', pid: 100 }; } }, { last: last() });
  await provider.endSession(A, false, false);
  assert.deepEqual(calls, [{ force: false, archive: false }]);
  assert.deepEqual([lastMsg(posted, 'endResult').archived, lastMsg(posted, 'endResult').archiveError], [false, null]);
  assert.ok(vscode.__status.some((t) => t === 'Ended: Spike'));
});

test('onMessage awaits its handlers: a rejecting end is logged, not thrown', async () => {
  const { provider } = boot({ endSession: async () => { throw new Error('kaboom'); } }, { last: last() });
  await assert.doesNotReject(provider.onMessage({ type: 'end', sessionId: A, archive: true }));
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'error' && /message end failed: kaboom/.test(m)));
});

test('unarchive message: core is called and unarchiveResult is posted', async () => {
  const un = [];
  const { provider, posted } = boot({ unarchiveSession: (id) => { un.push(id); } }, { last: last() });
  await provider.onMessage({ type: 'unarchive', sessionId: A });
  assert.deepEqual(un, [A]);
  assert.deepEqual(lastMsg(posted, 'unarchiveResult'), { type: 'unarchiveResult', sessionId: A, ok: true });
});

test('unarchive message: a store failure is reported, not thrown', async () => {
  const { provider, posted } = boot({ unarchiveSession: () => { throw new Error('EPERM'); } }, { last: last() });
  await provider.onMessage({ type: 'unarchive', sessionId: A });
  assert.deepEqual(lastMsg(posted, 'unarchiveResult'), { type: 'unarchiveResult', sessionId: A, ok: false, message: 'EPERM' });
});

test('pickAndOpen: picking an archived row unarchives it first; an ordinary row does not', async () => {
  const un = [];
  const opened = [];
  const seeded = last();
  seeded.sessions[0].archived = true;
  const { provider } = boot({ unarchiveSession: (id) => { un.push(id); } }, { last: seeded });
  provider.openSession = async (id) => { opened.push(id); };
  vscode.__pick = 0;
  await provider.pickAndOpen();
  assert.deepEqual([un, opened], [[A], [A]]);

  const plain = boot({ unarchiveSession: (id) => { un.push(id); } }, { last: last() });
  plain.provider.openSession = async (id) => { opened.push(id); };
  vscode.__pick = 0;
  await plain.provider.pickAndOpen();
  assert.deepEqual([un, opened], [[A], [A, A]]);
});

test.after(cleanup);
