'use strict';
// The Marketplace binds an extension name to the publisher that first used it and reserves a
// removed name forever (the original name session-board was lost that way on 2026-09-24), so
// the listing nima-ghorbani.session-board-vscode is the only place this extension can be published.
// Renaming `publisher` or `name` breaks that binding, the heartbeat file names and the
// cross-window URI route at once; this test makes such a rename fail the build instead of the
// upload.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Same isolation as usage.test.cjs: core.cjs derives its data dir from these at load time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-manifest-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
const PKG = require('../package.json');
const core = require('../core.cjs');

test('manifest identity matches the Marketplace listing', () => {
  assert.equal(PKG.publisher, 'nima-ghorbani');
  assert.equal(PKG.name, 'session-board-vscode');
  assert.equal(PKG.displayName, 'Session Board for VS Code');   // "Session Board" is reserved too
  assert.equal(core.EXTENSION_ID, 'nima-ghorbani.session-board-vscode');
});

test('Marketplace page images are absolute links into extension/media', () => {
  // vsce rewrites a relative image link against the repository root, but the images live under
  // extension/media/, so a relative link lands one folder too high and the listing shows a
  // broken image. Absolute links are left alone.
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const links = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, 'the Marketplace page has at least one screenshot');
  for (const l of links) assert.match(l, /^https:\/\/github\.com\/nghorbani\/session-board\/raw\/HEAD\/extension\/media\//, l);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
