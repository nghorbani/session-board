'use strict';
/*
 * notify.cjs on its own: which events a window announces (waiting, done), which it leaves out
 * (first sight, muted rows, the done setting), and where each goes (a VS Code toast when this
 * window is focused, nothing when a focused window has seen it, pending while a focused window's
 * heartbeat is older than the event, a claimed Windows notification otherwise), plus batching,
 * release-and-retry on a failed toast and the one-time failure report. Plain fake dependencies,
 * no vscode and no core.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, PENDING_MAX_MS } = require('../notify.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const D = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const row = (id, extra) => Object.assign({ sessionId: id, pid: 1, title: 'T' + id[0], status: 'busy', unseen: false, unseenAt: null, muted: false, statusUpdatedAt: 10 }, extra);
const done = (id, at, extra) => row(id, Object.assign({ status: 'idle', unseen: true, unseenAt: at }, extra));
const waiting = (id, at, extra) => row(id, Object.assign({ status: 'waiting', statusUpdatedAt: at, waitingFor: 'permission prompt' }, extra));

/** A notifier over recording fakes; `env` sets focus, the focused peer time, the clock and the settings. */
function harness(env) {
  env = Object.assign({ focused: false, peerAt: 0, now: 100000, notifyOnDone: true, systemNotifications: true, systemAvailable: true, toastFails: 0 }, env);
  const rec = { vs: [], sys: [], claims: new Set(), claimed: [], released: [], reports: [] };
  const n = createNotifier({
    isFocused: () => env.focused,
    focusedPeerAt: () => env.peerAt,
    claim: (id, kind, at) => { const k = id + kind + at; if (rec.claims.has(k)) return false; rec.claims.add(k); rec.claimed.push([id, kind, at]); return true; },
    release: (id, kind, at) => { rec.claims.delete(id + kind + at); rec.released.push([id, kind, at]); },
    launchFor: async (r) => 'vscode://board/open?session=' + r.sessionId,
    showVsToast: (ev) => rec.vs.push([ev.kind, ev.row.sessionId, ev.text]),
    showSystemToast: async (items) => { if (env.toastFails > 0) { env.toastFails--; throw new Error('blocked by policy'); } rec.sys.push(items); },
    settings: () => ({ notifyOnDone: env.notifyOnDone, systemNotifications: env.systemNotifications }),
    get systemAvailable() { return env.systemAvailable; },
    reportFailure: (m) => rec.reports.push(m),
    now: () => env.now,
  });
  return { n, env, rec };
}

test('events: nothing on the first snapshot; a new waiting row and a finished answer are announced once', async () => {
  const { n, rec } = harness({ focused: true });
  await n.observe([waiting(A, 5), done(B, 50)]);                                  // already there when the window opened
  assert.deepEqual(rec.vs, [], 'no flood at start-up');
  await n.observe([waiting(A, 5), done(B, 50), row(C)]);
  await n.observe([waiting(A, 5), done(B, 50), waiting(C, 60)]);
  await n.observe([row(A), done(B, 70), waiting(C, 60)]);                           // B answers again
  assert.deepEqual(rec.vs, [['waiting', C, 'Ta: permission prompt'], ['done', B, 'T6: done']]);
});

test('events: a turn shorter than one poll still counts (unseenAt moved while the row stayed idle); a row first seen unseen does not', async () => {
  const { n, rec } = harness({ focused: true });
  await n.observe([done(A, 50)]);
  await n.observe([done(A, 50), done(B, 40)]);                                       // B appears already unseen: an old answer
  await n.observe([done(A, 80), done(B, 40)]);
  assert.deepEqual(rec.vs.map((v) => [v[0], v[1]]), [['done', A]]);
});

test('muted rows are tracked but never announced, so unmuting raises nothing either; the done setting turns done off only', async () => {
  const { n, env, rec } = harness({ focused: true });
  await n.observe([row(A), row(B)]);
  await n.observe([waiting(A, 20, { muted: true }), done(B, 30, { muted: true })]);
  await n.observe([waiting(A, 20), done(B, 30)]);                                    // unmuted, same events
  assert.deepEqual(rec.vs, []);
  env.notifyOnDone = false;
  await n.observe([row(A), row(B)]);
  await n.observe([waiting(A, 40), done(B, 50)]);
  assert.deepEqual(rec.vs.map((v) => v[0]), ['waiting']);
});

test('focused peer: a heartbeat written after the event means that window spoke; an older one keeps the event pending until it expires', async () => {
  const { n, env, rec } = harness({ peerAt: 0 });
  await n.observe([row(A), row(B)]);
  env.now = 200000; env.peerAt = 200500;                                             // the peer wrote after we saw the events
  await n.observe([done(A, 150000), row(B)]);
  assert.deepEqual([rec.vs, rec.sys, rec.claimed], [[], [], []], 'dropped: the focused window spoke');
  env.now = 300000; env.peerAt = 299000;                                             // a focused peer that has not written since
  await n.observe([done(A, 150000), done(B, 290000)]);
  assert.deepEqual(rec.sys, [], 'pending while the peer may still speak');
  env.now = 300000 + PENDING_MAX_MS - 1;
  await n.observe([done(A, 150000), done(B, 290000)]);
  assert.deepEqual(rec.sys, [], 'still pending just before the limit');
  env.now = 300000 + PENDING_MAX_MS;
  await n.observe([done(A, 150000), done(B, 290000)]);
  assert.deepEqual(rec.sys.map((items) => items.map((i) => i.title)), [['T6']], 'after the limit: the Windows path');
});

