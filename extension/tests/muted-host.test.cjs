'use strict';
/*
 * Host side of Mute and the notifications: the mute and unmute messages call core and answer
 * muteResult (a throwing store answers ok: false), the activity-bar badge leaves muted sessions
 * out, the notifier built by the host speaks through VS Code toasts in a focused window and
 * through core's Windows toast otherwise, a click on that toast (the /open URI) marks the
 * session seen, a focus change writes a heartbeat, and the posted snapshot carries this window's
 * id. The host is booted by tests/shim/host.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, cleanup, vscode } = require('./shim/host.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const row = (id, extra) => Object.assign({ sessionId: id, pid: 100, title: 'Spike ' + id.slice(0, 2), name: 'spike', status: 'idle', cwd: 'C:\\x', window: null, archived: false, muted: false }, extra);
const last = (rows) => ({ sessions: rows, limits: {}, usage: null });
const lastMsg = (posted, type) => posted.filter((m) => m.type === type).pop();

test('mute and unmute messages: core is called for a valid id only, the result is posted and the board refreshes', async () => {
  const calls = [];
  const { provider, posted } = boot({ muteSession: (id) => { calls.push(['mute', id]); }, unmuteSession: (id) => { calls.push(['unmute', id]); } }, { last: last([row(A)]) });
  let scheduled = 0;
  provider.schedule = () => { scheduled++; };
  await provider.onMessage({ type: 'mute', sessionId: A });
  await provider.onMessage({ type: 'unmute', sessionId: A });
  await provider.onMessage({ type: 'mute', sessionId: 'nope' });
  await provider.onMessage({ type: 'blind', sessionId: A });           // the 0.10.0 message is gone
  assert.deepEqual(calls, [['mute', A], ['unmute', A]]);
  assert.deepEqual(posted.filter((m) => m.type === 'muteResult'), [
    { type: 'muteResult', sessionId: A, ok: true, muted: true, message: '' },
    { type: 'muteResult', sessionId: A, ok: true, muted: false, message: '' },
  ]);
  assert.equal(scheduled, 2);
});

test('a store that throws answers ok: false with the message and logs it', async () => {
  const { provider, posted } = boot({ muteSession: () => { throw new Error('EACCES: permission denied'); } }, { last: last([row(A)]) });
  provider.schedule = () => {};
  await assert.doesNotReject(provider.onMessage({ type: 'mute', sessionId: A }));
  assert.deepEqual(lastMsg(posted, 'muteResult'), { type: 'muteResult', sessionId: A, ok: false, muted: false, message: 'EACCES: permission denied' });
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'error' && /mute .*EACCES/.test(m)));
});

test('the activity-bar badge counts waiting sessions that are not muted', () => {
  const { provider } = boot({}, { last: last([row(A, { status: 'waiting' }), row(B, { status: 'waiting', muted: true })]) });
  provider.updateBadge();
  assert.equal(provider.view.badge.value, 1);
  provider.last = last([row(B, { status: 'waiting', muted: true })]);
  provider.updateBadge();
  assert.equal(provider.view.badge, undefined, 'only a muted session waits: no badge');
});

test('focused window: a new waiting row is a warning toast, a finished answer an information toast; muted rows and the done setting stay silent', async () => {
  const { provider } = boot({}, {});
  const n = provider.notifier;
  await n.observe([row(A, { status: 'busy' }), row(B, { status: 'busy' })]);                       // primes
  await n.observe([row(A, { status: 'waiting', waitingFor: 'input needed' }), row(B, { status: 'idle', unseen: true, unseenAt: 1000 })]);
  assert.deepEqual([vscode.__warnings, vscode.__infos], [['Spike 11: input needed'], ['Spike 66: done']]);
  vscode.__warnings.length = 0; vscode.__infos.length = 0;
  await n.observe([row(A, { status: 'busy', muted: true }), row(B, { status: 'busy', muted: true })]);
  await n.observe([row(A, { status: 'waiting', muted: true }), row(B, { status: 'idle', unseen: true, unseenAt: 2000, muted: true })]);
  assert.deepEqual([vscode.__warnings, vscode.__infos], [[], []], 'muted: silent');
  vscode.__config['sessionBoard.notifyOnDone'] = false;
  await n.observe([row(A, { status: 'busy' }), row(B, { status: 'busy' })]);
  await n.observe([row(A, { status: 'busy' }), row(B, { status: 'idle', unseen: true, unseenAt: 3000 })]);
  assert.deepEqual(vscode.__infos, [], 'notifyOnDone off: no done toast');
});

test('no window focused: one Windows notification through core, with the open URI of the session', async () => {
  const shown = [];
  const claims = [];
  const { provider } = boot({
    focusedPeerAt: () => 0,
    claimNotice: (id, kind, at) => { claims.push([id, kind, at]); return true; },
    releaseNotice: () => {},
    openUriForPid: async (id, pid) => 'vscode://board/open?session=' + id + '&pid=' + pid,
    showSystemToast: async (items) => { shown.push(items); },
  }, {});
  vscode.window.state.focused = false;
  const n = provider.notifier;
  await n.observe([row(A, { status: 'busy' })]);
  await n.observe([row(A, { status: 'idle', unseen: true, unseenAt: 5000 })]);
  if (!require('../core.cjs').IS_WINDOWS) { assert.deepEqual(shown, []); return; }     // the Windows path needs Windows
  assert.deepEqual(claims, [[A, 'done', 5000]]);
  assert.deepEqual(shown, [[{ title: 'Spike 11', body: 'done', launch: 'vscode://board/open?session=' + A + '&pid=100' }]]);
  assert.deepEqual([vscode.__warnings, vscode.__infos], [[], []], 'no VS Code toast in an unfocused window');
});

test('a click on the Windows notification (the /open URI) marks the session seen before revealing it', async () => {
  const seen = [];
  const { provider } = boot({ markSeen: (id) => { seen.push(id); } }, { last: last([row(A)]) });
  provider.revealHere = async () => true;
  await provider.handleUri({ path: '/open', query: 'session=' + A + '&windowId=1', toString: () => 'vscode://x/open' });
  await provider.handleUri({ path: '/open', query: 'session=nope', toString: () => 'vscode://x/open' });
  assert.deepEqual(seen, [A]);
});

test('a focus change writes a heartbeat that carries the focus; the poll heartbeat carries it too', async () => {
  const beats = [];
  const { provider } = boot({ writeHeartbeat: (...args) => { beats.push(args); }, snapshot: async () => ({ sessions: [], limits: {}, usage: null }), refreshUsageIfStale: () => null }, { noSnapshot: true });
  provider.schedule = () => {};
  vscode.window.state.focused = false;
  vscode.__windowState.forEach((fn) => fn({ focused: false }));
  assert.deepEqual(beats.map((b) => b[3]), [false]);
  vscode.window.state.focused = true;
  await provider.refresh();
  assert.deepEqual(beats.map((b) => b[3]), [false, true]);
  assert.equal(beats[1][0], process.pid);
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
