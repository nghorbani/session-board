'use strict';
/*
 * Host side of Unseen and ✎: opening a session from the board marks it seen before the jump
 * (or the copy, when no window owns it), the `seen` message does the same, and the `retitle`
 * message answers with a retitleResult on every outcome and refreshes after a success. The
 * host is booted by tests/shim/host.cjs; the core functions are scripted per case.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, cleanup, vscode } = require('./shim/host.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const LAST = { sessions: [{ sessionId: A, pid: 100, title: 'Spike', name: 'spike', status: 'idle', unseen: true, cwd: 'C:\\x', window: null, archived: false }], limits: {}, usage: null };
const last = () => JSON.parse(JSON.stringify(LAST));
const lastMsg = (posted, type) => posted.filter((m) => m.type === type).pop();

test('openSession marks the session seen, also when no window owns it and the command is copied', async () => {
  const seen = [];
  const { provider } = boot({ markSeen: (id) => { seen.push(id); }, pidAlive: () => true, exthostForPid: async () => null, windowForPid: async () => null }, { last: last() });
  await provider.openSession(A);
  assert.deepEqual(seen, [A]);
});

test('openSession of a session that has ended does not mark it seen', async () => {
  const seen = [];
  const { provider } = boot({ markSeen: (id) => { seen.push(id); }, pidAlive: () => false }, { last: last() });
  await provider.openSession(A);
  assert.deepEqual(seen, []);
});

test('a failing seen marker is logged, never thrown', async () => {
  const { provider } = boot({ markSeen: () => { throw new Error('EACCES'); }, pidAlive: () => true, exthostForPid: async () => null, windowForPid: async () => null }, { last: last() });
  await assert.doesNotReject(provider.openSession(A));
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'warn' && /seen marker.*EACCES/.test(m)));
});

test('seen message: core is called for a valid id only', async () => {
  const seen = [];
  const { provider } = boot({ markSeen: (id) => { seen.push(id); } }, { last: last() });
  await provider.onMessage({ type: 'seen', sessionId: A });
  await provider.onMessage({ type: 'seen', sessionId: 'nope' });
  assert.deepEqual(seen, [A]);
});

test('retitle message: the result is posted and a success refreshes the board', async () => {
  const asked = [];
  const { provider, posted } = boot({ retitleSession: async (id) => { asked.push(id); return { ok: true, title: 'New title' }; } }, { last: last() });
  let scheduled = 0;
  provider.schedule = () => { scheduled++; };
  await provider.onMessage({ type: 'retitle', sessionId: A });
  assert.deepEqual(asked, [A]);
  assert.deepEqual(lastMsg(posted, 'retitleResult'), { type: 'retitleResult', sessionId: A, ok: true, title: 'New title', message: '' });
  assert.equal(scheduled, 1);
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'info' && /retitle .*New title/.test(m)));
});

test('retitle message: a failure carries its message and refreshes nothing', async () => {
  const { provider, posted } = boot({ retitleSession: async () => ({ ok: false, code: 'no-transcript', message: 'no prompts in the transcript yet' }) }, { last: last() });
  let scheduled = 0;
  provider.schedule = () => { scheduled++; };
  await provider.onMessage({ type: 'retitle', sessionId: A });
  assert.deepEqual(lastMsg(posted, 'retitleResult'), { type: 'retitleResult', sessionId: A, ok: false, title: null, message: 'no prompts in the transcript yet' });
  assert.equal(scheduled, 0);
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'warn' && /retitle .*no prompts/.test(m)));
});

test('retitle message: a throwing core call is logged, not thrown', async () => {
  const { provider } = boot({ retitleSession: async () => { throw new Error('kaboom'); } }, { last: last() });
  await assert.doesNotReject(provider.onMessage({ type: 'retitle', sessionId: A }));
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'error' && /message retitle failed: kaboom/.test(m)));
});

test.after(cleanup);
