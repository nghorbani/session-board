#!/usr/bin/env node
/**
 * Renders the README screenshots from extension/index.html with example sessions, in a
 * headless Chromium (Chrome or Edge). No real session data is read; the page's fetch calls
 * are answered from the fixtures below.
 *
 *   node tools/screenshot.cjs     -> extension/media/board.png, extension/media/search.png
 *
 * Set SCREENSHOT_BROWSER to a Chromium executable when none of the usual paths exist.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'extension', 'index.html');
const OUT_DIR = path.join(ROOT, 'extension', 'media');
const WIDTH = 440;

function browser() {
  const candidates = [
    process.env.SCREENSHOT_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('no Chromium browser found; set SCREENSHOT_BROWSER');
  return hit;
}

// -- fixtures ----------------------------------------------------------------------------

const now = Date.now();
const HOUR = 3600 * 1000;

function session(sessionId, title, status, extra) {
  return Object.assign({
    sessionId, title, status, waitingFor: null, name: null, lastPrompt: null,
    cwd: 'C:\\code\\acme\\webapp', window: { id: 1, label: 'webapp' }, ageMinutes: 0,
    contextTokens: 120000, pct: 13, transcriptPath: null, kind: 'interactive',
  }, extra);
}

const sessions = [
  session('57f9950b-6af0-43b1-8cf6-df44231415d6', 'Fix flaky upload test', 'waiting', { waitingFor: 'permission prompt', ageMinutes: 4, contextTokens: 168000, pct: 18 }),
  session('9c6e6599-150d-4902-86d7-0912fb739fb2', 'Release notes for 2.4', 'waiting', { waitingFor: 'input needed', ageMinutes: 22, contextTokens: 94000, pct: 10, cwd: 'C:\\code\\acme\\docs', window: { id: 2, label: 'docs' } }),
  session('8de2ac3e-106d-4060-8465-ad7df94a6f7c', 'Migrate auth to OAuth', 'busy', { contextTokens: 611000, pct: 66 }),
  session('8ea18419-65ce-4e4d-800a-fc1766733b8e', 'Refactor CSV importer', 'busy', { contextTokens: 872000, pct: 95, cwd: 'C:\\code\\acme\\api', window: { id: 3, label: 'api' } }),
  session('06011aa6-f5ad-4143-81a7-ec8d73d905d6', 'Explore vector databases', 'idle', { ageMinutes: 48, contextTokens: 42000, pct: 5, cwd: 'C:\\code\\acme\\research', window: { id: 2, label: 'docs' }, unseen: true }),
  session('f012f188-e632-41b8-82a0-99a8e5855280', 'Spike: streaming parser', 'idle', { ageMinutes: 95, contextTokens: 210000, pct: 23, archived: true }),
  session('5ec9d000-209b-466d-8118-6f18417f7a92', 'Nightly dependency bump', 'idle', { ageMinutes: 35, contextTokens: 76000, pct: 8, cwd: 'C:\\code\\acme\\api', window: { id: 3, label: 'api' }, muted: true }),
];

const snapshot = {
  at: now, stale: false, error: null, limits: { compact: 920000, save: 846400 }, platform: 'win32', sessions, thisWindowId: 1, order: { mode: 'activity', show: 'open' },
  ended: [
    { sessionId: '3f1c9a20-7b44-4c1e-9d2a-5e8f0b6a1c33', status: 'ended', live: false, title: 'Upload retry policy review', lastPrompt: null, cwd: 'C:/code/acme/webapp', transcriptPath: 'C:/Users/dev/.claude/projects/C--code-acme-webapp/3f1c9a20.jsonl', path: 'C:/Users/dev/.claude/projects/C--code-acme-webapp/3f1c9a20.jsonl', folder: 'C--code-acme-webapp', ageMinutes: 190, hasTranscript: true, archived: false, window: { id: 1, label: 'webapp' } },
    { sessionId: '8b7e2d41-1a90-4f3b-8c6d-2e4a9f0c7b15', status: 'ended', live: false, title: 'Login page copy changes', lastPrompt: null, cwd: 'C:/code/acme/webapp', transcriptPath: 'C:/Users/dev/.claude/projects/C--code-acme-webapp/8b7e2d41.jsonl', path: 'C:/Users/dev/.claude/projects/C--code-acme-webapp/8b7e2d41.jsonl', folder: 'C--code-acme-webapp', ageMinutes: 1500, hasTranscript: true, archived: false, window: { id: 1, label: 'webapp' } },
  ],
  usage: {
    state: 'ok', at: now - 2 * 60000, ageSeconds: 120, subscriptionType: 'max', available: true,
    windows: {
      five_hour: { label: '5h', usedPct: 42, resetsAt: now + 2 * HOUR + 10 * 60000, expired: false },
      seven_day: { label: '7d', usedPct: 18, resetsAt: now + 3 * 24 * HOUR, expired: false },
      seven_day_opus: { label: '7d Opus', usedPct: 61, resetsAt: now + 3 * 24 * HOUR, expired: false },
    },
    extraUsage: null, error: null, cacheError: null,
    account: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'dev@example.com', orgName: 'Example', subscriptionType: 'max' }, accountError: null,
  },
};

const searchRows = [
  { sessionId: '8ea18419-65ce-4e4d-800a-fc1766733b8e', title: 'Refactor CSV importer', live: true, status: 'busy', folder: 'acme/api', cwd: 'C:\\code\\acme\\api', ageMinutes: 0, window: { id: 3, label: 'api' },
    snippets: ['…the CSV importer chokes on quoted newlines; the new parser streams rows instead…'] },
  { sessionId: '96655b25-aa6f-4954-8905-59d65d781f9a', title: 'CSV importer v1', live: false, folder: 'acme/api', cwd: 'C:\\code\\acme\\api', ageMinutes: 60 * 24 * 12,
    snippets: ['…wrote the first CSV importer with a fixed delimiter; header row optional…', '…the CSV files from the ERP export use semicolons…'] },
  { sessionId: '51f0fe27-2fba-40e5-89d8-62b248fa5239', title: 'Invoice export cleanup', live: false, folder: 'acme/webapp', cwd: 'C:\\code\\acme\\webapp', ageMinutes: 60 * 24 * 40,
    snippets: ['…export invoices as CSV instead of XLSX for the accounting hand-off…'] },
];

// -- rendering ---------------------------------------------------------------------------

function mock(mode) {
  return `
window.Notification = undefined;
document.body.classList.add('vscode');
var __snapshot = ${JSON.stringify(snapshot)};
var __rows = ${JSON.stringify(searchRows)};
window.fetch = function (url) {
  var u = String(url);
  var body = {};
  if (u.indexOf('/api/sessions') === 0) body = __snapshot;
  else if (u.indexOf('/api/search') === 0) {
    var m = u.match(/requestId=([^&]+)/);
    body = { requestId: m ? decodeURIComponent(m[1]) : '', query: 'csv', content: true, total: 3, shown: 3, partial: false, skipped: 0, rgAvailable: true, rows: __rows };
  }
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
};
${mode === 'search' ? `
setTimeout(function () {
  var q = document.getElementById('q');
  q.value = 'csv';
  q.dispatchEvent(new Event('input'));
  q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
}, 400);` : ''}
`;
}

function render(mode, out, height) {
  // Chromium will not shrink its window below roughly 500 px, so the page is pinned to the
  // sidebar width and the capture is cropped to it.
  const html = fs.readFileSync(INDEX, 'utf8')
    .replace('</head>', '<style>html, body { width: ' + WIDTH + 'px !important; }</style></head>')
    .replace('<script>', '<script>' + mock(mode) + '</script>\n<script>');
  const tmp = path.join(os.tmpdir(), 'session-board-demo-' + mode + '.html');
  fs.writeFileSync(tmp, html);
  try {
    execFileSync(browser(), [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
      '--window-size=' + WIDTH + ',' + height, '--virtual-time-budget=3000',
      '--screenshot=' + out, 'file:///' + tmp.replace(/\\/g, '/'),
    ], { stdio: 'ignore', timeout: 60000 });
  } finally {
    fs.unlinkSync(tmp);
  }
  console.log('wrote ' + out);
}

module.exports = { browser };   // tests/page.test.cjs reuses the browser discovery

if (require.main === module) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Heights fit the fixtures above; adjust when they change (SCREENSHOT_*_HEIGHT override).
  const heights = { board: Number(process.env.SCREENSHOT_BOARD_HEIGHT) || 1000, search: Number(process.env.SCREENSHOT_SEARCH_HEIGHT) || 870 };
  render('board', path.join(OUT_DIR, 'board.png'), heights.board);
  render('search', path.join(OUT_DIR, 'search.png'), heights.search);
}
