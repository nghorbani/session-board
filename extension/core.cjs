'use strict';
/**
 * Data layer for Session Board.
 *
 * Live sessions come from `claude agents --json` (the built-in agent view renders only
 * background sessions, but the JSON lists every one). Each row is enriched with transcript
 * facts (context tokens, title, last prompt) and the VS Code window it runs in; sessions
 * can be jumped to, ended, and searched across every transcript on disk. Shared by
 * server.cjs (browser page) and extension.js (VS Code sidebar).
 *
 * Windows first: the window mapping (Win32_Process + VS Code's exthost.log) and ending a
 * session (taskkill) are Windows-only; listing, titles, tokens and search work anywhere
 * ripgrep and the claude CLI exist.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PKG = require('./package.json');
const EXTENSION_ID = PKG.publisher + '.' + PKG.name;

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const CODE_LOGS_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'logs');
const VSCODE_EXTENSIONS_JSON = path.join(os.homedir(), '.vscode', 'extensions', 'extensions.json');

const TAIL_BYTES = 512 * 1024;       // context-guard reads the same window
const TITLE_TAIL_BYTES = 256 * 1024; // ai-title / last-prompt lines sit near the end
const AGENTS_TIMEOUT_MS = 20000;
const INDEX_TTL_MS = 60000;          // live-row transcript filename index refresh
const PROCESS_TREE_MIN_INTERVAL_MS = 10000;
const INSTALLED_TTL_MS = 60000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;
const IS_WINDOWS = process.platform === 'win32';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Child processes must not look like nested Claude sessions. */
function strippedEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_')) continue;
    env[k] = v;
  }
  return env;
}

/** execFile as a promise that never throws: { code, stdout, stderr, timedOut, killed }. */
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, Object.assign({
      env: strippedEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
    }, opts || {}), (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '') + (err && typeof err.code !== 'number' ? ' ' + String(err.message || err) : ''),
        timedOut: Boolean(err && err.killed && err.signal === 'SIGTERM' && opts && opts.timeout),
        killed: Boolean(err && err.killed),
        child,
      });
    });
    if (opts && opts.onChild) opts.onChild(child);
  });
}

// ---------------------------------------------------------------------------------------
// Transcript facts for live rows
// ---------------------------------------------------------------------------------------

function readTail(file, bytes) {
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return null; }
  if (!stat.isFile() || stat.size === 0) return null;
  const start = Math.max(0, stat.size - bytes);
  const length = stat.size - start;
  let fd = null;
  try {
    const buf = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, length, start);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1); // drop the partial first line
    }
    return text;
  } catch (_) {
    return null;                                  // a failure after stat costs one row, not the poll
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

/**
 * Live context size: input + cache_creation + cache_read tokens of the last assistant
 * message in the transcript, read from the file tail only. null when unknown.
 * Lifted from ~/.claude/hooks/context-guard/context-guard.cjs; zero-usage trailers skipped.
 */
function contextTokens(transcriptPath) {
  const text = readTail(transcriptPath, TAIL_BYTES);
  if (text == null) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"usage"') === -1) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (!obj || obj.type !== 'assistant') continue;
    const usage = obj.message && obj.message.usage;
    if (!usage || typeof usage !== 'object') continue;
    const total = num(usage.input_tokens)
      + num(usage.cache_creation_input_tokens)
      + num(usage.cache_read_input_tokens);
    if (total > 0) return total;
  }
  return null;
}

/**
 * Claude Code's generated title (`ai-title` lines), the name set with /rename
 * (`custom-title` lines, re-emitted per turn like the generated one) and the last prompt;
 * newest of each wins.
 */
function titleFromTranscript(transcriptPath) {
  const text = readTail(transcriptPath, TITLE_TAIL_BYTES);
  if (text == null) return { title: null, customTitle: null, lastPrompt: null };
  const lines = text.split('\n');
  let title = null;
  let customTitle = null;
  let lastPrompt = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (!title && line.indexOf('"ai-title"') !== -1) {
      try { const o = JSON.parse(line); if (o && o.aiTitle) title = String(o.aiTitle); } catch (_) { /* skip */ }
    }
    if (!customTitle && line.indexOf('"custom-title"') !== -1) {
      try { const o = JSON.parse(line); if (o && o.customTitle) customTitle = String(o.customTitle); } catch (_) { /* skip */ }
    }
    if (!lastPrompt && line.indexOf('"last-prompt"') !== -1) {
      try {
        const o = JSON.parse(line);
        if (o && o.lastPrompt) lastPrompt = String(o.lastPrompt).replace(/\s+/g, ' ').trim();
      } catch (_) { /* skip */ }
    }
    if (title && customTitle && lastPrompt) break;
  }
  return { title, customTitle, lastPrompt };
}

/**
 * sessionId -> transcript path for live rows. Deriving the path from a session's cwd
 * matches only two thirds of sessions (drive-letter case and path mangling differ);
 * transcripts are named for their session id, so index by filename.
 */
let indexCache = { at: 0, map: new Map() };

