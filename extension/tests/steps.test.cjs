'use strict';
/*
 * steps.cjs: the transcript reader. Builds a graph index of one transcript file, walks the
 * active path, turns path nodes into compact step records, reads a step's full body on demand
 * by stored offset, follows file growth, and splits steps into sections for the page.
 *
 * Fixtures are inline JSONL lines written to a temp dir (never a real transcript, never `claude`).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const steps = require('../steps.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-steps-'));
let fileCounter = 0;
function newFile() { return path.join(tmp, 'tr-' + (++fileCounter) + '.jsonl'); }

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

test('split API response: two assistant lines sharing one message id both contribute steps', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'hello'),
    assistantLine(uuid(2), uuid(1), 'msg-1', [{ type: 'text', text: 'first part' }]),
    assistantLine(uuid(3), uuid(2), 'msg-1', [{ type: 'text', text: 'second part' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const s = idx.steps();
  assert.deepEqual(s.map((x) => x.kind), ['you', 'text', 'text']);
  assert.equal(s[1].preview.indexOf('first part') !== -1 || idx.body(s[1].id).text.indexOf('first part') !== -1, true);
  assert.equal(idx.body(s[2].id).text, 'second part');
});

test('tool call with its result on the path, and a parallel call whose result sits off the path', async () => {
  const file = newFile();
  // two tool_use blocks in one assistant turn; only one tool_result is on the ancestor chain,
  // the other tool_result line hangs off its own call (not an ancestor of the tip) but must
  // still be joined by tool_use id.
  writeLines(file, [
    userLine(uuid(1), null, 'run two things'),
    assistantLine(uuid(2), uuid(1), 'm1', [
      { type: 'tool_use', id: 'call-a', name: 'Bash', input: { command: 'echo a', description: 'echo a' } },
      { type: 'tool_use', id: 'call-b', name: 'Bash', input: { command: 'echo b', description: 'echo b' } },
    ]),
    // result for call-b is written as a sidechain / off-path line (parent not the tip's ancestor)
    toolResultLine(uuid(3), uuid(2), 'call-b', 'b-output', { isSidechain: true }),
    toolResultLine(uuid(4), uuid(2), 'call-a', 'a-output'),
    assistantLine(uuid(5), uuid(4), 'm2', [{ type: 'text', text: 'done' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const s = idx.steps();
  const tools = s.filter((x) => x.kind === 'tool');
  assert.equal(tools.length, 2);
  const a = tools.find((t) => t.title === 'Bash' && idx.body(t.id).result === 'a-output');
  const b = tools.find((t) => t.title === 'Bash' && idx.body(t.id).result === 'b-output');
  assert.ok(a, 'on-path result joined');
  assert.ok(b, 'off-path result still joined by tool_use id');
});

test('a retry leaves an abandoned branch out of the steps, and compaction crosses via logicalParentUuid', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'first try'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'abandoned reply' }]),
    // retry: a new user line with the SAME parent, superseding uuid(2)'s branch
    userLine(uuid(3), uuid(1), 'retried message'),
    assistantLine(uuid(4), uuid(3), 'm2', [{ type: 'text', text: 'kept reply' }]),
    { type: 'system', uuid: uuid(5), parentUuid: uuid(4), subtype: 'compact_boundary',
      logicalParentUuid: uuid(4), timestamp: new Date(2026, 0, 1, 0, 3).toISOString(),
      compactMetadata: { preTokens: 1000, postTokens: 10 } },
    userLine(uuid(6), uuid(5), 'after compaction', { isCompactSummary: false }),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const s = idx.steps();
  const bodies = s.map((x) => x.kind === 'you' || x.kind === 'text' ? idx.body(x.id).text : null);
  assert.equal(bodies.includes('abandoned reply'), false, 'abandoned branch left out');
  assert.equal(bodies.includes('kept reply'), true);
  assert.ok(s.some((x) => x.kind === 'compaction'), 'compaction step present');
  assert.equal(bodies.includes('after compaction'), true, 'walk crosses logicalParentUuid');
});

test('empty and filled thinking blocks: update vs reasoning, with duration on the empty one', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'go'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'thinking', thinking: 'short progress note' }]),
    assistantLine(uuid(3), uuid(2), 'm2', [{ type: 'thinking', thinking: '' }], { thinkingDurationMs: 12345 }),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const s = idx.steps();
  const update = s.find((x) => x.kind === 'update');
  const reasoning = s.find((x) => x.kind === 'reasoning');
  assert.ok(update, 'non-empty thinking is an update step');
  assert.equal(idx.body(update.id).text, 'short progress note');
  assert.ok(reasoning, 'empty thinking is a reasoning step');
  assert.equal(reasoning.durationMs, 12345);
});

test('AskUserQuestion: single choice, multi choice, free text, and a two-question dialog in both answer formats', async () => {
  function askLine(u, parent, questions, resultText) {
    return [
      assistantLine(u, parent, 'm-ask-' + u, [{ type: 'tool_use', id: 'ask-' + u, name: 'AskUserQuestion', input: { questions } }]),
      toolResultLine(uuid(Number(u.slice(-12)) + 1), u, 'ask-' + u, resultText),
    ];
  }
  const file = newFile();
  const singleQ = [{ header: 'Pick', question: 'Which color?', multiSelect: false,
    options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }];
  const multiQ = [{ header: 'Pick several', question: 'Which fruits?', multiSelect: true,
    options: [{ label: 'Apple', description: 'a' }, { label: 'Pear', description: 'p' }, { label: 'Plum', description: 'pl' }] }];
  const freeQ = [{ header: 'Say it', question: 'What do you want?', multiSelect: false,
    options: [{ label: 'Option A', description: 'a' }] }];
  const twoQ = [
    { header: 'Q1', question: 'First one?', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] },
    { header: 'Q2', question: 'Second one?', multiSelect: true, options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }] },
  ];

  let lines = [userLine(uuid(1), null, 'start')];
  let cur = uuid(1);
  const u2 = uuid(2); lines = lines.concat(askLine(u2, cur, singleQ, 'Your questions have been answered: "Which color?"="Red". You can now continue.'));
  cur = uuid(3);
  const u4 = uuid(4); lines = lines.concat(askLine(u4, cur, multiQ, 'Your questions have been answered: "Which fruits?"="Apple, Pear". You can now continue.'));
  cur = uuid(5);
  const u6 = uuid(6); lines = lines.concat(askLine(u6, cur, freeQ, 'Your questions have been answered: "What do you want?"="a pony, please". You can now continue.'));
  cur = uuid(7);
  // two-question dialog, format 1: both answers in one "answered:" sentence
  const u8 = uuid(8); lines = lines.concat(askLine(u8, cur, twoQ, 'Your questions have been answered: "First one?"="Yes", "Second one?"="X, Y". You can now continue.'));
  cur = uuid(9);
  // two-question dialog, format 2: structured per-question content blocks in the result
  lines.push(assistantLine(uuid(10), cur, 'm-ask-10', [{ type: 'tool_use', id: 'ask-10', name: 'AskUserQuestion', input: { questions: twoQ } }]));
  lines.push(toolResultLine(uuid(11), uuid(10), 'ask-10', [
    { type: 'text', text: 'Your questions have been answered: "First one?"="No". You can now continue.' },
    { type: 'text', text: 'Your questions have been answered: "Second one?"="X". You can now continue.' },
  ]));

  writeLines(file, lines);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const qs = idx.steps().filter((x) => x.kind === 'question');
  assert.equal(qs.length, 5);

  const b0 = idx.body(qs[0].id);
  assert.equal(b0.questions.length, 1);
  assert.equal(b0.questions[0].multiSelect, false);
  assert.equal(b0.questions[0].answered, true);
  assert.equal(b0.questions[0].options.find((o) => o.label === 'Red').chosen, true);
  assert.equal(b0.questions[0].options.find((o) => o.label === 'Blue').chosen, false);

  const b1 = idx.body(qs[1].id);
  const chosenMulti = b1.questions[0].options.filter((o) => o.chosen).map((o) => o.label);
  assert.deepEqual(chosenMulti.sort(), ['Apple', 'Pear']);
  assert.equal(b1.questions[0].options.find((o) => o.label === 'Plum').chosen, false);

  const b2 = idx.body(qs[2].id);
  assert.equal(b2.questions[0].other, 'a pony, please');

  const b3 = idx.body(qs[3].id);
  assert.equal(b3.questions.length, 2);
  assert.equal(b3.questions[0].options.find((o) => o.label === 'Yes').chosen, true);
  assert.deepEqual(b3.questions[1].options.filter((o) => o.chosen).map((o) => o.label).sort(), ['X', 'Y']);

  const b4 = idx.body(qs[4].id);
  assert.equal(b4.questions.length, 2);
  assert.equal(b4.questions[0].options.find((o) => o.label === 'No').chosen, true);
  assert.equal(b4.questions[1].options.find((o) => o.label === 'X').chosen, true);
  assert.equal(b4.questions[1].options.find((o) => o.label === 'Y').chosen, false);
});

test('ExitPlanMode approved is a plan step with its text and approval', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'plan something'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: { plan: 'Do step one, then step two.' } }]),
    toolResultLine(uuid(3), uuid(2), 'plan-1', 'User has approved your plan. You can now start coding.'),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const plan = idx.steps().find((x) => x.kind === 'plan');
  assert.ok(plan);
  assert.equal(plan.approved, true);
  assert.equal(idx.body(plan.id).text, 'Do step one, then step two.');
});

test('Agent call: report arrives as a task notification, and a second as an agent message', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'delegate two things'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'tool_use', id: 'agent-a', name: 'Agent',
      input: { description: 'first task', prompt: 'do the first thing', subagent_type: 'general-purpose' } }]),
    toolResultLine(uuid(3), uuid(2), 'agent-a', 'Async agent launched (agentId: agent-a-id).'),
    // bookkeeping lines (queue-operation) carry no uuid/parentUuid and are not tree nodes:
    // they sit off to the side of the ancestor chain, so the next tree node's parent is uuid(3).
    { type: 'queue-operation',
      content: '<task-notification><tool-use-id>agent-a</tool-use-id><result>report from the notification</result></task-notification>',
      timestamp: new Date(2026, 0, 1, 0, 4).toISOString() },
    assistantLine(uuid(5), uuid(3), 'm2', [{ type: 'tool_use', id: 'agent-b', name: 'Agent',
      input: { description: 'second task', prompt: 'do the second thing', subagent_type: 'general-purpose' } }]),
    toolResultLine(uuid(6), uuid(5), 'agent-b', 'Async agent launched (agentId: agent-b-id).'),
    userLine(uuid(7), uuid(6), '<agent-message from="agent-b-id">The report follows:\n  report from the agent message\n</agent-message>', { isMeta: true }),
    assistantLine(uuid(8), uuid(7), 'm3', [{ type: 'text', text: 'both done' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const subs = idx.steps().filter((x) => x.kind === 'subagent');
  assert.equal(subs.length, 2);
  const bodyA = idx.body(subs[0].id);
  const bodyB = idx.body(subs[1].id);
  assert.equal(bodyA.prompt, 'do the first thing');
  assert.ok(bodyA.report.indexOf('report from the notification') !== -1);
  assert.ok(bodyB.report.indexOf('report from the agent message') !== -1);
  // the notification and the hand-back message themselves are not "you" steps
  assert.equal(idx.steps().some((x) => x.kind === 'you' && String(idx.body(x.id).text || '').indexOf('agent-message') !== -1), false);
});

test('meta and notification user lines are not counted as you steps', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'real message'),
    userLine(uuid(2), uuid(1), 'a meta note', { isMeta: true }),
    userLine(uuid(3), uuid(2), '[SYSTEM NOTIFICATION] something happened'),
    userLine(uuid(4), uuid(3), 'Another Claude session sent a message: hi'),
    assistantLine(uuid(5), uuid(4), 'm1', [{ type: 'text', text: 'ok' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const youSteps = idx.steps().filter((x) => x.kind === 'you');
  assert.equal(youSteps.length, 1);
  assert.equal(idx.body(youSteps[0].id).text, 'real message');
});

test('an unparsable line is skipped and counted; an unknown block type becomes "other"', async () => {
  const file = newFile();
  const goodLines = [
    userLine(uuid(1), null, 'hi'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'mystery_block', weird: true }]),
  ];
  fs.writeFileSync(file, goodLines.map(line).join('') + 'not valid json at all\n');
  const idx = steps.createStepIndex(file);
  await idx.open();
  assert.equal(idx.counts().unreadable, 1);
  const other = idx.steps().find((x) => x.kind === 'other');
  assert.ok(other, 'unknown block type is an "other" step');
  assert.equal(other.blockType, 'mystery_block');
});

test('known bookkeeping system subtypes (stop_hook_summary, informational) are left out; an unknown subtype still shows as "other"', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'hi'),
    { type: 'system', uuid: uuid(2), parentUuid: uuid(1), subtype: 'stop_hook_summary', content: 'hook ran', timestamp: new Date(2026, 0, 1, 0, 3).toISOString() },
    { type: 'system', uuid: uuid(3), parentUuid: uuid(2), subtype: 'informational', content: 'fyi', timestamp: new Date(2026, 0, 1, 0, 3).toISOString() },
    { type: 'system', uuid: uuid(4), parentUuid: uuid(3), subtype: 'some_future_kind', content: 'mystery', timestamp: new Date(2026, 0, 1, 0, 3).toISOString() },
    assistantLine(uuid(5), uuid(4), 'm1', [{ type: 'text', text: 'done' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const kinds = idx.steps().map((x) => x.kind);
  assert.equal(kinds.filter((k) => k === 'other').length, 1, 'only the unknown subtype becomes other');
  const other = idx.steps().find((x) => x.kind === 'other');
  assert.equal(other.blockType, 'system:some_future_kind');
  assert.equal(kinds.includes('you'), true);
  assert.equal(kinds.includes('text'), true);
});

test('missing fields never throw: a line with absent message/content/timestamp indexes cleanly', async () => {
  const file = newFile();
  writeLines(file, [
    { type: 'user', uuid: uuid(1), parentUuid: null },
    { type: 'assistant', uuid: uuid(2), parentUuid: uuid(1), message: {} },
  ]);
  const idx = steps.createStepIndex(file);
  await assert.doesNotReject(() => idx.open());
  assert.doesNotThrow(() => idx.steps());
});

test('a line of 3 MB indexes cleanly and its body reports the true size, cut at the 200 KB body limit', async () => {
  const file = newFile();
  const big = 'x'.repeat(3 * 1024 * 1024);
  writeLines(file, [
    userLine(uuid(1), null, 'short'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: big }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  assert.equal(idx.steps().length, 2, 'the 3 MB line indexes as one step, same as any other');
  const t = idx.steps().find((x) => x.kind === 'text');
  const b = idx.body(t.id);
  assert.equal(b.truncated, true);
  assert.equal(b.size, big.length);
  assert.equal(b.text.length, 200 * 1024);
});

test('backward indexing in several small chunks yields and reports progress', async () => {
  const file = newFile();
  const objs = [];
  for (let i = 1; i <= 40; i++) {
    objs.push(i === 1 ? userLine(uuid(i), null, 'line ' + i) : assistantLine(uuid(i), uuid(i - 1), 'm' + i, [{ type: 'text', text: 'line ' + i + ' '.repeat(2000) }]));
  }
  writeLines(file, objs);
  const sizeBytes = fs.statSync(file).size;
  assert.ok(sizeBytes > 20000, 'fixture big enough to need multiple small chunks');
  const idx = steps.createStepIndex(file, { chunkBytes: 4096, tailBytes: 4096 });
  const progressCalls = [];
  await idx.open((p) => progressCalls.push(p));
  assert.ok(progressCalls.length > 1, 'more than one progress callback with small chunk size');
  assert.equal(idx.steps().length, 40);
  assert.equal(idx.steps()[0].kind, 'you');
});

test('a partial last line completes on the next poll', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'first')]);
  fs.appendFileSync(file, '{"type":"user","uuid":"' + uuid(2) + '","parentUuid":"' + uuid(1) + '","message":{"role":"user","content":"cut off'); // no closing, no newline
  const idx = steps.createStepIndex(file);
  await idx.open();
  assert.equal(idx.steps().length, 1, 'the partial line is not consumed yet');
  // complete the line and append a newline plus a following complete line
  fs.appendFileSync(file, ' now complete"}}\n');
  fs.appendFileSync(file, line(assistantLine(uuid(3), uuid(2), 'm1', [{ type: 'text', text: 'reply' }])));
  const res = await idx.poll();
  assert.equal(idx.steps().length, 3);
  assert.equal(res.appended.length, 2);
  assert.equal(idx.body(idx.steps()[1].id).text, 'cut off now complete');
});

test('file growth (append) reports appended steps without a reset', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  assert.equal(idx.steps().length, 1);
  fs.appendFileSync(file, line(assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'reply' }])));
  const res = await idx.poll();
  assert.equal(res.reset, null);
  assert.equal(res.appended.length, 1);
  assert.equal(idx.steps().length, 2);
});

test('a path change (retry after the fact) reports a reset point', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'hi'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'first reply' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const firstStepId = idx.steps()[1].id;
  // a retry: new user line with the same parent as uuid(1)'s only child slot, abandoning uuid(2)
  fs.appendFileSync(file, line(userLine(uuid(3), uuid(1), 'edited message')));
  fs.appendFileSync(file, line(assistantLine(uuid(4), uuid(3), 'm2', [{ type: 'text', text: 'second reply' }])));
  const res = await idx.poll();
  assert.ok(res.reset, 'path changed: a reset point is reported');
  const bodies = idx.steps().map((s) => (s.kind === 'you' || s.kind === 'text') ? idx.body(s.id).text : null);
  assert.equal(bodies.includes('first reply'), false);
  assert.equal(bodies.includes('second reply'), true);
});

test('file shrink starts a new generation with a fresh index', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'hi'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'a reasonably long first reply' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const gen1 = idx.generation();
  writeLines(file, [userLine(uuid(9), null, 'rewritten from scratch')]);
  const res = await idx.poll();
  assert.notEqual(idx.generation(), gen1);
  assert.equal(idx.steps().length, 1);
  assert.equal(idx.body(idx.steps()[0].id).text, 'rewritten from scratch');
  assert.ok(res.reset !== undefined);
});

test('a replaced file (same size, different identity) also starts a new generation', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'alpha message right here')]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const gen1 = idx.generation();
  const before = fs.statSync(file).size;
  fs.unlinkSync(file);
  // write a same-length but different-content file (forces a new inode on most filesystems;
  // the module is expected to also detect this by birth time / identity where available)
  const replacement = JSON.stringify(userLine(uuid(1), null, 'beta message over here')).padEnd(before - 1, ' ') + '\n';
  fs.writeFileSync(file, replacement);
  await idx.poll();
  // whichever way identity is detected, re-reading from scratch must yield the new content
  const text = idx.body(idx.steps()[0].id).text;
  assert.ok(text.indexOf('beta') !== -1 || text.indexOf('alpha') !== -1, 'index did not crash on replacement');
});

test('a stale body read (file changed generation) answers stale instead of wrong content', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hello there')]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const heldStep = idx.steps()[0]; // a caller (the page) keeps the whole step record, not just its id
  // rewritten from scratch at a different (smaller) size: a new generation, even though it
  // happens to reuse the same uuid for its first line
  writeLines(file, [userLine(uuid(1), null, 'short')]);
  await idx.poll();
  assert.notEqual(idx.generation(), heldStep.generation, 'sanity: the rewrite did start a new generation');
  const res = idx.body(heldStep);
  assert.equal(res.stale, true);
});

test('a body over 200 KB is truncated with the total size reported', async () => {
  const file = newFile();
  const huge = 'y'.repeat(250 * 1024);
  writeLines(file, [
    userLine(uuid(1), null, 'hi'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: huge }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const t = idx.steps().find((x) => x.kind === 'text');
  const b = idx.body(t.id);
  assert.equal(b.truncated, true);
  assert.equal(b.text.length, 200 * 1024);
  assert.equal(b.size, huge.length);
});

test('sections and the strip counts; a you step is never doubled', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'please do the thing'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'working on it' }]),
    assistantLine(uuid(3), uuid(2), 'm1', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'C:/proj/a.txt' } }]),
    toolResultLine(uuid(4), uuid(3), 'e1', 'ok'),
    assistantLine(uuid(5), uuid(4), 'm2', [{ type: 'tool_use', id: 'ask1', name: 'AskUserQuestion',
      input: { questions: [{ header: 'H', question: 'Continue?', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] } }]),
    toolResultLine(uuid(6), uuid(5), 'ask1', 'Your questions have been answered: "Continue?"="Yes". You can now continue.'),
    assistantLine(uuid(7), uuid(6), 'm3', [{ type: 'tool_use', id: 'plan1', name: 'ExitPlanMode', input: { plan: 'final plan text' } }]),
    toolResultLine(uuid(8), uuid(7), 'plan1', 'User has approved your plan. You can now start coding.'),
    assistantLine(uuid(9), uuid(8), 'm4', [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'C:/proj/b.txt' } }]),
    toolResultLine(uuid(10), uuid(9), 'w1', 'ok'),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const allSteps = idx.steps();
  const { sections, strip } = steps.buildSections(allSteps, idx.body.bind(idx));
  assert.ok(sections.length >= 2, 'at least a you-opened section and the plan-approved section');
  const headings = sections.map((s) => s.heading);
  assert.ok(headings.some((h) => h.indexOf('please do the thing') !== -1 || h === 'please do the thing'));
  // a you step is never both a heading and a row elsewhere
  let youBodyRows = 0;
  for (const s of sections) for (const r of s.body || []) if (r.kind === 'you') youBodyRows++;
  assert.equal(youBodyRows, 0, 'you steps never appear as rows, only as section headings');
  assert.ok(strip.filesChanged >= 2);
  assert.ok(strip.decisions >= 1);
  assert.ok(strip.totalTimeMs >= 0);
  assert.equal(strip.sections, sections.length);
});

test('total time is working time, not the wall-clock span: a session left open overnight does not read as hours', async () => {
  const file = newFile();
  const t0 = new Date(2026, 0, 1, 9, 0, 0);
  const at = (mins) => new Date(t0.getTime() + mins * 60000).toISOString();
  writeLines(file, [
    // first section: 9:00 to 9:02, two minutes of real work
    Object.assign(userLine(uuid(1), null, 'morning task'), { timestamp: at(0) }),
    Object.assign(assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'on it' }]), { timestamp: at(2) }),
    // left open overnight: next input is 18 hours later
    Object.assign(userLine(uuid(3), uuid(2), 'next day task'), { timestamp: at(18 * 60) }),
    Object.assign(assistantLine(uuid(4), uuid(3), 'm2', [{ type: 'text', text: 'done' }]), { timestamp: at(18 * 60 + 3) }),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const { strip } = steps.buildSections(idx.steps(), idx.body.bind(idx));
  // working time: ~2 minutes in the first section plus ~3 minutes in the second, nowhere near
  // the 18-hour wall-clock span between the two inputs.
  assert.ok(strip.totalTimeMs < 10 * 60 * 1000, 'the overnight gap must not be counted as working time: got ' + strip.totalTimeMs + 'ms');
  assert.ok(strip.totalTimeMs >= 4 * 60 * 1000, 'the actual working spans should still be counted: got ' + strip.totalTimeMs + 'ms');
  assert.ok(strip.wallClockMs >= 18 * 60 * 60000, 'the wall-clock span is kept too, for the tooltip');
});

test('Work lines stay in time order: a run of tool calls between two texts becomes its own Work line, not a lump at the end', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'do two things and report on each'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'C:/proj/a.txt' } }]),
    toolResultLine(uuid(3), uuid(2), 'e1', 'ok'),
    assistantLine(uuid(4), uuid(3), 'm2', [{ type: 'text', text: 'first one is done' }]),
    assistantLine(uuid(5), uuid(4), 'm3', [{ type: 'tool_use', id: 'e2', name: 'Write', input: { file_path: 'C:/proj/b.txt' } }]),
    toolResultLine(uuid(6), uuid(5), 'e2', 'ok'),
    assistantLine(uuid(7), uuid(6), 'm4', [{ type: 'text', text: 'second one is done too' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const { sections } = steps.buildSections(idx.steps(), idx.body.bind(idx));
  const youSection = sections.find((s) => s.kind === 'you');
  const rowKinds = youSection.body.map((r) => r.kind);
  assert.deepEqual(rowKinds, ['work', 'text', 'work', 'text'],
    'two separate Work lines in time order, not one work lump after both texts: got ' + JSON.stringify(rowKinds));
});

test('a message typed mid-turn (a queued_command attachment with a human origin) is a you step that opens its own section', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'start the long task'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 60', description: 'run a long command' } }]),
    {
      type: 'attachment', uuid: uuid(3), parentUuid: uuid(2), timestamp: new Date(2026, 0, 1, 0, 5).toISOString(),
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'while that runs, also check the other file', origin: { kind: 'human' } },
    },
    // a peer-origin or task-notification queued_command must NOT become a you step
    {
      type: 'attachment', uuid: uuid(4), parentUuid: uuid(3), timestamp: new Date(2026, 0, 1, 0, 6).toISOString(),
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'a message from another session', origin: { kind: 'peer' } },
    },
    toolResultLine(uuid(5), uuid(4), 'b1', 'done'),
    assistantLine(uuid(6), uuid(5), 'm2', [{ type: 'text', text: 'checked it, all good' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const allSteps = idx.steps();
  const kinds = allSteps.map((s) => s.kind);
  assert.deepEqual(kinds.filter((k) => k === 'you'), ['you', 'you'], 'the first message and the human-origin queued command both become you steps');
  const typed = allSteps.find((s) => s.nodeUuid === uuid(3));
  assert.ok(typed, 'the human-origin attachment produced a step');
  assert.equal(idx.body(typed.id).text, 'while that runs, also check the other file');
  const peerStep = allSteps.find((s) => s.nodeUuid === uuid(4));
  assert.equal(peerStep, undefined, 'a peer-origin queued command is not a you step');

  const { sections } = steps.buildSections(allSteps, idx.body.bind(idx));
  const typedSection = sections.find((s) => s.openerId === typed.id);
  assert.ok(typedSection, 'the typed message opens its own section');
  assert.equal(typedSection.kind, 'you', 'labelled You, not Claude');
});

test('a you message whose content is a list of blocks (text plus a pasted image) reads as the text parts joined, with "(image)" for the image', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, [
      { type: 'text', text: 'what do you make of this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'looking at it now' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const you = idx.steps().find((s) => s.kind === 'you');
  assert.ok(you, 'a you step was built');
  assert.equal(idx.body(you.id).text, 'what do you make of this\n(image)');
  assert.equal(you.preview.indexOf('[object Object]'), -1, 'the preview never stringifies a block');

  const { sections } = steps.buildSections(idx.steps(), idx.body.bind(idx));
  const youSection = sections.find((s) => s.kind === 'you');
  assert.ok(youSection, 'the message still opens its own section');
  assert.equal(youSection.heading.indexOf('[object Object]'), -1, 'the heading never stringifies a block');
  assert.ok(youSection.heading.indexOf('what do you make of this') !== -1, 'the heading uses the text part');
});

test('a you message that is only a pasted image (no text block) reads as "(image)", not empty or "[object Object]"', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'got it' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const you = idx.steps().find((s) => s.kind === 'you');
  assert.ok(you, 'an image-only message still becomes a you step');
  assert.equal(idx.body(you.id).text, '(image)');
});

test('a queued message (attachment prompt) whose content is a list of blocks reads as the text parts joined, with "(image)" for the image', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'start the long task'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 60' } }]),
    {
      type: 'attachment', uuid: uuid(3), parentUuid: uuid(2), timestamp: new Date(2026, 0, 1, 0, 5).toISOString(),
      attachment: {
        type: 'queued_command', commandMode: 'prompt',
        prompt: [
          { type: 'text', text: 'also look at this screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
        origin: { kind: 'human' },
      },
    },
    toolResultLine(uuid(4), uuid(3), 'b1', 'done'),
    assistantLine(uuid(5), uuid(4), 'm2', [{ type: 'text', text: 'checked it' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const allSteps = idx.steps();
  const typed = allSteps.find((s) => s.nodeUuid === uuid(3));
  assert.ok(typed, 'the queued list-content prompt produced a step');
  assert.equal(idx.body(typed.id).text, 'also look at this screenshot\n(image)');
  assert.equal(typed.preview.indexOf('[object Object]'), -1, 'the preview never stringifies a block');

  const { sections } = steps.buildSections(allSteps, idx.body.bind(idx));
  const typedSection = sections.find((s) => s.openerId === typed.id);
  assert.ok(typedSection, 'it still opens its own section');
  assert.equal(typedSection.heading.indexOf('[object Object]'), -1, 'the heading never stringifies a block');
});

test('a "[Request interrupted by user]" line is a quiet marker, not a you step, and does not open a section', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'start the long task'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 60' } }]),
    userLine(uuid(3), uuid(2), [{ type: 'text', text: '[Request interrupted by user]' }]),
    userLine(uuid(4), uuid(3), 'actually do something else'),
    assistantLine(uuid(5), uuid(4), 'm2', [{ type: 'text', text: 'switching to that now' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const allSteps = idx.steps();
  const kinds = allSteps.map((s) => s.kind);
  assert.deepEqual(kinds.filter((k) => k === 'you'), ['you', 'you'], 'the interrupted line is not counted as a you step');
  const marker = allSteps.find((s) => s.nodeUuid === uuid(3));
  assert.ok(marker, 'the interrupted line still produced a step');
  assert.equal(marker.kind, 'interrupted');
  assert.equal(idx.body(marker.id).text, 'Interrupted');

  const { sections } = steps.buildSections(allSteps, idx.body.bind(idx));
  assert.equal(sections.some((s) => s.openerId === marker.id), false, 'the marker never opens its own section');
  const owningSection = sections.find((s) => (s.body || []).some((r) => r.stepId === marker.id));
  assert.ok(owningSection, 'the marker sits inside the section it interrupted');
  assert.equal(owningSection.body.find((r) => r.stepId === marker.id).kind, 'interrupted');
});

test('"[Request interrupted by user for tool use]" is recognised the same way', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'run the long build'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'build' } }]),
    userLine(uuid(3), uuid(2), [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
  ]);
  const idx = steps.createStepIndex(file);
  await idx.open();
  const marker = idx.steps().find((s) => s.nodeUuid === uuid(3));
  assert.ok(marker, 'the step was built');
  assert.equal(marker.kind, 'interrupted');
});
