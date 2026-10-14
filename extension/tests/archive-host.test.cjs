'use strict';
/*
 * Host side of ⤓: endSession(sid, force, archive) forwards `archive` to core, retries with
 * force after the modal, reports `archived` and `archiveError` in endResult, never lets a
 * rejection escape onMessage, answers `unarchive`, and unarchives a picked archived row.
 * The host is booted by tests/shim/host.cjs; core.endSession is scripted per case.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, cleanup, vscode, core } = require('./shim/host.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const LAST = { sessions: [{ sessionId: A, pid: 100, title: 'Spike', name: 'spike', status: 'idle', cwd: 'C:\\x', window: null, archived: false }], limits: {}, usage: null };
const last = () => JSON.parse(JSON.stringify(LAST));
const lastMsg = (posted, type) => posted.filter((m) => m.type === type).pop();

test('archive ok: endResult carries archived, the status bar says Archived', async () => {
  const calls = [];
  const { provider, posted } = boot({ endSession: async (id, opts) => { calls.push(opts); return { ok: true, code: 'ended', pid: 100, archived: true }; } }, { last: last() });
  await provider.endSession(A, false, true);
  assert.deepEqual(calls, [{ force: false, archive: true }]);
  assert.deepEqual(lastMsg(posted, 'endResult'), { type: 'endResult', sessionId: A, ok: true, code: 'ended', message: '', archived: true, archiveError: null, moved: false, moveError: null });
  assert.ok(vscode.__status.some((t) => t === 'Archived: Spike'));
});

test('archive needs-force: the modal offers Archive session and the retry keeps archive', async () => {
  const calls = [];
  const { provider, posted } = boot({ endSession: async (id, opts) => { calls.push(opts); return calls.length === 1 ? { ok: false, code: 'needs-force', status: 'busy' } : { ok: true, code: 'ended', archived: true }; } }, { last: last() });
  vscode.__answer = 'Archive session';
  await provider.endSession(A, false, true);
  assert.deepEqual(calls, [{ force: false, archive: true }, { force: true, archive: true }]);
  assert.match(vscode.__warnings[0], /Archive it\? This ends it and everything it started/);
  assert.equal(lastMsg(posted, 'endResult').archived, true);
});

test('archive cancelled at the modal: no retry, endResult cancelled, no marker call', async () => {
  const calls = [];
  const { provider, posted } = boot({ endSession: async (id, opts) => { calls.push(opts); return { ok: false, code: 'needs-force', status: 'waiting' }; } }, { last: last() });
  vscode.__answer = undefined;
  await provider.endSession(A, false, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(lastMsg(posted, 'endResult'), { type: 'endResult', sessionId: A, ok: false, code: 'cancelled', message: 'cancelled' });
});

test('archive with a failed marker write: ended, not archived, and the user is told', async () => {
  const { provider, posted } = boot({ endSession: async () => ({ ok: true, code: 'ended', archived: false, archiveError: 'EACCES: permission denied' }) }, { last: last() });
  await provider.endSession(A, false, true);
  const r = lastMsg(posted, 'endResult');
  assert.deepEqual([r.ok, r.archived, r.archiveError], [true, false, 'EACCES: permission denied']);
  assert.ok(vscode.__warnings.some((t) => /^Ended, not archived: Spike/.test(t)));
  assert.ok(!vscode.__status.some((t) => /^Archived:/.test(t)));
});

test('plain end still works: archive false, status bar says Ended', async () => {
  const calls = [];
  const { provider, posted } = boot({ endSession: async (id, opts) => { calls.push(opts); return { ok: true, code: 'ended', pid: 100 }; } }, { last: last() });
  await provider.endSession(A, false, false);
  assert.deepEqual(calls, [{ force: false, archive: false }]);
  assert.deepEqual([lastMsg(posted, 'endResult').archived, lastMsg(posted, 'endResult').archiveError], [false, null]);
  assert.ok(vscode.__status.some((t) => t === 'Ended: Spike'));
});

test('onMessage awaits its handlers: a rejecting end is logged, not thrown', async () => {
  const { provider } = boot({ endSession: async () => { throw new Error('kaboom'); } }, { last: last() });
  await assert.doesNotReject(provider.onMessage({ type: 'end', sessionId: A, archive: true }));
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'error' && /message end failed: kaboom/.test(m)));
});

test('unarchive message: core is called and unarchiveResult is posted', async () => {
  const un = [];
  const { provider, posted } = boot({ unarchiveSession: (id) => { un.push(id); } }, { last: last() });
  await provider.onMessage({ type: 'unarchive', sessionId: A });
  assert.deepEqual(un, [A]);
  assert.deepEqual(lastMsg(posted, 'unarchiveResult'), { type: 'unarchiveResult', sessionId: A, ok: true, restoredTo: null });
});

test('unarchive message: a store failure is reported, not thrown', async () => {
  const { provider, posted } = boot({ unarchiveSession: () => { throw new Error('EPERM'); } }, { last: last() });
  await provider.onMessage({ type: 'unarchive', sessionId: A });
  assert.deepEqual(lastMsg(posted, 'unarchiveResult'), { type: 'unarchiveResult', sessionId: A, ok: false, message: 'EPERM' });
});

test('pickAndOpen: picking an archived row unarchives it first; an ordinary row does not', async () => {
  const un = [];
  const opened = [];
  const seeded = last();
  seeded.sessions[0].archived = true;
  const { provider } = boot({ unarchiveSession: (id) => { un.push(id); } }, { last: seeded });
  provider.openSession = async (id) => { opened.push(id); };
  vscode.__pick = 0;
  await provider.pickAndOpen();
  assert.deepEqual([un, opened], [[A], [A]]);

  const plain = boot({ unarchiveSession: (id) => { un.push(id); } }, { last: last() });
  plain.provider.openSession = async (id) => { opened.push(id); };
  vscode.__pick = 0;
  await plain.provider.pickAndOpen();
  assert.deepEqual([un, opened], [[A], [A, A]]);
});

// The transcript moves with the archive: what the host reports and restores.

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = 'cccccccc-3333-4333-8333-333333333333';
const noUsage = { refreshUsageIfStale: () => null };

test('archive with a moved transcript: endResult says moved, the status bar says Archived', async () => {
  const { provider, posted } = boot({ endSession: async () => ({ ok: true, code: 'ended', pid: 100, archived: true, moved: true, from: 'C:\\p\\a.jsonl', to: 'C:\\t\\a.jsonl' }) }, { last: last() });
  await provider.endSession(A, false, true);
  const r = lastMsg(posted, 'endResult');
  assert.deepEqual([r.archived, r.moved, r.moveError], [true, true, null]);
  assert.ok(vscode.__status.some((t) => t === 'Archived: Spike'));
  assert.ok(vscode.__log.some(([lvl, m]) => lvl === 'info' && /archive .*: ended \+archived \+moved/.test(m)), JSON.stringify(vscode.__log));
});

test('archive whose move failed: endResult carries moveError, the user is warned, the row still leaves', async () => {
  const { provider, posted } = boot({ endSession: async () => ({ ok: true, code: 'ended', pid: 100, archived: true, moved: false, moveError: 'running again under pid 5' }) }, { last: last() });
  await provider.endSession(A, false, true);
  const r = lastMsg(posted, 'endResult');
  assert.deepEqual([r.ok, r.archived, r.moved, r.moveError], [true, true, false, 'running again under pid 5']);
  assert.ok(vscode.__warnings.some((t) => t === 'Archived on the board; transcript not moved: running again under pid 5'), JSON.stringify(vscode.__warnings));
  assert.ok(!vscode.__status.some((t) => /^Archived:/.test(t)));
  assert.ok(vscode.__log.some(([, m]) => /move failed: running again under pid 5/.test(m)));
});

test('unarchive message: the reply carries restoredTo', async () => {
  const { provider, posted } = boot({ unarchiveSession: async () => ({ restoredTo: 'C:\\p\\a.jsonl' }) }, { last: last() });
  await provider.onMessage({ type: 'unarchive', sessionId: A });
  assert.deepEqual(lastMsg(posted, 'unarchiveResult'), { type: 'unarchiveResult', sessionId: A, ok: true, restoredTo: 'C:\\p\\a.jsonl' });
});

test('openPast: a stowed transcript is restored first and the restored path is used, whatever path the page sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-host-open-'));
  const restored = path.join(dir, P + '.jsonl');
  fs.writeFileSync(restored, '{}\n');
  const un = [];
  const { provider, posted } = boot(Object.assign({
    stowedTranscripts: () => (un.length ? [] : [path.join(dir, 'stowed', P + '.jsonl')]),   // gone once restored
    readArchived: () => new Set(),
    liveTranscripts: () => [restored],
    unarchiveSession: async (id) => { un.push(id); return { restoredTo: restored }; },
  }, noUsage), { last: last() });
  await provider.openPast(P, path.join(dir, 'stowed', P + '.jsonl'), 'C:\\x');
  assert.deepEqual(un, [P]);
  const r = lastMsg(posted, 'openResult');
  assert.equal(r.restoredTo, restored, JSON.stringify(r));
  assert.notEqual(r.message, 'transcript no longer exists');
  assert.ok(vscode.__status.some((t) => t === 'Copied: claude --resume ' + P), 'handed over with the resume command');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('openPast: a board marker without a stowed file still goes through unarchive', async () => {
  const un = [];
  const { provider } = boot(Object.assign({ stowedTranscripts: () => [], readArchived: () => new Set([P]), liveTranscripts: () => [], unarchiveSession: async (id) => { un.push(id); return { restoredTo: null }; } }, noUsage), { last: last() });
  await provider.openPast(P, '', 'C:\\x');
  assert.deepEqual(un, [P]);
});

test('openPast: a restore that fails posts the error and resumes nothing', async () => {
  const { provider, posted } = boot(Object.assign({ stowedTranscripts: () => ['C:\\t\\p.jsonl'], readArchived: () => new Set([P]), liveTranscripts: () => [], unarchiveSession: async () => { throw new Error('a different file is already at C:\\p\\p.jsonl; C:\\t\\p.jsonl stays'); } }, noUsage), { last: last() });
  await provider.openPast(P, 'C:\\t\\p.jsonl', 'C:\\x');
  const r = lastMsg(posted, 'openResult');
  assert.deepEqual([r.ok, /a different file is already at/.test(r.message)], [false, true], JSON.stringify(r));
  assert.ok(!vscode.__status.some((t) => /^Copied:/.test(t)), 'nothing copied');
});

test('copyResume: a stowed transcript is restored before the command is copied; a failed restore copies nothing', async () => {
  const un = [];
  const ok = boot({ stowedTranscripts: () => ['C:\\t\\a.jsonl'], unarchiveSession: async (id) => { un.push(id); return { restoredTo: 'C:\\p\\a.jsonl' }; } }, { last: last() });
  await ok.provider.copyResume(A);
  assert.deepEqual(un, [A]);
  assert.ok(vscode.__status.some((t) => t === 'Copied: claude --resume ' + A));
  const bad = boot({ stowedTranscripts: () => ['C:\\t\\a.jsonl'], unarchiveSession: async () => { throw new Error('EPERM'); } }, { last: last() });
  await bad.provider.copyResume(A);
  assert.ok(!vscode.__status.some((t) => /^Copied:/.test(t)), 'nothing copied after the failure');
  assert.ok(vscode.__warnings.some((t) => /transcript.*EPERM/.test(t)), JSON.stringify(vscode.__warnings));
});

test('claudeArchiveError is logged when it appears or changes, not on every poll', async () => {
  let err = 'SQLITE_BUSY: database is locked';
  const { provider } = boot(Object.assign({ snapshot: async () => ({ sessions: [], limits: {}, usage: null, claudeArchiveError: err }) }, noUsage), { noSnapshot: true });
  await provider.refresh();
  await provider.refresh();
  const lines = () => vscode.__log.filter(([lvl, m]) => lvl === 'warn' && /Claude Code's archive/.test(m));
  assert.equal(lines().length, 1, JSON.stringify(vscode.__log));
  err = 'node:sqlite unavailable (Node 20.0.0)';
  await provider.refresh();
  assert.equal(lines().length, 2);
  err = null;
  await provider.refresh();
  await provider.refresh();
  assert.equal(lines().length, 2);
});

test('boot resets the core patches of an earlier test', async () => {
  const first = boot({ stowedTranscripts: () => ['patched'] }, { last: last() });
  assert.deepEqual(first.provider && core.stowedTranscripts(A), ['patched']);
  boot({}, { last: last() });
  assert.notDeepEqual(core.stowedTranscripts(A), ['patched']);
});

test.after(cleanup);
