'use strict';
/*
 * Notes store for the step viewer: a bookmark on one step, kept as its own file so several
 * windows writing at once never lose one another's note. Pure module, no vscode import: fs
 * and the data directory are injected or defaulted, the way notify.cjs and steps-service.cjs
 * take their dependencies, so tests never touch a real data directory.
 *
 * Layout: <dataDir>/notes/<sessionId>/<noteId>.json holds { id, stepId, at, text }, written
 * tmp-then-rename. A "sent" record (the next build's steer/branch hand-over) is its own file
 * <sessionId>/<noteId>.sent.<at>.json holding { kind, at }, so two windows recording a send at
 * the same time never overwrite one another's record either; list() and get() read them back
 * and attach them to the note as `sent: [...]`, sorted by `at`.
 *
 * Deliberately not core.cjs's readMarkers: it deletes any file without a numeric top-level
 * `at`, and a note's own `at` is its creation time, not a liveness clock that store expects.
 */

const nodeFs = require('fs');
const path = require('path');

// a whole session id, as core.cjs's UUID_RE and the routes of server.cjs take it
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_ID_RE = /^[0-9a-f]{32}$/;           // crypto.randomBytes(16).toString('hex')
const TEXT_MAX = 16 * 1024;

function createNotesStore(deps) {
  deps = deps || {};
  const fs = deps.fs || nodeFs;
  const crypto = deps.crypto || require('crypto');
  const dataDir = deps.dataDir || path.join(require('os').homedir(), '.session-board-steps');
  const now = deps.now || Date.now;

  function notesRoot() { return path.join(dataDir, 'notes'); }
  function sessionDir(sessionId) { return path.join(notesRoot(), sessionId); }
  function noteFile(sessionId, noteId) { return path.join(sessionDir(sessionId), noteId + '.json'); }
  // a send is one file of its own; the random tail keeps two sends of one millisecond apart
  function sentFile(sessionId, noteId, at) { return path.join(sessionDir(sessionId), noteId + '.sent.' + at + '-' + crypto.randomBytes(4).toString('hex') + '.json'); }
  // left by a delete, so a write of the same note that was already on its way can tell
  function tombFile(sessionId, noteId) { return path.join(sessionDir(sessionId), noteId + '.deleted'); }
  const TOMB_KEEP_MS = 60 * 60 * 1000;

  function checkSessionId(sessionId) {
    sessionId = String(sessionId || '');
    if (!SESSION_ID_RE.test(sessionId)) throw new Error('not a session id');
    return sessionId;
  }
  function checkNoteId(noteId) {
    noteId = String(noteId || '');
    if (!NOTE_ID_RE.test(noteId)) throw new Error('not a note id');
    return noteId;
  }
  function checkText(text) {
    text = String(text == null ? '' : text);
    if (!text.trim()) throw new Error('note text is empty');
    if (Buffer.byteLength(text, 'utf8') > TEXT_MAX) throw new Error('note text is over 16 KB');
    return text;
  }

  function writeJsonAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + now() + '-' + Math.random().toString(16).slice(2);
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }

  function readJsonSafe(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }

  /** The sent records of one note, oldest first; an unreadable file is skipped, not deleted. */
  function readSent(sessionId, noteId) {
    let names = [];
    try { names = fs.readdirSync(sessionDir(sessionId)); } catch (_) { return []; }
    const prefix = noteId + '.sent.';
    const out = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const rec = readJsonSafe(path.join(sessionDir(sessionId), name));
      if (!rec || typeof rec !== 'object' || typeof rec.kind !== 'string') continue;
      out.push({ kind: rec.kind, at: Number(rec.at) || 0 });
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }

  function withSent(sessionId, rec) {
    return Object.assign({}, rec, { sent: readSent(sessionId, rec.id) });
  }

  /** New note on a step; the id is generated here so a caller never builds a path from one it chose. */
  function add(sessionId, stepId, text) {
    sessionId = checkSessionId(sessionId);
    stepId = String(stepId || '');
    if (!stepId) throw new Error('note needs a step id');
    const clean = checkText(text);
    const id = crypto.randomBytes(16).toString('hex');
    const rec = { id, stepId, at: now(), text: clean };
    writeJsonAtomic(noteFile(sessionId, id), rec);
    return withSent(sessionId, rec);
  }

  /** Last writer wins, and only when the note still exists: a write racing a delete must never
      bring a deleted note back by recreating its file. The note is read first; a delete that
      lands after that read and before the write is caught afterwards by the mark the delete
      leaves (it writes the mark before it removes the file, so one of the two always sees the
      other). */
  function edit(sessionId, noteId, text) {
    sessionId = checkSessionId(sessionId);
    noteId = checkNoteId(noteId);
    const clean = checkText(text);
    const file = noteFile(sessionId, noteId);
    const existing = readJsonSafe(file);
    if (!existing || typeof existing !== 'object') return null; // deleted meanwhile, or never existed
    const rec = Object.assign({}, existing, { text: clean });
    writeJsonAtomic(file, rec);
    if (fs.existsSync(tombFile(sessionId, noteId))) {
      try { fs.unlinkSync(file); } catch (_) { /* the delete removed it itself */ }
      return null;
    }
    return withSent(sessionId, rec);
  }

  /** Removes the note and every sent record of it; a note already gone is not an error. */
  function del(sessionId, noteId) {
    sessionId = checkSessionId(sessionId);
    noteId = checkNoteId(noteId);
    const dir = sessionDir(sessionId);
    const prefix = noteId + '.';
    // The mark first, before anything is looked at, then the files: see edit(). An edit that
    // finishes before the mark is an edit followed by this delete; one that finishes after it
    // sees the mark and reports the note gone. The mark does not wait for the note file to be
    // there: an edit of another window may put it back between a look and the removal below.
    // A session without a folder has no note, and gets no mark.
    try { fs.writeFileSync(tombFile(sessionId, noteId), ''); } catch (_) { /* the removal below still runs */ }
    // a note that was there when the mark was set is one this delete removes, also when an
    // edit that saw the mark takes the file away first
    let removed = fs.existsSync(noteFile(sessionId, noteId));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { names = []; }
    const cutoff = now() - TOMB_KEEP_MS;
    for (const name of names) {
      if (name.endsWith('.deleted') && name !== noteId + '.deleted') {
        // marks of earlier deletes have done their job once every write of that time is over
        try { if (fs.statSync(path.join(dir, name)).mtimeMs < cutoff) fs.unlinkSync(path.join(dir, name)); } catch (_) { /* gone */ }
        continue;
      }
      if (name !== noteId + '.json' && !name.startsWith(prefix + 'sent.')) continue;
      try { fs.unlinkSync(path.join(dir, name)); if (name === noteId + '.json') removed = true; } catch (_) { /* already gone */ }
    }
    return removed;
  }

  /** Records a send against a note; the note itself must still exist (an edit-vs-delete race
      applies here too: nothing is written for a note that is already gone). */
  function addSent(sessionId, noteId, kind) {
    sessionId = checkSessionId(sessionId);
    noteId = checkNoteId(noteId);
    kind = String(kind || '');
    if (kind !== 'steer' && kind !== 'branch') throw new Error('unknown sent kind');
    const existing = readJsonSafe(noteFile(sessionId, noteId));
    if (!existing) return null;
    const at = now();
    const file = sentFile(sessionId, noteId, at);
    try {
      writeJsonAtomic(file, { kind, at });
    } catch (e) {
      // a delete at this moment takes the half-written record with it; that is not an error
      if (fs.existsSync(tombFile(sessionId, noteId))) return null;
      throw e;
    }
    if (fs.existsSync(tombFile(sessionId, noteId))) {
      // deleted while this record was written: nothing of the note stays
      try { fs.unlinkSync(file); } catch (_) { /* the delete removed it itself */ }
      return null;
    }
    return withSent(sessionId, existing);
  }

  function get(sessionId, noteId) {
    sessionId = checkSessionId(sessionId);
    noteId = checkNoteId(noteId);
    const rec = readJsonSafe(noteFile(sessionId, noteId));
    if (!rec || typeof rec !== 'object') return null;
    return withSent(sessionId, rec);
  }

  /** A session's notes, sorted by creation time; an unreadable file is skipped in place, never
      deleted (a half-written file from a concurrent writer must survive to be read again). */
  function list(sessionId) {
    sessionId = checkSessionId(sessionId);
    const dir = sessionDir(sessionId);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.indexOf('.sent.') !== -1) continue;
      const id = name.slice(0, -5);
      if (!NOTE_ID_RE.test(id)) continue;
      const rec = readJsonSafe(path.join(dir, name));
      if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || typeof rec.stepId !== 'string') continue;
      out.push(withSent(sessionId, rec));
    }
    out.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    return out;
  }

  /** Removes a whole session's notes once its transcript is gone from both roots, mirroring
      core.cjs's pruneDead shape (liveIds, transcripts) but over directories, not single
      marker files, since a session's notes are several files at once. */
  function pruneDead(liveIds, transcripts, confirmGone) {
    // no look at the disk, no delete: the two lists alone are not enough (see below)
    if (typeof confirmGone !== 'function') return;
    const root = notesRoot();
    let sessionIds = [];
    try { sessionIds = fs.readdirSync(root); } catch (_) { return; }
    for (const sessionId of sessionIds) {
      if (!SESSION_ID_RE.test(sessionId)) continue;
      if (liveIds && liveIds.has && liveIds.has(sessionId)) continue;
      if (transcripts && transcripts.has && transcripts.has(sessionId)) continue;
      // `transcripts` may be a list read a while ago. Notes are text someone wrote, so before
      // they go the caller looks at the disk itself; anything but a clear "gone" keeps them.
      if (confirmGone(sessionId) !== true) continue;
      try { fs.rmSync(path.join(root, sessionId), { recursive: true, force: true }); } catch (_) { /* leave it for the next pass */ }
    }
  }

  return { add, edit, delete: del, addSent, get, list, pruneDead };
}

module.exports = { createNotesStore, TEXT_MAX, SESSION_ID_RE, NOTE_ID_RE };
