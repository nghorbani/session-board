'use strict';
/*
 * Notifications for one window's board: which events to announce and where.
 *
 * observe(sessions), once per snapshot
 *   ├─ first call: remember every row, announce nothing (no flood when a window opens)
 *   ├─ events: waiting  a row that starts waiting (keyed by its statusUpdatedAt)
 *   │          done     a known row whose unseenAt moved (the answer ended; the time comes from
 *   │                   the unseen marker, so every window keys the event the same way)
 *   ├─ muted rows raise nothing (they are still tracked, so unmuting raises nothing either);
 *   │   done events only while settings().notifyOnDone
 *   └─ route each event:
 *        this window focused ─────────────────────────▶ showVsToast(event)
 *        a focused window wrote a heartbeat after the event ─▶ dropped (it saw the event, it spoke)
 *        a focused window's last heartbeat is older ───▶ pending, routed again next call;
 *                                                         after PENDING_MAX_MS the Windows path
 *        no window focused ─▶ Windows path: settings().systemNotifications, a system that can
 *            show it, an event time; claim(id, kind, at) so one window shows it
 *            └─ the claimed events of one call go out as one showSystemToast(batch)
 *               (MAX_TOASTS, the last one says how many more)
 *   a failed batch releases its claims and is retried once on the next call; a second failure
 *   is reported once per notifier (reportFailure) and those events are dropped.
 *
 * No vscode import: the host injects focus, toasts, settings and the core calls, so the tests
 * drive it with plain functions.
 */

const PENDING_MAX_MS = 60000;
const MAX_TOASTS = 3;
const TITLE_MAX = 120;

function cut(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function titleOf(row) { return cut(row.title || row.name || String(row.sessionId).slice(0, 8), TITLE_MAX); }

/** The text of the VS Code toast. */
function toastText(ev) {
  return titleOf(ev.row) + ': ' + (ev.kind === 'done' ? 'done' : (ev.row.waitingFor || 'needs input'));
}

/**
 * deps: isFocused() → bool; focusedPeerAt() → newest focused peer heartbeat time or 0;
 * claim(id, kind, at) → bool; release(id, kind, at); launchFor(row) → Promise<uri|null>;
 * showVsToast(event); showSystemToast(items) → Promise; settings() → { notifyOnDone,
 * systemNotifications }; systemAvailable (bool); reportFailure(message); log { info, warn };
 * now() (defaults to Date.now).
 */
function createNotifier(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || { info() {}, warn() {} };
  const prevWaiting = new Set();
  const prevUnseenAt = new Map();
  const known = new Set();
  let primed = false;
  let pending = [];            // { kind, id, at, firstSeen, retry }
  let failureReported = false;
  let chain = Promise.resolve();

  /** The row still shows the event and is not muted. */
  function stillLive(ev, rows) {
    const row = rows.get(ev.id);
    if (!row || row.muted) return null;
    if (ev.kind === 'waiting') return row.status === 'waiting' ? row : null;
    return row.unseen && Number(row.unseenAt) === ev.at ? row : null;
  }

  function detect(sessions) {
    const fresh = [];
    const settings = deps.settings();
    const waitingNow = new Set();
    for (const s of sessions) {
      const id = s.sessionId;
      if (s.status === 'waiting') {
        waitingNow.add(id);
        if (primed && !prevWaiting.has(id) && !s.muted) fresh.push({ kind: 'waiting', id, at: Number(s.statusUpdatedAt) || 0, firstSeen: now() });
      }
      const u = Number(s.unseenAt) || 0;
      if (u) {
        const before = prevUnseenAt.get(id) || 0;
        if (primed && known.has(id) && u > before && s.unseen && !s.muted && settings.notifyOnDone !== false) {
          fresh.push({ kind: 'done', id, at: u, firstSeen: now() });
        }
        prevUnseenAt.set(id, Math.max(u, before));
      }
    }
    prevWaiting.clear();
    for (const id of waitingNow) prevWaiting.add(id);
    known.clear();
    for (const s of sessions) known.add(s.sessionId);
    for (const id of [...prevUnseenAt.keys()]) if (!known.has(id)) prevUnseenAt.delete(id);
    primed = true;
    return fresh;
  }

  async function run(sessions) {
    const rows = new Map(sessions.map((s) => [s.sessionId, s]));
    const candidates = pending.concat(detect(sessions));
    pending = [];
    const settings = deps.settings();
    const focused = Boolean(deps.isFocused());
    const peerAt = focused ? 0 : Number(deps.focusedPeerAt()) || 0;
    const batch = [];
    for (const ev of candidates) {
      const row = stillLive(ev, rows);
      if (!row) continue;
      if (ev.kind === 'done' && settings.notifyOnDone === false) continue;
      if (focused) { deps.showVsToast({ kind: ev.kind, row, text: toastText({ kind: ev.kind, row }) }); continue; }
      if (peerAt) {
        if (peerAt >= ev.firstSeen) continue;                                      // that window saw it
        if (now() - ev.firstSeen < PENDING_MAX_MS) { pending.push(ev); continue; } // it may still speak
      }
      if (!settings.systemNotifications || !deps.systemAvailable || !ev.at) continue;
      let won = false;
      try { won = deps.claim(ev.id, ev.kind, ev.at); } catch (e) { log.warn('notice claim failed: ' + String((e && e.message) || e)); }
      if (won) batch.push({ ev, row });
    }
    if (!batch.length) return;
    const shown = batch.slice(0, MAX_TOASTS);
    const more = batch.length - shown.length;
    let items;
    try {
      items = await Promise.all(shown.map(async ({ ev, row }, i) => ({
        title: titleOf(row),
        body: (ev.kind === 'done' ? 'done' : 'needs you: ' + (row.waitingFor || 'input')) + (more && i === shown.length - 1 ? ' (and ' + more + ' more)' : ''),
        launch: await Promise.resolve(deps.launchFor(row)).catch(() => null),
      })));
      await deps.showSystemToast(items);
      log.info('windows notification: ' + batch.map(({ ev }) => ev.kind + ' ' + ev.id).join(', '));
    } catch (e) {
      const message = String((e && e.message) || e);
      for (const { ev } of batch) deps.release(ev.id, ev.kind, ev.at);
      const again = batch.filter(({ ev }) => !ev.retry).map(({ ev }) => Object.assign({}, ev, { retry: true }));
      log.warn('windows notification failed' + (again.length ? ', retrying once' : '') + ': ' + message);
      pending = pending.concat(again);
      if (again.length < batch.length && !failureReported) { failureReported = true; deps.reportFailure(message); }
    }
  }

  return {
    /** One snapshot's rows; calls run one after another, so state is never shared mid-flight. */
    observe(sessions) {
      chain = chain.then(() => run(Array.isArray(sessions) ? sessions : [])).catch((e) => log.warn('notifier: ' + String((e && e.message) || e)));
      return chain;
    },
  };
}

module.exports = { createNotifier, toastText, PENDING_MAX_MS, MAX_TOASTS, TITLE_MAX };
