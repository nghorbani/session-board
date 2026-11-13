'use strict';
/**
 * Session Board: a sidebar view listing every live Claude Code session across all VS Code
 * windows, with status, title and context usage. Click opens the session in place when this
 * window owns it, otherwise the owning window is brought forward. Rows can be ended, and a
 * search box finds sessions by title or transcript content, live or past.
 *
 * The page (index.html) and data layer (core.cjs) are the same files the optional browser
 * front end uses; this file is the VS Code host for them.
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const core = require('./core.cjs');
const { createNotifier } = require('./notify.cjs');

const VIEW_ID = 'sessionBoard.view';
const POLL_VISIBLE_MS = 5000;
const POLL_HIDDEN_MS = 15000;
const USAGE_VISIBLE_MS = 5 * 60 * 1000;
const USAGE_HIDDEN_MS = 15 * 60 * 1000;

class BoardProvider {
  constructor(context, log) {
    this.context = context;
    this.log = log;
    this.view = null;
    this.last = null;
    this.timer = null;
    this.stopped = false;
    this.notifier = this.makeNotifier();
    this.inFlight = false;     // one snapshot at a time; a request during one queues one follow-up
    this.queued = false;
    this.seq = 0;
    this.searchAbort = null;   // AbortController of the latest search
    this.searchRequestId = null;
    this.accountError = null;  // the account probe failure last logged, so it is said once per change
    this.claudeArchiveError = null;   // same for the read of Claude Code's archive
  }

  // -- webview ---------------------------------------------------------------------------

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => this.schedule(0));
    view.onDidDispose(() => { this.view = null; });
    if (this.last) this.push();
    this.updateBadge();
    this.schedule(0);
  }

  html(webview) {
    let html = fs.readFileSync(path.join(this.context.extensionPath, 'index.html'), 'utf8');
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
      + 'style-src ' + webview.cspSource + ' \'unsafe-inline\'; '
      + 'script-src \'nonce-' + nonce + '\';">';
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">' + csp);
    html = html.replace('<script>', '<script nonce="' + nonce + '">');
    return html;
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  push() {
    if (this.last) this.post({ type: 'snapshot', data: this.last });
  }

  async onMessage(m) {
    if (!m || typeof m !== 'object') return;
    const sid = String(m.sessionId || '');
    try {
      // Every handler is awaited so a rejection lands in the catch below instead of escaping.
      switch (m.type) {
        case 'refresh': return await this.refresh();
        case 'open': if (core.UUID_RE.test(sid)) return await this.openSession(sid); return;
        case 'copy': if (core.UUID_RE.test(sid)) return await this.copyResume(sid); return;   // a click that cannot open the session
        case 'copyText': return await this.copyText(m.text);
        case 'end': if (core.UUID_RE.test(sid)) return await this.endSession(sid, Boolean(m.force), Boolean(m.archive)); return;
        case 'unarchive': if (core.UUID_RE.test(sid)) return await this.unarchive(sid); return;
        case 'search': return await this.search(String(m.query || ''), Boolean(m.content), String(m.requestId || ''));
        case 'cancelSearch': return this.cancelSearch();
        case 'openPast': if (core.UUID_RE.test(sid)) return await this.openPast(sid, String(m.path || ''), String(m.cwd || '')); return;
        case 'seen': if (core.UUID_RE.test(sid)) this.markSeen(sid); return;
        case 'mute': if (core.UUID_RE.test(sid)) return this.setMuted(sid, true); return;
        case 'unmute': if (core.UUID_RE.test(sid)) return this.setMuted(sid, false); return;
        case 'order': return this.setOrder(m.ids);
        case 'sortMode': return this.setSortMode(m.mode);
        case 'showMode': return this.setShowMode(m.show);
        case 'archivePast': if (core.UUID_RE.test(sid)) return await this.archivePast(sid); return;
        case 'retitle': if (core.UUID_RE.test(sid)) return await this.retitle(sid); return;
        case 'refreshUsage': return await this.refreshUsage(String(m.requestId || ''));
        default: return;
      }
    } catch (e) {
      this.log.error('message ' + m.type + ' failed: ' + String((e && e.message) || e));
    }
  }

  /** The resume command, where a click cannot open the session; a transcript the board stowed is brought back first, or nothing is copied. */
  async copyResume(sid) {
    if (core.stowedTranscripts(sid).length) {
      try {
        const r = await core.unarchiveSession(sid);
        this.log.info('unarchive ' + sid + ' (copy)' + (r && r.restoredTo ? ': ' + r.restoredTo : ''));
      } catch (e) {
        const message = String((e && e.message) || e);
        this.log.warn('unarchive ' + sid + ' (copy) failed: ' + message);
        vscode.window.showWarningMessage('Could not bring the transcript back, so the resume command was not copied: ' + message);
        return;
      }
    }
    await vscode.env.clipboard.writeText('claude --resume ' + sid);
    vscode.window.setStatusBarMessage('Copied: claude --resume ' + sid, 3000);
  }

  /** A value from a row's details line (the id, the transcript path) onto the clipboard. */
  async copyText(text) {
    if (typeof text !== 'string' || !text) return;
    await vscode.env.clipboard.writeText(text.slice(0, 4096));
    vscode.window.setStatusBarMessage('Copied: ' + (text.length > 60 ? text.slice(0, 59) + '…' : text), 3000);
  }

  // -- usage limits ----------------------------------------------------------------------

  /** Put the freshest usage state into the last snapshot and push it (never resend a stale one). */
  mergeUsage() {
    if (!this.last) return;
    this.last.usage = core.usageState();
    this.noteAccountError(this.last.usage);
    this.push();
  }

  /** An account probe failure (a CLI without `auth status`, a timeout) is logged when it appears or changes. */
  noteAccountError(u) {
    const err = (u && u.accountError) || null;
    if (err === this.accountError) return;
    this.accountError = err;
    if (err) this.log.warn('account probe: ' + err);
  }

  /** A failed read of Claude Code's archive (its state database busy, corrupt, or no node:sqlite) is logged when it appears or changes. */
  noteClaudeArchiveError(snap) {
    const err = (snap && snap.claudeArchiveError) || null;
    if (err === this.claudeArchiveError) return;
    this.claudeArchiveError = err;
    if (err) this.log.warn("Claude Code's archive could not be read; its archived sessions are not put away: " + err);
  }

  /**
   * Forced probe from ↻ or the command; the 15 s throttle in core still applies. The page
   * matches the `usageResult` reply to its click by `requestId` (the command passes none) and
   * ends the button's busy state on it, so the reply is posted on every outcome, after the
   * merged snapshot when one exists and even before the first snapshot.
   */
  async refreshUsage(requestId) {
    const id = requestId || '';
    try {
      const u = await core.fetchUsage();
      this.mergeUsage();
      if (u && u.throttled) vscode.window.setStatusBarMessage('Session Board: usage limits were refreshed a moment ago.', 3000);
      else if (u && u.error) this.log.warn('usage probe: ' + u.error);
      else {
        const tags = [u && u.subscriptionType, u && u.account && u.account.email].filter(Boolean);
        this.log.info('usage probe ok' + (tags.length ? ' (' + tags.join(', ') + ')' : ''));
      }
      this.post({ type: 'usageResult', requestId: id, throttled: Boolean(u && u.throttled), error: (u && u.error) || null });
    } catch (e) {
      const message = String((e && e.message) || e);
      this.log.error('usage refresh failed: ' + message);
      this.post({ type: 'usageResult', requestId: id, throttled: false, error: message });
    }
  }

  // -- polling ---------------------------------------------------------------------------

  schedule(delayMs) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), delayMs);
  }

  async refresh() {
    clearTimeout(this.timer);
    if (this.inFlight) { this.queued = true; return; }
    this.inFlight = true;
    const mySeq = ++this.seq;
    this.beat();
    try {
      // Claude Code lists programmatic sessions (claude -p, SDK runs) only with a process wrapper set; the board follows.
      const snap = await core.snapshot({ includeProgrammatic: Boolean(vscode.workspace.getConfiguration('claudeCode').get('claudeProcessWrapper')) });
      if (mySeq === this.seq) {          // an older result never overwrites a newer one
        snap.thisWindowId = core.windowIdForExthost(process.pid) || null;   // the page lists this window's section first
        this.last = snap;
        this.noteClaudeArchiveError(snap);
        this.push();
        this.updateBadge();
        this.notifier.observe(snap.sessions);
      }
    } catch (e) {
      this.log.error('poll failed: ' + String((e && e.message) || e));
    } finally {
      this.inFlight = false;
    }
    const visible = Boolean(this.view && this.view.visible);
    // Usage limits refresh on their own clock and never hold the session list back.
    const pending = core.refreshUsageIfStale(visible ? USAGE_VISIBLE_MS : USAGE_HIDDEN_MS);
    if (pending) {
      pending.then((u) => {
        this.mergeUsage();
        if (u && u.error) this.log.warn('usage probe: ' + u.error);
      }, (e) => this.log.warn('usage probe failed: ' + String((e && e.message) || e)));
    }
    if (this.queued) { this.queued = false; this.schedule(200); } else this.schedule(visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
  }

  updateBadge() {
    if (!this.view || !this.last) return;
    const waiting = this.last.sessions.filter((s) => s.status === 'waiting' && !s.muted).length;   // a muted session counts nowhere
    this.view.badge = waiting
      ? { value: waiting, tooltip: waiting + ' Claude Code session' + (waiting === 1 ? '' : 's') + ' need input' }
      : undefined;
  }

  /** This window's heartbeat, with whether it has the OS focus (the other boards leave a notification to a focused window). */
  beat() {
    const ext = this.context.extension;
    core.writeHeartbeat(process.pid, (ext && ext.id) || core.EXTENSION_ID, vscode.workspace.name || null, Boolean(vscode.window.state.focused),
      (ext && ext.packageJSON && ext.packageJSON.version) || null,
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] && vscode.workspace.workspaceFolders[0].uri.fsPath) || null);
  }

  /**
   * Waiting and done notifications (notify.cjs decides which and where): a toast in this window
   * when it is focused, a Windows notification from one window when none is.
   */
  makeNotifier() {
    const settings = () => {
      const c = vscode.workspace.getConfiguration('sessionBoard');
      return { notifyOnDone: c.get('notifyOnDone', true), systemNotifications: c.get('systemNotifications', true) };
    };
    return createNotifier({
      isFocused: () => Boolean(vscode.window.state.focused),
      focusedPeerAt: () => core.focusedPeerAt(process.pid),
      claim: (id, kind, at) => core.claimNotice(id, kind, at),
      release: (id, kind, at) => core.releaseNotice(id, kind, at),
      launchFor: (row) => core.openUriForPid(row.sessionId, row.pid),
      showSystemToast: (items) => core.showSystemToast(items),
      systemAvailable: core.IS_WINDOWS,
      settings,
      showVsToast: (ev) => {
        const show = ev.kind === 'done' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
        show(ev.text, 'Open').then((choice) => { if (choice === 'Open') this.openSession(ev.row.sessionId); });
      },
      reportFailure: (message) => vscode.window.showWarningMessage('Session Board: Windows notifications are unavailable (' + message + '). Toasts still show in a focused VS Code window.'),
      log: { info: (m) => this.log.info(m), warn: (m) => this.log.warn(m) },
    });
  }

  sessionRow(sessionId) {
    return ((this.last && this.last.sessions) || []).find((s) => s.sessionId === sessionId) || null;
  }

  // -- opening ---------------------------------------------------------------------------

  /**
   * Open a session that lives in this window the way the user has Claude Code configured.
   * `claude-vscode.editor.open` honours claudeCode.preferredLocation only when its sixth
   * argument marks the call as programmatic; called bare it opens an editor tab and rewrites
   * the preference to "panel". `primaryEditor.open` is the fallback (always an editor tab).
   */
  async revealHere(sessionId) {
    const honour = { programmatic: 'honor-preferred-location' };
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, undefined, undefined, undefined, honour);
      this.log.info('revealed ' + sessionId + ' via claude-vscode.editor.open');
      return true;
    } catch (e) {
      this.log.warn('claude-vscode.editor.open failed: ' + String((e && e.message) || e));
    }
    try {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
      this.log.info('revealed ' + sessionId + ' via claude-vscode.primaryEditor.open');
      return true;
    } catch (e) {
      this.log.warn('claude-vscode.primaryEditor.open failed: ' + String((e && e.message) || e));
      return false;
    }
  }

  /** vscode://<this extension id>/open?session=<id>, routed here by windowId. */
  async handleUri(uri) {
    this.log.info('uri ' + uri.toString(true));
    if (uri.path === '/rename') {
      const id = new URLSearchParams(uri.query).get('session') || '';
      if (core.UUID_RE.test(id)) await this.openClaudeRename(id);
      return;
    }
    if (uri.path !== '/open') return;
    const sessionId = new URLSearchParams(uri.query).get('session') || '';
    if (!core.UUID_RE.test(sessionId)) return;
    this.markSeen(sessionId);                 // a click on a Windows notification counts as opening it
    if (!(await this.revealHere(sessionId))) {
      vscode.window.showWarningMessage('Claude Code is not active in this window, so the session could not be opened here.');
    }
  }

  async openSession(sessionId) {
    const row = this.sessionRow(sessionId);
    if (!row) return;
    if (!core.pidAlive(row.pid)) {
      this.log.info('open ' + sessionId + ': process gone');
      vscode.window.showInformationMessage('That session has ended. Copied: claude --resume ' + sessionId);
      await vscode.env.clipboard.writeText('claude --resume ' + sessionId);
      this.schedule(0);
      return;
    }
    this.markSeen(sessionId);                 // opening from the board is "seen", whatever the jump does next
    const owner = await core.exthostForPid(Number(row.pid));
    if (owner === process.pid) {
      this.log.info('open ' + sessionId + ': owned by this window');
      if (await this.revealHere(sessionId)) return;
    }
    const win = await core.windowForPid(Number(row.pid));
    if (!win) {
      this.log.info('open ' + sessionId + ': no VS Code window found, copying resume command');
      await this.copyResume(sessionId);
      vscode.window.showInformationMessage('No VS Code window owns this session. Copied: claude --resume ' + sessionId);
      return;
    }
    const viaBoard = core.boardAlive(win.exthostPid);
    this.log.info('open ' + sessionId + ': window ' + win.windowId + (viaBoard ? ' via ' + viaBoard : ' via anthropic.claude-code'));
    try {
      await core.focusSession(sessionId, win.windowId, { viaBoard });
    } catch (e) {
      this.log.error('focus failed: ' + String((e && e.message) || e));
      vscode.window.showErrorMessage('Could not open the session: ' + String((e && e.message) || e));
    }
  }

  /**
   * A past session: resume in place when its folder is in this window, otherwise hand over.
   * A transcript the board stowed (or a board marker) is brought back first, and the path is
   * resolved by id afterwards: the page may still hold the stowed path.
   */
  async openPast(sessionId, transcriptPath, cwd) {
    let restoredTo = null;
    if (core.stowedTranscripts(sessionId).length || core.readArchived().has(sessionId)) {
      try {
        const r = await core.unarchiveSession(sessionId);
        restoredTo = (r && r.restoredTo) || null;
        this.log.info('unarchive ' + sessionId + ' (open)' + (restoredTo ? ': ' + restoredTo : ''));
      } catch (e) {
        const message = String((e && e.message) || e);
        this.log.warn('unarchive ' + sessionId + ' (open) failed: ' + message);
        this.post({ type: 'openResult', sessionId, ok: false, message });
        return;
      }
    }
    const resolved = core.liveTranscripts(sessionId)[0] || transcriptPath;
    if (resolved && !fs.existsSync(resolved)) {
      this.post({ type: 'openResult', sessionId, ok: false, message: 'transcript no longer exists', restoredTo });
      return;
    }
    const liveRow = this.sessionRow(sessionId);
    if (liveRow && core.pidAlive(liveRow.pid)) return this.openSession(sessionId);

    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const here = cwd && folders.some((f) => core.isInside(cwd, f));
    if (here) {
      this.log.info('openPast ' + sessionId + ': resuming in this window');
      if (await this.revealHere(sessionId)) { this.post({ type: 'openResult', sessionId, ok: true, restoredTo }); return; }
    }
    await this.copyResume(sessionId);
    this.post({ type: 'openResult', sessionId, ok: false, message: 'copied resume command', restoredTo });
    const folderExists = cwd && fs.existsSync(cwd);
    const choice = await vscode.window.showInformationMessage(
      'Session ' + sessionId.slice(0, 8) + ' belongs to ' + (cwd || 'an unknown folder') + '. Copied "claude --resume ' + sessionId
      + '". Opening the folder in a new window is step one; resume the session there with the board or the picker.',
      ...(folderExists ? ['Open folder in new window'] : []));
    if (choice === 'Open folder in new window') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), { forceNewWindow: true });
    }
  }

  // -- ending ----------------------------------------------------------------------------

  /** ✕ (end) and ⤓ (archive: end, then keep the session off the board) share this path. */
  async endSession(sessionId, force, archive) {
    const row = this.sessionRow(sessionId);
    const label = row ? (row.title || row.name) : sessionId.slice(0, 8);
    const verb = archive ? 'Archive' : 'End';
    let result = await core.endSession(sessionId, { force, archive });
    if (result.code === 'needs-force') {
      const choice = await vscode.window.showWarningMessage(
        label + ' is ' + result.status + '. ' + (archive
          ? 'Archive it? This ends it and everything it started; in-flight work is lost.'
          : 'End it and everything it started? In-flight work is lost.'),
        { modal: true }, verb + ' session');
      if (choice !== verb + ' session') {
        this.post({ type: 'endResult', sessionId, ok: false, code: 'cancelled', message: 'cancelled' });
        return;
      }
      result = await core.endSession(sessionId, { force: true, archive });
    }
    const moveError = result.archived ? (result.moveError || null) : null;
    this.log.info((archive ? 'archive ' : 'end ') + sessionId + ': ' + result.code + (result.archived ? ' +archived' : '') + (result.moved ? ' +moved' : '')
      + (result.message ? ' (' + result.message + ')' : '') + (result.archiveError ? '; archive failed: ' + result.archiveError : '')
      + (moveError ? '; move failed: ' + moveError : ''));
    this.post({ type: 'endResult', sessionId, ok: result.ok, code: result.code, message: result.message || '', archived: Boolean(result.archived), archiveError: result.archiveError || null, moved: Boolean(result.moved), moveError });
    if (result.ok && result.archiveError) vscode.window.showWarningMessage('Ended, not archived: ' + label + ' (' + result.archiveError + ')');
    else if (result.ok && moveError) vscode.window.showWarningMessage('Archived on the board; transcript not moved: ' + moveError);
    else if (result.ok) vscode.window.setStatusBarMessage((result.archived ? 'Archived: ' : 'Ended: ') + label, 3000);
    else if (result.code !== 'cancelled') vscode.window.showWarningMessage('Could not ' + verb.toLowerCase() + ' ' + label + ': ' + (result.message || result.code));
    this.schedule(300);
  }

  /** ⤒ on a row, or a click on an archived live row: the transcript comes back and the session shows on the board again. */
  async unarchive(sessionId) {
    try {
      const r = await core.unarchiveSession(sessionId);
      const restoredTo = (r && r.restoredTo) || null;
      this.log.info('unarchive ' + sessionId + (restoredTo ? ': ' + restoredTo : ''));
      this.post({ type: 'unarchiveResult', sessionId, ok: true, restoredTo });
    } catch (e) {
      const message = String((e && e.message) || e);
      this.log.error('unarchive ' + sessionId + ' failed: ' + message);
      this.post({ type: 'unarchiveResult', sessionId, ok: false, message });
    }
    this.schedule(0);
  }

  /** The bell on a row: the shared mute marker is written or removed, the page hears the outcome, the next snapshot carries the flag. */
  setMuted(sessionId, muted) {
    let ok = true;
    let message = '';
    try {
      if (muted) core.muteSession(sessionId); else core.unmuteSession(sessionId);
      this.log.info((muted ? 'mute ' : 'unmute ') + sessionId);
    } catch (e) {
      ok = false;
      message = String((e && e.message) || e);
      this.log.error((muted ? 'mute ' : 'unmute ') + sessionId + ' failed: ' + message);
    }
    this.post({ type: 'muteResult', sessionId, ok, muted: ok ? muted : false, message });
    this.schedule(0);
  }

  /** A move on the page: the group's complete order becomes ranks; the page hears the outcome, the next snapshot carries it. */
  setOrder(ids) {
    let ok = true;
    let count = 0;
    let message = '';
    try {
      if (!Array.isArray(ids)) throw new Error('order must be a list of session ids');
      count = core.setOrder(ids);
      this.log.info('order ' + count + ' sessions');
    } catch (e) {
      ok = false;
      message = String((e && e.message) || e);
      this.log.error('order failed: ' + message);
    }
    this.post({ type: 'orderResult', ok, count: ok ? count : 0, message });
    this.schedule(0);
  }

  /** The header switch: the board-wide mode file; every window follows with its next snapshot. */
  setSortMode(mode) {
    let ok = true;
    let message = '';
    try {
      core.setSortMode(String(mode || ''));
      this.log.info('sort mode ' + mode);
    } catch (e) {
      ok = false;
      message = String((e && e.message) || e);
      this.log.error('sort mode failed: ' + message);
    }
    this.post({ type: 'sortModeResult', ok, mode: ok ? String(mode) : null, message });
    this.schedule(0);
  }

  /** The header's "running | open | all" switch: the board-wide file; every window follows with its next snapshot. */
  setShowMode(show) {
    let ok = true;
    let message = '';
    try {
      core.setShowMode(String(show || ''));
      this.log.info('show ' + show);
    } catch (e) {
      ok = false;
      message = String((e && e.message) || e);
      this.log.error('show mode failed: ' + message);
    }
    this.post({ type: 'showModeResult', ok, show: ok ? String(show) : null, message });
    this.schedule(0);
  }

  /** ⤓ on an ended row: the archive marker, then the transcript move; the page hears the outcome. */
  async archivePast(sessionId) {
    const r = await core.archivePast(sessionId);
    if (!r.ok) this.log.warn('archive ' + sessionId + ' failed: ' + r.message);
    else this.log.info('archive ' + sessionId + ' (ended)' + (r.moveError ? ': transcript not moved: ' + r.moveError : ''));
    if (r.ok && r.moveError) vscode.window.showWarningMessage('Archived on the board; transcript not moved: ' + r.moveError);
    this.post({ type: 'archivePastResult', sessionId, ok: Boolean(r.ok), message: r.ok ? '' : r.message });
    this.schedule(0);
  }

  // -- unseen and titles -----------------------------------------------------------------

  /** The seen marker: an unseen row leaves the Unseen group with the next snapshot. */
  markSeen(sessionId) {
    try { core.markSeen(sessionId); } catch (e) { this.log.warn('seen marker for ' + sessionId + ' failed: ' + String((e && e.message) || e)); }
  }

  /**
   * ✎ on a row: a small model suggests a title; Claude Code keeps it.
   *   a running session in a VS Code window ──▶ handToClaude: the suggestion on the clipboard,
   *     the session opened in its window and Claude's own rename box (Claude tells the CLI, so
   *     the name survives the next answer) ──▶ retitleResult code handed
   *   any other ──▶ an input box prefilled with the suggestion ──▶ Escape: code cancelled;
   *     Enter: core.renameSession writes Claude's title ──▶ retitleResult with the title
   * The page hears retitleResult on every outcome, so its ✎ never stays busy.
   */
  async retitle(sessionId) {
    const reply = (r) => this.post(Object.assign({ type: 'retitleResult', sessionId, ok: false, title: null, message: '' }, r));
    try {
      const row = this.sessionRow(sessionId);
      const suggestion = await core.suggestTitle(sessionId);
      if (suggestion.ok) this.log.info('title suggestion for ' + sessionId + ': "' + suggestion.title + '"');
      else this.log.warn('title suggestion for ' + sessionId + ' failed: ' + (suggestion.message || suggestion.code));
      if (row && row.window && core.pidAlive(row.pid)) {
        await this.handToClaude(row, suggestion.ok ? suggestion.title : null);
        return reply({ ok: true, code: 'handed' });
      }
      const current = (row && row.title) || '';
      const typed = await vscode.window.showInputBox({
        title: 'Session title (written where Claude Code reads it)',
        prompt: suggestion.ok ? 'Suggested from the progress so far; edit or replace it' : 'No suggestion (' + (suggestion.message || suggestion.code) + '); type a title',
        value: suggestion.ok ? suggestion.title : current,
        validateInput: (v) => (v && v.trim() ? undefined : 'Enter a title'),
      });
      if (typed === undefined) return reply({ code: 'cancelled' });
      const result = core.renameSession(sessionId, typed);
      if (result.code === 'claude-owned') {               // it started running meanwhile
        if (row) await this.handToClaude(row, typed.trim());
        return reply({ ok: true, code: 'handed' });
      }
      if (!result.ok) {
        this.log.warn('rename ' + sessionId + ' failed: ' + (result.message || result.code));
        return reply({ code: result.code, message: result.message || result.code });
      }
      this.log.info('rename ' + sessionId + ': "' + result.title + '"' + (result.warning ? ' (' + result.warning + ')' : ''));
      if (result.warning) vscode.window.showWarningMessage('Renamed, but ' + result.warning);
      reply({ ok: true, title: result.title });
      this.schedule(0);
    } catch (e) {
      const message = String((e && e.message) || e);
      this.log.error('rename ' + sessionId + ' failed: ' + message);
      reply({ message });
    }
  }

  /**
   * A running session keeps the name its CLI holds, so its rename goes through Claude Code:
   * the text goes onto the clipboard, then Claude's rename box opens in the session's window
   * (here, or through the board running there, 0.11.0 or newer). Without such a board the
   * message says where to rename.
   */
  async handToClaude(row, text) {
    if (text) await vscode.env.clipboard.writeText(text);
    const hint = text ? 'Suggested title copied: paste it into Claude Code\'s rename box.' : 'Rename the session in Claude Code\'s rename box.';
    const owner = await core.exthostForPid(Number(row.pid));
    if (owner === process.pid) {
      vscode.window.setStatusBarMessage(hint, 8000);
      await this.openClaudeRename(row.sessionId);
      return;
    }
    const win = await core.windowForPid(Number(row.pid));
    const board = win ? core.boardAlive(win.exthostPid) : null;
    if (win && board && core.versionAtLeast(core.boardVersion(win.exthostPid), '0.11.0')) {
      try {
        await core.focusSession(row.sessionId, win.windowId, { viaBoard: board, route: 'rename' });
        vscode.window.setStatusBarMessage(hint, 8000);
        return;
      } catch (e) { this.log.warn('rename hand-over failed: ' + String((e && e.message) || e)); }
    }
    vscode.window.showInformationMessage('That session runs in another window without a current Session Board. Rename it there in Claude Code' + (text ? ' (the suggested title is on the clipboard).' : '.'));
  }

  /** Open the session here and Claude Code's rename box for it; nothing runs when the session could not be revealed. */
  async openClaudeRename(sessionId) {
    if (!(await this.revealHere(sessionId))) {
      vscode.window.showInformationMessage('The session could not be opened here; rename it in Claude Code.');
      return false;
    }
    try {
      await vscode.commands.executeCommand('claude-vscode.renameSessionTab');
      return true;
    } catch (e) {
      this.log.warn('claude-vscode.renameSessionTab failed: ' + String((e && e.message) || e));
      vscode.window.showInformationMessage('Claude Code did not open its rename box; use "Claude Code: Rename Session Tab" on the session.');
      return false;
    }
  }

  // -- search ----------------------------------------------------------------------------

  cancelSearch() {
    if (this.searchAbort) { this.searchAbort.abort(); this.searchAbort = null; }
    if (this.searchRequestId) core.cancelSearch(this.searchRequestId);
  }

  async search(query, content, requestId) {
    this.cancelSearch();                           // a newer search supersedes the running one
    const ac = new AbortController();
    this.searchAbort = ac;
    this.searchRequestId = requestId;
    const runIt = () => core.searchSessions(query, { content, requestId, signal: ac.signal, appRoot: vscode.env.appRoot });
    let result;
    try {
      result = content
        ? await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Session Board: searching transcripts…', cancellable: true },
          (_progress, token) => { token.onCancellationRequested(() => ac.abort()); return runIt(); })
        : await runIt();
    } catch (e) {
      result = { requestId, query, content, total: 0, shown: 0, partial: true, partialReason: String((e && e.message) || e), rows: [] };
    }
    if (this.searchRequestId !== requestId) return;   // superseded while running
    this.log.info('search "' + query + '"' + (content ? ' +content' : '') + ': ' + (result.total || 0) + ' hits' + (result.partial ? ' (partial)' : ''));
    this.post({ type: 'searchResult', data: result });
  }

  async pickAndOpen() {
    if (!this.last) await this.refresh();
    const rows = ((this.last && this.last.sessions) || []).slice();
    const rank = { waiting: 0, busy: 1, idle: 2 };
    const putAway = (s) => Boolean(s.archived) && s.status !== 'waiting';   // archived rows sort last
    rows.sort((a, b) => (putAway(a) ? 9 : (rank[a.status] ?? 3)) - (putAway(b) ? 9 : (rank[b.status] ?? 3)));
    const items = rows.map((s) => ({
      label: (s.status === 'waiting' ? '$(warning) ' : s.status === 'busy' ? '$(sync~spin) ' : '') + (s.title || s.name),
      description: putAway(s) ? 'archived' : (s.status === 'waiting' ? (s.waitingFor || 'waiting') : s.status),
      detail: (s.window && s.window.label ? s.window.label + ' · ' : '') + s.cwd,
      sessionId: s.sessionId,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open a Claude Code session', matchOnDetail: true });
    if (!pick) return;
    if (rows.some((s) => s.sessionId === pick.sessionId && s.archivedBy !== 'claude-code' && s.archived)) {   // an explicit open brings it back
      try { await core.unarchiveSession(pick.sessionId); this.log.info('unarchive ' + pick.sessionId + ' (picked)'); }
      catch (e) { this.log.warn('unarchive ' + pick.sessionId + ' failed: ' + String((e && e.message) || e)); }
    }
    await this.openSession(pick.sessionId);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.cancelSearch();
  }
}

function activate(context) {
  const log = vscode.window.createOutputChannel('Session Board', { log: true });
  const provider = new BoardProvider(context, log);
  context.subscriptions.push(
    log,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('sessionBoard.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('sessionBoard.open', () => provider.pickAndOpen()),
    vscode.commands.registerCommand('sessionBoard.search', async () => {
      await vscode.commands.executeCommand(VIEW_ID + '.focus');
      provider.post({ type: 'focusSearch' });
    }),
    vscode.commands.registerCommand('sessionBoard.refreshUsage', () => provider.refreshUsage()),
    vscode.window.registerUriHandler({ handleUri: (uri) => provider.handleUri(uri) }),
    vscode.window.onDidChangeWindowState(() => provider.beat()),   // the other boards learn about a focus change within a poll
    { dispose: () => provider.stop() },
  );
  log.info('activated in extension host ' + process.pid + ' as ' + ((context.extension && context.extension.id) || core.EXTENSION_ID));
  if (!core.IS_WINDOWS && !context.globalState.get('platformNoticeShown')) {
    context.globalState.update('platformNoticeShown', true);
    vscode.window.showInformationMessage(
      'Session Board: listing and search work here, but the window mapping and ending sessions need Windows in this version; jumps copy the resume command instead.');
  }
  provider.schedule(1500);
}

function deactivate() {}

module.exports = { activate, deactivate };
