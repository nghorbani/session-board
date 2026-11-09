'use strict';
/*
 * Host side of Unseen and ✎: opening a session from the board marks it seen before the jump
 * (or the copy, when no window owns it), the `seen` message does the same, and ✎ (the `retitle`
 * message): a suggestion prefills a box and the board writes Claude Code's title for a session
 * that is not running; a running one goes to Claude Code's own rename box (here, through the
 * board in its window, or a message); every outcome answers retitleResult. The host is booted
 * by tests/shim/host.cjs; the core functions are scripted per case.
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

const ended = () => last();                                                    // window: null, pid 100 (not running)
const running = () => { const l = last(); Object.assign(l.sessions[0], { window: { id: 3, exthostPid: 4242, label: 'x' } }); return l; };

test('✎ on a session that is not running: the suggestion prefills the box, Enter writes Claude\'s title, the board refreshes', async () => {
  const renamed = [];
  const { provider, posted } = boot({ suggestTitle: async () => ({ ok: true, title: 'Suggested' }), renameSession: (id, t) => { renamed.push([id, t]); return { ok: true, title: t.trim() }; }, pidAlive: () => false }, { last: ended() });
  let scheduled = 0;
  provider.schedule = () => { scheduled++; };
  vscode.__inputAnswer = ' Typed title ';
  await provider.onMessage({ type: 'retitle', sessionId: A });
  assert.equal(vscode.__inputs[0].value, 'Suggested');
  assert.deepEqual(renamed, [[A, ' Typed title ']]);
  assert.deepEqual(lastMsg(posted, 'retitleResult'), { type: 'retitleResult', sessionId: A, ok: true, title: 'Typed title', message: '' });
  assert.equal(scheduled, 1);
  assert.deepEqual(vscode.__executed, [], 'Claude\'s rename box is not involved');
});

test('✎: Escape writes nothing and answers cancelled; a failed suggestion prefills the current title and says why', async () => {
  const renamed = [];
  const { provider, posted } = boot({ suggestTitle: async () => ({ ok: false, code: 'timeout', message: 'claude did not answer within 90 s' }), renameSession: (id, t) => { renamed.push(t); return { ok: true, title: t }; }, pidAlive: () => false }, { last: ended() });
  provider.schedule = () => {};
  await provider.onMessage({ type: 'retitle', sessionId: A });
  assert.equal(vscode.__inputs[0].value, 'Spike', 'the current title');
  assert.match(vscode.__inputs[0].prompt, /No suggestion \(claude did not answer within 90 s\)/);
  assert.deepEqual(renamed, []);
  assert.deepEqual(lastMsg(posted, 'retitleResult'), { type: 'retitleResult', sessionId: A, ok: false, title: null, message: '', code: 'cancelled' });
});

test('✎: a failed write answers its code and message and refreshes nothing', async () => {
  const { provider, posted } = boot({ suggestTitle: async () => ({ ok: true, title: 'S' }), renameSession: () => ({ ok: false, code: 'no-transcript', message: 'no transcript for this session' }), pidAlive: () => false }, { last: ended() });
  let scheduled = 0;
  provider.schedule = () => { scheduled++; };
  vscode.__inputAnswer = 'S';
  await provider.onMessage({ type: 'retitle', sessionId: A });
  assert.deepEqual(lastMsg(posted, 'retitleResult'), { type: 'retitleResult', sessionId: A, ok: false, title: null, message: 'no transcript for this session', code: 'no-transcript' });
  assert.equal(scheduled, 0);
});

test('✎ on a running session in this window: no board box; the suggestion goes on the clipboard and Claude\'s rename box opens on the revealed session', async () => {
  const renamed = [];
  const { provider, posted } = boot({ suggestTitle: async () => ({ ok: true, title: 'Suggested' }), renameSession: () => { renamed.push(1); return { ok: true }; }, pidAlive: () => true, exthostForPid: async () => process.pid }, { last: running() });
  const revealed = [];
  provider.revealHere = async (id) => { revealed.push(id); return true; };
  await provider.onMessage({ type: 'retitle', sessionId: A });
  assert.deepEqual([vscode.__inputs.length, renamed.length], [0, 0]);
  assert.deepEqual(vscode.__clipboard, ['Suggested']);
  assert.deepEqual(revealed, [A]);
  assert.deepEqual(vscode.__executed, [['claude-vscode.renameSessionTab']]);
  assert.deepEqual(lastMsg(posted, 'retitleResult'), { type: 'retitleResult', sessionId: A, ok: true, title: null, message: '', code: 'handed' });
});

test('✎ on a running session: Claude\'s box only opens after a successful reveal', async () => {
  const { provider } = boot({ suggestTitle: async () => ({ ok: true, title: 'S' }), pidAlive: () => true, exthostForPid: async () => process.pid }, { last: running() });
  provider.revealHere = async () => false;
  await provider.onMessage({ type: 'retitle', sessionId: A });
  assert.deepEqual(vscode.__executed, []);
  assert.ok(vscode.__infos.some((m) => /could not be opened here/.test(m)));
});

test('✎ on a running session in another window: through the board there (0.11.0 or newer) on its /rename route, else a message', async () => {
  const focused = [];
  const patches = (version) => ({ suggestTitle: async () => ({ ok: true, title: 'S' }), pidAlive: () => true, exthostForPid: async () => 999, windowForPid: async () => ({ windowId: 3, exthostPid: 4242 }), boardAlive: () => 'nima-ghorbani.session-board-vscode', boardVersion: () => version, focusSession: async (id, win, opts) => { focused.push([id, win, opts]); } });
  let h = boot(patches('0.11.0'), { last: running() });
  await h.provider.onMessage({ type: 'retitle', sessionId: A });
  assert.deepEqual(focused, [[A, 3, { viaBoard: 'nima-ghorbani.session-board-vscode', route: 'rename' }]]);
  assert.deepEqual(vscode.__clipboard, ['S']);
  focused.length = 0;
  h = boot(patches(null), { last: running() });                                  // a 0.10.x board reports no version
  await h.provider.onMessage({ type: 'retitle', sessionId: A });
  assert.deepEqual(focused, []);
  assert.ok(vscode.__infos.some((m) => /without a current Session Board/.test(m)));
});

test('the /rename URI reveals the session and opens Claude\'s rename box; a bad id does nothing', async () => {
  const { provider } = boot({}, { last: running() });
  const revealed = [];
  provider.revealHere = async (id) => { revealed.push(id); return true; };
  await provider.handleUri({ path: '/rename', query: 'session=' + A + '&windowId=3', toString: () => 'vscode://x/rename' });
  await provider.handleUri({ path: '/rename', query: 'session=nope', toString: () => 'vscode://x/rename' });
  assert.deepEqual(revealed, [A]);
  assert.deepEqual(vscode.__executed, [['claude-vscode.renameSessionTab']]);
});

test('✎: a throwing core call is logged and still answers, so the button never stays busy', async () => {
  const { provider, posted } = boot({ suggestTitle: async () => { throw new Error('kaboom'); } }, { last: ended() });
  await assert.doesNotReject(provider.onMessage({ type: 'retitle', sessionId: A }));
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'error' && /rename .*kaboom/.test(m)));
  assert.equal(lastMsg(posted, 'retitleResult').message, 'kaboom');
});

test('copyText message: a details value goes onto the clipboard, capped at 4096 characters; anything but a string is ignored', async () => {
  const { provider } = boot({}, { last: last() });
  const copied = [];
  const orig = vscode.env.clipboard.writeText;
  vscode.env.clipboard.writeText = async (t) => { copied.push(t); };
  try {
    await provider.onMessage({ type: 'copyText', text: A });
    await provider.onMessage({ type: 'copyText', text: 'x'.repeat(5000) });
    await provider.onMessage({ type: 'copyText', text: 42 });
    await provider.onMessage({ type: 'copyText', text: '' });
  } finally { vscode.env.clipboard.writeText = orig; }
  assert.deepEqual(copied.map((t) => t.length), [A.length, 4096]);
  assert.equal(copied[0], A);
});

test.after(cleanup);