function transcriptIndex() {
  if (Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.map;
  const map = new Map();
  for (const file of listTranscripts()) {
    const id = path.basename(file.path, '.jsonl');
    if (!map.has(id)) map.set(id, file.path);
  }
  indexCache = { at: Date.now(), map };
  return map;
}

/** Top-level transcripts only; subagent transcripts live one level deeper. */
function listTranscripts() {
  const out = [];
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => path.join(PROJECTS_DIR, d.name));
  } catch (_) { return out; }
  for (const dir of projectDirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }   // deleted or unreadable: skipped
      if (!st.isFile()) continue;
      out.push({ path: full, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

const factsCache = new Map(); // sessionId -> { key, tokens, title, lastPrompt }

function transcriptFacts(sessionId, file) {
  const empty = { tokens: null, title: null, customTitle: null, lastPrompt: null };
  if (!file) return empty;
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return empty; }
  const key = stat.size + ':' + stat.mtimeMs;
  const hit = factsCache.get(sessionId);
  if (hit && hit.key === key) return hit;
  const tokens = contextTokens(file);
  const { title, customTitle, lastPrompt } = titleFromTranscript(file);
  const facts = { key, tokens, title, customTitle, lastPrompt };
  factsCache.set(sessionId, facts);
  return facts;
}

/**
 * Context marks. The compaction window comes from the user's settings.json; without it
 * there is no percentage, only a token count. The save mark comes from the context-guard
 * hook's env var or defaults to 92% of the compaction window.
 */
function thresholds() {
  let compact = null;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
    const v = Number(settings.autoCompactWindow);
    if (Number.isFinite(v) && v > 0) compact = v;
  } catch (_) { /* no settings */ }
  const fromEnv = Number(process.env.CONTEXT_GUARD_THRESHOLD_TOKENS);
  const save = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : (compact ? Math.round(compact * 0.92) : null);
  return { compact, save };
}

/** One session-registry record (`~/.claude/sessions/<pid>.json`) or null. */
function readRegistry(pid) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, pid + '.json'), 'utf8'));
    return rec && typeof rec === 'object' ? rec : null;
  } catch (_) {
    return null;
  }
}

function registryTimes() {
  const byId = new Map();
  let names = [];
  try { names = fs.readdirSync(SESSIONS_DIR); } catch (_) { return byId; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'));
      if (rec && rec.sessionId) {
        byId.set(rec.sessionId, {
          statusUpdatedAt: Number(rec.statusUpdatedAt) || Number(rec.updatedAt) || null,
          name: rec.name ? String(rec.name) : null,
          nameSource: rec.nameSource ? String(rec.nameSource) : null,   // "user" after /rename, else "derived"
        });
      }
    } catch (_) { /* skip unreadable record */ }
  }
  return byId;
}

// ---------------------------------------------------------------------------------------
// Session -> VS Code window
// ---------------------------------------------------------------------------------------

/**
 * A session's claude.exe is a child of its window's extension host, and VS Code logs each
 * window's extension-host pid under logs/<run>/window<N>/exthost/exthost.log. VS Code routes
 * a vscode:// URI to a specific window when the query carries windowId=<N>, and the handling
 * window force-focuses itself, so the whole jump is one `code --open-url` call.
 */
const parentByPid = new Map();      // claude.exe pid -> parent pid, evicted when the pid is gone
let exthostPids = new Set();
let windowByExthost = new Map();
let processTreeAt = 0;

async function runPowerShell(script, timeout) {
  if (!IS_WINDOWS) return { code: -1, stdout: '', stderr: 'PowerShell is Windows-only' };
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeout || 20000 });
}

async function refreshProcessTree() {
  processTreeAt = Date.now();
  const r = await runPowerShell(
    "$c = Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
    'Select-Object ProcessId, ParentProcessId; ' +
    "$e = Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*node.mojom.NodeService*' } | " +
    'Select-Object -ExpandProperty ProcessId; ' +
    '@{ claude = @($c); exthost = @($e) } | ConvertTo-Json -Compress -Depth 3');
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'process tree query failed');
  const tree = JSON.parse(r.stdout);
  const seen = new Set();
  for (const row of tree.claude || []) {
    if (row && row.ProcessId) {
      parentByPid.set(Number(row.ProcessId), Number(row.ParentProcessId));
      seen.add(Number(row.ProcessId));
    }
  }
  for (const pid of [...parentByPid.keys()]) if (!seen.has(pid)) parentByPid.delete(pid); // pid reuse guard
  exthostPids = new Set((tree.exthost || []).map(Number));
}

function refreshWindowLog() {
  windowByExthost = new Map();
  let runs;
  try { runs = fs.readdirSync(CODE_LOGS_DIR).sort().reverse(); } catch (_) { return; }
  for (const runName of runs) {
    const runDir = path.join(CODE_LOGS_DIR, runName);
    let entries;
    try { entries = fs.readdirSync(runDir).filter((n) => /^window\d+$/.test(n)); } catch (_) { continue; }
    if (!entries.length) continue;               // CLI-only runs have no window dirs
    for (const name of entries) {
      let text;
      try { text = fs.readFileSync(path.join(runDir, name, 'exthost', 'exthost.log'), 'utf8'); } catch (_) { continue; }
      const win = Number(name.slice('window'.length));
      const re = /Extension host with pid (\d+) started/g;
      let m;
      while ((m = re.exec(text)) !== null) windowByExthost.set(Number(m[1]), win);
    }
    return;                                      // newest run with windows is the live instance
  }
}

/** The extension-host pid that owns a session process, or null. */
async function exthostForPid(pid) {
  if (!pid || !IS_WINDOWS) return null;
  const known = parentByPid.get(pid);
  const stale = known !== undefined && !exthostPids.has(known) && !parentByPid.has(known);
  if ((!parentByPid.has(pid) || stale) && Date.now() - processTreeAt > PROCESS_TREE_MIN_INTERVAL_MS) {
    try { await refreshProcessTree(); } catch (_) { return null; }
  }
  let cur = pid;
  for (let hops = 0; hops < 6; hops++) {           // subagents hang off another claude.exe
    const parent = parentByPid.get(cur);
    if (!parent) return null;
    if (exthostPids.has(parent)) return parent;
    cur = parent;
  }
  return null;
}

