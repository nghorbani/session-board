'use strict';
/*
 * Host side of the manual order: the order and sortMode messages call core and answer
 * orderResult / sortModeResult (a throwing store answers ok: false), a non-list ids never
 * reaches core, and the posted snapshot carries order.mode and rank as core gives them.
 * The host is booted by tests/shim/host.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, cleanup, vscode } = require('./shim/host.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const lastMsg = (posted, type) => posted.filter((m) => m.type === type).pop();

test('order and sortMode messages call core, post their results and refresh the board', async () => {
  const calls = [];
  const { provider, posted } = boot({ setOrder: (ids) => { calls.push(['order', ids]); return ids.length; }, setSortMode: (mode) => { calls.push(['mode', mode]); return mode; } });
  let scheduled = 0;
  provider.schedule = () => { scheduled++; };
  await provider.onMessage({ type: 'order', ids: [B, A] });
  await provider.onMessage({ type: 'sortMode', mode: 'manual' });
  assert.deepEqual(calls, [['order', [B, A]], ['mode', 'manual']]);
  assert.deepEqual(lastMsg(posted, 'orderResult'), { type: 'orderResult', ok: true, count: 2, message: '' });
  assert.deepEqual(lastMsg(posted, 'sortModeResult'), { type: 'sortModeResult', ok: true, mode: 'manual', message: '' });
  assert.equal(scheduled, 2);
});

test('a non-list ids is refused before core; a throwing store answers ok: false with the message and logs it', async () => {
  const calls = [];
  const { provider, posted } = boot({ setOrder: (ids) => { calls.push(ids); throw new Error('EACCES: permission denied'); }, setSortMode: () => { throw new Error('unknown sort mode: x'); } });
  provider.schedule = () => {};
  await provider.onMessage({ type: 'order', ids: 'nope' });
  await provider.onMessage({ type: 'order' });
  assert.deepEqual(calls, [], 'a non-list never reaches core');
  assert.deepEqual(lastMsg(posted, 'orderResult'), { type: 'orderResult', ok: false, count: 0, message: 'order must be a list of session ids' });
  await assert.doesNotReject(provider.onMessage({ type: 'order', ids: [A] }));
  assert.deepEqual(lastMsg(posted, 'orderResult'), { type: 'orderResult', ok: false, count: 0, message: 'EACCES: permission denied' });
  await assert.doesNotReject(provider.onMessage({ type: 'sortMode', mode: 'x' }));
  assert.deepEqual(lastMsg(posted, 'sortModeResult'), { type: 'sortModeResult', ok: false, mode: null, message: 'unknown sort mode: x' });
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'error' && /order .*EACCES/.test(m)));
});

test('the posted snapshot carries order.mode and rank as core gives them', async () => {
  const { provider, posted } = boot({
    snapshot: async () => ({ sessions: [{ sessionId: A, rank: 2 }, { sessionId: B, rank: null }], order: { mode: 'manual' }, limits: {}, usage: null }),
    windowIdForExthost: () => 1,
    refreshUsageIfStale: () => null,
  });
  provider.schedule = () => {};
  await provider.refresh();
  const snap = lastMsg(posted, 'snapshot').data;
  assert.equal(snap.order.mode, 'manual');
  assert.deepEqual(snap.sessions.map((s) => s.rank), [2, null]);
});

test('showMode and archivePast messages call core and post their results; a moved-nowhere archive warns', async () => {
  const calls = [];
  const { provider, posted } = boot({
    setShowMode: (show) => { if (show !== 'all' && show !== 'running') throw new Error('unknown show mode: ' + show); calls.push(['show', show]); return show; },
    archivePast: async (sid) => { calls.push(['archive', sid]); return sid === A ? { ok: true, moved: false, moveError: 'the archive folder is on another volume' } : { ok: false, code: 'running', message: 'the session is running; end it first' }; },
  });
  let scheduled = 0;
  provider.schedule = () => { scheduled++; };
  await provider.onMessage({ type: 'showMode', show: 'running' });
  await provider.onMessage({ type: 'showMode', show: 'x' });
  await provider.onMessage({ type: 'archivePast', sessionId: A });
  await provider.onMessage({ type: 'archivePast', sessionId: B });
  await provider.onMessage({ type: 'archivePast', sessionId: 'nope' });
  assert.deepEqual(calls, [['show', 'running'], ['archive', A], ['archive', B]]);
  assert.deepEqual(posted.filter((m) => m.type === 'showModeResult').map((m) => [m.ok, m.show]), [[true, 'running'], [false, null]]);
  assert.deepEqual(posted.filter((m) => m.type === 'archivePastResult').map((m) => [m.sessionId, m.ok, m.message]), [[A, true, ''], [B, false, 'the session is running; end it first']]);
  assert.ok(vscode.__warnings.some((w) => /transcript not moved: the archive folder is on another volume/.test(w)));
  assert.equal(scheduled, 4);
});

test.after(() => cleanup());
