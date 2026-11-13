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
const { boot, cleanup, vscode, core } = require('./shim/host.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const LAST = { sessions: [{ sessionId: A, pid: 100, title: 'My session', name: 'my-session', status: 'idle', unseen: false, cwd: 'C:\\x', window: null, archived: false }], limits: {}, usage: null };
const last = () => JSON.parse(JSON.stringify(LAST));
/** A fixture whose session's cwd is `cwd`, so a path under it is a trusted root and opens
    without the confirmation prompt. */
function lastWithCwd(cwd) {
  return { sessions: [{ sessionId: A, pid: 100, title: 'My session', name: 'my-session', status: 'idle', unseen: false, cwd, window: null, archived: false }], limits: {}, usage: null };
}

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

test('an ended session\'s panel and the session title use its row from last.ended, not the id', async () => {
  const service = fakeService();
  const endedLast = { sessions: [], ended: [{ sessionId: A, title: 'Plan the migration', status: 'ended' }], limits: {}, usage: null };
  const { provider } = boot({}, { last: endedLast });
  provider.stepsService = service;
  await provider.onMessage({ type: 'steps', sessionId: A });
  assert.equal(vscode.__panels[0].title, 'Steps: Plan the migration');
});

test('a session the board has not snapshotted at all gets its title read straight from the transcript', async () => {
  const service = fakeService();
  const { provider } = boot({
    transcriptIndex: () => new Map([[A, 'C:\\fake\\' + A + '.jsonl']]),
    transcriptFacts: () => ({ tokens: null, title: 'Generated title', customTitle: 'Renamed by hand', lastPrompt: null }),
  }, { last: { sessions: [], ended: [], limits: {}, usage: null } });
  provider.stepsService = service;
  await provider.onMessage({ type: 'steps', sessionId: A });
  assert.equal(vscode.__panels[0].title, 'Steps: Renamed by hand', 'the custom title wins over the generated one');
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

// -- openLink -------------------------------------------------------------------------------

test('openLink url: http and https open with openExternal', async () => {
  const { provider } = boot({}, { last: last() });
  let r = await provider.openStepsLink(A, 'url', 'http://example.invalid/page');
  assert.equal(r.ok, true);
  r = await provider.openStepsLink(A, 'url', 'https://example.invalid/page');
  assert.equal(r.ok, true);
  assert.equal(vscode.__openedExternal.length, 2);
});

test('openLink url: any other scheme is refused, never handed to openExternal', async () => {
  const { provider } = boot({}, { last: last() });
  for (const target of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://evil/thing', 'ftp://x/y']) {
    const r = await provider.openStepsLink(A, 'url', target);
    assert.equal(r.ok, false);
  }
  assert.equal(vscode.__openedExternal.length, 0, 'nothing but http/https ever reaches openExternal');
});

test('openLink path: a folder under the session\'s working directory is revealed directly, no prompt', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  vscode.__statTypes['C:\\proj\\folder'] = vscode.FileType.Directory;
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\folder');
  assert.equal(r.ok, true);
  assert.equal(vscode.__warnings.length, 0, 'a trusted path never asks first');
  const call = vscode.__executed.find((c) => c[0] === 'revealFileInOS');
  assert.ok(call);
  assert.equal(call[1].fsPath, 'C:\\proj\\folder');
});

test('openLink path: a file under the working directory opens in an editor tab, no prompt', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  vscode.__statTypes['C:\\proj\\foo.py'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\foo.py');
  assert.equal(r.ok, true);
  assert.equal(vscode.__warnings.length, 0);
  assert.equal(vscode.__openedDocs.length, 1);
  assert.equal(vscode.__shownDocs.length, 1);
});

test('openLink path: a .md file opens with the Markdown preview instead of an editor tab', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  vscode.__statTypes['C:\\proj\\readme.md'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\readme.md');
  assert.equal(r.ok, true);
  const call = vscode.__executed.find((c) => c[0] === 'markdown.showPreview');
  assert.ok(call);
  assert.equal(vscode.__openedDocs.length, 0, 'the preview command is used instead of opening it as a plain document');
});

test('openLink path: a file:line suffix moves the cursor to that line', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  vscode.__statTypes['C:\\proj\\foo.py'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\foo.py:42');
  assert.equal(r.ok, true);
  assert.equal(vscode.__openedDocs[0] && vscode.__openedDocs[0].fsPath, 'C:\\proj\\foo.py', 'the :line suffix is stripped before resolving the path');
});

// -- trusted roots and the confirmation gate -----------------------------------------------

test('openLink path: a drive-letter path under the session\'s working directory opens without asking', async () => {
  const { provider } = boot({}, { last: lastWithCwd('Z:\\mapped\\proj') });
  vscode.__statTypes['Z:\\mapped\\proj\\foo.py'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'Z:\\mapped\\proj\\foo.py');
  assert.equal(r.ok, true);
  assert.equal(vscode.__warnings.length, 0, 'a mapped drive letter is local path syntax, not a network path');
});

test('openLink path: a path outside the session\'s working directory, the workspace folders and home asks first, and only opens on yes', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  vscode.__statTypes['D:\\elsewhere\\foo.py'] = vscode.FileType.File;
  vscode.__answer = undefined;   // the user has not answered the prompt yet: Escape/no
  let r = await provider.openStepsLink(A, 'path', 'D:\\elsewhere\\foo.py');
  assert.equal(r.ok, false);
  assert.equal(vscode.__warnings.length, 1, 'one confirmation prompt');
  assert.ok(/Open D:\\elsewhere\\foo\.py\?/.test(vscode.__warnings[0]));
  assert.equal(vscode.__openedDocs.length, 0, 'nothing opens without a yes');
  vscode.__answer = 'Open';
  r = await provider.openStepsLink(A, 'path', 'D:\\elsewhere\\foo.py');
  assert.equal(r.ok, true);
  assert.equal(vscode.__openedDocs.length, 1, 'opens once the user says yes');
});

// -- network paths: refused before any stat, by shape, not by name --------------------------
//
// safeLocalFileUri is an allow list (only a drive-letter root on Windows, or a single leading
// separator elsewhere, ever passes), checked on the fully resolved path; these refusal cases
// cover the shapes an earlier deny-list version of this check missed (mixed separators, the NT
// object prefix) alongside the ones it did catch, each asserted against vscode.__statCalls so a
// refusal is provably never followed by a stat, not just by its result.

const REFUSED_PATHS = [
  ['\\/host\\share\\x', 'mixed separators (leading \\/ )'],
  ['/\\host/share/x', 'mixed separators (leading /\\ )'],
  ['\\??\\UNC\\host\\share\\x', 'the NT object prefix'],
  ['\\\\?\\UNC\\host\\share\\x', 'the \\\\?\\ device prefix'],
  ['\\\\.\\pipe\\x', 'the \\\\.\\ device prefix'],
  ['\\foo\\bar', 'a rooted path with no drive letter'],
  ['//host/share', 'a // UNC form'],
  ['\\\\host\\share', 'a \\\\ UNC form'],
  ['file://evilhost/share/x', 'a file:// URI used as a path'],
];

for (const [target, label] of REFUSED_PATHS) {
  test('openLink path: ' + label + ' is refused, and stat is never called', async () => {
    const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
    const r = await provider.openStepsLink(A, 'path', target);
    assert.equal(r.ok, false);
    assert.match(r.message, /Network paths/);
    assert.deepEqual(vscode.__statCalls, [], 'stat was never reached for ' + JSON.stringify(target));
    assert.equal(vscode.__openedDocs.length, 0);
  });
}

test('openLink path: a relative path that resolves outside any drive root is refused, caught after resolving', async () => {
  const { provider } = boot({}, { last: lastWithCwd('\\\\evilhost\\share') });
  const r = await provider.openStepsLink(A, 'path', 'x.txt');
  assert.equal(r.ok, false);
  assert.match(r.message, /Network paths/);
  assert.deepEqual(vscode.__statCalls, [], 'a UNC working directory must not make a relative path trust it');
  assert.equal(vscode.__openedDocs.length, 0);
});

test('openLink path: a network refusal copies the path to the clipboard', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  await provider.openStepsLink(A, 'path', '\\\\evilhost\\share\\x.txt');
  assert.deepEqual(vscode.__clipboard, ['\\\\evilhost\\share\\x.txt']);
});

