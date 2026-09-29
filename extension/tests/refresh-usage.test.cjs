'use strict';
/*
 * Host side of the ↻ busy state. The page keeps its button spinning until the extension
 * answers its `refreshUsage` request with a `usageResult` carrying the same request id, so
 * refreshUsage() must post that reply on every outcome: after the merged snapshot when one
 * exists, on a throttled probe, on a failed probe, when the probe throws, and before the
 * first snapshot ever arrived. The host is booted by tests/shim/host.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, cleanup, vscode } = require('./shim/host.cjs');

const FRESH = { state: 'ok', at: 2, ageSeconds: 0, subscriptionType: 'team', windows: { five_hour: { label: '5h', usedPct: 10, resetsAt: null, expired: false } }, extraUsage: null, error: null, throttled: false };

function bootUsage(fetchImpl, opts) {
  return boot({ fetchUsage: fetchImpl, usageState: () => FRESH }, opts);
}

test('refreshUsage: a good probe posts the merged snapshot, then usageResult with the request id', async () => {
  const { provider, posted } = bootUsage(async () => FRESH);
  await provider.refreshUsage('req-1');
  assert.deepEqual(posted.map((m) => m.type), ['snapshot', 'usageResult']);
  assert.equal(posted[0].data.usage, FRESH, 'the snapshot carries the fresh usage, not the captured one');
  assert.deepEqual(posted[1], { type: 'usageResult', requestId: 'req-1', throttled: false, error: null });
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'info' && /usage probe ok/.test(m)));
});

test('refreshUsage: a throttled probe says so in the reply and in the status bar', async () => {
  const { provider, posted } = bootUsage(async () => Object.assign({}, FRESH, { throttled: true }));
  await provider.refreshUsage('req-2');
  assert.deepEqual(posted[posted.length - 1], { type: 'usageResult', requestId: 'req-2', throttled: true, error: null });
  assert.ok(vscode.__status.some((t) => /refreshed a moment ago/.test(t)));
});

test('refreshUsage: a failed probe carries its error in the reply', async () => {
  const { provider, posted } = bootUsage(async () => Object.assign({}, FRESH, { error: 'claude exited with 2' }));
  await provider.refreshUsage('req-3');
  assert.deepEqual(posted.map((m) => m.type), ['snapshot', 'usageResult']);
  assert.deepEqual(posted[1], { type: 'usageResult', requestId: 'req-3', throttled: false, error: 'claude exited with 2' });
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'warn' && /claude exited with 2/.test(m)));
});

test('refreshUsage: a throwing probe still answers, with the message as the error', async () => {
  const { provider, posted } = bootUsage(async () => { throw new Error('boom'); });
  await provider.refreshUsage('req-4');
  assert.deepEqual(posted, [{ type: 'usageResult', requestId: 'req-4', throttled: false, error: 'boom' }]);
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'error' && /boom/.test(m)));
});

test('refreshUsage: before the first snapshot the reply is posted alone', async () => {
  const { provider, posted } = bootUsage(async () => FRESH, { noSnapshot: true });
  await provider.refreshUsage('req-5');
  assert.deepEqual(posted, [{ type: 'usageResult', requestId: 'req-5', throttled: false, error: null }]);
});

test('refreshUsage: the command palette route replies with an empty id, which no busy state matches', async () => {
  const { posted } = bootUsage(async () => FRESH);
  await vscode.__commands['sessionBoard.refreshUsage']();
  assert.deepEqual(posted[posted.length - 1], { type: 'usageResult', requestId: '', throttled: false, error: null });
});

test.after(cleanup);
