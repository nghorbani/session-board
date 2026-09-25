'use strict';
/*
 * Host side of the ↻ busy state. The page keeps its button spinning until the extension
 * answers its `refreshUsage` request with a `usageResult` carrying the same request id, so
 * refreshUsage() must post that reply on every outcome: after the merged snapshot when one
 * exists, on a throttled probe, on a failed probe, when the probe throws, and before the
 * first snapshot ever arrived. `vscode` is the stub in tests/shim/vscode.js; the core
 * functions are patched on the module object, which is how extension.js calls them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Same isolation as the other suites: core.cjs derives its data dir from these at load time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-refresh-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;

// `require('vscode')` only resolves inside an extension host; point it at the stub first.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return path.join(__dirname, 'shim', 'vscode.js');
  return resolveFilename.call(this, request, ...rest);
};
const vscode = require('vscode');
const core = require('../core.cjs');
const ext = require('../extension.js');

const FRESH = { state: 'ok', at: 2, ageSeconds: 0, subscriptionType: 'team', windows: { five_hour: { label: '5h', usedPct: 10, resetsAt: null, expired: false } }, extraUsage: null, error: null, throttled: false };

/** Activate against the stub, stop the poll, patch core, attach a recording view. */
function boot(fetchImpl, opts) {
  vscode.__reset();
  const context = {
    subscriptions: [],
    extensionPath: path.join(__dirname, '..'),
    extension: { id: 'nima-ghorbani.session-board-vscode' },
    globalState: { get: () => true, update: async () => {} },
  };
  ext.activate(context);
  const provider = vscode.__providers[0];
  provider.stop();                                     // the test drives refreshUsage() alone; no poll
  core.writeHeartbeat = () => {};
  core.snapshot = async () => ({ sessions: [], limits: {}, usage: FRESH });
  core.fetchUsage = fetchImpl;
  core.usageState = () => FRESH;
  if (!(opts && opts.noSnapshot)) provider.last = { sessions: [], limits: {}, usage: { state: 'ok', at: 1, windows: {} } };
  const posted = [];
  provider.view = { visible: true, webview: { postMessage: (m) => posted.push(m) } };
  return { provider, posted };
}

test('refreshUsage: a good probe posts the merged snapshot, then usageResult with the request id', async () => {
  const { provider, posted } = boot(async () => FRESH);
  await provider.refreshUsage('req-1');
  assert.deepEqual(posted.map((m) => m.type), ['snapshot', 'usageResult']);
  assert.equal(posted[0].data.usage, FRESH, 'the snapshot carries the fresh usage, not the captured one');
  assert.deepEqual(posted[1], { type: 'usageResult', requestId: 'req-1', throttled: false, error: null });
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'info' && /usage probe ok/.test(m)));
});

test('refreshUsage: a throttled probe says so in the reply and in the status bar', async () => {
  const { provider, posted } = boot(async () => Object.assign({}, FRESH, { throttled: true }));
  await provider.refreshUsage('req-2');
  assert.deepEqual(posted[posted.length - 1], { type: 'usageResult', requestId: 'req-2', throttled: true, error: null });
  assert.ok(vscode.__status.some((t) => /refreshed a moment ago/.test(t)));
});

test('refreshUsage: a failed probe carries its error in the reply', async () => {
  const { provider, posted } = boot(async () => Object.assign({}, FRESH, { error: 'claude exited with 2' }));
  await provider.refreshUsage('req-3');
  assert.deepEqual(posted.map((m) => m.type), ['snapshot', 'usageResult']);
  assert.deepEqual(posted[1], { type: 'usageResult', requestId: 'req-3', throttled: false, error: 'claude exited with 2' });
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'warn' && /claude exited with 2/.test(m)));
});

test('refreshUsage: a throwing probe still answers, with the message as the error', async () => {
  const { provider, posted } = boot(async () => { throw new Error('boom'); });
  await provider.refreshUsage('req-4');
  assert.deepEqual(posted, [{ type: 'usageResult', requestId: 'req-4', throttled: false, error: 'boom' }]);
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'error' && /boom/.test(m)));
});

test('refreshUsage: before the first snapshot the reply is posted alone', async () => {
  const { provider, posted } = boot(async () => FRESH, { noSnapshot: true });
  await provider.refreshUsage('req-5');
  assert.deepEqual(posted, [{ type: 'usageResult', requestId: 'req-5', throttled: false, error: null }]);
});

test('refreshUsage: the command palette route replies with an empty id, which no busy state matches', async () => {
  const { posted } = boot(async () => FRESH);
  await vscode.__commands['sessionBoard.refreshUsage']();
  assert.deepEqual(posted[posted.length - 1], { type: 'usageResult', requestId: '', throttled: false, error: null });
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
