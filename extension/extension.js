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
const { createStepsService } = require('./steps-service.cjs');

const VIEW_ID = 'sessionBoard.view';
/** Escapes a value for use inside a double-quoted HTML attribute. */
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * An allow list, not a deny list: a path clicked in the viewer comes from transcript text, not
 * from something the user typed, and a UNC form (plain, mixed-separator, an NT object path, or
 * either Windows device prefix) makes Windows contact a named host to authenticate just for the
 * stat call, which can leak the user's NTLM credentials. Enumerating the ways to spell a network
 * path keeps missing one (`\/host\share`, `/\host/share` and `\??\UNC\...` all slipped past an
 * earlier version of this check that matched only `\\`, `//` and `\\?\`/`\\.\`), so this instead
 * demands the shape a trusted local path has to have and refuses everything else.
 *
 * `resolved` must already be the fully resolved absolute path (home expansion and the session's
 * own working directory both applied); this only classifies that final string, normalised with
 * `path.win32.normalize` on Windows so every `/` becomes `\` before the shape check runs (a
 * mixed-separator UNC form is still a UNC form once its separators agree). On Windows the one
 * allowed shape is a drive letter root (`C:\...`); a rooted path with no drive (`\foo`), any
 * path starting with two separators in any mix, an NT object prefix (`\??\`), and the `\\?\` /
 * `\\.\` device prefixes are all refused by simply not matching that shape, not by naming each
 * of them. On other platforms the one allowed shape is a path starting with exactly one `/`.
 * Returns the `vscode.Uri.file(...)` built from the checked, normalised value, so the same Uri
 * the shape check approved is what every caller passes on to stat, revealFileInOS, the editor
 * and the preview, never a second parse of the original string; returns null when the path is
 * refused, including when the Uri's authority is not empty (a `file://host/...` spelling that
 * reached this far through some other route would carry a host there).
 */
