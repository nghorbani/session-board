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

test('openLink path: a folder is revealed in the OS file explorer', async () => {
  const { provider } = boot({}, { last: last() });
  vscode.__statTypes['C:\\proj\\folder'] = vscode.FileType.Directory;
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\folder');
  assert.equal(r.ok, true);
  const call = vscode.__executed.find((c) => c[0] === 'revealFileInOS');
  assert.ok(call);
  assert.equal(call[1].fsPath, 'C:\\proj\\folder');
});

test('openLink path: a file opens in an editor tab', async () => {
  const { provider } = boot({}, { last: last() });
  vscode.__statTypes['C:\\proj\\foo.py'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\foo.py');
  assert.equal(r.ok, true);
  assert.equal(vscode.__openedDocs.length, 1);
  assert.equal(vscode.__shownDocs.length, 1);
});

test('openLink path: a .md file opens with the Markdown preview instead of an editor tab', async () => {
  const { provider } = boot({}, { last: last() });
  vscode.__statTypes['C:\\proj\\readme.md'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\readme.md');
  assert.equal(r.ok, true);
  const call = vscode.__executed.find((c) => c[0] === 'markdown.showPreview');
  assert.ok(call);
  assert.equal(vscode.__openedDocs.length, 0, 'the preview command is used instead of opening it as a plain document');
});

test('openLink path: a file:line suffix moves the cursor to that line', async () => {
  const { provider } = boot({}, { last: last() });
  vscode.__statTypes['C:\\proj\\foo.py'] = vscode.FileType.File;
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\foo.py:42');
  assert.equal(r.ok, true);
  assert.equal(vscode.__openedDocs[0] && vscode.__openedDocs[0].fsPath, 'C:\\proj\\foo.py', 'the :line suffix is stripped before resolving the path');
});

test('openLink path: a path that does not exist answers a plain message, not a throw', async () => {
  const { provider } = boot({}, { last: last() });
  vscode.__statRejects['C:\\proj\\missing.txt'] = new Error('ENOENT');
  const r = await provider.openStepsLink(A, 'path', 'C:\\proj\\missing.txt');
  assert.equal(r.ok, false);
  assert.ok(r.message);
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
  const { provider } = boot({}, { last: last() });
  vscode.__statTypes['C:\\proj\\foo.py'] = vscode.FileType.File;
  await provider.openStepsLink(A, 'path', 'C:\\proj\\foo.py');
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
  const { provider } = boot({}, { last: last() });
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

test.after(() => cleanup());
