'use strict';
/**
 * A printable page to a PDF file, through a Chromium-based browser that is installed on the
 * machine (Edge on every Windows, Chrome or Chromium elsewhere), run headless for the one
 * print. No VS Code in here: the host passes what it has, the tests pass fakes.
 *
 *   findBrowser()             the browser to print with, or null when the machine has none
 *   sealHtml(html)            the page with a content policy that lets nothing run or load
 *   htmlToPdf(html, outFile)  { ok: true } | { ok: false, message, noBrowser? }
 *
 * Set SESSION_BOARD_BROWSER to a Chromium-based executable when none of the usual paths exist.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const PRINT_TIMEOUT_MS = 120000;

function browserCandidates(env, platform) {
  const named = [env.SESSION_BOARD_BROWSER, env.SCREENSHOT_BROWSER];
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA, 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean);
    const apps = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe'];
    return named.concat(...apps.map((app) => roots.map((root) => path.win32.join(root, app))));
  }
  if (platform === 'darwin') {
    return named.concat([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
  }
  return named.concat(['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium']);
}

/** The first candidate that exists: the one named in the environment, then the usual install
    paths of Chrome, Edge and Chromium. Null when there is none. */
function findBrowser(deps) {
  deps = deps || {};
  const exists = deps.exists || fs.existsSync;
  const hit = browserCandidates(deps.env || process.env, deps.platform || process.platform).filter(Boolean).find((p) => exists(p));
  return hit || null;
}

const NO_SCRIPT_POLICY = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">';

/** The page as the browser gets it: the same html with a content policy in front of everything
    else in its head, so nothing in it runs or loads, whatever it holds. Null for a page
    without a head, which cannot be sealed. */
function sealHtml(html) {
  const m = /<head[^>]*>/i.exec(String(html || ''));
  if (!m) return null;
  const end = m.index + m[0].length;
  return html.slice(0, end) + NO_SCRIPT_POLICY + html.slice(end);
}

/** Runs the browser to its end; resolves `{ error }`, null when it exited cleanly. */
function runBrowser(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err) => {
      if (!err) return resolve({ error: null });
      resolve({ error: err.killed ? 'it did not finish within ' + Math.round(timeoutMs / 1000) + ' s' : String(err.message || err).split('\n')[0] });
    });
  });
}

/** A file that starts and ends as a PDF does. A browser stopped in the middle of its print
    can leave one that only starts like it. */
function isWholePdf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const head = Buffer.alloc(5);
      fs.readSync(fd, head, 0, 5, 0);
      const tail = Buffer.alloc(Math.min(size, 1024));
      fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      return head.toString('latin1') === '%PDF-' && tail.toString('latin1').indexOf('%%EOF') !== -1;
    } finally { fs.closeSync(fd); }
  } catch (_) { return false; }
}

/**
 * Prints `html` to `outFile`. The browser works in a temp folder of its own (the sealed page,
 * a fresh profile, the PDF), and the PDF is copied out only when it is a whole one, so a failed print
 * leaves nothing at `outFile`. `deps`: findBrowser, run(exe, args, timeoutMs), timeoutMs.
 */
async function htmlToPdf(html, outFile, deps) {
  deps = deps || {};
  const exe = (deps.findBrowser || findBrowser)();
  if (!exe) return { ok: false, noBrowser: true, message: 'No Chrome, Edge or Chromium was found to print the PDF with.' };
  const sealed = sealHtml(html);
  if (!sealed) return { ok: false, message: 'the page to print has no head' };
  const timeoutMs = deps.timeoutMs || PRINT_TIMEOUT_MS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-board-pdf-'));
  try {
    const page = path.join(dir, 'story.html');
    const printed = path.join(dir, 'story.pdf');
    fs.writeFileSync(page, sealed, 'utf8');
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
      '--user-data-dir=' + path.join(dir, 'profile'),
      '--no-pdf-header-footer', '--print-to-pdf-no-header',   // the flag of the new and of the old headless mode
      '--print-to-pdf=' + printed,
      pathToFileURL(page).href,
    ];
    const res = await (deps.run || runBrowser)(exe, args, timeoutMs);
    if (!isWholePdf(printed)) return { ok: false, message: 'The browser wrote no PDF' + (res && res.error ? ': ' + res.error : '') + '.' };
    fs.copyFileSync(printed, outFile);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  } finally {
    // the browser's crash handler may hold a file of the profile for a moment
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* left to the temp cleanup */ }
  }
}

module.exports = { findBrowser, sealHtml, htmlToPdf, PRINT_TIMEOUT_MS };