async function windowForPid(pid) {
  const exthost = await exthostForPid(pid);
  if (!exthost) return null;
  if (!windowByExthost.has(exthost)) refreshWindowLog();
  const windowId = windowByExthost.get(exthost);
  return windowId ? { windowId, exthostPid: exthost } : null;
}

// ---------------------------------------------------------------------------------------
// Board heartbeats: which windows run this extension, under which id
// ---------------------------------------------------------------------------------------

const HEARTBEAT_DIR = path.join(os.tmpdir(), 'claude-sessions-board');
const HEARTBEAT_FRESH_MS = 45000;

function writeHeartbeat(exthostPid, extensionId) {
  const id = EXTENSION_ID_RE.test(String(extensionId || '')) ? extensionId : EXTENSION_ID;
  try {
    fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
    const target = path.join(HEARTBEAT_DIR, 'board-' + exthostPid + '-' + id + '.json');
    const tmp = target + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ pid: exthostPid, at: Date.now(), id }));
    fs.renameSync(tmp, target);
  } catch (_) { /* best effort */ }
}

let installedCache = { at: 0, ids: null };

/** Ids VS Code lists as installed; a retired id still running until reload is not one. */
function installedExtensionIds() {
  if (Date.now() - installedCache.at < INSTALLED_TTL_MS && installedCache.ids) return installedCache.ids;
  const ids = new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(VSCODE_EXTENSIONS_JSON, 'utf8'));
    for (const e of arr || []) {
      const id = e && e.identifier && e.identifier.id;
      if (id) ids.add(String(id).toLowerCase());
    }
  } catch (_) { /* unreadable: treat every id as installed */ installedCache = { at: Date.now(), ids: null }; return null; }
  installedCache = { at: Date.now(), ids };
  return ids;
}

/** The extension id of the freshest installed board in that window, or null. */
function boardAlive(exthostPid) {
  let names = [];
  try { names = fs.readdirSync(HEARTBEAT_DIR); } catch (_) { return null; }
  const prefix = 'board-' + exthostPid + '-';
  const installed = installedExtensionIds();
  let best = null;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(HEARTBEAT_DIR, name), 'utf8'));
      const id = String(rec.id || '');
      if (!EXTENSION_ID_RE.test(id)) continue;
      if (Date.now() - Number(rec.at) >= HEARTBEAT_FRESH_MS) continue;
      if (installed && !installed.has(id.toLowerCase())) continue;
      if (!best || Number(rec.at) > best.at) best = { id, at: Number(rec.at) };
    } catch (_) { /* skip */ }
  }
  return best ? best.id : null;
}

// ---------------------------------------------------------------------------------------
// Usage limits, via Claude Code's status line
// ---------------------------------------------------------------------------------------
//
// Claude Code reports the subscription usage windows (`rate_limits`: five_hour, seven_day,
// spend_limit; each `used_percentage` and `resets_at`) only to the configured status line
// command, on stdin, after every reply. Session Board ships a small status line script that
// prints a one-line footer for the session and writes the latest limits to USAGE_FILE; the
// board reads that file. The user adds the status line to ~/.claude/settings.json themselves
// (Connect copies the snippet and opens the file); the board never edits settings.json. No
// credentials are read and nothing leaves the machine.

const DATA_DIR = IS_WINDOWS
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SessionBoard')
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'session-board');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const STATUSLINE_NAME = IS_WINDOWS ? 'statusline.ps1' : 'statusline.sh';
const STATUSLINE_SCRIPT = path.join(DATA_DIR, STATUSLINE_NAME);
const STATUSLINE_SOURCE = path.join(__dirname, 'statusline', STATUSLINE_NAME);
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');

/** The settings.json command line; forward slashes because Claude Code may run it via Git Bash. */
function statusLineCommand() {
  const p = STATUSLINE_SCRIPT.replace(/\\/g, '/');
  return IS_WINDOWS ? 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + p + '"' : 'bash "' + p + '"';
}

/** The `statusLine` entry as text to paste inside the top-level object of settings.json. */
function statusLineSnippet() {
  return '"statusLine": ' + JSON.stringify({ type: 'command', command: statusLineCommand() }, null, 2);
}

