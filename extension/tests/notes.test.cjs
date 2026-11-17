'use strict';
/*
 * notes.cjs: one file per note under <dataDir>/notes/<sessionId>/<noteId>.json, sent records as
 * their own files, the 16 KB text cap, bad-id rejection, last-writer-wins edits that never
 * revive a deleted note, delete removing sent records too, list sorted by `at` skipping
 * unreadable files, and pruning only when the transcript is gone from both roots. Every test
 * points dataDir at its own temp dir; nothing here touches a real transcript or data directory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createNotesStore, TEXT_MAX } = require('../notes.cjs');

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';

function freshStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notes-'));
  return { dataDir, store: createNotesStore({ dataDir }) };
}

test('add: writes one file per note and returns it with an empty sent list', () => {
  const { dataDir, store } = freshStore();
  const note = store.add(A, 'u1:0', 'why this step?');
  assert.equal(note.stepId, 'u1:0');
  assert.equal(note.text, 'why this step?');
  assert.equal(typeof note.id, 'string');
  assert.match(note.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(note.sent, []);
  const file = path.join(dataDir, 'notes', A, note.id + '.json');
  assert.ok(fs.existsSync(file));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.id, note.id);
  assert.equal(onDisk.stepId, 'u1:0');
  assert.equal(onDisk.text, 'why this step?');
  assert.equal(typeof onDisk.at, 'number');
});

test('add: rejects empty text', () => {
  const { store } = freshStore();
  assert.throws(() => store.add(A, 'u1:0', ''), /empty/);
  assert.throws(() => store.add(A, 'u1:0', '   '), /empty/);
});

test('add: rejects text over the 16 KB cap with a plain message', () => {
  const { store } = freshStore();
  const big = 'x'.repeat(TEXT_MAX + 1);
  assert.throws(() => store.add(A, 'u1:0', big), /16 KB/);
  const ok = 'x'.repeat(TEXT_MAX);
  assert.doesNotThrow(() => store.add(A, 'u1:0', ok));
});

test('add: a session id must match the checked pattern; nothing is written for a bad one', () => {
  const { dataDir, store } = freshStore();
  assert.throws(() => store.add('not a session', 'u1:0', 'x'), /session id/);
  assert.throws(() => store.add('../../etc/passwd', 'u1:0', 'x'), /session id/);
  assert.equal(fs.existsSync(path.join(dataDir, 'notes')), false);
});

test('edit: a note id must match its own strict pattern', () => {
  const { store } = freshStore();
  assert.throws(() => store.edit(A, 'not-a-note-id', 'x'), /note id/);
  assert.throws(() => store.edit(A, '../../x', 'x'), /note id/);
});

test('edit: last writer wins and changes the text in place', () => {
  const { store } = freshStore();
  const note = store.add(A, 'u1:0', 'first');
  const edited = store.edit(A, note.id, 'second');
  assert.equal(edited.text, 'second');
  assert.equal(edited.id, note.id);
  assert.equal(edited.stepId, 'u1:0'); // unrelated fields survive the edit
  const again = store.get(A, note.id);
  assert.equal(again.text, 'second');
});

test('edit: writes only when the note file still exists, so a delete racing an edit is not revived', () => {
  const { dataDir, store } = freshStore();
  const note = store.add(A, 'u1:0', 'first');
  store.delete(A, note.id);
  const result = store.edit(A, note.id, 'second');
  assert.equal(result, null);
  assert.equal(fs.existsSync(path.join(dataDir, 'notes', A, note.id + '.json')), false);
});

// A store whose file system lets a test act at one exact moment: right before a file is moved
// into place (the last step of every write here).
function storeWithHook(dataDir, clock) {
  const hook = { beforeRename: null };
  const hookedFs = Object.assign({}, fs, {
    renameSync: (from, to) => { const h = hook.beforeRename; hook.beforeRename = null; if (h) h(to); return fs.renameSync(from, to); },
  });
  return { hook, store: createNotesStore(Object.assign({ dataDir, fs: hookedFs }, clock ? { now: clock } : {})) };
}

test('edit: a delete that lands between the edit\'s read and its write does not leave the note behind', () => {
  const { dataDir, store: other } = freshStore();
  const { hook, store } = storeWithHook(dataDir);
  const note = store.add(A, 'u1:0', 'first');
  hook.beforeRename = () => { other.delete(A, note.id); };   // another window deletes it at that moment
  const result = store.edit(A, note.id, 'second');
  assert.equal(result, null, 'the edit reports the note as gone');
  assert.equal(fs.existsSync(path.join(dataDir, 'notes', A, note.id + '.json')), false, 'and the deleted note is not back');
  assert.deepEqual(store.list(A), []);
});

test('addSent: a delete that lands while a send is being recorded leaves no record of a note that is gone', () => {
  const { dataDir, store: other } = freshStore();
  const { hook, store } = storeWithHook(dataDir);
  const note = store.add(A, 'u1:0', 'first');
  hook.beforeRename = () => { other.delete(A, note.id); };
  assert.equal(store.addSent(A, note.id, 'steer'), null);
  const left = fs.readdirSync(path.join(dataDir, 'notes', A)).filter((n) => n.indexOf('.sent.') !== -1);
  assert.deepEqual(left, []);
});

test('addSent: two sends recorded in the same millisecond are both kept', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notes-'));
  const frozen = () => 1700000000000;
  const one = createNotesStore({ dataDir, now: frozen });
  const two = createNotesStore({ dataDir, now: frozen });   // a second window
  const note = one.add(A, 'u1:0', 'ask about this');
  one.addSent(A, note.id, 'steer');
  two.addSent(A, note.id, 'steer');
  assert.equal(one.get(A, note.id).sent.length, 2);
});

test('edit: rejects empty or too-long text the same way add does', () => {
  const { store } = freshStore();
  const note = store.add(A, 'u1:0', 'first');
  assert.throws(() => store.edit(A, note.id, ''), /empty/);
  assert.throws(() => store.edit(A, note.id, 'x'.repeat(TEXT_MAX + 1)), /16 KB/);
});

test('delete: removes the note and is not an error on a note already gone', () => {
  const { dataDir, store } = freshStore();
  const note = store.add(A, 'u1:0', 'first');
  const removed = store.delete(A, note.id);
  assert.equal(removed, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'notes', A, note.id + '.json')), false);
  const removedAgain = store.delete(A, note.id);
  assert.equal(removedAgain, false);
});

test('delete: removes the note\'s sent records too', () => {
  const { dataDir, store } = freshStore();
  const note = store.add(A, 'u1:0', 'first');
  store.addSent(A, note.id, 'steer');
  store.addSent(A, note.id, 'branch');
  const dir = path.join(dataDir, 'notes', A);
  assert.equal(fs.readdirSync(dir).filter((f) => f.indexOf('.sent.') !== -1).length, 2);
  store.delete(A, note.id);
  assert.equal(fs.readdirSync(dir).filter((f) => f.indexOf('.sent.') !== -1).length, 0);
});

test('addSent: records are their own files, so two windows never rewrite the same list', () => {
  const { dataDir, store } = freshStore();
  const note = store.add(A, 'u1:0', 'first');
  const r1 = store.addSent(A, note.id, 'steer');
  const r2 = store.addSent(A, note.id, 'steer');
  assert.equal(r1.sent.length, 1);
  assert.equal(r2.sent.length, 2);
  const dir = path.join(dataDir, 'notes', A);
  const sentFiles = fs.readdirSync(dir).filter((f) => f.indexOf('.sent.') !== -1);
  assert.equal(sentFiles.length, 2);
  const again = store.get(A, note.id);
  assert.equal(again.sent.length, 2);
  assert.ok(again.sent.every((s) => s.kind === 'steer'));
});

test('addSent: rejects an unknown kind and does nothing for a note that is gone', () => {
  const { store } = freshStore();
  const note = store.add(A, 'u1:0', 'first');
  assert.throws(() => store.addSent(A, note.id, 'teleport'), /kind/);
  store.delete(A, note.id);
  const result = store.addSent(A, note.id, 'steer');
  assert.equal(result, null);
});

test('list: returns a session\'s notes sorted by at', () => {
  let clock = 1000;
  const store2 = createNotesStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notes-')), now: () => clock });
  clock = 1000; const n1 = store2.add(A, 'u1:0', 'first');
  clock = 3000; const n2 = store2.add(A, 'u2:0', 'second');
  clock = 2000; const n3 = store2.add(A, 'u3:0', 'third');
  const list = store2.list(A);
  assert.deepEqual(list.map((n) => n.id), [n1.id, n3.id, n2.id]);
});

test('list: an unreadable note file is skipped, not deleted', () => {
  const { dataDir, store } = freshStore();
  const note = store.add(A, 'u1:0', 'good');
  const dir = path.join(dataDir, 'notes', A);
  const badId = 'f'.repeat(32);
  fs.writeFileSync(path.join(dir, badId + '.json'), 'not json at all');
  const list = store.list(A);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, note.id);
  assert.ok(fs.existsSync(path.join(dir, badId + '.json')), 'the unreadable file is left in place');
});

test('list: an empty or missing session has no notes', () => {
  const { store } = freshStore();
  assert.deepEqual(store.list(A), []);
});

test('list: rejects a bad session id', () => {
  const { store } = freshStore();
  assert.throws(() => store.list('nope'), /session id/);
});

test('two writers adding notes to the same session at once both survive', async () => {
  const { dataDir, store } = freshStore();
  void dataDir;
  const [n1, n2] = await Promise.all([
    Promise.resolve(store.add(A, 'u1:0', 'from writer one')),
    Promise.resolve(store.add(A, 'u2:0', 'from writer two')),
  ]);
  assert.notEqual(n1.id, n2.id);
  const list = store.list(A);
  assert.equal(list.length, 2);
  assert.ok(list.some((n) => n.text === 'from writer one'));
  assert.ok(list.some((n) => n.text === 'from writer two'));
});

// -- prune -----------------------------------------------------------------------------------

test('pruneDead: a session\'s notes are removed only once its transcript is gone from both roots', () => {
  const { dataDir, store } = freshStore();
  store.add(A, 'u1:0', 'keep me while the transcript is live');
  store.add(B, 'u1:0', 'this session has no transcript anywhere');

  // A is still live; B has no transcript in either root: only B's notes go.
  store.pruneDead(new Set([A]), new Map());
  assert.equal(fs.existsSync(path.join(dataDir, 'notes', A)), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'notes', B)), false);
});

test('pruneDead: a transcript in the stowed root (not live) still keeps the notes', () => {
  const { dataDir, store } = freshStore();
  store.add(A, 'u1:0', 'ended but transcript stowed');
  store.pruneDead(new Set(), new Map([[A, '/stowed/path/' + A + '.jsonl']]));
  assert.equal(fs.existsSync(path.join(dataDir, 'notes', A)), true);
});

test('pruneDead: with a check of the disk given, notes go only when that check agrees the transcript is gone', () => {
  const { store } = freshStore();
  store.add(A, 'u1:0', 'the list of transcripts was read before my session wrote its file');
  store.add(B, 'u1:0', 'my transcript really is gone');
  const asked = [];
  store.pruneDead(new Set(), new Map(), (sessionId) => { asked.push(sessionId); return sessionId === B; });
  assert.equal(store.list(A).length, 1, 'kept: the disk still has the transcript');
  assert.equal(store.list(B).length, 0, 'removed: the disk has none');
  assert.deepEqual(asked.sort(), [A, B]);
});

test('pruneDead: nothing to prune when the notes root does not exist yet', () => {
  const { store } = freshStore();
  assert.doesNotThrow(() => store.pruneDead(new Set(), new Map()));
});