// -- still allowed: drive letters, both separator styles, and the working directory ---------

test('openLink path: a drive-letter path (backslash form) under the working directory opens', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  vscode.__statTypes['C:\\proj\\dir\\file.md'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\dir\\file.md');
  assert.equal(r.ok, true);
  assert.ok(vscode.__statCalls.length >= 1);
});

test('openLink path: a mapped drive letter (Z:\\...) opens, a mapped drive is local path syntax', async () => {
  const { provider } = boot({}, { last: lastWithCwd('Z:\\dir') });
  vscode.__statTypes['Z:\\dir'] = vscode.FileType.Directory;
  const r = await provider.openStepsLink(A, 'path', 'Z:\\dir');
  assert.equal(r.ok, true);
});

test('openLink path: a drive-letter path with forward slashes opens', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\dir') });
  vscode.__statTypes['C:\\dir\\file.txt'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'c:/dir/file.txt');
  assert.equal(r.ok, true);
});

test('openLink path: a relative path under the session\'s working directory opens, no prompt', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  vscode.__statTypes['C:\\proj\\sub\\file.txt'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'sub\\file.txt');
  assert.equal(r.ok, true);
  assert.equal(vscode.__warnings.length, 0);
});

test('openLink path: a path that does not exist answers a plain message, not a throw', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  vscode.__statRejects['C:\\proj\\missing.txt'] = new Error('ENOENT');
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\missing.txt');
  assert.equal(r.ok, false);
  assert.ok(r.message);
  assert.equal(r.message.indexOf('Network paths') === -1, true, 'reached the stat failure, not a network refusal');
});