/** Read-only look at the user settings: is a status line set, and is it ours? */
function statusLineState(settingsPath) {
  let raw;
  try { raw = fs.readFileSync(settingsPath || SETTINGS_FILE, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { installed: false, ours: false, command: null, error: null };
    return { installed: null, ours: false, command: null, error: String(e.message || e) };
  }
  let settings;
  try { settings = JSON.parse(raw); } catch (e) {
    return { installed: null, ours: false, command: null, error: 'settings.json is not plain JSON (' + String(e.message || e) + ')' };
  }
  const sl = settings && typeof settings === 'object' ? settings.statusLine : null;
  const cmd = sl && typeof sl === 'object' ? String(sl.command || '') : '';
  const mine = STATUSLINE_SCRIPT.replace(/\\/g, '/').toLowerCase();
  const ours = Boolean(cmd) && cmd.replace(/\\/g, '/').toLowerCase().includes(mine);
  return { installed: Boolean(sl), ours, command: cmd || null, error: null };
}

/** Copy the packaged script to its stable path when it is missing or outdated. */
function refreshStatusLineScript() {
  try {
    const src = fs.readFileSync(STATUSLINE_SOURCE);
    let cur = null;
    try { cur = fs.readFileSync(STATUSLINE_SCRIPT); } catch (_) { /* not copied yet */ }
    if (cur && cur.equals(src)) return { updated: false, path: STATUSLINE_SCRIPT };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(STATUSLINE_SOURCE, STATUSLINE_SCRIPT);
    return { updated: true, path: STATUSLINE_SCRIPT };
  } catch (e) {
    return { updated: false, path: STATUSLINE_SCRIPT, error: String(e.message || e) };
  }
}

/** Everything Connect needs: the script in place and the snippet the user pastes. */
function statusLineSetup() {
  const copied = refreshStatusLineScript();
  return {
    ok: !copied.error,
    code: copied.error ? 'script-copy-failed' : 'ready',
    message: copied.error || null,
    script: STATUSLINE_SCRIPT,
    command: statusLineCommand(),
    snippet: statusLineSnippet(),
    settingsPath: SETTINGS_FILE,
    state: statusLineState(),
  };
}

/**
 * What the board shows at the top. `state`: not-connected (no status line), other-statusline
 * (a foreign one), settings-unreadable, waiting (ours, never ran), no-limits (ran, Claude
 * Code reported none), ok (windows present). `windows.*.resetsAt` is epoch ms.
 */
function usageState(settingsPath) {
  const sl = statusLineState(settingsPath);
  let file = null;
  try { file = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch (_) { file = null; }
  const out = { statusLine: sl, at: null, ageSeconds: null, model: null, sessionId: null, windows: null, file: USAGE_FILE, dataDir: DATA_DIR };
  if (file && typeof file === 'object') {
    const at = Number(file.at) || null;
    out.at = at;
    out.ageSeconds = at ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null;
    out.model = file.model ? String(file.model) : null;
    out.sessionId = file.session_id ? String(file.session_id) : null;
    const rl = file.rate_limits;
    if (rl && typeof rl === 'object') {
      out.windows = {};
      for (const k of ['five_hour', 'seven_day', 'spend_limit']) {
        const w = rl[k];
        if (!w || typeof w !== 'object') continue;
        const pct = Number(w.used_percentage);
        const resets = Number(w.resets_at);
        const resetsAt = Number.isFinite(resets) && resets > 0 ? resets * 1000 : null;
        out.windows[k] = { usedPct: Number.isFinite(pct) ? pct : null, resetsAt, expired: Boolean(resetsAt && resetsAt <= Date.now()) };
      }
      if (!Object.keys(out.windows).length) out.windows = null;
    }
  }
  out.state = sl.error ? 'settings-unreadable'
    : !sl.installed ? 'not-connected'
    : !sl.ours ? 'other-statusline'
    : !file ? 'waiting'
    : !out.windows ? 'no-limits'
    : 'ok';
  return out;
}

function safeUsage() {
  try { return usageState(); } catch (_) { return null; }
}

/** Bring the session's VS Code window forward on that session. */
function focusSession(sessionId, windowId, opts) {
  return new Promise((resolve, reject) => {
    if (!UUID_RE.test(String(sessionId)) || !Number.isInteger(windowId)) {
      return reject(new Error('refusing to build a URI from unchecked input'));
    }
    const viaBoard = opts && opts.viaBoard;
    const authority = typeof viaBoard === 'string' && EXTENSION_ID_RE.test(viaBoard) ? viaBoard : 'anthropic.claude-code';
    const target = 'vscode://' + authority + '/open?session=' + sessionId + '&windowId=' + windowId;
    // shell: true is required to run code.cmd; the quotes keep cmd.exe from reading `&`.
    execFile('code', ['--open-url', '"' + target + '"'], {
      env: strippedEnv(), timeout: 15000, windowsHide: true, shell: true,
    }, (err) => (err ? reject(err) : resolve(target)));
  });
}

// ---------------------------------------------------------------------------------------
// Snapshot of live sessions
// ---------------------------------------------------------------------------------------

function validRow(r) {
  return r && typeof r === 'object'
    && typeof r.sessionId === 'string' && r.sessionId.length > 0
    && Number.isInteger(Number(r.pid)) && Number(r.pid) > 0
    && typeof r.status === 'string';
}

function fetchAgents() {
  return new Promise((resolve, reject) => {
    execFile('claude', ['agents', '--json'], {
      env: strippedEnv(), timeout: AGENTS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      windowsHide: true, shell: IS_WINDOWS,       // resolve claude.cmd/.exe off PATH
    }, (err, stdout) => {
      if (err) return reject(new Error('claude agents --json failed: ' + String(err.message || err).split('\n')[0]));
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (e) { return reject(new Error('claude agents --json returned no JSON')); }
      if (!Array.isArray(parsed) || !parsed.every(validRow)) {
        return reject(new Error("Claude Code's session output changed; update Session Board"));
      }
      resolve(parsed);
    });
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

let lastGood = null;      // last rows from the CLI, survives a failed poll
let lastSnapshot = null;  // last enriched snapshot, used by search for the live union

function lastGoodRows() { return (lastGood && lastGood.rows) || []; }
function lastSnapshotRows() { return (lastSnapshot && lastSnapshot.sessions) || []; }

async function snapshot() {
  const limits = thresholds();
  let rows;
  let stale = false;
  let error = null;
  try {
    rows = await fetchAgents();
  } catch (e) {
    if (!lastGood) {
      return { at: Date.now(), stale: true, error: String(e.message || e), limits, platform: process.platform, sessions: [], usage: safeUsage() };
    }
    rows = lastGood.rows;
    stale = true;
    error = String(e.message || e);
  }
  rows = rows.filter((r) => pidAlive(Number(r.pid)));   // a killed session may leave a registry row briefly

  const index = transcriptIndex();
  const times = registryTimes();
  const now = Date.now();

  const windows = new Map();
  for (const r of rows) {
    const w = await windowForPid(Number(r.pid));
    if (w) windows.set(r.sessionId, w);
  }
  const labelVotes = new Map();
  for (const r of rows) {
    const w = windows.get(r.sessionId);
    if (!w || !r.cwd) continue;
    const base = String(r.cwd).split(/[\\/]/).filter(Boolean).pop() || r.cwd;
    const votes = labelVotes.get(w.windowId) || new Map();
    votes.set(base, (votes.get(base) || 0) + 1);
    labelVotes.set(w.windowId, votes);
  }
  const windowLabel = new Map();
  for (const [win, votes] of labelVotes) windowLabel.set(win, [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0]);

  const sessions = rows.map((r) => {
    const file = index.get(r.sessionId) || null;
    const facts = transcriptFacts(r.sessionId, file);
    const t = times.get(r.sessionId) || {};
    const changedAt = t.statusUpdatedAt || null;
    const w = windows.get(r.sessionId) || null;
    const tokens = facts.tokens;
    return {
      sessionId: r.sessionId,
      pid: Number(r.pid),
      window: w ? { id: w.windowId, exthostPid: w.exthostPid, label: windowLabel.get(w.windowId) || null } : null,
      name: r.name || String(r.sessionId).slice(0, 8),
      nameSource: t.nameSource || null,
      // a /rename (custom-title line, or the registry's user-set name) beats the generated title
      title: facts.customTitle || (t.nameSource === 'user' && r.name ? String(r.name) : null) || facts.title,
      generatedTitle: facts.title,
      lastPrompt: facts.lastPrompt,
      cwd: r.cwd || '',
      transcriptPath: file,
      kind: r.kind || 'interactive',
      status: r.status,
      waitingFor: r.waitingFor || null,
      startedAt: r.startedAt || null,
      statusUpdatedAt: changedAt,
      ageMinutes: changedAt ? Math.round((now - changedAt) / 60000) : null,
      contextTokens: tokens,
      pct: tokens == null || !limits.compact ? null : Math.min(100, Math.round((tokens / limits.compact) * 100)),
      hasTranscript: Boolean(file),
      needsAttention: r.status === 'waiting',
    };
  });

  if (!stale) lastGood = { rows, at: now };
  lastSnapshot = { at: now, stale, error, limits, platform: process.platform, sessions, usage: safeUsage() };
  return lastSnapshot;
}

// ---------------------------------------------------------------------------------------
// Ending a session
// ---------------------------------------------------------------------------------------

/**
 * Process identity for the kill guard: name and creation time as a FILETIME, matching the
 * registry record's `procStart` (same clock, same units) or `startedAt` (epoch ms).
 */
async function processIdentity(pid) {
  const r = await runPowerShell(
    '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '"; ' +
    'if ($p) { @{ name = $p.Name; ft = [string]$p.CreationDate.ToFileTimeUtc(); ppid = $p.ParentProcessId } | ConvertTo-Json -Compress }',
    15000);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  try {
    const o = JSON.parse(r.stdout);
    return o && o.name ? { name: String(o.name), fileTime: String(o.ft || ''), ppid: Number(o.ppid) } : null;
  } catch (_) { return null; }
}

function identityMatches(rec, ident) {
  if (!ident || String(ident.name).toLowerCase() !== 'claude.exe') return false;
  const FIVE_S_TICKS = 50000000n;                  // 100 ns ticks
  if (rec.procStart && ident.fileTime && /^\d+$/.test(String(rec.procStart)) && /^\d+$/.test(ident.fileTime)) {
    const a = BigInt(String(rec.procStart));
    const b = BigInt(ident.fileTime);
    return (a > b ? a - b : b - a) <= FIVE_S_TICKS;
  }
  if (rec.startedAt && ident.fileTime && /^\d+$/.test(ident.fileTime)) {
    const epochMs = Number((BigInt(ident.fileTime) - 116444736000000000n) / 10000n);
    return Math.abs(epochMs - Number(rec.startedAt)) <= 5000;
  }
  return false;                                    // no timestamp to compare: refuse
}

const ending = new Map(); // sessionId -> promise, one attempt at a time

async function endSession(sessionId, opts) {
  sessionId = String(sessionId || '');
  if (!UUID_RE.test(sessionId)) return { ok: false, code: 'invalid', message: 'Not a session id.' };
  if (ending.has(sessionId)) return { ok: false, code: 'pending', message: 'Already ending this session.' };
  const p = doEndSession(sessionId, Boolean(opts && opts.force));
  ending.set(sessionId, p);
  try { return await p; } finally { ending.delete(sessionId); }
}

async function doEndSession(sessionId, force) {
  if (!IS_WINDOWS) return { ok: false, code: 'unsupported', message: 'Ending sessions is Windows-only in this version.' };
  const row = lastGoodRows().find((r) => r.sessionId === sessionId);
  if (!row) return { ok: false, code: 'unknown', message: 'Unknown session.' };
  const pid = Number(row.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, code: 'invalid', message: 'Bad pid.' };

  const rec = readRegistry(pid);
  if (!rec) return { ok: false, code: 'gone', message: 'No registry record; the session has probably ended already.' };
  if (rec.sessionId !== sessionId) return { ok: false, code: 'mismatch', message: 'Registry names a different session for this pid; refusing.' };

  const status = String(rec.status || '');
  if ((status === 'busy' || status === 'waiting') && !force) {
    return { ok: false, code: 'needs-force', status, message: 'Session is ' + status + '.' };
  }

  const ident = await processIdentity(pid);
  if (!ident) return { ok: false, code: 'gone', message: 'Pid ' + pid + ' no longer exists.' };
  if (!identityMatches(rec, ident)) {
    return { ok: false, code: 'mismatch', message: 'Pid ' + pid + ' is not the claude.exe this record describes; refusing.' };
  }

  const r = await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000 });
  if (r.timedOut) return { ok: false, code: 'timeout', message: 'taskkill did not finish in 10 s.' };
  if (r.code === 128 || /not found/i.test(r.stderr)) return { ok: false, code: 'gone', message: 'Process already gone.' };
  if (/denied/i.test(r.stderr)) return { ok: false, code: 'denied', message: 'Access denied ending pid ' + pid + '.' };
  if (r.code !== 0) return { ok: false, code: 'failed', message: (r.stderr || r.stdout).trim().split('\n')[0] || ('taskkill exit ' + r.code) };

  for (let i = 0; i < 30 && pidAlive(pid); i++) await new Promise((res) => setTimeout(res, 100));
  if (pidAlive(pid)) return { ok: false, code: 'partial', message: 'taskkill returned but pid ' + pid + ' is still alive.' };
  parentByPid.delete(pid);
  return { ok: true, code: 'ended', pid };
}

// ---------------------------------------------------------------------------------------
// Search across all sessions (ripgrep does all transcript reading)
// ---------------------------------------------------------------------------------------

let rgState = { probed: false, path: null, version: null, error: null };

/** VS Code install roots (`.../resources/app`) to look for a bundled ripgrep in. */
function vscodeAppRoots(appRoot) {
  const roots = [];
  if (appRoot) roots.push(appRoot);
  const bases = [];
  if (IS_WINDOWS) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const name of ['Microsoft VS Code', 'Microsoft VS Code Insiders']) {
      bases.push(path.join(local, 'Programs', name));
      if (process.env.ProgramFiles) bases.push(path.join(process.env.ProgramFiles, name));
    }
  } else if (process.platform === 'darwin') {
    bases.push('/Applications/Visual Studio Code.app/Contents/Resources');
  } else {
    bases.push('/usr/share/code', '/usr/lib/code', '/opt/visual-studio-code');
  }
  for (const base of bases) {
    const direct = path.join(base, 'resources', 'app');
    if (fs.existsSync(direct)) roots.push(direct);
    let subs = [];
    try { subs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { continue; }
    for (const sub of subs) {                    // 1.138 keeps the app under a hashed folder
      const nested = path.join(base, sub, 'resources', 'app');
      if (fs.existsSync(nested)) roots.push(nested);
    }
  }
  return [...new Set(roots)];
}

function rgCandidates(appRoot) {
  const exe = IS_WINDOWS ? 'rg.exe' : 'rg';
  const plat = process.platform + '-' + process.arch;
  const list = ['rg'];
  for (const root of vscodeAppRoots(appRoot)) {
    list.push(path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', plat, exe));
    list.push(path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe));
    list.push(path.join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', exe));
  }
  return list;
}

/** Once per process: find a ripgrep that actually runs. */
async function rgProbe(appRoot) {
  if (rgState.probed) return rgState;
  for (const cand of rgCandidates(appRoot)) {
    if (cand !== 'rg' && !fs.existsSync(cand)) continue;
    const r = await run(cand, ['--version'], { timeout: 10000 });
    if (r.code === 0 && /ripgrep/i.test(r.stdout)) {
      rgState = { probed: true, path: cand, version: r.stdout.split('\n')[0].trim(), error: null };
      return rgState;
    }
    rgState.error = (r.stderr || '').trim().split('\n')[0] || ('exit ' + r.code);
  }
  rgState.probed = true;
  return rgState;
}

const RG_BASE = ['--no-ignore', '--hidden', '--max-depth', '2', '--glob', '*.jsonl', '--no-messages'];

/** Split `path:match` from `rg -H -N -o` where the path may contain drive-letter colons. */
function splitPathMatch(line, marker) {
  const idx = line.indexOf(':' + marker);
  if (idx <= 0) return null;
  return { file: line.slice(0, idx), match: line.slice(idx + 1) };
}

const searchIndex = { rows: new Map(), signature: '' }; // path -> { sessionId, cwd, title, mtime, size }

/**
 * Index of every top-level transcript: file sweep for existence and freshness, then three
 * ripgrep passes over whole files for the newest `aiTitle`, the newest `customTitle` and
 * the first `cwd`. No head
 * or tail reads, nothing synchronous beyond readdir/stat; skipped when nothing changed.
 */
async function sessionIndex(ctx) {
  const files = listTranscripts();
  const signature = files.map((f) => f.path + '|' + f.size + '|' + f.mtime).sort().join('\n');
  if (signature === searchIndex.signature && searchIndex.rows.size) return searchIndex.rows;

  const rows = new Map();
  for (const f of files) {
    const prev = searchIndex.rows.get(f.path);
    rows.set(f.path, {
      path: f.path, sessionId: path.basename(f.path, '.jsonl'), size: f.size, mtime: f.mtime,
      cwd: prev ? prev.cwd : null, title: prev ? prev.title : null,
    });
  }
  const rg = await rgProbe(ctx && ctx.appRoot);
  if (rg.path) {
    // Patterns are constants, never user input; `-o` keeps output to the match, so a
    // multi-MB first line costs nothing.
    const titles = await run(rg.path, [...RG_BASE, '-H', '-N', '-o', '--no-heading',
      '-e', '"aiTitle":"(?:[^"\\\\]|\\\\.)*"', PROJECTS_DIR],
    { timeout: 30000, maxBuffer: 64 * 1024 * 1024, signal: ctx && ctx.signal, onChild: ctx && ctx.track });
    for (const line of titles.stdout.split('\n')) {
      const pm = splitPathMatch(line, '"aiTitle":"');
      if (!pm) continue;
      const row = rows.get(path.normalize(pm.file));
      if (!row) continue;
      try { row.title = JSON.parse('{' + pm.match + '}').aiTitle || row.title; } catch (_) { /* keep previous */ }
    }
    // /rename names (custom-title lines) win over generated titles; newest per file wins.
    const customs = await run(rg.path, [...RG_BASE, '-H', '-N', '-o', '--no-heading',
      '-e', '"customTitle":"(?:[^"\\\\]|\\\\.)*"', PROJECTS_DIR],
    { timeout: 30000, maxBuffer: 64 * 1024 * 1024, signal: ctx && ctx.signal, onChild: ctx && ctx.track });
    for (const line of customs.stdout.split('\n')) {
      const pm = splitPathMatch(line, '"customTitle":"');
      if (!pm) continue;
      const row = rows.get(path.normalize(pm.file));
      if (!row) continue;
      try { row.title = JSON.parse('{' + pm.match + '}').customTitle || row.title; } catch (_) { /* keep previous */ }
    }
    const cwds = await run(rg.path, [...RG_BASE, '-H', '-N', '-o', '--no-heading', '-m', '1',
      '-e', '"cwd":"(?:[^"\\\\]|\\\\.)*"', PROJECTS_DIR],
    { timeout: 30000, maxBuffer: 64 * 1024 * 1024, signal: ctx && ctx.signal, onChild: ctx && ctx.track });
    for (const line of cwds.stdout.split('\n')) {
      const pm = splitPathMatch(line, '"cwd":"');
      if (!pm) continue;
      const row = rows.get(path.normalize(pm.file));
      if (!row || row.cwd) continue;
      try { row.cwd = JSON.parse('{' + pm.match + '}').cwd || row.cwd; } catch (_) { /* keep */ }
    }
  }
  searchIndex.rows = rows;
  searchIndex.signature = signature;
  return rows;
}

/** Escape a query the way it would appear inside a JSON string, so quotes and newlines match. */
function jsonEscaped(q) {
  const s = JSON.stringify(q);
  return s.slice(1, -1);
}

/** ±70 chars around a byte offset in a line, using bytes so multibyte text stays aligned. */
function sliceAround(lineText, byteStart, byteEnd) {
  const buf = Buffer.from(lineText, 'utf8');
  const a = Math.max(0, byteStart - 70);
  const b = Math.min(buf.length, byteEnd + 70);
  return (a > 0 ? '…' : '') + buf.subarray(a, b).toString('utf8').replace(/\s+/g, ' ') + (b < buf.length ? '…' : '');
}

/** Prefer the decoded conversation text when the match sits inside message.content. */
function snippetFromLine(lineText, sub, query) {
  if (lineText.length <= 4 * 1024 * 1024) {
    try {
      const o = JSON.parse(lineText);
      const c = o && o.message && o.message.content;
      const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')) : [];
      const q = query.toLowerCase();
      for (const t of texts) {
        const i = t.toLowerCase().indexOf(q);
        if (i !== -1) {
          const a = Math.max(0, i - 70);
          const b = Math.min(t.length, i + query.length + 70);
          return (a > 0 ? '…' : '') + t.slice(a, b).replace(/\s+/g, ' ') + (b < t.length ? '…' : '');
        }
      }
    } catch (_) { /* not JSON or no text field: fall back to raw */ }
  }
  return sliceAround(lineText, sub.start, sub.end);
}

const searchRuns = new Map(); // requestId -> { children: Set, aborted }

function cancelSearch(requestId) {
  const runState = searchRuns.get(requestId);
  if (!runState) return;
  runState.aborted = true;
  for (const child of runState.children) { try { child.kill(); } catch (_) { /* gone */ } }
}

/**
 * Title pass over the index plus the live snapshot; optional content pass with ripgrep.
 * Returns { requestId, query, content, total, shown, partial, skipped, rgAvailable, rows }.
 */
async function searchSessions(query, opts) {
  opts = opts || {};
  const requestId = String(opts.requestId || Date.now());
  const q = String(query || '').trim().slice(0, 200);
  const runState = { children: new Set(), aborted: false };
  searchRuns.set(requestId, runState);
  const track = (child) => { runState.children.add(child); child.on('exit', () => runState.children.delete(child)); };
  if (opts.signal) opts.signal.addEventListener('abort', () => cancelSearch(requestId), { once: true });
  const ctx = { signal: opts.signal, track, appRoot: opts.appRoot };
  const started = Date.now();
  const budgetLeft = () => Math.max(1000, 30000 - (Date.now() - started));

  try {
    const rg = await rgProbe(opts.appRoot);
    const base = { requestId, query: q, content: Boolean(opts.content), total: 0, shown: 0, partial: false, skipped: 0, rgAvailable: Boolean(rg.path), rgError: rg.error, rows: [] };
    if (!q) return base;

    const index = await sessionIndex(ctx);
    if (runState.aborted) return Object.assign(base, { cancelled: true });
    const live = new Map(lastSnapshotRows().map((s) => [s.sessionId, s]));
    const ql = q.toLowerCase();
    const has = (v) => typeof v === 'string' && v.toLowerCase().indexOf(ql) !== -1;

    const hits = new Map(); // key path|sessionId -> row
    const addRow = (row, source) => {
      const key = row.path || ('live:' + row.sessionId);
      const prev = hits.get(key);
      if (prev) { prev.source = prev.source === source ? source : 'both'; return prev; }
      hits.set(key, Object.assign({ source }, row));
      return hits.get(key);
    };

    for (const s of live.values()) {
      if (has(s.title) || has(s.lastPrompt) || has(s.name) || has(s.cwd) || has(s.sessionId)) {
        addRow({ sessionId: s.sessionId, path: s.transcriptPath, cwd: s.cwd, title: s.title || s.lastPrompt || null, mtime: Date.now() }, 'title');
      }
    }
    for (const row of index.values()) {
      if (has(row.title) || has(row.cwd) || has(row.sessionId)) addRow(row, 'title');
    }

    if (opts.content && rg.path) {
      const listed = await run(rg.path, [...RG_BASE, '-i', '-l', '-F', '-e', q, '-e', jsonEscaped(q), PROJECTS_DIR],
        { timeout: budgetLeft(), maxBuffer: 64 * 1024 * 1024, signal: opts.signal, onChild: track });
      if (runState.aborted) return Object.assign(base, { cancelled: true });
      if (listed.code === 2 || listed.timedOut) { base.partial = true; base.partialReason = listed.timedOut ? 'content search timed out' : (listed.stderr.trim().split('\n')[0] || 'ripgrep reported errors'); }
      for (const line of listed.stdout.split('\n')) {
        const p = path.normalize(line.trim());
        if (!p) continue;
        const row = index.get(p);
        if (row) addRow(row, 'content'); else base.skipped++;
      }
    } else if (opts.content && !rg.path) {
      base.partial = true;
      base.partialReason = 'ripgrep not found; content search unavailable';
    }

    const all = [...hits.values()].map((row) => {
      const s = live.get(row.sessionId);
      return Object.assign(row, {
        live: Boolean(s), status: s ? s.status : 'past', pid: s ? s.pid : null, window: s ? s.window : null,
        name: s ? s.name : null, folder: row.cwd ? String(row.cwd).split(/[\\/]/).filter(Boolean).pop() : null,
        ageMinutes: row.mtime ? Math.round((Date.now() - row.mtime) / 60000) : null, snippets: [],
      });
    });
    all.sort((a, b) => (a.live === b.live ? (b.mtime || 0) - (a.mtime || 0) : a.live ? -1 : 1));
    base.total = all.length;
    const shown = all.slice(0, 50);
    base.shown = shown.length;

    // Snippets for the first 20 displayed rows that came from the content pass, 4 at a time.
    if (opts.content && rg.path) {
      const targets = shown.filter((r) => r.path && r.source !== 'title').slice(0, 20);
      for (let i = 0; i < targets.length && !runState.aborted; i += 4) {
        await Promise.all(targets.slice(i, i + 4).map(async (row) => {
          const r = await run(rg.path, ['--json', '-i', '-F', '-m', '2', '-e', q, '-e', jsonEscaped(q), row.path],
            { timeout: budgetLeft(), maxBuffer: 64 * 1024 * 1024, signal: opts.signal, onChild: track });
          if (r.code === 2) base.partial = true;
          for (const line of r.stdout.split('\n')) {
            if (!line || line.indexOf('"type":"match"') === -1) continue;
            try {
              const ev = JSON.parse(line);
              const text = ev.data && ev.data.lines && ev.data.lines.text;
              const sub = ev.data && ev.data.submatches && ev.data.submatches[0];
              if (typeof text === 'string' && sub) row.snippets.push(snippetFromLine(text, sub, q));
            } catch (_) { /* skip malformed event */ }
            if (row.snippets.length >= 2) break;
          }
        }));
      }
    }
    if (runState.aborted) return Object.assign(base, { cancelled: true });
    base.rows = shown;
    return base;
  } finally {
    searchRuns.delete(requestId);
  }
}

/** Windows-aware "child is inside parent": case-insensitive, normalized separators, segment boundary. */
function isInside(child, parent) {
  if (!child || !parent) return false;
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+/g, path.sep).replace(/[\\/]+$/, '') + path.sep;
  let c = norm(child), p = norm(parent);
  if (IS_WINDOWS) { c = c.toLowerCase(); p = p.toLowerCase(); }
  return c.startsWith(p);
}

module.exports = {
  EXTENSION_ID,
  UUID_RE,
  IS_WINDOWS,
  snapshot,
  lastGoodRows,
  lastSnapshotRows,
  thresholds,
  exthostForPid,
  windowForPid,
  focusSession,
  writeHeartbeat,
  boardAlive,
  pidAlive,
  readRegistry,
  endSession,
  rgProbe,
  sessionIndex,
  searchSessions,
  cancelSearch,
  isInside,
  DATA_DIR,
  USAGE_FILE,
  statusLineState,
  refreshStatusLineScript,
  statusLineSetup,
  usageState,
};
