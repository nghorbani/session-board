'use strict';
/*
 * ✎ in core.cjs: the transcript excerpt the title call sees, the cleaning of the model's
 * reply, and retitleSession() against the shim (SB_SHIM_TITLE picks the reply). No real
 * model call: the shim stands in for the CLI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-retitle-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
const sessionsDir = path.join(tmp, 'sessions');
const projectsDir = path.join(tmp, 'projects');
fs.mkdirSync(sessionsDir);
fs.mkdirSync(path.join(projectsDir, 'proj'), { recursive: true });
process.env.SB_SESSIONS_DIR = sessionsDir;
process.env.SB_PROJECTS_DIR = projectsDir;
process.env.PATH = path.join(__dirname, 'shim') + path.delimiter + process.env.PATH;
const core = require('../core.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';
const transcript = path.join(projectsDir, 'proj', A + '.jsonl');
const line = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(transcript,
  line({ type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>injected</system-reminder>' }, sessionId: A })
  + line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the walnut threshold' }] }, sessionId: A })
  + line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'I looked at the config.' }, { type: 'tool_use', name: 'Read', input: {} }] }, sessionId: A })
  + line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'file contents' }] }, sessionId: A })
  + line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, sessionId: A })
  + line({ type: 'user', message: { role: 'user', content: 'Now verify on Thor' }, sessionId: A })
  + line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Verified on Thor; the detection rate is 97 %.' }] }, sessionId: A })
  + 'not json\n'
  + line({ type: 'ai-title', aiTitle: 'Generated', sessionId: A }));

test('transcriptExcerpt: the prompts and the last answer; injected, markup and tool lines skipped', () => {
  const ex = core.transcriptExcerpt(transcript);
  assert.match(ex, /Prompt 1: Fix the walnut threshold/);
  assert.match(ex, /Prompt 2: Now verify on Thor/);
  assert.match(ex, /Last answer: Verified on Thor; the detection rate is 97 %\./);
  assert.ok(!/system-reminder|command-name|file contents|I looked at the config|hmm/.test(ex), ex);
  assert.equal(core.transcriptExcerpt(path.join(tmp, 'missing.jsonl')), '');
  const empty = path.join(projectsDir, 'proj', B + '.jsonl');
  fs.writeFileSync(empty, line({ type: 'ai-title', aiTitle: 'No prompts', sessionId: B }));
  assert.equal(core.transcriptExcerpt(empty), '', 'a transcript without a prompt gives nothing');
});

test('transcriptExcerpt: a prompt buried behind megabytes of tool output is still found, newest answer kept', () => {
  const buried = path.join(projectsDir, 'proj', 'cccccccc-3333-4333-8333-333333333333.jsonl');
  const filler = 'x'.repeat(1000);
  const parts = [
    line({ type: 'user', message: { role: 'user', content: 'First ask with an umlaut: Größe' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Old answer' }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Second ask' }] } }),
  ];
  for (let i = 0; i < 2600; i++) parts.push(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: filler + i }] } }));
  parts.push(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Newest answer after the tool run' }] } }));
  fs.writeFileSync(buried, parts.join(''));
  assert.ok(fs.statSync(buried).size > 2.5 * 1024 * 1024, 'the tool run spans more than two chunks');
  const ex = core.transcriptExcerpt(buried);
  assert.match(ex, /Prompt 1: First ask with an umlaut: Größe/);
  assert.match(ex, /Prompt 2: Second ask/);
  assert.match(ex, /Last answer: Newest answer after the tool run/);
  assert.ok(!/Old answer/.test(ex), 'only the newest answer is kept');
  fs.unlinkSync(buried);
});

test('cleanTitle: the last line, quotes and a trailing period stripped, length capped', () => {
  assert.equal(core.cleanTitle('Permission warning line\n"Walnut threshold fix verified."\n'), 'Walnut threshold fix verified');
  assert.equal(core.cleanTitle("  'Single quoted'  "), 'Single quoted');
  assert.equal(core.cleanTitle('Title:  two   spaces'), 'Title: two spaces');
  assert.equal(core.cleanTitle('\n\n'), null);
  assert.equal(core.cleanTitle(null), null);
  assert.equal(core.cleanTitle('x'.repeat(200)).length, 80);
});

test('retitleSession: the shim reply is cleaned and stored, and the prompt carries the excerpt', async () => {
  const promptFile = path.join(tmp, 'prompt.txt');
  process.env.SB_SHIM_TITLE_PROMPT_FILE = promptFile;
  const r = await core.retitleSession(A, { timeoutMs: 20000 });
  delete process.env.SB_SHIM_TITLE_PROMPT_FILE;
  assert.deepEqual(r, { ok: true, title: 'Walnut threshold fix verified on Thor' });
  const stored = core.readTitles().get(A);
  assert.equal(stored.title, 'Walnut threshold fix verified on Thor');
  assert.ok(stored.at > 0);
  assert.equal(stored.seenCustomTitle, null);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  assert.match(prompt, /Reply with the title only/);
  assert.match(prompt, /Prompt 2: Now verify on Thor/);
  assert.match(prompt, /Last answer: Verified on Thor/);
});

test('retitleSession: failures are reported and nothing is stored', async () => {
  fs.rmSync(core.TITLES_DIR, { recursive: true, force: true });
  process.env.SB_SHIM_TITLE = 'fail';
  let r = await core.retitleSession(A, { timeoutMs: 20000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'failed');
  assert.match(r.message, /model not available/);
  process.env.SB_SHIM_TITLE = 'empty';
  r = await core.retitleSession(A, { timeoutMs: 20000 });
  assert.deepEqual([r.ok, r.code], [false, 'empty']);
  process.env.SB_SHIM_TITLE = 'hang';
  const t0 = Date.now();
  r = await core.retitleSession(A, { timeoutMs: 1500 });
  delete process.env.SB_SHIM_TITLE;
  assert.deepEqual([r.ok, r.code], [false, 'timeout'], JSON.stringify(r));
  assert.match(r.message, /did not answer within 2 s/);
  assert.ok(Date.now() - t0 < 15000, 'returned after the timeout');
  r = await core.retitleSession('nope', {});
  assert.deepEqual([r.ok, r.code], [false, 'invalid']);
  r = await core.retitleSession(B, {});
  assert.deepEqual([r.ok, r.code], [false, 'no-transcript'], 'a transcript without prompts');
  r = await core.retitleSession('cccccccc-3333-4333-8333-333333333333', {});
  assert.deepEqual([r.ok, r.code], [false, 'no-transcript'], 'no transcript at all');
  assert.equal(core.readTitles().has(A), false);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
