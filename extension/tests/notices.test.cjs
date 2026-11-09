'use strict';
/*
 * The Windows notification pieces in core.cjs: one claim per event across windows (exclusive
 * create under DATA_DIR/notices, released after a failed toast, old claims pruned), the toast
 * XML (escaped text, the open URI as a protocol launch) and the PowerShell script, which must
 * never contain session text: a title is data that a prompt can steer, so it only reaches
 * PowerShell as base64 inside a single-quoted literal. SB_TOAST_LOG records the script instead
 * of spawning powershell.exe.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notices-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
process.env.SB_CODE_USER_DIR = path.join(tmp, 'User');   // never the real state.vscdb
const toastLog = path.join(tmp, 'toasts.jsonl');
process.env.SB_TOAST_LOG = toastLog;
const core = require('../core.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const HOSTILE = "it's <done> & $(Remove-Item C:\\x); 'quoted' \"dq\" `tick`";

test('claims: the first claim of an event wins, a second loses, kinds and times are separate events; a release lets it be claimed again', () => {
  assert.equal(core.claimNotice(A, 'done', 1000), true);
  assert.equal(core.claimNotice(A, 'done', 1000), false, 'another window got there first');
  assert.equal(core.claimNotice(A, 'waiting', 1000), true);
  assert.equal(core.claimNotice(A, 'done', 2000), true);
  core.releaseNotice(A, 'done', 1000);
  assert.equal(core.claimNotice(A, 'done', 1000), true, 'released after a failed toast');
  core.releaseNotice(A, 'done', 999);                                         // nothing there: fine
  assert.throws(() => core.claimNotice('nope', 'done', 1), /not a session id/);
  assert.throws(() => core.claimNotice(A, 'other', 1), /unknown notice kind/);
  assert.throws(() => core.claimNotice(A, 'done', 0), /needs a time/);
});

test('claims: a claim older than a day is removed on the next claim', () => {
  const old = path.join(core.NOTICES_DIR, A + '.done.5');
  fs.writeFileSync(old, '1');
  const then = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(old, then, then);
  core.claimNotice(A, 'done', 6);
  assert.equal(fs.existsSync(old), false);
});

test('toast XML: the text is escaped and the open URI is a protocol launch; no launch, no activation', () => {
  const xml = core.toastXml({ title: HOSTILE, body: 'done', launch: 'vscode://x/open?session=' + A + '&windowId=3' });
  assert.match(xml, /^<toast activationType="protocol" launch="vscode:\/\/x\/open\?session=[0-9a-f-]+&amp;windowId=3">/);
  assert.ok(xml.includes('it&apos;s &lt;done&gt; &amp; $(Remove-Item C:\\x); &apos;quoted&apos; &quot;dq&quot; `tick`'));
  assert.equal(core.toastXml({ title: 'x' }), '<toast><visual><binding template="ToastGeneric"><text>x</text></binding></visual></toast>');
});

test('the PowerShell script holds only base64 and constants: no session text, no quote it could break out of', async () => {
  await core.showSystemToast([{ title: HOSTILE, body: 'done', launch: 'vscode://x/open?session=' + A + '&windowId=3' }, { title: 'second', body: 'needs you: input' }]);
  const rec = JSON.parse(fs.readFileSync(toastLog, 'utf8').trim().split('\n').pop());
  for (const piece of ["it's", 'Remove-Item', 'quoted', 'second', 'needs you', A]) assert.equal(rec.script.includes(piece), false, piece + ' leaked into the script');
  const literals = [...rec.script.matchAll(/FromBase64String\('([^']*)'\)/g)].map((m) => m[1]);
  assert.equal(literals.length, 2, 'one toast per item');
  for (const b64 of literals) assert.match(b64, /^[A-Za-z0-9+/=]+$/);
  assert.deepEqual(literals.map((b) => Buffer.from(b, 'base64').toString('utf8')), rec.xml, 'the literals decode to the escaped XML');
  assert.ok(rec.script.includes("CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')"));
});

test('an empty batch does nothing; SB_TOAST_FAIL makes the dry run reject like a failed PowerShell', async () => {
  const before = fs.existsSync(toastLog) ? fs.readFileSync(toastLog, 'utf8') : '';
  await core.showSystemToast([]);
  assert.equal(fs.existsSync(toastLog) ? fs.readFileSync(toastLog, 'utf8') : '', before);
  process.env.SB_TOAST_FAIL = 'blocked';
  await assert.rejects(core.showSystemToast([{ title: 'x' }]), /blocked/);
  delete process.env.SB_TOAST_FAIL;
});

test('openUri: the board route when one runs in that window, Claude Code otherwise; unchecked input gives null', () => {
  assert.equal(core.openUri(A, 3, 'nima-ghorbani.session-board-vscode'), 'vscode://nima-ghorbani.session-board-vscode/open?session=' + A + '&windowId=3');
  assert.equal(core.openUri(A, 3, null), 'vscode://anthropic.claude-code/open?session=' + A + '&windowId=3');
  assert.equal(core.openUri(A, 3, 'evil/../x'), 'vscode://anthropic.claude-code/open?session=' + A + '&windowId=3');
  assert.equal(core.openUri('nope', 3, null), null);
  assert.equal(core.openUri(A, '3', null), null);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
