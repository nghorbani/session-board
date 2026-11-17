'use strict';
/*
 * Transcript lines in the shape Claude Code stores them, for the suites that write a JSONL
 * fixture into a temp dir (steps.test.cjs, steps-service.test.cjs). One place, so a change to
 * the stored shape reaches every suite that builds on it.
 */
const fs = require('fs');

/** A line uuid from a small number; its last two digits also set the seconds of the timestamp. */
function uuid(n) {
  const s = String(n).padStart(12, '0');
  return '00000000-0000-4000-8000-' + s;
}
function line(obj) { return JSON.stringify(obj) + '\n'; }
function writeLines(file, objs) { fs.writeFileSync(file, objs.map(line).join('')); }

function userLine(u, parent, text, extra) {
  return Object.assign({ type: 'user', uuid: u, parentUuid: parent, timestamp: new Date(2026, 0, 1, 0, 0, Number(u.slice(-2)) || 0).toISOString(),
    message: { role: 'user', content: text } }, extra);
}
function toolResultLine(u, parent, toolUseId, resultContent, extra) {
  return Object.assign({ type: 'user', uuid: u, parentUuid: parent, timestamp: new Date(2026, 0, 1, 0, 1, Number(u.slice(-2)) || 0).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: resultContent }] },
    toolUseResult: {}, sourceToolAssistantUUID: parent }, extra);
}
function assistantLine(u, parent, msgId, content, extra) {
  return Object.assign({ type: 'assistant', uuid: u, parentUuid: parent, timestamp: new Date(2026, 0, 1, 0, 2, Number(u.slice(-2)) || 0).toISOString(),
    message: { id: msgId, role: 'assistant', content } }, extra);
}

module.exports = { uuid, line, writeLines, userLine, toolResultLine, assistantLine };
