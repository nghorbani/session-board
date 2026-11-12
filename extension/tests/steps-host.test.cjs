'use strict';
/*
 * Host side of the Steps panel: a "steps" message with a session id opens (or reveals) one
 * webview panel per session, titled "Steps: <title>", wired so page messages reach
 * service.handle and service pushes reach the panel; everything is released on dispose. The
 * host is booted by tests/shim/host.cjs; steps-service.cjs is faked per test so this suite
 * never touches a real transcript.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, cleanup, vscode } = require('./shim/host.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const LAST = { sessions: [{ sessionId: A, pid: 100, title: 'My session', name: 'my-session', status: 'idle', unseen: false, cwd: 'C:\\x', window: null, archived: false }], limits: {}, usage: null };
const last = () => JSON.parse(JSON.stringify(LAST));

function fakeService(overrides) {
  const handled = [];
  const subs = new Map();
  return Object.assign({
    handle: async (msg) => { handled.push(msg); return { type: (msg.type || 'unknown') + 'Result', requestId: msg.requestId, ok: true }; },
    subscribe: (sessionId, cb) => { subs.set(sessionId, cb); return () => subs.delete(sessionId); },
    __handled: handled,
    __subs: subs,
  }, overrides || {});
}

test('the steps message opens one panel per session, titled with the session\'s title', async () => {
  const service = fakeService();
  const { provider } = boot({}, { last: last() });
  provider.stepsService = service;
  await provider.onMessage({ type: 'steps', sessionId: A });
  assert.equal(vscode.__panels.length, 1);
  assert.equal(vscode.__panels[0].title, 'Steps: My session');
});

test('asking again for the same session reveals the existing panel instead of creating a new one', async () => {
  const service = fakeService();
  const { provider } = boot({}, { last: last() });
  provider.stepsService = service;
  await provider.onMessage({ type: 'steps', sessionId: A });
  await provider.onMessage({ type: 'steps', sessionId: A });
  assert.equal(vscode.__panels.length, 1);
  assert.equal(vscode.__panels[0].__revealed, 1);
});

test('a different session opens its own panel', async () => {
  const l = last();
  l.sessions.push({ sessionId: B, pid: 101, title: 'Other session', name: 'other', status: 'idle', unseen: false, cwd: 'C:\\y', window: null, archived: false });
  const service = fakeService();
  const { provider } = boot({}, { last: l });
  provider.stepsService = service;
  await provider.onMessage({ type: 'steps', sessionId: A });
  await provider.onMessage({ type: 'steps', sessionId: B });
  assert.equal(vscode.__panels.length, 2);
});

test('messages from the page are routed to service.handle, and pushes reach the panel', async () => {
  const service = fakeService();
  const { provider } = boot({}, { last: last() });
  provider.stepsService = service;
  await provider.onMessage({ type: 'steps', sessionId: A });
  const panel = vscode.__panels[0];
  panel.__fireMessage({ type: 'body', sessionId: A, stepId: 'x:0' });
  await Promise.resolve();
  assert.ok(service.__handled.some((m) => m.type === 'body' && m.stepId === 'x:0'));
  const cb = service.__subs.get(A);
  assert.equal(typeof cb, 'function');
  cb({ type: 'stepsChanged', sessionId: A, appended: [] });
  assert.ok(panel.__posted.some((m) => m.type === 'stepsChanged'));
});

test('dispose unsubscribes from the service and sends close, so a later steps message opens a fresh panel', async () => {
  const service = fakeService();
  const { provider } = boot({}, { last: last() });
  provider.stepsService = service;
  await provider.onMessage({ type: 'steps', sessionId: A });
  const panel = vscode.__panels[0];
  panel.dispose();
  await Promise.resolve();
  assert.equal(service.__subs.has(A), false, 'unsubscribed on dispose');
  assert.ok(service.__handled.some((m) => m.type === 'close' && m.sessionId === A));
  await provider.onMessage({ type: 'steps', sessionId: A });
  assert.equal(vscode.__panels.length, 2, 'a fresh panel is created once the old one is gone');
});

test('the steps message is in onMessage() and ignores a bad session id', async () => {
  const service = fakeService();
  const { provider } = boot({}, { last: last() });
  provider.stepsService = service;
  await provider.onMessage({ type: 'steps', sessionId: 'not-a-uuid' });
  assert.equal(vscode.__panels.length, 0);
});

test('revealHere without a prompt keeps its six positional arguments (regression)', async () => {
  const { provider } = boot({ exthostForPid: async () => process.pid, pidAlive: () => true }, { last: last() });
  await provider.revealHere(A);
  const call = vscode.__executed.find((c) => c[0] === 'claude-vscode.editor.open');
  assert.ok(call);
  assert.equal(call.length, 7);
  assert.equal(call[1], A);
  assert.equal(call[2], undefined);
  assert.deepEqual(call[6], { programmatic: 'honor-preferred-location' });
});

test.after(() => cleanup());
