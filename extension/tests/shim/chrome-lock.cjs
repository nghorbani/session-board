'use strict';
/*
 * A file lock that keeps the two headless-Chrome suites (page.test.cjs, steps-page.test.cjs)
 * from running at the same time, without touching the concurrency of the other 25 suites.
 *
 * Each runs in its own worker process when node:test runs files in parallel, so an in-process
 * mutex cannot reach across them; a lock file in the OS temp dir can. acquire() creates the
 * file exclusively (`wx`) and polls with a short backoff when another suite holds it; a stale
 * lock (holder process gone, or past MAX_AGE_MS) is taken over rather than waited out forever.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_PATH = path.join(os.tmpdir(), 'session-board-chrome-suite.lock');
const POLL_MS = 150;
const MAX_WAIT_MS = 120000;
const MAX_AGE_MS = 180000; // longer than either suite's own test timeout

function held() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8');
    const rec = JSON.parse(raw);
    if (!rec || typeof rec.pid !== 'number') return false;
    if (Date.now() - Number(rec.at || 0) > MAX_AGE_MS) return false; // stale, take it
    try { process.kill(rec.pid, 0); return true; } catch (_) { return false; } // holder gone
  } catch (_) {
    return false; // no lock file, or unreadable: treat as free
  }
}

function tryTake() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (!held()) { try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* another racer removed it */ } }
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Blocks until this process owns the lock, or throws after MAX_WAIT_MS. */
async function acquire() {
  const start = Date.now();
  while (!tryTake()) {
    if (Date.now() - start > MAX_WAIT_MS) throw new Error('chrome-lock: timed out waiting for the other Chrome suite to finish');
    await sleep(POLL_MS);
  }
}

/** Releases the lock if this process still owns it; a lock taken over by someone else is left alone. */
function release() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8');
    const rec = JSON.parse(raw);
    if (rec && rec.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch (_) { /* already gone */ }
}

module.exports = { acquire, release };