test('openLink path: a relative path resolves against the session\'s own working directory', async () => {
  const l = { sessions: [{ sessionId: A, pid: 100, title: 'My session', name: 'my-session', status: 'idle', unseen: false, cwd: 'C:\\work\\proj', window: null, archived: false }], limits: {}, usage: null };
  const { provider } = boot({}, { last: l });
  vscode.__statTypes['C:\\work\\proj\\src\\mod.py'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'src\\mod.py');
  assert.equal(r.ok, true);
  assert.equal(vscode.__openedDocs[0] && vscode.__openedDocs[0].fsPath, 'C:\\work\\proj\\src\\mod.py');
});

test('openLink path: ~ resolves against the home directory', async () => {
  const home = require('os').homedir();
  const target = require('path').join(home, 'notes.txt');
  const { provider } = boot({}, { last: last() });
  vscode.__statTypes[target] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', '~/notes.txt');
  assert.equal(r.ok, true);
  assert.equal(vscode.__openedDocs[0] && vscode.__openedDocs[0].fsPath, target);
});

test('openLink path: an absolute path is used as given, never run as a command', async () => {
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  vscode.__statTypes['C:\\proj\\foo.py'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\foo.py');
  assert.equal(r.ok, true);
  assert.equal(vscode.__executed.some((c) => c[0] !== 'revealFileInOS' && c[0] !== 'markdown.showPreview'), false, 'no shell or run command is ever executed for a path link');
});

test('openLink: an unknown kind is refused', async () => {
  const { provider } = boot({}, { last: last() });
  const r = await provider.openStepsLink(A, 'carrierPigeon', 'C:\\proj\\foo.py');
  assert.equal(r.ok, false);
});

// -- openText -------------------------------------------------------------------------------

test('openText opens an untitled document with the given text', async () => {
  const { provider } = boot({}, { last: last() });
  const r = await provider.openStepsText('Step text', 'the full body');
  assert.equal(r.ok, true);
  assert.equal(vscode.__openedDocs.length, 1);
  assert.equal(vscode.__openedDocs[0].content, 'the full body');
  assert.equal(vscode.__shownDocs.length, 1);
});

// -- panel message routing ---------------------------------------------------------------

test('openLink and openText sent from the panel are answered by the host, not forwarded to the service', async () => {
  const service = fakeService();
  const { provider } = boot({}, { last: lastWithCwd('C:\\proj') });
  vscode.__statTypes['C:\\proj\\foo.py'] = vscode.FileType.File;
  provider.stepsService = service;
  await provider.onMessage({ type: 'steps', sessionId: A });
  const panel = vscode.__panels[0];
  panel.__fireMessage({ type: 'openLink', kind: 'path', target: 'C:\\proj\\foo.py' });
  for (let i = 0; i < 10 && !panel.__posted.some((m) => m.type === 'openLinkResult'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(service.__handled.some((m) => m.type === 'openLink'), false, 'the service never sees an openLink message');
  assert.ok(panel.__posted.some((m) => m.type === 'openLinkResult' && m.ok === true));
  panel.__fireMessage({ type: 'openText', title: 't', text: 'hello' });
  for (let i = 0; i < 10 && !panel.__posted.some((m) => m.type === 'openTextResult'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(panel.__posted.some((m) => m.type === 'openTextResult'));
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

test('revealHere with a prompt passes it as the command\'s own second argument', async () => {
  const { provider } = boot({ exthostForPid: async () => process.pid, pidAlive: () => true }, { last: last() });
  await provider.revealHere(A, 'About your step at 14:05 ("x"): why this?');
  const call = vscode.__executed.find((c) => c[0] === 'claude-vscode.editor.open');
  assert.ok(call);
  assert.equal(call.length, 7);
  assert.equal(call[1], A);
  assert.equal(call[2], 'About your step at 14:05 ("x"): why this?');
  assert.deepEqual(call[6], { programmatic: 'honor-preferred-location' });
});

// -- B3: deliverToSession (the steps-service "deliver" hand-over) -------------------------

const runningWindow = () => { const l = last(); Object.assign(l.sessions[0], { window: { id: 3, exthostPid: 4242, label: 'x' } }); return l; };
const terminalRow = () => last();   // window: null already, from LAST

function setExtensionVersion(version) {
  if (version === undefined) { delete vscode.__extensions['anthropic.claude-code']; return; }
  vscode.__extensions['anthropic.claude-code'] = { packageJSON: { version } };
}

test('deliverToSession, same window, Claude Code 2.1.322 (the gate version): hand-over plus clipboard', async () => {
  const { provider } = boot({ exthostForPid: async () => process.pid, pidAlive: () => true }, { last: runningWindow() });
  setExtensionVersion('2.1.322');
  const result = await provider.deliverToSession(A, 'About your step at 14:05 ("x"): why this?', { kind: 'single' });
  assert.deepEqual(result, { ok: true, message: 'In the chat box and on the clipboard.' });
  const call = vscode.__executed.find((c) => c[0] === 'claude-vscode.editor.open');
  assert.equal(call[2], 'About your step at 14:05 ("x"): why this?');
  assert.deepEqual(vscode.__clipboard, ['About your step at 14:05 ("x"): why this?']);
});

test('deliverToSession, same window, Claude Code 2.1.400 (newer than the gate): hand-over plus clipboard', async () => {
  const { provider } = boot({ exthostForPid: async () => process.pid, pidAlive: () => true }, { last: runningWindow() });
  setExtensionVersion('2.1.400');
  const result = await provider.deliverToSession(A, 'text', { kind: 'single' });
  assert.equal(result.ok, true);
  assert.ok(vscode.__executed.some((c) => c[0] === 'claude-vscode.editor.open' && c[2] === 'text'));
  assert.deepEqual(vscode.__clipboard, ['text']);
});

test('deliverToSession, same window, Claude Code 2.1.100 (below the gate): clipboard only, no hand-over attempted', async () => {
  const { provider } = boot({ exthostForPid: async () => process.pid, pidAlive: () => true }, { last: runningWindow() });
  setExtensionVersion('2.1.100');
  const result = await provider.deliverToSession(A, 'text', { kind: 'single' });
  assert.deepEqual(result, { ok: false, message: 'On the clipboard. Paste it into the session.' });
  assert.equal(vscode.__executed.some((c) => c[0] === 'claude-vscode.editor.open'), false);
  assert.deepEqual(vscode.__clipboard, ['text']);
});

test('deliverToSession, same window, Claude Code absent: clipboard only, no hand-over attempted', async () => {
  const { provider } = boot({ exthostForPid: async () => process.pid, pidAlive: () => true }, { last: runningWindow() });
  setExtensionVersion(undefined);
  const result = await provider.deliverToSession(A, 'text', { kind: 'single' });
  assert.deepEqual(result, { ok: false, message: 'On the clipboard. Paste it into the session.' });
  assert.equal(vscode.__executed.some((c) => c[0] === 'claude-vscode.editor.open'), false);
  assert.deepEqual(vscode.__clipboard, ['text']);
});

test('deliverToSession, another window with a current board: a claim is written and the /steer URI is opened', async () => {
  const opened = [];
  const h = boot({
    exthostForPid: async () => 999,
    windowForPid: async () => ({ windowId: 3, exthostPid: 4242 }),
    boardAlive: () => 'nima-ghorbani.session-board-vscode',
    boardVersion: () => '0.12.0',
    steerToWindow: async (sessionId, windowId, board, claimId) => { opened.push({ sessionId, windowId, board, claimId }); },
  }, { last: runningWindow() });
  const result = await h.provider.deliverToSession(A, 'About your step at 09:00 ("x"): a note', { kind: 'single' });
  assert.deepEqual(result, { ok: true, message: 'In the chat box and on the clipboard.' });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].sessionId, A);
  assert.equal(opened[0].windowId, 3);
  assert.equal(opened[0].board, 'nima-ghorbani.session-board-vscode');
  assert.match(opened[0].claimId, /^[0-9a-f]{32}$/);
  assert.deepEqual(vscode.__clipboard, ['About your step at 09:00 ("x"): a note']);
});

test('deliverToSession, another window without a current board (old or no board): clipboard only', async () => {
  const h = boot({
    exthostForPid: async () => 999,
    windowForPid: async () => ({ windowId: 3, exthostPid: 4242 }),
    boardAlive: () => null,
  }, { last: runningWindow() });
  const result = await h.provider.deliverToSession(A, 'text', { kind: 'single' });
  assert.deepEqual(result, { ok: false, message: 'On the clipboard. Paste it into the session.' });
});

test('deliverToSession, another window with a board older than 0.12.0: clipboard only', async () => {
  const h = boot({
    exthostForPid: async () => 999,
    windowForPid: async () => ({ windowId: 3, exthostPid: 4242 }),
    boardAlive: () => 'nima-ghorbani.session-board-vscode',
    boardVersion: () => '0.11.2',
  }, { last: runningWindow() });
  const result = await h.provider.deliverToSession(A, 'text', { kind: 'single' });
  assert.deepEqual(result, { ok: false, message: 'On the clipboard. Paste it into the session.' });
});

test('deliverToSession, a terminal or background session (no VS Code window at all): clipboard only', async () => {
  const { provider } = boot({}, { last: terminalRow() });
  const result = await provider.deliverToSession(A, 'text', { kind: 'single' });
  assert.deepEqual(result, { ok: false, message: 'On the clipboard. Paste it into the session.' });
  assert.deepEqual(vscode.__clipboard, ['text']);
});

test('deliverToSession restores a stowed transcript first, the way copyResume does', async () => {
  const restored = [];
  const h = boot({
    stowedTranscripts: () => ['C:\\t\\a.jsonl'],
    unarchiveSession: async (id) => { restored.push(id); return { restoredTo: 'C:\\p\\a.jsonl' }; },
  }, { last: terminalRow() });
  await h.provider.deliverToSession(A, 'text', { kind: 'single' });
  assert.deepEqual(restored, [A]);
});

test('deliverToSession always writes to the clipboard, whichever branch it takes', async () => {
  const scenarios = [
    boot({}, { last: terminalRow() }),
    boot({ exthostForPid: async () => 999, windowForPid: async () => null }, { last: runningWindow() }),
  ];
  for (const h of scenarios) {
    vscode.__clipboard.length = 0;
    await h.provider.deliverToSession(A, 'always on the clipboard', { kind: 'single' });
    assert.deepEqual(vscode.__clipboard, ['always on the clipboard']);
  }
});

// -- B3: the owning side of /steer ---------------------------------------------------------

test('handleSteerUri: a fresh claim is read, the stowed transcript restored first, and the session revealed with the text as the prompt', async () => {
  const restored = [];
  const h = boot({
    exthostForPid: async () => process.pid, pidAlive: () => true,
    stowedTranscripts: () => ['C:\\t\\a.jsonl'],
    unarchiveSession: async (id) => { restored.push(id); return { restoredTo: 'C:\\p\\a.jsonl' }; },
  }, { last: last() });
  setExtensionVersion('2.1.322');
  const claimId = core.writeSteerClaim('About your step at 10:00 ("x"): steer text');
  await h.provider.handleUri({ path: '/steer', query: 'session=' + A + '&note=' + claimId, toString: () => '' });
  assert.deepEqual(restored, [A]);
  const call = vscode.__executed.find((c) => c[0] === 'claude-vscode.editor.open');
  assert.ok(call, 'the session was revealed');
  assert.equal(call[2], 'About your step at 10:00 ("x"): steer text');
});

test('handleSteerUri: a stale claim (past 30 seconds) is ignored, nothing is revealed', async () => {
  const h = boot({ exthostForPid: async () => process.pid, pidAlive: () => true }, { last: last() });
  setExtensionVersion('2.1.322');
  const claimId = core.writeSteerClaim('late text');
  // age the claim file past the 30-second window directly, the way the core.cjs suite does
  const fs = require('fs');
  const path = require('path');
  const file = path.join(core.DATA_DIR, 'steers', claimId + '.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(Object.assign(rec, { at: Date.now() - 31000 })));
  await h.provider.handleUri({ path: '/steer', query: 'session=' + A + '&note=' + claimId, toString: () => '' });
  assert.equal(vscode.__executed.some((c) => c[0] === 'claude-vscode.editor.open'), false);
});

test('handleSteerUri: a replayed URI (the claim already taken) does nothing the second time', async () => {
  const h = boot({ exthostForPid: async () => process.pid, pidAlive: () => true }, { last: last() });
  setExtensionVersion('2.1.322');
  const claimId = core.writeSteerClaim('once only');
  await h.provider.handleUri({ path: '/steer', query: 'session=' + A + '&note=' + claimId, toString: () => '' });
  vscode.__executed.length = 0;
  await h.provider.handleUri({ path: '/steer', query: 'session=' + A + '&note=' + claimId, toString: () => '' });
  assert.equal(vscode.__executed.some((c) => c[0] === 'claude-vscode.editor.open'), false, 'the second, replayed call finds no claim');
});

test('handleSteerUri: a malformed claim id does nothing, never throws', async () => {
  const h = boot({ exthostForPid: async () => process.pid, pidAlive: () => true }, { last: last() });
  setExtensionVersion('2.1.322');
  await assert.doesNotReject(h.provider.handleUri({ path: '/steer', query: 'session=' + A + '&note=not-a-claim-id', toString: () => '' }));
  assert.equal(vscode.__executed.some((c) => c[0] === 'claude-vscode.editor.open'), false);
});

test.after(() => cleanup());
