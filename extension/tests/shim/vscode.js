'use strict';
/*
 * Stand-in for the `vscode` module in the host tests: the API surface extension.js touches
 * at activation and in refreshUsage(). It records what the extension registers and says
 * (providers, commands, status bar messages, log lines) so a test can assert on them.
 * Loaded through a Module._resolveFilename hook in the test file; never packaged.
 */
const disposable = () => ({ dispose() {} });

const api = {
  __providers: [],     // webview view providers, in registration order
  __commands: Object.create(null),
  __status: [],        // setStatusBarMessage texts
  __log: [],           // [level, message] from the output channel
  __warnings: [],      // showWarningMessage texts
  __answer: undefined, // what showWarningMessage / showInformationMessage resolve to
  __pick: undefined,   // what showQuickPick resolves to (an index into the items, or undefined)
  __reset() {
    api.__providers.length = 0;
    api.__status.length = 0;
    api.__log.length = 0;
    api.__warnings.length = 0;
    api.__answer = undefined;
    api.__pick = undefined;
    for (const k of Object.keys(api.__commands)) delete api.__commands[k];
  },
  window: {
    state: { focused: true },
    createOutputChannel: () => ({
      info: (m) => api.__log.push(['info', m]),
      warn: (m) => api.__log.push(['warn', m]),
      error: (m) => api.__log.push(['error', m]),
      dispose() {},
    }),
    registerWebviewViewProvider: (id, provider) => { api.__providers.push(provider); return disposable(); },
    registerUriHandler: () => disposable(),
    setStatusBarMessage: (text) => { api.__status.push(text); return disposable(); },
    showInformationMessage: async () => api.__answer,
    showWarningMessage: async (text) => { api.__warnings.push(text); return api.__answer; },
    showErrorMessage: async () => undefined,
    showQuickPick: async (items) => (api.__pick === undefined ? undefined : items[api.__pick]),
    withProgress: (opts, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable() }),
  },
  commands: {
    registerCommand: (id, fn) => { api.__commands[id] = fn; return disposable(); },
    executeCommand: async () => undefined,
  },
  env: { appRoot: '', clipboard: { writeText: async () => {} } },
  workspace: { workspaceFolders: [] },
  ProgressLocation: { Notification: 15 },
  Uri: {
    file: (p) => ({ fsPath: p, toString: () => p }),
    parse: (s) => ({ toString: () => s }),
  },
};

module.exports = api;
