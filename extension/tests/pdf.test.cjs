'use strict';
/*
 * pdf.cjs: a printable page to a PDF file through an installed Chromium-based browser. The
 * browser is a fake here (a function that writes what a browser would), plus one run with a
 * real one when the machine has it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pdf = require('../pdf.cjs');

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Story</title><style>p { color: #222; }</style></head><body><p>hello</p></body></html>';

function outFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pdf-test-'));
  return path.join(dir, 'story.pdf');
}
function arg(args, name) {
  const hit = args.find((a) => a.indexOf(name + '=') === 0);
  return hit ? hit.slice(name.length + 1) : null;
}
/** A browser that prints: it writes a PDF where it was told to, and keeps what it was given. */
function printingBrowser(seen) {
  return async (exe, args) => {
    seen.exe = exe;
    seen.args = args;
    const url = args[args.length - 1];
    seen.page = fs.readFileSync(require('url').fileURLToPath(url), 'utf8');
    seen.workDir = path.dirname(arg(args, '--print-to-pdf'));
    fs.writeFileSync(arg(args, '--print-to-pdf'), '%PDF-1.4 a printed story\n%%EOF\n');
    return { error: null };
  };
}

test('sealHtml puts a content policy in front of everything else in the head, so nothing in the page runs or loads', () => {
  const sealed = pdf.sealHtml(PAGE);
  const head = sealed.indexOf('<head>');
  assert.equal(sealed.indexOf('<meta http-equiv="Content-Security-Policy"'), head + '<head>'.length);
  assert.ok(sealed.indexOf("default-src 'none'") !== -1);
  assert.ok(sealed.indexOf('script-src') === -1, 'no script source is allowed, so none is named');
  assert.ok(sealed.endsWith(PAGE.slice(PAGE.indexOf('<meta charset'))), 'the rest of the page is unchanged');
  assert.equal(pdf.sealHtml('<p>no head at all</p>'), null);
});

test('htmlToPdf prints the sealed page with a headless browser on a profile of its own and puts the PDF where it was asked to', async () => {
  const out = outFile();
  const seen = {};
  const res = await pdf.htmlToPdf(PAGE, out, { findBrowser: () => 'C:/browser/app.exe', run: printingBrowser(seen) });
  assert.deepEqual(res, { ok: true });
  assert.equal(fs.readFileSync(out, 'utf8'), '%PDF-1.4 a printed story\n%%EOF\n');
  assert.equal(seen.exe, 'C:/browser/app.exe');
  assert.ok(seen.args.some((a) => a.indexOf('--headless') === 0), 'headless: ' + seen.args.join(' '));
  assert.ok(arg(seen.args, '--user-data-dir'), 'a profile of its own, never the one the owner browses with');
  assert.ok(/^file:\/\//.test(seen.args[seen.args.length - 1]), 'the page is handed over as a file');
  assert.ok(seen.page.indexOf('Content-Security-Policy') !== -1, 'the page the browser gets is the sealed one');
  assert.equal(fs.existsSync(seen.workDir), false, 'the folder it worked in is gone');
});

test('htmlToPdf without a browser says so and writes nothing', async () => {
  const out = outFile();
  const res = await pdf.htmlToPdf(PAGE, out, { findBrowser: () => null, run: async () => { throw new Error('must not run'); } });
  assert.equal(res.ok, false);
  assert.equal(res.noBrowser, true);
  assert.equal(fs.existsSync(out), false);
});

test('htmlToPdf says why when the browser wrote no PDF, and leaves no file behind', async () => {
  const out = outFile();
  const seen = {};
  const res = await pdf.htmlToPdf(PAGE, out, {
    findBrowser: () => 'C:/browser/app.exe',
    run: async (exe, args) => { seen.workDir = path.dirname(arg(args, '--print-to-pdf')); return { error: 'it did not finish within 120 s' }; },
  });
  assert.equal(res.ok, false);
  assert.ok(res.message.indexOf('did not finish within 120 s') !== -1, res.message);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(seen.workDir), false);
  // a file that is not a PDF is not passed on as one
  const junk = await pdf.htmlToPdf(PAGE, out, {
    findBrowser: () => 'C:/browser/app.exe',
    run: async (exe, args) => { fs.writeFileSync(arg(args, '--print-to-pdf'), 'not a pdf'); return { error: null }; },
  });
  assert.equal(junk.ok, false);
  assert.equal(fs.existsSync(out), false);
  // a PDF the browser was stopped in the middle of: it starts like one and has no end
  const cut = await pdf.htmlToPdf(PAGE, out, {
    findBrowser: () => 'C:/browser/app.exe',
    run: async (exe, args) => { fs.writeFileSync(arg(args, '--print-to-pdf'), '%PDF-1.4 half a story'); return { error: 'it did not finish within 120 s' }; },
  });
  assert.equal(cut.ok, false);
  assert.ok(cut.message.indexOf('did not finish within 120 s') !== -1, cut.message);
  assert.equal(fs.existsSync(out), false);
});

test('htmlToPdf refuses a page without a head: it could not be sealed', async () => {
  const res = await pdf.htmlToPdf('<p>bare</p>', outFile(), { findBrowser: () => 'C:/browser/app.exe', run: async () => { throw new Error('must not run'); } });
  assert.equal(res.ok, false);
});

test('findBrowser takes the first candidate that exists, the named one first', () => {
  const have = new Set(['/usr/bin/chromium', '/opt/mine/browser']);
  const exists = (p) => have.has(p);
  assert.equal(pdf.findBrowser({ env: {}, exists, platform: 'linux' }), '/usr/bin/chromium');
  assert.equal(pdf.findBrowser({ env: { SESSION_BOARD_BROWSER: '/opt/mine/browser' }, exists, platform: 'linux' }), '/opt/mine/browser');
  assert.equal(pdf.findBrowser({ env: {}, exists: () => false, platform: 'linux' }), null);
});

const REAL = pdf.findBrowser();
test('with a browser of this machine, a page becomes a real PDF and a script in it does not run', { skip: REAL ? false : 'no Chromium-based browser found', timeout: 120000 }, async () => {
  const out = outFile();
  // the script would change the title the PDF carries; sealed, it never runs
  const page = PAGE.replace('<p>hello</p>', '<p>hello</p><script>document.title = "script ran";</script>');
  const res = await pdf.htmlToPdf(page, out);
  assert.deepEqual(res, { ok: true });
  const bytes = fs.readFileSync(out);
  assert.equal(bytes.slice(0, 5).toString('latin1'), '%PDF-');
  assert.ok(bytes.length > 500, 'a PDF of ' + bytes.length + ' bytes');
  const text = bytes.toString('latin1');
  assert.ok(/\/Title\s*\(Story\)/.test(text), 'the PDF carries the title the page was written with');
  assert.equal(text.indexOf('script ran'), -1);
});
