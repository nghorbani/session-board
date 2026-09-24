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
  session('a1', 'Fix flaky upload test', 'waiting', { waitingFor: 'permission prompt', ageMinutes: 4, contextTokens: 168000, pct: 18 }),
  session('a2', 'Release notes for 2.4', 'waiting', { waitingFor: 'input needed', ageMinutes: 22, contextTokens: 94000, pct: 10, cwd: 'C:\\code\\acme\\docs', window: { id: 2, label: 'docs' } }),
  session('a3', 'Migrate auth to OAuth', 'busy', { contextTokens: 611000, pct: 66 }),
  session('a4', 'Refactor CSV importer', 'busy', { contextTokens: 872000, pct: 95, cwd: 'C:\\code\\acme\\api', window: { id: 3, label: 'api' } }),
  session('a5', 'Explore vector databases', 'idle', { ageMinutes: 48, contextTokens: 42000, pct: 5, cwd: 'C:\\code\\acme\\research', window: { id: 2, label: 'docs' } }),
];

const snapshot = {
  at: now, stale: false, error: null, limits: { compact: 920000, save: 846400 }, platform: 'win32', sessions,
  usage: {
    state: 'ok', at: now - 2 * 60000, ageSeconds: 120, subscriptionType: 'max', available: true,
    windows: {
      five_hour: { label: '5h', usedPct: 42, resetsAt: now + 2 * HOUR + 10 * 60000, expired: false },
      seven_day: { label: '7d', usedPct: 18, resetsAt: now + 3 * 24 * HOUR, expired: false },
      seven_day_opus: { label: '7d Opus', usedPct: 61, resetsAt: now + 3 * 24 * HOUR, expired: false },
    },
    extraUsage: null, error: null, cacheError: null,
  },
};

const searchRows = [
  { sessionId: 'a4', title: 'Refactor CSV importer', live: true, status: 'busy', folder: 'acme/api', cwd: 'C:\\code\\acme\\api', ageMinutes: 0, window: { id: 3, label: 'api' },
    snippets: ['…the CSV importer chokes on quoted newlines; the new parser streams rows instead…'] },
  { sessionId: 'p1', title: 'CSV importer v1', live: false, folder: 'acme/api', cwd: 'C:\\code\\acme\\api', ageMinutes: 60 * 24 * 12,
    snippets: ['…wrote the first CSV importer with a fixed delimiter; header row optional…', '…the CSV files from the ERP export use semicolons…'] },
  { sessionId: 'p2', title: 'Invoice export cleanup', live: false, folder: 'acme/webapp', cwd: 'C:\\code\\acme\\webapp', ageMinutes: 60 * 24 * 40,
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

fs.mkdirSync(OUT_DIR, { recursive: true });
// Heights fit the fixtures above; adjust when they change (SCREENSHOT_*_HEIGHT override).
const heights = { board: Number(process.env.SCREENSHOT_BOARD_HEIGHT) || 880, search: Number(process.env.SCREENSHOT_SEARCH_HEIGHT) || 870 };
render('board', path.join(OUT_DIR, 'board.png'), heights.board);
render('search', path.join(OUT_DIR, 'search.png'), heights.search);
