'use strict';
// tools/release-notes.cjs prints one CHANGELOG section as the notes of a GitHub Release. A tag
// for a version the changelog does not know must fail before a release is created, and the
// manifest version must always have its section, so a forgotten changelog entry fails the build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { notesFor } = require('../../tools/release-notes.cjs');

const PKG = require('../package.json');
const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'release-notes.cjs');
const SAMPLE = '# Changelog\n\n## 0.6.0\n\n- first line\n- second line\n\n## 0.5.0\n\n- older\n';

test('notesFor returns the bullets of one version only', () => {
  assert.equal(notesFor(SAMPLE, '0.6.0'), '- first line\n- second line');
  assert.equal(notesFor(SAMPLE, '0.5.0'), '- older');
  assert.equal(notesFor(SAMPLE, '0.4.0'), null);
  assert.equal(notesFor(SAMPLE.replace(/\n/g, '\r\n'), '0.5.0'), '- older', 'CRLF changelogs work too');
});

test('the changelog has a section for the manifest version', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  assert.ok(notesFor(text, PKG.version), 'CHANGELOG.md lacks a "## ' + PKG.version + '" section');
});

test('the command prints the section, accepts a v prefix, and fails on an unknown version', () => {
  const out = execFileSync(process.execPath, [SCRIPT, 'v' + PKG.version], { encoding: 'utf8' });
  assert.match(out, /^- /);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '0.0.0'], { encoding: 'utf8', stdio: 'pipe' }), /no "## 0\.0\.0" section/);
});
