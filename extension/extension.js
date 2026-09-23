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

const VIEW_ID = 'sessionBoard.view';
const POLL_VISIBLE_MS = 5000;
const POLL_HIDDEN_MS = 15000;

class BoardProvider {
  constructor(context, log) {
    this.context = context;
    this.log = log;
    this.view = null;
    this.last = null;
    this.timer = null;
    this.stopped = false;
    this.prevWaiting = new Set();
    this.primed = false;
    this.inFlight = false;     // one snapshot at a time; a request during one queues one follow-up
    this.queued = false;
    this.seq = 0;
    this.searchAbort = null;   // AbortController of the latest search
    this.searchRequestId = null;
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
      switch (m.type) {
        case 'refresh': return this.refresh();
        case 'open': if (core.UUID_RE.test(sid)) return this.openSession(sid); return;
        case 'copy': if (core.UUID_RE.test(sid)) return this.copyResume(sid); return;
        case 'end': if (core.UUID_RE.test(sid)) return this.endSession(sid, Boolean(m.force)); return;
        case 'search': return this.search(String(m.query || ''), Boolean(m.content), String(m.requestId || ''));
        case 'cancelSearch': return this.cancelSearch();
        case 'openPast': if (core.UUID_RE.test(sid)) return this.openPast(sid, String(m.path || ''), String(m.cwd || '')); return;
        default: return;
      }
    } catch (e) {
      this.log.error('message ' + m.type + ' failed: ' + String((e && e.message) || e));
    }
  }

  async copyResume(sid) {
    await vscode.env.clipboard.writeText('claude --resume ' + sid);
    vscode.window.setStatusBarMessage('Copied: claude --resume ' + sid, 3000);
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
    core.writeHeartbeat(process.pid, (this.context.extension && this.context.extension.id) || core.EXTENSION_ID);
    try {
      const snap = await core.snapshot();
      if (mySeq === this.seq) {          // an older result never overwrites a newer one
        this.last = snap;
        this.push();
        this.updateBadge();
        this.notifyNewlyWaiting();
      }
    } catch (e) {
      this.log.error('poll failed: ' + String((e && e.message) || e));
    } finally {
      this.inFlight = false;
    }
    const visible = Boolean(this.view && this.view.visible);
    if (this.queued) { this.queued = false; this.schedule(200); } else this.schedule(visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
  }

  updateBadge() {
    if (!this.view || !this.last) return;
    const waiting = this.last.sessions.filter((s) => s.status === 'waiting').length;
    this.view.badge = waiting
      ? { value: waiting, tooltip: waiting + ' Claude Code session' + (waiting === 1 ? '' : 's') + ' need input' }
      : undefined;
  }

  /** Toast on a new waiting session; only the focused window speaks, the badge counts everywhere. */
  notifyNewlyWaiting() {
    if (!this.last) return;
    const now = new Set();
    const fresh = [];
    for (const s of this.last.sessions) {
      if (s.status !== 'waiting') continue;
      now.add(s.sessionId);
      if (this.primed && !this.prevWaiting.has(s.sessionId)) fresh.push(s);
    }
    this.prevWaiting = now;
    this.primed = true;
    if (!vscode.window.state.focused) return;
    for (const s of fresh) {
      vscode.window.showWarningMessage((s.title || s.name) + ': ' + (s.waitingFor || 'needs input'), 'Open')
        .then((choice) => { if (choice === 'Open') this.openSession(s.sessionId); });
    }
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
    if (uri.path !== '/open') return;
    const sessionId = new URLSearchParams(uri.query).get('session') || '';
    if (!core.UUID_RE.test(sessionId)) return;
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

  /** A past session: resume in place when its folder is in this window, otherwise hand over. */
  async openPast(sessionId, transcriptPath, cwd) {
    if (transcriptPath && !fs.existsSync(transcriptPath)) {
      this.post({ type: 'openResult', sessionId, ok: false, message: 'transcript no longer exists' });
      return;
    }
    const liveRow = this.sessionRow(sessionId);
    if (liveRow && core.pidAlive(liveRow.pid)) return this.openSession(sessionId);

    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const here = cwd && folders.some((f) => core.isInside(cwd, f));
    if (here) {
      this.log.info('openPast ' + sessionId + ': resuming in this window');
      if (await this.revealHere(sessionId)) { this.post({ type: 'openResult', sessionId, ok: true }); return; }
    }
    await this.copyResume(sessionId);
    this.post({ type: 'openResult', sessionId, ok: false, message: 'copied resume command' });
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

  async endSession(sessionId, force) {
    const row = this.sessionRow(sessionId);
    const label = row ? (row.title || row.name) : sessionId.slice(0, 8);
    let result = await core.endSession(sessionId, { force });
    if (result.code === 'needs-force') {
      const choice = await vscode.window.showWarningMessage(
        label + ' is ' + result.status + '. End it and everything it started? In-flight work is lost.',
        { modal: true }, 'End session');
      if (choice !== 'End session') {
        this.post({ type: 'endResult', sessionId, ok: false, code: 'cancelled', message: 'cancelled' });
        return;
      }
      result = await core.endSession(sessionId, { force: true });
    }
    this.log.info('end ' + sessionId + ': ' + result.code + (result.message ? ' (' + result.message + ')' : ''));
    this.post({ type: 'endResult', sessionId, ok: result.ok, code: result.code, message: result.message || '' });
    if (result.ok) vscode.window.setStatusBarMessage('Ended: ' + label, 3000);
    else if (result.code !== 'cancelled') vscode.window.showWarningMessage('Could not end ' + label + ': ' + (result.message || result.code));
    this.schedule(300);
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
    rows.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
    const items = rows.map((s) => ({
      label: (s.status === 'waiting' ? '$(warning) ' : s.status === 'busy' ? '$(sync~spin) ' : '') + (s.title || s.name),
      description: s.status === 'waiting' ? (s.waitingFor || 'waiting') : s.status,
      detail: (s.window && s.window.label ? s.window.label + ' · ' : '') + s.cwd,
      sessionId: s.sessionId,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open a Claude Code session', matchOnDetail: true });
    if (pick) await this.openSession(pick.sessionId);
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
    vscode.window.registerUriHandler({ handleUri: (uri) => provider.handleUri(uri) }),
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
