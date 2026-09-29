'use strict';
/*
 * Boots extension.js against the vscode stub for the host suites: resolves `vscode` to
 * tests/shim/vscode.js, isolates the data dir, activates with a fake context, stops the
 * poll, patches the core functions a test scripts, and attaches a view that records every
 * posted message. Require it before anything else that loads core.cjs or extension.js.
 *
 *   boot({ fetchUsage: async () => … })  ──▶ { provider, posted, context }
 *   provider.<method>(…)                  ──▶ posted[]: the webview messages, in order
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-host-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;

// `require('vscode')` only resolves inside an extension host; point it at the stub.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return path.join(__dirname, 'vscode.js');
  return resolveFilename.call(this, request, ...rest);
};
const vscode = require('vscode');
const core = require('../../core.cjs');
const ext = require('../../extension.js');

/** Activate, stop the poll, patch core with `patches`, seed `provider.last`, attach a recording view. */
function boot(patches, opts) {
  vscode.__reset();
  const context = {
    subscriptions: [],
    extensionPath: path.join(__dirname, '..', '..'),
    extension: { id: 'nima-ghorbani.session-board-vscode' },
    globalState: { get: () => true, update: async () => {} },
  };
  ext.activate(context);
  const provider = vscode.__providers[0];
  provider.stop();                                     // the test drives the provider; no poll
  core.writeHeartbeat = () => {};
  core.snapshot = async () => ({ sessions: [], limits: {}, usage: null });
  Object.assign(core, patches || {});
  if (!(opts && opts.noSnapshot)) provider.last = (opts && opts.last) || { sessions: [], limits: {}, usage: { state: 'ok', at: 1, windows: {} } };
  const posted = [];
  provider.view = { visible: true, webview: { postMessage: (m) => posted.push(m) } };
  return { provider, posted, context };
}

function cleanup() { fs.rmSync(tmp, { recursive: true, force: true }); }

module.exports = { boot, cleanup, vscode, core, ext, tmp };