test('a pending event that is muted, seen or over in the meantime is dropped', async () => {
  const { n, env, rec } = harness({ peerAt: 1 });
  await n.observe([row(A), row(B), row(C)]);
  await n.observe([done(A, 10), done(B, 20), waiting(C, 30)]);
  env.now += PENDING_MAX_MS;
  await n.observe([done(A, 10, { muted: true }), row(B, { status: 'idle' }), row(C)]);
  assert.deepEqual([rec.sys, rec.vs], [[], []]);
});

test('nobody focused: one window claims each event; the batch is one toast call with the open URI; a lost claim stays silent', async () => {
  const one = harness();
  const two = harness();
  two.rec.claims = one.rec.claims;                                                    // the two windows share the notices folder
  for (const h of [one, two]) await h.n.observe([row(A), row(B)]);
  await one.n.observe([waiting(A, 11), done(B, 22)]);
  await two.n.observe([waiting(A, 11), done(B, 22)]);
  assert.deepEqual(one.rec.sys, [[
    { title: 'T1', body: 'needs you: permission prompt', launch: 'vscode://board/open?session=' + A },
    { title: 'T6', body: 'done', launch: 'vscode://board/open?session=' + B },
  ]]);
  assert.deepEqual(two.rec.sys, [], 'the other window lost both claims');
});

test('no Windows path without the setting, without a system that can show it, or without an event time', async () => {
  for (const env of [{ systemNotifications: false }, { systemAvailable: false }]) {
    const { n, rec } = harness(env);
    await n.observe([row(A)]);
    await n.observe([done(A, 10)]);
    assert.deepEqual([rec.sys, rec.claimed], [[], []], JSON.stringify(env));
  }
  const { n, rec } = harness();
  await n.observe([row(A)]);
  await n.observe([waiting(A, null, { statusUpdatedAt: null })]);
  assert.deepEqual([rec.sys, rec.claimed], [[], []], 'no time: nothing to claim');
});

test('a burst shows three toasts in one call, the last one says how many more', async () => {
  const { n, rec } = harness();
  await n.observe([row(A), row(B), row(C), row(D)]);
  await n.observe([done(A, 1), done(B, 2), done(C, 3), done(D, 4)]);
  assert.equal(rec.sys.length, 1);
  assert.deepEqual(rec.sys[0].map((i) => i.body), ['done', 'done', 'done (and 1 more)']);
  assert.equal(rec.claimed.length, 4, 'every event is claimed, so no other window repeats it');
});

test('a failed toast releases its claims and is retried once on the next call; a second failure is reported once and dropped', async () => {
  const { n, env, rec } = harness({ toastFails: 1 });
  await n.observe([row(A)]);
  await n.observe([done(A, 10)]);
  assert.deepEqual([rec.sys, rec.released, rec.reports], [[], [[A, 'done', 10]], []], 'released, retry queued');
  await n.observe([done(A, 10)]);
  assert.deepEqual(rec.sys.map((x) => x.length), [1], 'the retry went out');
  env.toastFails = 2;
  await n.observe([row(A), row(B)]);
  await n.observe([done(A, 20), done(B, 30)]);
  await n.observe([done(A, 20), done(B, 30)]);
  assert.deepEqual(rec.reports, ['blocked by policy'], 'reported once');
  await n.observe([done(A, 20), done(B, 30)]);
  assert.equal(rec.sys.length, 1, 'dropped after the retry');
  env.toastFails = 2;
  await n.observe([row(A)]);
  await n.observe([done(A, 40)]);
  await n.observe([done(A, 40)]);
  assert.deepEqual(rec.reports, ['blocked by policy'], 'never reported twice');
});

test('a focused window shows a pending or retried event as a VS Code toast', async () => {
  const { n, env, rec } = harness({ toastFails: 1 });
  await n.observe([row(A)]);
  await n.observe([done(A, 10)]);
  env.focused = true;
  await n.observe([done(A, 10)]);
  assert.deepEqual(rec.vs.map((v) => v[0]), ['done']);
  assert.deepEqual(rec.sys, []);
});

test('titles are cut to 120 characters', async () => {
  const { n, rec } = harness({ focused: true });
  await n.observe([row(A)]);
  await n.observe([done(A, 10, { title: 'x'.repeat(300) })]);
  assert.equal(rec.vs[0][2], 'x'.repeat(119) + '…: done');
});
