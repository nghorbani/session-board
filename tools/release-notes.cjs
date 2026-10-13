#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section of one version, for the notes of a GitHub Release.
 *
 *   node tools/release-notes.cjs 0.6.0     -> the bullets under "## 0.6.0"
 *
 * Exit 1 when the version has no section, so a tag without release notes fails the workflow
 * before a release is created.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CHANGELOG = path.join(__dirname, '..', 'extension', 'CHANGELOG.md');

/** The lines between "## <version>" and the next "## " heading, trimmed; null when absent or empty. */
function notesFor(text, version) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '## ' + version);
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  const out = body.join('\n').trim();
  return out || null;
}

if (require.main === module) {
  const version = String(process.argv[2] || '').replace(/^v/, '');
  if (!version) { console.error('usage: release-notes.cjs <version>'); process.exit(2); }
  const notes = notesFor(fs.readFileSync(CHANGELOG, 'utf8'), version);
  if (!notes) { console.error('CHANGELOG.md has no "## ' + version + '" section'); process.exit(1); }
  process.stdout.write(notes + '\n');
}

module.exports = { notesFor };
