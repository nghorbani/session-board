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
  __commandErrors: Object.create(null),   // command id -> message, for a command a test makes fail
  __clipboard: [],     // clipboard writes
  __config: Object.create(null),   // sessionBoard.* settings a test sets; absent keys take the code's default
  __windowState: [],   // onDidChangeWindowState listeners
  __answer: undefined, // what showWarningMessage / showInformationMessage resolve to
  __pick: undefined,   // what showQuickPick resolves to (an index into the items, or undefined)
  __panels: [],        // every webview panel created, in creation order
  __openedExternal: [], // every vscode.env.openExternal(uri) call
  __openedDocs: [],     // every vscode.workspace.openTextDocument(...) call
  __shownDocs: [],      // every vscode.window.showTextDocument(doc) call
  __statRejects: Object.create(null),   // fsPath -> error, so a test can make workspace.fs.stat fail for a path
  __statTypes: Object.create(null),     // fsPath -> FileType (default: File) for a path that should stat ok
  __statCalls: [],                      // every fsPath workspace.fs.stat was asked about, in order
  __extensions: Object.create(null),    // extensionId -> { packageJSON: { version } }, what extensions.getExtension(id) returns
  __reset() {
    api.__providers.length = 0;
    api.__status.length = 0;
    api.__log.length = 0;
    api.__warnings.length = 0;
    api.__infos.length = 0;
    api.__inputs.length = 0;
    api.__inputAnswer = undefined;
    api.__executed.length = 0;
    for (const k of Object.keys(api.__commandErrors)) delete api.__commandErrors[k];
    api.__clipboard.length = 0;
    api.__windowState.length = 0;
    api.__panels.length = 0;
    api.__openedExternal.length = 0;
    api.__openedDocs.length = 0;
    api.__shownDocs.length = 0;
    for (const k of Object.keys(api.__statRejects)) delete api.__statRejects[k];
    for (const k of Object.keys(api.__statTypes)) delete api.__statTypes[k];
    api.__statCalls.length = 0;
    for (const k of Object.keys(api.__config)) delete api.__config[k];
    api.window.state.focused = true;
    api.__answer = undefined;
    api.__pick = undefined;
    for (const k of Object.keys(api.__commands)) delete api.__commands[k];
    for (const k of Object.keys(api.__extensions)) delete api.__extensions[k];
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
      panel.__showOptions = showOptions;   // the editor column the panel was asked to open in
      api.__panels.push(panel);
      return panel;
    },
    showTextDocument: async (doc) => { api.__shownDocs.push(doc); return {}; },
  },
  commands: {
    registerCommand: (id, fn) => { api.__commands[id] = fn; return disposable(); },
    executeCommand: async (id, ...args) => {
      api.__executed.push([id, ...args]);
      if (api.__commandErrors[id]) throw new Error(api.__commandErrors[id]);
      return undefined;
    },
  },
  extensions: {
    getExtension: (id) => api.__extensions[id] || undefined,
  },
  env: {
    appRoot: '',
    clipboard: { writeText: async (t) => { api.__clipboard.push(t); } },
    openExternal: async (uri) => { api.__openedExternal.push(uri); return true; },
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: (section) => ({ get: (key, dflt) => { const k = section + '.' + key; return k in api.__config ? api.__config[k] : dflt; } }),
    openTextDocument: async (opts) => { api.__openedDocs.push(opts); return { uri: opts && opts.content !== undefined ? { scheme: 'untitled' } : (opts && opts.fsPath ? opts : { fsPath: String(opts) }) }; },
    fs: {
      stat: async (uri) => {
        const fsPath = uri && uri.fsPath;
        api.__statCalls.push(fsPath);
        if (fsPath in api.__statRejects) throw api.__statRejects[fsPath];
        const type = fsPath in api.__statTypes ? api.__statTypes[fsPath] : 1; // FileType.File
        return { type };
      },
    },
  },
  FileType: { File: 1, Directory: 2 },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  Uri: {
    file: (p) => ({ fsPath: p, toString: () => p }),
    parse: (s) => ({ toString: () => s }),
  },
  Position: function (line, character) { this.line = line; this.character = character; },
  Range: function (start, end) { this.start = start; this.end = end; },
  Selection: function (anchor, active) { this.anchor = anchor; this.active = active; },
};

module.exports = api;
