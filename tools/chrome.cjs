'use strict';
/**
 * Headless Chromium for the page suites and the README screenshots: where the browser is, a
 * free port, and one started browser driven over the DevTools protocol through Node's own
 * WebSocket. One place, so a start-up or shutdown fix reaches the two page suites and
 * tools/screenshot.cjs alike.
 *
 * Set SCREENSHOT_BROWSER to a Chromium executable when none of the usual paths exist.
 */
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { findBrowser } = require('../extension/pdf.cjs');

/** Where the browser is: the same search the extension makes for its PDF export. */
function browser() {
  const hit = findBrowser();
  if (!hit) throw new Error('no Chromium browser found; set SCREENSHOT_BROWSER');
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

function getJson(url) {
  return new Promise((res, rej) => http.get(url, (r) => {
    let b = '';
    r.on('data', (d) => { b += d; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej));
}

function killTree(pid) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* gone */ }
  } else {
    try { process.kill(pid); } catch (_) { /* gone */ }
  }
}

/**
 * Starts a headless browser on a fresh profile and connects to its DevTools port. Resolves
 * `{ send(method, params, sessionId), close() }`; `close()` stops the browser and removes the
 * profile. When the browser does not come up, the error carries its exit code and the end of
 * its own output, and nothing is left running.
 */
async function startChrome(extraArgs) {
  const exe = browser();   // before anything is started: without a browser there is nothing to clean up
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'session-board-chrome-'));
  const child = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile]
    .concat(extraArgs || [], ['about:blank']), { stdio: ['ignore', 'ignore', 'pipe'] });
  // the browser's own output, so a start that fails says why
  let output = '';
  let exited = null;
  child.stderr.on('data', (d) => { output = (output + d.toString('utf8')).slice(-4000); });
  child.on('exit', (code, signal) => { exited = signal || code; });
  child.on('error', (e) => { output += '\nspawn failed: ' + e.message; });
  let ws = null;
  const stop = async () => {
    try { if (ws) ws.close(); } catch (_) { /* closed already */ }
    killTree(child.pid);
    await sleep(300);   // the crash handler may hold a file for a moment; a leftover temp profile is not a failure
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* left to the temp cleanup */ }
  };
  try {
    let info = null;
    for (let i = 0; i < 100 && !info; i++) { try { info = await getJson('http://127.0.0.1:' + port + '/json/version'); } catch (_) { await sleep(200); } }
    if (!info) {
      throw new Error('the browser (' + exe + ') did not open its debugging port within 20 s'
        + (exited !== null ? '; it exited with ' + exited : '; it is still running')
        + '. Its last output:\n' + (output.trim().split(/\r?\n/).slice(-15).join('\n') || '(nothing)'));
    }
    ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const p = m.id ? pending.get(m.id) : null;
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
    };
    const send = (method, params, sessionId) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    });
    return { send, close: stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

module.exports = { browser, freePort, getJson, startChrome };
