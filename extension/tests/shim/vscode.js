'use strict';
/*
 * Stand-in for the `vscode` module in the host tests: the API surface extension.js touches
 * at activation and in refreshUsage(). It records what the extension registers and says
 * (providers, commands, status bar messages, log lines) so a test can assert on them.
 * Loaded through a Module._resolveFilename hook in the test file; never packaged.
 */
const disposable = () => ({ dispose() {} });

/* A fake webview panel: records postMessage calls, lets a test fire onDidReceiveMessage,
   reveal()/dispose() update __revealed/__disposed so a test can assert panel life cycle. */
function makePanel(viewType, title, opts) {
  const messageHandlers = [];
  const disposeHandlers = [];
  const panel = {
    viewType,
    title,
    options: opts,
    webview: {
      html: '',
      cspSource: 'vscode-webview:',
      options: {},
      postMessage: (m) => { panel.__posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (fn) => { messageHandlers.push(fn); return disposable(); },
      asWebviewUri: (u) => u,
    },
    __posted: [],
    __revealed: 0,
    __disposed: false,
    reveal: () => { panel.__revealed += 1; },
    onDidDispose: (fn) => { disposeHandlers.push(fn); return disposable(); },
    dispose: () => { panel.__disposed = true; for (const fn of disposeHandlers) fn(); },
    __fireMessage: (m) => { for (const fn of messageHandlers) fn(m); },
  };
  return panel;
}

const api = {
  __providers: [],     // webview view providers, in registration order
  __commands: Object.create(null),
  __status: [],        // setStatusBarMessage texts
  __log: [],           // [level, message] from the output channel
  __warnings: [],      // showWarningMessage texts
  __infos: [],         // showInformationMessage texts
  __inputs: [],        // showInputBox options
  __inputAnswer: undefined,   // what showInputBox resolves to (undefined = Escape)
  __executed: [],      // executeCommand calls: [id, ...args]
  __clipboard: [],     // clipboard writes
  __config: Object.create(null),   // sessionBoard.* settings a test sets; absent keys take the code's default
  __windowState: [],   // onDidChangeWindowState listeners
  __answer: undefined, // what showWarningMessage / showInformationMessage resolve to
  __pick: undefined,   // what showQuickPick resolves to (an index into the items, or undefined)
  __panels: [],        // every webview panel created, in creation order
  __reset() {
    api.__providers.length = 0;
    api.__status.length = 0;
    api.__log.length = 0;
    api.__warnings.length = 0;
    api.__infos.length = 0;
    api.__inputs.length = 0;
    api.__inputAnswer = undefined;
    api.__executed.length = 0;
    api.__clipboard.length = 0;
    api.__windowState.length = 0;
    api.__panels.length = 0;
    for (const k of Object.keys(api.__config)) delete api.__config[k];
    api.window.state.focused = true;
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
    onDidChangeWindowState: (fn) => { api.__windowState.push(fn); return disposable(); },
    setStatusBarMessage: (text) => { api.__status.push(text); return disposable(); },
    showInformationMessage: async (text) => { api.__infos.push(text); return api.__answer; },
    showWarningMessage: async (text) => { api.__warnings.push(text); return api.__answer; },
    showErrorMessage: async () => undefined,
    showQuickPick: async (items) => (api.__pick === undefined ? undefined : items[api.__pick]),
    showInputBox: async (opts) => { api.__inputs.push(opts); return api.__inputAnswer; },
    withProgress: (opts, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable() }),
    createWebviewPanel: (viewType, title, showOptions, opts) => {
      const panel = makePanel(viewType, title, opts);
      api.__panels.push(panel);
      return panel;
    },
  },
  commands: {
    registerCommand: (id, fn) => { api.__commands[id] = fn; return disposable(); },
    executeCommand: async (id, ...args) => { api.__executed.push([id, ...args]); return undefined; },
  },
  env: { appRoot: '', clipboard: { writeText: async (t) => { api.__clipboard.push(t); } } },
  workspace: {
    workspaceFolders: [],
    getConfiguration: (section) => ({ get: (key, dflt) => { const k = section + '.' + key; return k in api.__config ? api.__config[k] : dflt; } }),
  },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  Uri: {
    file: (p) => ({ fsPath: p, toString: () => p }),
    parse: (s) => ({ toString: () => s }),
  },
};

module.exports = api;
