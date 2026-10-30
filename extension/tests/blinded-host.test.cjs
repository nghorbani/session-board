'use strict';
/*
 * Host side of Blinded: the blind and unblind messages call core and answer blindResult (a
 * throwing store answers ok: false), the activity-bar badge and the toast leave blinded
 * sessions out, unblinding a waiting session raises no toast, and the posted snapshot
 * carries this window's id. The host is booted by tests/shim/host.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, cleanup, vscode } = require('./shim/host.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const row = (id, extra) => Object.assign({ sessionId: id, pid: 100, title: 'Spike ' + id.slice(0, 2), name: 'spike', status: 'idle', cwd: 'C:\\x', window: null, archived: false, blinded: false }, extra);
const last = (rows) => ({ sessions: rows, limits: {}, usage: null });
const lastMsg = (posted, type) => posted.filter((m) => m.type === type).pop();

test('blind and unblind messages: core is called for a valid id only, the result is posted and the board refreshes', async () => {
  const calls = [];
  const { provider, posted } = boot({ blindSession: (id) => { calls.push(['blind', id]); }, unblindSession: (id) => { calls.push(['unblind', id]); } }, { last: last([row(A)]) });
  let scheduled = 0;
  provider.schedule = () => { scheduled++; };
  await provider.onMessage({ type: 'blind', sessionId: A });
  await provider.onMessage({ type: 'unblind', sessionId: A });
  await provider.onMessage({ type: 'blind', sessionId: 'nope' });
  assert.deepEqual(calls, [['blind', A], ['unblind', A]]);
  assert.deepEqual(posted.filter((m) => m.type === 'blindResult'), [
    { type: 'blindResult', sessionId: A, ok: true, blinded: true, message: '' },
    { type: 'blindResult', sessionId: A, ok: true, blinded: false, message: '' },
  ]);
  assert.equal(scheduled, 2);
});

test('a store that throws answers ok: false with the message and logs it', async () => {
  const { provider, posted } = boot({ blindSession: () => { throw new Error('EACCES: permission denied'); } }, { last: last([row(A)]) });
  provider.schedule = () => {};
  await assert.doesNotReject(provider.onMessage({ type: 'blind', sessionId: A }));
  assert.deepEqual(lastMsg(posted, 'blindResult'), { type: 'blindResult', sessionId: A, ok: false, blinded: false, message: 'EACCES: permission denied' });
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'error' && /blind .*EACCES/.test(m)));
});

test('the activity-bar badge counts waiting sessions that are not blinded', () => {
  const { provider } = boot({}, { last: last([row(A, { status: 'waiting' }), row(B, { status: 'waiting', blinded: true })]) });
  provider.updateBadge();
  assert.equal(provider.view.badge.value, 1);
  provider.last = last([row(B, { status: 'waiting', blinded: true })]);
  provider.updateBadge();
  assert.equal(provider.view.badge, undefined, 'only a blinded session waits: no badge');
});

test('the toast skips a blinded session, says nothing when it is unblinded while waiting, and speaks for a new one', () => {
  const { provider } = boot({}, { last: last([row(A, { status: 'idle' })]) });
  provider.notifyNewlyWaiting();                                            // primes
  provider.last = last([row(A, { status: 'waiting', blinded: true })]);
  provider.notifyNewlyWaiting();
  assert.deepEqual(vscode.__warnings, [], 'blinded: no toast');
  provider.last = last([row(A, { status: 'waiting', blinded: false })]);
  provider.notifyNewlyWaiting();
  assert.deepEqual(vscode.__warnings, [], 'unblinded while waiting: already tracked, no toast');
  provider.last = last([row(A, { status: 'waiting' }), row(B, { status: 'waiting', title: 'New one', waitingFor: 'input needed' })]);
  provider.notifyNewlyWaiting();
  assert.deepEqual(vscode.__warnings, ['New one: input needed']);
});

test('the posted snapshot carries this window id from the extension host pid', async () => {
  const asked = [];
  const { provider, posted } = boot({ snapshot: async () => ({ sessions: [], limits: {}, usage: null }), windowIdForExthost: (pid) => { asked.push(pid); return 3; }, refreshUsageIfStale: () => null }, { noSnapshot: true });
  provider.schedule = () => {};
  await provider.refresh();
  assert.deepEqual(asked, [process.pid]);
  assert.equal(lastMsg(posted, 'snapshot').data.thisWindowId, 3);
});

test.after(() => cleanup());