function safeLocalFileUri(resolved) {
  const isWindows = process.platform === 'win32';
  const normalized = isWindows ? path.win32.normalize(String(resolved || '')) : String(resolved || '');
  const shapeOk = isWindows ? /^[A-Za-z]:\\(?!\\)/.test(normalized) : /^\/(?!\/)/.test(normalized);
  if (!shapeOk) return null;
  const uri = vscode.Uri.file(normalized);
  if (uri.authority) return null;   // defence in depth: a Uri that still carries a host is refused too
  return uri;
}

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
    this.stepsService = createStepsService({
      resolveTranscript: (sessionId) => core.transcriptIndex().get(sessionId)
        || core.liveTranscripts(sessionId)[0] || core.stowedTranscripts(sessionId)[0] || null,
      sessionTitle: (sessionId) => this.stepsSessionTitle(sessionId),
      dataDir: core.DATA_DIR,
      rg: { probe: (appRoot) => core.rgProbe(appRoot), run: core.run, RG_BASE: core.RG_BASE, jsonEscaped: core.jsonEscaped },
      deliver: (sessionId, text, meta) => this.deliverToSession(sessionId, text, meta),
    });
    this.stepsPanels = new Map();   // sessionId -> panel, one per session (E9)
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
    // a replacer FUNCTION, never a plain replacement string: String.replace expands $-patterns
    // ($&, $', $`, $1...) in a string argument, so anything built from outside data has to go
    // in through a function's return value, inserted literally, not as that second argument.
    html = html.replace('<meta charset="utf-8">', () => '<meta charset="utf-8">' + csp);
    html = html.replace('<script>', () => '<script nonce="' + nonce + '">');
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
        case 'steps': if (core.UUID_RE.test(sid)) return await this.openSteps(sid); return;
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
    const live = ((this.last && this.last.sessions) || []).find((s) => s.sessionId === sessionId);
    if (live) return live;
    return ((this.last && this.last.ended) || []).find((s) => s.sessionId === sessionId) || null;
  }

  /** A session's title for the Steps panel and tab: the row's title when the session is live or
      ended (both carry Claude Code's own name), else read straight from its transcript (a
      session the board has not snapshotted yet, right after a reload). Never the 8-hex-id
      fallback here; that is the page's own last resort when this returns null too. */
  stepsSessionTitle(sessionId) {
    const row = this.sessionRow(sessionId);
    if (row && (row.title || row.name)) return row.title || row.name;
    const file = core.transcriptIndex().get(sessionId) || core.liveTranscripts(sessionId)[0] || core.stowedTranscripts(sessionId)[0];
    if (!file) return null;
    const facts = core.transcriptFacts(sessionId, file);
    return facts.customTitle || facts.title || null;
  }

  // -- opening ---------------------------------------------------------------------------

  /**
   * Open a session that lives in this window the way the user has Claude Code configured.
   * `claude-vscode.editor.open` honours claudeCode.preferredLocation only when its sixth
   * argument marks the call as programmatic; called bare it opens an editor tab and rewrites
   * the preference to "panel". `primaryEditor.open` is the fallback (always an editor tab).
   *
   * `prompt`, when given, is passed as the command's own second argument (B3: the Steps
   * viewer's "Send to session" hand-over). The call without a prompt keeps its exact six
   * arguments unchanged (a regression the host suite pins), since `undefined` and an omitted
   * argument are the same thing to `executeCommand` either way, but writing it out keeps that
   * guarantee visible in the source rather than resting on an engine detail.
   */
  async revealHere(sessionId, prompt) {
    const honour = { programmatic: 'honor-preferred-location' };
    try {
      if (prompt === undefined) {
        await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, undefined, undefined, undefined, honour);
      } else {
        await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, prompt, undefined, undefined, undefined, honour);
      }
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

  // -- B3: send to session (the steps-service "deliver" hand-over) -----------------------

  /**
   * The Claude Code extension version from which `claude-vscode.editor.open`'s prompt argument
   * is known to fill the chat box (the plan's spike, E13): below it, or when the extension is
   * missing altogether, hand-over is never attempted and the text goes to the clipboard plus
   * the existing open instead.
   */
  static get STEER_MIN_CLAUDE_VERSION() { return '2.1.322'; }

  /** Whether this window's own Claude Code extension is new enough for prompt hand-over. */
  claudeHandOverOk() {
    const ext = vscode.extensions.getExtension('anthropic.claude-code');
    const version = ext && ext.packageJSON && ext.packageJSON.version;
    return Boolean(version) && core.versionAtLeast(version, BoardProvider.STEER_MIN_CLAUDE_VERSION);
  }

  /** A stowed transcript is restored first, the way copyResume does, before anything else about
   *  the session (its window, whether it is running) is decided from it. */
  async restoreStowedForDeliver(sessionId) {
    if (!core.stowedTranscripts(sessionId).length) return;
    try {
      const r = await core.unarchiveSession(sessionId);
      this.log.info('unarchive ' + sessionId + ' (send to session)' + (r && r.restoredTo ? ': ' + r.restoredTo : ''));
    } catch (e) {
      this.log.warn('unarchive ' + sessionId + ' (send to session) failed: ' + String((e && e.message) || e));
    }
  }

  /**
   * B2's `deliver(sessionId, text, meta)`: the text always lands on the clipboard; whether it
   * also reaches the session's own chat box depends on where the session runs and whether this
   * window's Claude Code is new enough (E13, the spike's own finding that "fill" cannot be
   * guaranteed on an older or missing extension). Returns { ok, message } where message is
   * exactly the line steps.html shows under the note.
   *   - a terminal or background session (no VS Code window at all): clipboard only.
   *   - owned by this window: hand-over here when claudeHandOverOk(), else clipboard only.
   *   - owned by another window: a one-shot claim plus the board's own /steer route, when that
   *     window runs a board 0.12.0 or newer; otherwise clipboard only (that window's Claude
   *     Code version cannot be known from here, so the fallback is the same as "unknown").
   *   - not running: resumed by the same call (revealHere / the /steer hand-over both resume a
   *     session that is not alive, the way Claude Code's own editor.open already does).
   * `ok: true` only when the text reached a chat box, not merely the clipboard: noteSend/
   * notesSendAll record a "sent" mark on that signal, and clipboard-only is not a sent note.
   */
  async deliverToSession(sessionId, text, meta) {
    await this.restoreStowedForDeliver(sessionId);
    await vscode.env.clipboard.writeText(text);
    const clipboardOnly = (message) => ({ ok: false, message: message || 'On the clipboard. Paste it into the session.' });

    const row = this.sessionRow(sessionId);
    if (!row || !row.window) {
      this.log.info('send to session ' + sessionId + ' (' + (meta && meta.kind) + '): no VS Code window, clipboard only');
      return clipboardOnly();
    }
    const owner = await core.exthostForPid(Number(row.pid));
    if (owner === process.pid) {
      if (!this.claudeHandOverOk()) {
        this.log.info('send to session ' + sessionId + ': this window\'s Claude Code is below ' + BoardProvider.STEER_MIN_CLAUDE_VERSION + ', clipboard only');
        return clipboardOnly();
      }
      const revealed = await this.revealHere(sessionId, text);
      if (!revealed) return clipboardOnly();
      this.log.info('send to session ' + sessionId + ' (' + (meta && meta.kind) + '): delivered in this window');
      return { ok: true, message: 'In the chat box and on the clipboard.' };
    }
    const win = await core.windowForPid(Number(row.pid));
    if (!win) return clipboardOnly();
    const board = core.boardAlive(win.exthostPid);
    if (!board || !core.versionAtLeast(core.boardVersion(win.exthostPid), '0.12.0')) {
      this.log.info('send to session ' + sessionId + ': owning window has no current board, clipboard only');
      return clipboardOnly();
    }
    const claimId = core.writeSteerClaim(text);
    try {
      await core.steerToWindow(sessionId, win.windowId, board, claimId);
      this.log.info('send to session ' + sessionId + ' (' + (meta && meta.kind) + '): handed to window ' + win.windowId);
      return { ok: true, message: 'In the chat box and on the clipboard.' };
    } catch (e) {
      this.log.warn('send to session ' + sessionId + ' failed to reach window ' + win.windowId + ': ' + String((e && e.message) || e));
      return clipboardOnly();
    }
  }

  /**
   * The owning side of a /steer hand-over: takeSteerClaim both reads and deletes the claim in
   * one step, so a replayed or logged URI finds nothing the second time, and the text never
   * comes from anywhere but that claim (never the URL's own query string). A malformed id, a
   * missing claim or one past its 30-second window all simply do nothing, same as an /open on a
   * session this window no longer has.
   */
  async handleSteerUri(uri) {
    const params = new URLSearchParams(uri.query);
    const sessionId = params.get('session') || '';
    const claimId = params.get('note') || '';
    if (!core.UUID_RE.test(sessionId)) return;
    const text = core.takeSteerClaim(claimId);
    if (text === null) { this.log.warn('steer ' + sessionId + ': no fresh claim for this URI'); return; }
    await this.restoreStowedForDeliver(sessionId);
    if (!this.claudeHandOverOk()) { this.log.warn('steer ' + sessionId + ': this window\'s Claude Code is below ' + BoardProvider.STEER_MIN_CLAUDE_VERSION); return; }
    if (!(await this.revealHere(sessionId, text))) this.log.warn('steer ' + sessionId + ': could not reveal the session in this window');
  }

  /** vscode://<this extension id>/open?session=<id>, routed here by windowId. */
  async handleUri(uri) {
    this.log.info('uri ' + uri.toString(true));
    if (uri.path === '/rename') {
      const id = new URLSearchParams(uri.query).get('session') || '';
      if (core.UUID_RE.test(id)) await this.openClaudeRename(id);
      return;
    }
    if (uri.path === '/steer') { await this.handleSteerUri(uri); return; }
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

  // -- steps panel -------------------------------------------------------------------------

  /**
   * "Steps" on a row: one webview panel per session (asking again reveals it), titled
   * "Steps: <title>", wired so page messages reach stepsService.handle and service pushes
   * (follow, indexing progress) reach the panel. Everything the service holds for this
   * session (its index, its follow timer) is released once the panel is disposed and no
   * other subscriber is left.
   */
  async openSteps(sessionId) {
    const existing = this.stepsPanels.get(sessionId);
    if (existing) { existing.reveal(); return; }
    const title = this.stepsSessionTitle(sessionId) || sessionId.slice(0, 8);
    const panel = vscode.window.createWebviewPanel(
      'sessionBoard.steps', 'Steps: ' + title, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    this.stepsPanels.set(sessionId, panel);
    panel.webview.html = this.stepsHtml(panel.webview, sessionId);
    const unsubscribe = this.stepsService.subscribe(sessionId, (msg) => {
      try { panel.webview.postMessage(msg); } catch (_) { /* panel gone */ }
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      let reply;
      if (msg.type === 'openLink') reply = await this.openStepsLink(sessionId, msg.kind, String(msg.target || ''));
      else if (msg.type === 'openText') reply = await this.openStepsText(String(msg.title || ''), String(msg.text || ''));
      else reply = await this.stepsService.handle(Object.assign({}, msg, { sessionId }));
      try { panel.webview.postMessage(reply); } catch (_) { /* panel gone */ }
    });
    panel.onDidDispose(() => {
      unsubscribe();
      this.stepsPanels.delete(sessionId);
      this.stepsService.handle({ type: 'close', sessionId }).catch(() => { /* best effort */ });
    });
  }

  /** Until extension/steps.html exists, a one-line placeholder loads in its place, through the
   *  same CSP and nonce approach as the board page; the session id rides in its own meta tag,
   *  the way index.html's board-token does, since the panel's postMessage channel carries only
   *  the host's own replies, never an initial value the page can read before its first send. */
  stepsHtml(webview, sessionId) {
    const stepsHtmlPath = path.join(this.context.extensionPath, 'steps.html');
    let html;
    try {
      html = fs.readFileSync(stepsHtmlPath, 'utf8');
    } catch (_) {
      html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
        + '<body style="font-family: sans-serif; padding: 2em;">Steps viewer coming soon.</body></html>';
    }
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
      + 'style-src ' + webview.cspSource + ' \'unsafe-inline\'; '
      + 'script-src \'nonce-' + nonce + '\';">';
    // sessionId is the board's own session id (already checked against core.UUID_RE before
    // openSteps is ever called), but it is escaped and inserted through a replacer function
    // all the same: a session id is still a value from outside this function's own control,
    // and a plain replacement string would expand any $-pattern it happened to carry.
    const sessionMeta = '<meta name="steps-session" content="' + escapeAttr(sessionId) + '">';
    const headMeta = '<meta charset="utf-8">' + csp + sessionMeta;
    html = html.replace('<meta charset="utf-8">', () => headMeta);
    html = html.replace('<script>', () => '<script nonce="' + nonce + '">');
    return html;
  }

  /**
   * A link clicked in the Steps viewer. `kind: 'url'` opens only http and https with
   * openExternal; anything else is refused rather than handed to the OS. `kind: 'path'` is
   * resolved (absolute as given, `~` against the home directory, relative against the
   * session's own working directory from the board's last snapshot when one is known), checked
   * by `safeLocalFileUri` and, once that passes, `stat`-ed through the one `Uri` the check
   * built: a folder is revealed in the OS file explorer, a file opens in an editor tab (a `.md`
   * file with the Markdown preview instead), and a trailing `:line` or `#Lline` moves the
   * cursor there. A path that does not exist, or that resolves outside anything the stat call
   * can read, answers with a plain message the page shows; nothing here ever executes a file or
   * passes a path to openExternal.
   *
   * A path is untrusted transcript text, not something the user typed, so it is resolved and
   * shape-checked before anything touches it: `safeLocalFileUri` only allows a path rooted at a
   * drive letter (Windows) or a single leading separator (elsewhere), which rules out every
   * network form (UNC, mixed separators, an NT object path, either device prefix, or a value
   * carrying its own URI scheme) by construction rather than by naming each one. Stat-ing a
   * network path makes Windows contact the named host to authenticate, which can leak the
   * user's NTLM credentials just because some text in a transcript looked like a path, so a
   * refused path is never passed to `stat` at all. A path outside the session's own working
   * directory, the open workspace folders and the home directory still opens, but only after
   * asking once, since it is still a local path a legitimate link could reasonably point
   * outside those (a `cd`'d-to build folder, say); only the network case has no way to proceed.
   */
  async openStepsLink(sessionId, kind, target) {
    if (kind === 'url') {
      if (!/^https?:\/\//i.test(target)) return { type: 'openLinkResult', ok: false, message: 'that link is not web or not openable here' };
      try { await vscode.env.openExternal(vscode.Uri.parse(target)); return { type: 'openLinkResult', ok: true }; }
      catch (e) { return { type: 'openLinkResult', ok: false, message: String((e && e.message) || e) }; }
    }
    if (kind !== 'path') return { type: 'openLinkResult', ok: false, message: 'unknown link kind' };
    const m = /^(.*?)(?::(\d+)|#L(\d+))$/.exec(target);
    const rawPath = m ? m[1] : target;
    const line = m ? Number(m[2] || m[3]) : null;
    // A value carrying its own URI scheme (file://host/..., or any other scheme://...) is
    // refused on the raw text, before resolveStepsPath gets a chance to fold it into a
    // relative path fragment under some trusted base, where it would read as harmless (nested
    // under the session's own working directory, say) even though the author meant it as an
    // absolute reference to somewhere else entirely; the resolved form is checked again below
    // regardless, since a relative path or one with `..` segments must not reach a network
    // path either.
    // At least two characters before the "://": a single letter there is a Windows drive
    // (`C://dir` is `C:/dir` with a doubled separator, still a plain local path), never a URI
    // scheme in practice, so requiring two characters tells the two apart without a drive
    // letter list of its own.
    if (/^[A-Za-z][A-Za-z0-9+.-]{1,}:\/\//.test(rawPath)) return this.refuseNetworkPath(rawPath);
    const resolved = this.resolveStepsPath(sessionId, rawPath);
    const uri = safeLocalFileUri(resolved);
    if (!uri) return this.refuseNetworkPath(resolved);
    if (!this.isStepsPathTrusted(sessionId, uri.fsPath)) {
      const choice = await vscode.window.showWarningMessage('Open ' + uri.fsPath + '?', { modal: true }, 'Open');
      if (choice !== 'Open') return { type: 'openLinkResult', ok: false, message: 'cancelled' };
    }
    let stat;
    try { stat = await vscode.workspace.fs.stat(uri); }
    catch (_) { return { type: 'openLinkResult', ok: false, message: 'that path does not exist: ' + uri.fsPath }; }
    try {
      if (stat.type === vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealFileInOS', uri);
        return { type: 'openLinkResult', ok: true };
      }
      if (/\.md$/i.test(uri.fsPath)) {
        await vscode.commands.executeCommand('markdown.showPreview', uri);
        return { type: 'openLinkResult', ok: true };
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      if (line && editor && editor.selection !== undefined) {
        // best-effort cursor placement; a fake editor in a test has no selection API to call.
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        if (editor.revealRange) editor.revealRange(new vscode.Range(pos, pos));
      }
      return { type: 'openLinkResult', ok: true };
    } catch (e) {
      return { type: 'openLinkResult', ok: false, message: String((e && e.message) || e) };
    }
  }

  /** A network path is refused outright, never stat-ed or opened; the page copies it instead. */
  async refuseNetworkPath(p) {
    await vscode.env.clipboard.writeText(p);
    return { type: 'openLinkResult', ok: false, message: 'Network paths are not opened from here. The path is on the clipboard.' };
  }

  /** True when `resolved` sits inside the session's own working directory, an open workspace
   *  folder, or the home directory: the roots a link can open without asking first. */
  isStepsPathTrusted(sessionId, resolved) {
    const row = this.sessionRow(sessionId);
    const roots = [];
    if (row && row.cwd) roots.push(row.cwd);
    for (const f of vscode.workspace.workspaceFolders || []) if (f && f.uri && f.uri.fsPath) roots.push(f.uri.fsPath);
    roots.push(require('os').homedir());
    return roots.some((root) => core.isInside(resolved, root) || path.resolve(resolved) === path.resolve(root));
  }

  /** Absolute as given, `~` against the home directory, else relative against the session's
   *  own working directory from the board's last snapshot (when known; otherwise unresolved,
   *  which the later stat call then simply fails on). */
  resolveStepsPath(sessionId, rawPath) {
    if (path.isAbsolute(rawPath)) return rawPath;
    if (rawPath === '~' || rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
      return path.join(require('os').homedir(), rawPath.slice(1));
    }
    const row = this.sessionRow(sessionId);
    const base = row && row.cwd ? row.cwd : null;
    return base ? path.resolve(base, rawPath) : rawPath;
  }

  /** openText { title, text }: an untitled document, the host side of "Open full text in an
   *  editor tab" for a truncated body. */
  async openStepsText(title, text) {
    try {
      const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
      await vscode.window.showTextDocument(doc);
      return { type: 'openTextResult', ok: true };
    } catch (e) {
      return { type: 'openTextResult', ok: false, message: String((e && e.message) || e) };
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
