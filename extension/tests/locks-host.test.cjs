'use strict';
/*
 * Host side of the locks: the locks message hands set, move and clear to core and answers
 * locksResult with the page's seq (a throwing store answers ok: false), then refreshes the
 * board; the retired order and sortMode messages are unknown types and get no reply; the posted
 * snapshot carries lockSlot, activityAt and workingSince as core gives them. The host is booted
 * by tests/shim/host.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, cleanup, vscode } = require('./shim/host.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const lastMsg = (posted, type) => posted.filter((m) => m.type === type).pop();

test('a locks message calls core with set, move and clear, answers with its seq and refreshes the board', async () => {
  const calls = [];
  const { provider, posted } = boot({ setLocks: (req) => { calls.push(req); return { set: 1, moved: 1, cleared: 0 }; } });
  let scheduled = 0;
  provider.schedule = () => { scheduled++; };
  await provider.onMessage({ type: 'locks', set: { [A]: 2 }, move: { [B]: 3 }, clear: [], seq: 7 });
  assert.deepEqual(calls, [{ set: { [A]: 2 }, move: { [B]: 3 }, clear: [] }]);
  assert.deepEqual(lastMsg(posted, 'locksResult'), { type: 'locksResult', ok: true, seq: 7, message: '' });
  assert.equal(scheduled, 1);
  await provider.onMessage({ type: 'locks', clear: [A] });
  assert.deepEqual(calls[1], { set: undefined, move: undefined, clear: [A] });
  assert.deepEqual(lastMsg(posted, 'locksResult'), { type: 'locksResult', ok: true, seq: null, message: '' }, 'a message without a seq is answered with null');
});

test('a throwing store answers ok: false with the message and its seq, and logs it', async () => {
  const { provider, posted } = boot({ setLocks: () => { throw new Error('EACCES: permission denied'); } });
  provider.schedule = () => {};
  await assert.doesNotReject(provider.onMessage({ type: 'locks', set: { [A]: 0 }, seq: 3 }));
  assert.deepEqual(lastMsg(posted, 'locksResult'), { type: 'locksResult', ok: false, seq: 3, message: 'EACCES: permission denied' });
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'error' && /locks .*EACCES/.test(m)));
});

test('the retired order and sortMode messages are unknown types: no call, no reply', async () => {
  const calls = [];
  const { provider, posted } = boot({ setLocks: (req) => { calls.push(req); return { set: 0, moved: 0, cleared: 0 }; } });
  provider.schedule = () => {};
  await provider.onMessage({ type: 'order', ids: [B, A] });
  await provider.onMessage({ type: 'sortMode', mode: 'manual' });
  assert.deepEqual(calls, []);
  assert.deepEqual(posted.filter((m) => /Result$/.test(m.type)), []);
});

test('the posted snapshot carries lockSlot, activityAt and workingSince as core gives them', async () => {
  const { provider, posted } = boot({
    snapshot: async () => ({ sessions: [{ sessionId: A, lockSlot: 2, activityAt: 1000, workingSince: 900 }, { sessionId: B, lockSlot: null, activityAt: 500, workingSince: null }], order: { show: 'auto' }, limits: {}, usage: null }),
    windowIdForExthost: () => 1,
    refreshUsageIfStale: () => null,
  });
  provider.schedule = () => {};
  await provider.refresh();
  const snap = lastMsg(posted, 'snapshot').data;
  assert.equal(snap.order.show, 'auto');
  assert.deepEqual(snap.sessions.map((s) => [s.lockSlot, s.activityAt, s.workingSince]), [[2, 1000, 900], [null, 500, null]]);
});

test('showMode and archivePast messages call core and post their results; a moved-nowhere archive warns', async () => {
  const calls = [];
  const { provider, posted } = boot({
    setShowMode: (show) => { if (!['auto', 'running', 'all'].includes(show)) throw new Error('unknown show mode: ' + show); calls.push(['show', show]); return show; },
    archivePast: async (sid) => { calls.push(['archive', sid]); return sid === A ? { ok: true, moved: false, moveError: 'the archive folder is on another volume' } : { ok: false, code: 'running', message: 'the session is running; end it first' }; },
  });
  let scheduled = 0;
  provider.schedule = () => { scheduled++; };
  await provider.onMessage({ type: 'showMode', show: 'running' });
  await provider.onMessage({ type: 'showMode', show: 'auto' });
  await provider.onMessage({ type: 'showMode', show: 'open' });
  await provider.onMessage({ type: 'archivePast', sessionId: A });
  await provider.onMessage({ type: 'archivePast', sessionId: B });
  await provider.onMessage({ type: 'archivePast', sessionId: 'nope' });
  assert.deepEqual(calls, [['show', 'running'], ['show', 'auto'], ['archive', A], ['archive', B]]);
  assert.deepEqual(posted.filter((m) => m.type === 'showModeResult').map((m) => [m.ok, m.show]), [[true, 'running'], [true, 'auto'], [false, null]], 'the old name "open" is no mode any more');
  assert.deepEqual(posted.filter((m) => m.type === 'archivePastResult').map((m) => [m.sessionId, m.ok, m.message]), [[A, true, ''], [B, false, 'the session is running; end it first']]);
  assert.ok(vscode.__warnings.some((w) => /transcript not moved: the archive folder is on another volume/.test(w)));
  assert.equal(scheduled, 5);
});

test('the host asks core for programmatic sessions only when Claude Code shows them (claudeCode.claudeProcessWrapper set)', async () => {
  const asked = [];
  const { provider } = boot({
    snapshot: async (opts) => { asked.push(Boolean(opts && opts.includeProgrammatic)); return { sessions: [], ended: [], order: { show: 'auto' }, limits: {}, usage: null }; },
    windowIdForExthost: () => 1,
    refreshUsageIfStale: () => null,
  });
  provider.schedule = () => {};
  await provider.refresh();
  vscode.__config['claudeCode.claudeProcessWrapper'] = 'C:/tools/wrap.cmd';
  try { await provider.refresh(); } finally { delete vscode.__config['claudeCode.claudeProcessWrapper']; }
  assert.deepEqual(asked, [false, true]);
});

test.after(() => cleanup());
