'use strict';
/*
 * steps-service.cjs: the message-based service that sits between the two transports (the
 * VS Code panel and the browser page) and steps.cjs. One handle(msg) per request/reply
 * message, one subscribe(sessionId, cb) for pushes (follow and indexing progress).
 *
 * Every dependency is injected: fs, the follow timer, the ripgrep runner and the transcript
 * lookup. No real transcript is ever read and no real `claude` or `rg` is spawned here; one
 * optional test runs the real `rg` only when rgProbe finds it on this machine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svcMod = require('../steps-service.cjs');
const core = require('../core.cjs');

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-9999-000000000000';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stepsvc-'));
let fileCounter = 0;
function newFile() { return path.join(tmp, 'tr-' + (++fileCounter) + '.jsonl'); }

const { uuid, line, writeLines, userLine, toolResultLine, assistantLine } = require('./shim/transcript.cjs');

/* a fake timer: setInterval/clearInterval replaced with handles the test fires by hand */
function fakeTimer() {
  const handles = new Map();
  let nextId = 1;
  return {
    setInterval: (fn) => { const id = nextId++; handles.set(id, fn); return id; },
    clearInterval: (id) => { handles.delete(id); },
    fire: async (id) => { const fn = handles.get(id); if (fn) await fn(); },
    fireAll: async () => { for (const fn of [...handles.values()]) await fn(); },
    size: () => handles.size,
  };
}

function makeDeps(overrides) {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const files = new Map(); // sessionId -> file path
  const titles = new Map();
  const timer = fakeTimer();
  const deps = {
    dataDir,
    resolveTranscript: (sessionId) => files.get(sessionId) || null,
    sessionTitle: (sessionId) => titles.get(sessionId) || null,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    pollIntervalMs: 1000,
    progressIntervalMs: 0,
    rg: {
      probe: async () => ({ path: null, error: 'not used in this test' }),
      run: async () => ({ code: 1, stdout: '', stderr: '' }),
      RG_BASE: core.RG_BASE,
      jsonEscaped: core.jsonEscaped,
    },
  };
  Object.assign(deps, overrides || {});
  deps.__files = files;
  deps.__titles = titles;
  deps.__timer = timer;
  return deps;
}

test('open on a small file replies with title, sections, strip, steps, generation and not-running index; seen defaults to null', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'please do the thing'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'working on it' }]),
  ]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  deps.__titles.set(A, 'My session');
  const svc = svcMod.createStepsService(deps);
  const reply = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  assert.equal(reply.type, 'openResult');
  assert.equal(reply.requestId, 'r1');
  assert.equal(reply.ok, true);
  assert.equal(reply.title, 'My session');
  assert.ok(Array.isArray(reply.sections));
  assert.ok(reply.strip);
  assert.ok(Array.isArray(reply.steps));
  assert.equal(typeof reply.generation, 'number');
  assert.equal(reply.indexing, false, 'a small file finishes indexing within open()');
  assert.equal(reply.seenStepId, null);
});

test('open on a file bigger than the tail replies early with indexing: true, then finishes in the background', async () => {
  const file = newFile();
  const objs = [];
  for (let i = 1; i <= 40; i++) {
    objs.push(i === 1 ? userLine(uuid(i), null, 'line ' + i) : assistantLine(uuid(i), uuid(i - 1), 'm' + i, [{ type: 'text', text: 'line ' + i + ' '.repeat(2000) }]));
  }
  writeLines(file, objs);
  // a tail far smaller than the file: open() must reply once the tail's own share of the file
  // is covered, long before the whole backward pass (which keeps running after the reply).
  const deps = makeDeps({ chunkBytes: 4096, tailBytes: 4096 });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  let doneSeen;
  const donePromise = new Promise((resolve) => { doneSeen = resolve; });
  svc.subscribe(A, (msg) => {
    pushes.push(msg);
    if (msg.type === 'stepsProgress' && msg.done) doneSeen();
  });
  const reply = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  assert.equal(reply.ok, true);
  assert.equal(reply.indexing, true, 'the backward pass has not covered the whole file yet');
  assert.ok(reply.steps.length < 40, 'only the tail is in at first paint');
  await donePromise;   // the background pass keeps running after the reply and eventually finishes
  assert.ok(pushes.some((m) => m.type === 'stepsProgress' && m.sessionId === A));
  const last = pushes.filter((m) => m.type === 'stepsProgress').pop();
  assert.equal(last.done, true);
  assert.equal(last.sections.length > 0, true, 'the completion push carries the full section list');
});

test('provisional pushes while indexing carry the growing section list under a stable key per section', async () => {
  const file = newFile();
  const objs = [];
  for (let i = 1; i <= 40; i++) {
    objs.push(i % 4 === 1 ? userLine(uuid(i), i === 1 ? null : uuid(i - 1), 'turn ' + i) : assistantLine(uuid(i), uuid(i - 1), 'm' + i, [{ type: 'text', text: 'line ' + i + ' '.repeat(2000) }]));
  }
  writeLines(file, objs);
  const deps = makeDeps({ chunkBytes: 4096, tailBytes: 4096 });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  let doneSeen;
  const donePromise = new Promise((resolve) => { doneSeen = resolve; });
  svc.subscribe(A, (msg) => {
    pushes.push(msg);
    if (msg.type === 'stepsProgress' && msg.done) doneSeen();
  });
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  await donePromise;
  const progress = pushes.filter((m) => m.type === 'stepsProgress');
  assert.ok(progress.length > 2, 'more than the first paint and the completion push');
  // every section the earliest provisional push already named keeps answering to the same
  // section-opening step id (its stable key) in every later push, right up to completion: the
  // page can merge pushes onto what it already drew without losing track of a section it has
  // already rendered, however many more sections arrive behind it as indexing continues.
  const firstKeys = progress[0].sections.map((s) => s.openerId).filter(Boolean);
  const lastKeys = progress[progress.length - 1].sections.map((s) => s.openerId).filter(Boolean);
  for (const k of firstKeys) assert.ok(lastKeys.includes(k), 'a section seen early is still present, under the same key, once indexing finishes');
  assert.ok(progress[progress.length - 1].sections.length >= progress[0].sections.length, 'sections only grow as indexing proceeds backward');
});

test('progress pushes while indexing are spaced in time: a pass faster than the interval sends one provisional push and the completion', async () => {
  const file = newFile();
  const objs = [];
  for (let i = 1; i <= 40; i++) {
    objs.push(i % 4 === 1 ? userLine(uuid(i), i === 1 ? null : uuid(i - 1), 'turn ' + i) : assistantLine(uuid(i), uuid(i - 1), 'm' + i, [{ type: 'text', text: 'line ' + i + ' '.repeat(2000) }]));
  }
  writeLines(file, objs);
  // the clock stands still, so every chunk after the first reports inside the interval
  const deps = makeDeps({ chunkBytes: 4096, tailBytes: 4096, progressIntervalMs: 500, now: () => 1000 });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const progress = [];
  let doneSeen;
  const donePromise = new Promise((resolve) => { doneSeen = resolve; });
  svc.subscribe(A, (msg) => {
    if (msg.type !== 'stepsProgress') return;
    progress.push(msg);
    if (msg.done) doneSeen();
  });
  const reply = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  assert.equal(reply.indexing, true, 'first paint still comes before the whole pass');
  await donePromise;
  assert.equal(progress.length, 2, 'one provisional push, then the completion');
  assert.equal(progress[0].done, false);
  assert.equal(progress[1].done, true);
  assert.equal(progress[1].sections.length, 10, 'the completion push carries every section');
});

test('bodies: one round trip loads the texts of several steps at once', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'first message'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'first reply' }]),
    userLine(uuid(3), uuid(2), 'second message'),
  ]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const ids = opened.steps.map((s) => s.id);
  const res = await svc.handle({ type: 'bodies', sessionId: A, stepIds: ids, generation: opened.generation });
  assert.equal(res.type, 'bodiesResult');
  assert.equal(res.items.length, 3);
  assert.deepEqual(res.items.map((it) => it.stepId), ids);
  assert.equal(res.items[0].text, 'first message');
  assert.equal(res.items[1].text, 'first reply');
  assert.equal(res.items[2].text, 'second message');
});

test('a section is headed by the words typed after a paste, also when the paste is longer than the 200 KB a body shows', async () => {
  const file = newFile();
  const paste = '<pasted_content id="ab12">\n' + 'a line of a long log\n'.repeat(13000) + '</pasted_content>\n';
  assert.ok(paste.length > 250 * 1024);
  writeLines(file, [userLine(uuid(1), null, paste + 'Why does this fail?'), assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'because' }])]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  assert.equal(opened.sections.find((sec) => sec.kind === 'you').heading, 'Why does this fail?');
});

test('the heading after a long paste stays your words when indexing goes on in the background and finishes', async () => {
  const file = newFile();
  const paste = '<pasted_content id="ab12">\n' + 'a line of a long log\n'.repeat(13000) + '</pasted_content>\n';
  const objs = [];
  for (let i = 1; i <= 30; i++) {
    objs.push(i === 1 ? userLine(uuid(i), null, 'line ' + i) : assistantLine(uuid(i), uuid(i - 1), 'm' + i, [{ type: 'text', text: 'line ' + i + ' '.repeat(2000) }]));
  }
  objs.push(userLine(uuid(31), uuid(30), paste + 'Why does this fail?'), assistantLine(uuid(32), uuid(31), 'm32', [{ type: 'text', text: 'because' }]));
  writeLines(file, objs);
  const deps = makeDeps({ chunkBytes: 4096, tailBytes: 4096 });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  let doneSeen;
  const donePromise = new Promise((resolve) => { doneSeen = resolve; });
  svc.subscribe(A, (msg) => {
    pushes.push(msg);
    if (msg.type === 'stepsProgress' && msg.done) doneSeen();
  });
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  await donePromise;
  const headingIn = (sections) => (sections.filter((sec) => sec.kind === 'you').pop() || {}).heading;
  assert.equal(headingIn(opened.sections), 'Why does this fail?', 'in the first reply');
  const progress = pushes.filter((m) => m.type === 'stepsProgress' && m.sections);
  assert.ok(progress.length >= 1 && progress[progress.length - 1].done, 'the pass ran on after the reply and finished');
  progress.forEach((m) => assert.equal(headingIn(m.sections), 'Why does this fail?', 'in a push of the indexing, done: ' + m.done));
});

test('bodies for an export: whole texts past the 200 KB cut, tool calls without their results', async () => {
  const file = newFile();
  const huge = 'y'.repeat(250 * 1024) + ' the very end';
  writeLines(file, [
    userLine(uuid(1), null, 'first message'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: huge }]),
    assistantLine(uuid(3), uuid(2), 'm2', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls', description: 'list' } }]),
    toolResultLine(uuid(4), uuid(3), 'b1', 'a.txt'),
  ]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const ids = opened.steps.map((s) => s.id);
  const shown = await svc.handle({ type: 'bodies', sessionId: A, stepIds: ids, generation: opened.generation });
  const forExport = await svc.handle({ type: 'bodies', sessionId: A, stepIds: ids, generation: opened.generation, forExport: true });
  const textAt = opened.steps.findIndex((s) => s.kind === 'text');
  const toolAt = opened.steps.findIndex((s) => s.kind === 'tool');
  assert.equal(shown.items[textAt].truncated, true);
  assert.deepEqual([forExport.items[textAt].truncated, forExport.items[textAt].text.length], [false, huge.length]);
  assert.equal(shown.items[toolAt].result, 'a.txt');
  assert.equal('result' in forExport.items[toolAt], false);
  assert.ok(forExport.items[toolAt].input, 'the command is still there');
});

test('bodies: a step from a generation that no longer exists answers stale, not a throw, and does not drop the rest of the batch', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hello'), assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'reply' }])]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const ids = opened.steps.map((s) => s.id);
  const res = await svc.handle({ type: 'bodies', sessionId: A, stepIds: ids, generation: opened.generation + 1 });
  assert.equal(res.items.length, 2);
  assert.ok(res.items.every((it) => it.stale === true));
});

test('bodies on a session with no open index answers stale for every requested step', async () => {
  const deps = makeDeps();
  const svc = svcMod.createStepsService(deps);
  const res = await svc.handle({ type: 'bodies', sessionId: B, stepIds: ['x:0', 'y:0'], generation: 0 });
  assert.equal(res.type, 'bodiesResult');
  assert.equal(res.items.length, 2);
  assert.ok(res.items.every((it) => it.stale === true));
});

test('body returns the index body for a step, stale when generation has moved on', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hello there')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const stepId = opened.steps[0].id;
  const generation = opened.steps[0].generation;
  const b = await svc.handle({ type: 'body', sessionId: A, stepId, generation });
  assert.equal(b.type, 'bodyResult');
  assert.equal(b.text, 'hello there');
  // rewrite from scratch at a smaller size: a new generation
  writeLines(file, [userLine(uuid(1), null, 'short')]);
  await deps.__timer.fireAll(); // a follow poll picks up the new generation
  const stale = await svc.handle({ type: 'body', sessionId: A, stepId, generation });
  assert.equal(stale.stale, true);
});

test('search with a faked ripgrep byte-offset run maps hits to steps and confirms against visible text', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'find the needle here'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'no match in this one' }]),
    // the tool_use id carries the word in its own raw JSON key, never shown in the step's
    // visible text (title + input summary + result): a byte-offset hit landing there must be
    // dropped by confirmation rather than counted as a real hit.
    assistantLine(uuid(3), uuid(2), 'm2', [{ type: 'tool_use', id: 'call-needle-xyz', name: 'Bash', input: { command: 'echo hi', description: 'say hi' } }]),
  ]);
  const text = fs.readFileSync(file, 'utf8');
  const offsetOfNeedleInLine1 = text.indexOf('needle');
  const offsetOfNeedleInToolId = text.indexOf('call-needle-xyz');
  const deps = makeDeps({
    rg: {
      probe: async () => ({ path: '/usr/bin/rg', error: null }),
      run: async () => {
        // simulate single-file `rg --byte-offset --only-matching ... -e needle` output
        // ("offset:match" per line, no path prefix) with one hit in the you step's visible
        // text and one inside the tool step's raw id, which confirmation must drop.
        const stdout = [
          offsetOfNeedleInLine1 + ':needle',
          offsetOfNeedleInToolId + ':needle',
        ].join('\n') + '\n';
        return { code: 0, stdout, stderr: '' };
      },
      RG_BASE: core.RG_BASE,
      jsonEscaped: core.jsonEscaped,
    },
  });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const toolStepId = opened.steps.find((s) => s.kind === 'tool').id;
  const res = await svc.handle({ type: 'search', sessionId: A, query: 'needle', requestId: 's1' });
  assert.equal(res.type, 'searchResult');
  assert.equal(res.requestId, 's1');
  assert.ok(Array.isArray(res.stepIds));
  assert.equal(res.stepIds.length, 1, 'only the you step is confirmed');
  assert.equal(res.stepIds.includes(toolStepId), false, 'the id-only hit is dropped by confirmation');
});

test('search falls back to a Node streaming scan when ripgrep is unavailable', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'alpha bravo charlie'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'no hit text' }]),
  ]);
  const deps = makeDeps({
    rg: { probe: async () => ({ path: null, error: 'ripgrep not found' }), run: async () => ({ code: 1, stdout: '', stderr: '' }), RG_BASE: core.RG_BASE, jsonEscaped: core.jsonEscaped },
  });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const res = await svc.handle({ type: 'search', sessionId: A, query: 'bravo', requestId: 's1' });
  assert.equal(res.stepIds.length, 1);
});

test('queries with a quote, a backslash and a non-ASCII letter do not throw and still match', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'a line with a "quote" and a \\backslash and café'),
  ]);
  const deps = makeDeps({
    rg: { probe: async () => ({ path: null, error: 'unavailable' }), run: async () => ({ code: 1, stdout: '', stderr: '' }), RG_BASE: core.RG_BASE, jsonEscaped: core.jsonEscaped },
  });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  for (const q of ['"quote"', '\\backslash', 'café']) {
    const res = await svc.handle({ type: 'search', sessionId: A, query: q, requestId: 'q-' + q });
    assert.equal(res.stepIds.length, 1, 'query ' + JSON.stringify(q) + ' matches');
  }
});

test('the 500 cap: more than 500 candidate steps answer "500+" beyond the cap', async () => {
  const file = newFile();
  const objs = [userLine(uuid(1), null, 'seed')];
  let parent = uuid(1);
  for (let i = 2; i <= 520; i++) {
    const u = uuid(i);
    objs.push(assistantLine(u, parent, 'm' + i, [{ type: 'text', text: 'needle present here' }]));
    parent = u;
  }
  writeLines(file, objs);
  const deps = makeDeps({
    rg: { probe: async () => ({ path: null, error: 'unavailable' }), run: async () => ({ code: 1, stdout: '', stderr: '' }), RG_BASE: core.RG_BASE, jsonEscaped: core.jsonEscaped },
  });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const res = await svc.handle({ type: 'search', sessionId: A, query: 'needle', requestId: 's1' });
  assert.equal(res.stepIds.length, 500);
  assert.equal(res.capped, true, '"500+" beyond the stated limit');
});

// A transcript where each query sits in one place only: a tool's output, a subagent's report
// that came as a task notification, the words typed into a question, and a text that follows
// a long stretch of non-ASCII text (byte offsets and character positions differ from there on).
function searchPlacesFixture(file) {
  const ask = { questions: [{ header: 'Way', question: 'Which way?', multiSelect: false, options: [{ label: 'Left', description: 'short' }, { label: 'Right', description: 'long' }] }] };
  writeLines(file, [
    userLine(uuid(1), null, 'ä'.repeat(900) + ' 日本語のテキスト '.repeat(40)),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'run the tests' } }]),
    toolResultLine(uuid(3), uuid(2), 't1', 'FAIL widget exploded in upload.test.ts'),
    assistantLine(uuid(4), uuid(3), 'm2', [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'look into it', prompt: 'find the cause' } }]),
    toolResultLine(uuid(5), uuid(4), 'a1', 'Async agent launched successfully. agentId: ag77'),
    userLine(uuid(6), uuid(5), '<task-notification><tool-use-id>a1</tool-use-id><status>completed</status><result>The cause is a stale lockfile.</result></task-notification>'),
    assistantLine(uuid(7), uuid(6), 'm3', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: ask }]),
    toolResultLine(uuid(8), uuid(7), 'q1', 'Your questions have been answered: "Which way?"="neither, take the ferry". You can now continue.'),
    assistantLine(uuid(9), uuid(8), 'm4', [{ type: 'text', text: 'The pelican has landed.' }]),
  ]);
}

async function searchPlaces(deps) {
  const file = newFile();
  searchPlacesFixture(file);
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const kindOf = (id) => opened.steps.find((s) => s.id === id).kind;
  const found = {};
  for (const q of ['widget exploded', 'stale lockfile', 'take the ferry', 'pelican']) {
    const res = await svc.handle({ type: 'search', sessionId: A, query: q, requestId: 's-' + q });
    found[q] = res.stepIds.map(kindOf);
  }
  return found;
}

const EVERY_PLACE = { 'widget exploded': ['tool'], 'stale lockfile': ['subagent'], 'take the ferry': ['question'], 'pelican': ['text'] };

test('search without ripgrep finds text that only a tool result, a subagent report or a typed answer holds, also after non-ASCII text', async () => {
  assert.deepEqual(await searchPlaces(makeDeps()), EVERY_PLACE);
});

test('search with ripgrep byte offsets finds the same places: a hit in a result or report line counts for the step that shows it', async () => {
  const deps = makeDeps();
  deps.rg = {
    probe: async () => ({ path: '/usr/bin/rg', error: null }),
    // what `rg --byte-offset --only-matching --fixed-strings --ignore-case -e q` prints for one file
    run: async (_rg, args) => {
      const q = args[args.indexOf('-e') + 1];
      const buf = fs.readFileSync(args[args.length - 1]);
      const needle = Buffer.from(q, 'utf8');
      const out = [];
      for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + 1)) out.push(at + ':' + q);
      return { code: out.length ? 0 : 1, stdout: out.join('\n') + (out.length ? '\n' : ''), stderr: '' };
    },
    RG_BASE: core.RG_BASE,
    jsonEscaped: core.jsonEscaped,
  };
  assert.deepEqual(await searchPlaces(deps), EVERY_PLACE);
});

test('search maps a very large number of hits to steps without comparing every hit with every step', async () => {
  const file = newFile();
  const lines = [userLine(uuid(1), null, 'start')];
  for (let i = 2; i <= 3001; i++) lines.push(assistantLine(uuid(i), uuid(i - 1), 'm' + i, [{ type: 'text', text: 'the ' + 'word the '.repeat(30) + i }]));
  writeLines(file, lines);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const t0 = Date.now();
  const res = await svc.handle({ type: 'search', sessionId: A, query: 'the', requestId: 's1' });
  assert.equal(res.stepIds.length, 500, 'capped at 500 confirmed hits');
  assert.equal(res.capped, true);
  assert.ok(Date.now() - t0 < 4000, 'took ' + (Date.now() - t0) + ' ms');
});

test('fullText answers the whole text of a step whose body is cut, and says so when the step is gone', async () => {
  const file = newFile();
  const huge = 'y'.repeat(250 * 1024) + ' the very end';
  writeLines(file, [userLine(uuid(1), null, 'hi'), assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: huge }])]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const text = opened.steps.find((s) => s.kind === 'text');
  const full = await svc.handle({ type: 'fullText', requestId: 'f1', sessionId: A, stepId: text.id });
  assert.deepEqual([full.type, full.ok, full.requestId, full.text.length], ['fullTextResult', true, 'f1', huge.length]);
  assert.ok(full.text.endsWith(' the very end'));
  const gone = await svc.handle({ type: 'fullText', sessionId: A, stepId: 'no-such:0' });
  assert.equal(gone.ok, false);
  const same = await svc.handle({ type: 'fullText', sessionId: A, stepId: text.id, generation: opened.generation });
  assert.equal(same.ok, true, 'asked for with the generation the step was shown under');
  const other = await svc.handle({ type: 'fullText', sessionId: A, stepId: text.id, generation: opened.generation + 1 });
  assert.equal(other.ok, false, 'a step held from another generation is not answered with the text of this one');
});

test('cancelSearch stops a running search; a new search cancels the previous one before it reaches ripgrep', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'one'), assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'two' }])]);
  let resolveProbe;
  const probeGate = new Promise((r) => { resolveProbe = r; });
  const runCalls = [];
  const deps = makeDeps({
    rg: {
      // the probe is the shared choke point: s1's probe is in flight when s2 arrives and aborts
      // it, so s1 must never reach rg.run at all; only s2's query does.
      probe: async () => { await probeGate; return { path: '/usr/bin/rg', error: null }; },
      run: async (cmd, args) => { runCalls.push(args[args.indexOf('-e') + 1]); return { code: 0, stdout: '', stderr: '' }; },
      RG_BASE: core.RG_BASE,
      jsonEscaped: core.jsonEscaped,
    },
  });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const p1 = svc.handle({ type: 'search', sessionId: A, query: 'one', requestId: 's1' });
  const p2 = svc.handle({ type: 'search', sessionId: A, query: 'two', requestId: 's2' });
  resolveProbe();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.cancelled, true, 'the superseded search answers cancelled');
  assert.equal(r2.requestId, 's2');
  assert.deepEqual(runCalls, ['two'], 'ripgrep ran only for the surviving query');
});

test('cancelSearch stops a search already waiting on ripgrep', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'one')]);
  let resolveRun;
  const runGate = new Promise((r) => { resolveRun = r; });
  const deps = makeDeps({
    rg: {
      probe: async () => ({ path: '/usr/bin/rg', error: null }),
      run: async () => { await runGate; return { code: 0, stdout: '', stderr: '' }; },
      RG_BASE: core.RG_BASE,
      jsonEscaped: core.jsonEscaped,
    },
  });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const p1 = svc.handle({ type: 'search', sessionId: A, query: 'one', requestId: 's1' });
  await Promise.resolve(); // let the search reach its ripgrep call
  await svc.handle({ type: 'cancelSearch', sessionId: A });
  resolveRun();
  const r1 = await p1;
  assert.equal(r1.cancelled, true);
});

test('follow: appended steps and a reset are pushed as stepsChanged', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  svc.subscribe(A, (msg) => pushes.push(msg));
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  fs.appendFileSync(file, line(assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'reply' }])));
  await deps.__timer.fireAll();
  const changed = pushes.filter((m) => m.type === 'stepsChanged');
  assert.ok(changed.length >= 1);
  assert.ok(changed[changed.length - 1].sections);
});

test('follow: an answer that arrives for a question already shown is pushed on its own, naming the question as updated and carrying the section it opens', async () => {
  const file = newFile();
  const ask = { questions: [{ header: 'Way', question: 'Which way?', multiSelect: false, options: [{ label: 'Left', description: 'the short way' }, { label: 'Right', description: 'the long way' }] }] };
  writeLines(file, [
    userLine(uuid(1), null, 'go'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: ask }]),
  ]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  svc.subscribe(A, (msg) => pushes.push(msg));
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const question = opened.steps.find((s) => s.kind === 'question');
  assert.equal(opened.sections.some((sec) => sec.kind === 'question'), false, 'no answer yet, so no question section');

  fs.appendFileSync(file, line(toolResultLine(uuid(3), uuid(2), 'q1', 'Your questions have been answered: "Which way?"="Right". You can now continue.')));
  await deps.__timer.fireAll();
  const changed = pushes.filter((m) => m.type === 'stepsChanged');
  assert.equal(changed.length, 1, 'the answer alone is worth a push');
  assert.deepEqual(changed[0].updated, [question.id]);
  assert.deepEqual(changed[0].appended, []);
  assert.ok(changed[0].sections.some((sec) => sec.kind === 'question' && sec.heading === 'Right'), 'the section the answer opens');
  assert.equal(changed[0].generation, opened.generation, 'a push says which generation its steps belong to');

  // nothing new in the file: no further push
  await deps.__timer.fireAll();
  assert.equal(pushes.filter((m) => m.type === 'stepsChanged').length, 1);
});

test('follow: after the transcript is replaced, the reset push carries the new generation', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'first life'), assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'one' }])]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  svc.subscribe(A, (msg) => pushes.push(msg));
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  fs.unlinkSync(file);
  writeLines(file, [userLine(uuid(1), null, 'second life')]);
  await deps.__timer.fireAll();
  const reset = pushes.filter((m) => m.type === 'stepsChanged' && m.reset !== undefined && m.reset !== null).pop();
  assert.ok(reset, 'a reset push');
  assert.equal(typeof reset.generation, typeof opened.generation, 'the push names its generation');
  assert.notEqual(reset.generation, opened.generation);
  const stale = await svc.handle({ type: 'bodies', sessionId: A, stepIds: [reset.steps[0].id], generation: opened.generation });
  assert.equal(stale.items[0].stale, true, 'the generation of the open no longer answers');
  const b = await svc.handle({ type: 'bodies', sessionId: A, stepIds: [reset.steps[0].id], generation: reset.generation });
  assert.equal(b.items[0].text, 'second life', 'a body asked for with the generation of the push is served');
});

test('a viewer that closes while its open is still reading leaves no follow timer behind', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi'), assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'reply' }])]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const unsubscribe = svc.subscribe(A, () => {});
  const opening = svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  unsubscribe();   // the panel is closed before the first reply
  const opened = await opening;
  assert.equal(deps.__timer.size(), 0, 'no timer for a session nobody watches');
  assert.equal(opened.ok, false);
});

// every step id a section list names: its opener, its own rows and the items of its Work lines
function idsNamedBy(sections) {
  const ids = [];
  for (const sec of sections) {
    if (sec.openerId) ids.push(sec.openerId);
    for (const row of sec.body || []) {
      if (row.stepId) ids.push(row.stepId);
      for (const id of row.items || []) ids.push(id);
    }
  }
  return ids;
}

test('pushes carry the compact record of every step they add: after indexing, a viewer holds one for each step its sections name', async () => {
  const file = newFile();
  const objs = [];
  for (let i = 1; i <= 40; i++) {
    objs.push(i % 4 === 1 ? userLine(uuid(i), i === 1 ? null : uuid(i - 1), 'turn ' + i) : assistantLine(uuid(i), uuid(i - 1), 'm' + i, [{ type: 'text', text: 'line ' + i + ' '.repeat(2000) }]));
  }
  writeLines(file, objs);
  const deps = makeDeps({ chunkBytes: 4096, tailBytes: 4096 });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const held = new Map(); // what a viewer keeps: step id -> compact record
  let last = null;
  let doneSeen;
  const donePromise = new Promise((resolve) => { doneSeen = resolve; });
  svc.subscribe(A, (msg) => {
    if (msg.type !== 'stepsProgress') return;
    for (const st of msg.steps || []) held.set(st.id, st);
    last = msg;
    if (msg.done) doneSeen();
  });
  const reply = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  for (const st of reply.steps) held.set(st.id, st);
  assert.ok(reply.steps.length < 40, 'the reply holds the tail only');
  await donePromise;
  const named = idsNamedBy(last.sections);
  assert.equal(named.length, 40);
  for (const id of named) {
    assert.ok(held.has(id), 'a compact record arrived for step ' + id);
    assert.ok(held.get(id).kind && held.get(id).at, 'with its kind and time');
  }
});

test('follow: a stepsChanged push carries the compact records of the steps it appends', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  svc.subscribe(A, (msg) => pushes.push(msg));
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  fs.appendFileSync(file, line(assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls', description: 'list the folder' } }])));
  await deps.__timer.fireAll();
  const changed = pushes.filter((m) => m.type === 'stepsChanged').pop();
  assert.equal(changed.steps.length, 1);
  assert.equal(changed.steps[0].kind, 'tool');
  assert.equal(changed.steps[0].title, 'Bash');
  assert.ok(changed.steps[0].at, 'with its time');
  assert.equal(changed.steps[0].rawInput, undefined, 'the compact record, not the reader\'s own step object');
});

test('every reply names the request it answers: the webview matches a reply to its request by that id alone', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi'), assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'reply' }])]);
  const deps = makeDeps({ deliver: async () => ({ ok: true, message: 'sent' }) });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r-open', sessionId: A });
  assert.equal(opened.requestId, 'r-open');
  const stepId = opened.steps[1].id;
  const added = await svc.handle({ type: 'noteAdd', requestId: 'r-add', sessionId: A, stepId, text: 'a note' });
  assert.equal(added.ok, true);
  const requests = [
    { type: 'body', stepId },
    { type: 'bodies', stepIds: [stepId] },
    { type: 'search', query: 'reply' },
    { type: 'cancelSearch' },
    { type: 'seen', stepId },
    { type: 'noteEdit', noteId: added.note.id, text: 'edited' },
    { type: 'noteSend', noteId: added.note.id },
    { type: 'notesSendAll' },
    { type: 'noteDelete', noteId: added.note.id },
    { type: 'no-such-type' },
    { type: 'close' },
  ];
  assert.equal(added.requestId, 'r-add', 'noteAdd');
  for (const [i, req] of requests.entries()) {
    const reply = await svc.handle(Object.assign({ requestId: 'r-' + i, sessionId: A }, req));
    assert.equal(reply.requestId, 'r-' + i, req.type + ' answers with its request id');
  }
});

test('seen: stores and returns the last step the owner had in view', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi'), assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'reply' }])]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const stepId = opened.steps[1].id;
  const seenReply = await svc.handle({ type: 'seen', sessionId: A, stepId });
  assert.equal(seenReply.ok, true);
  const reopened = await svc.handle({ type: 'open', requestId: 'r2', sessionId: A });
  assert.equal(reopened.seenStepId, stepId);
});

test('close releases the index and the follow timer when no subscriber is left', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const unsub = svc.subscribe(A, () => {});
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  assert.ok(deps.__timer.size() >= 1, 'a follow timer was started');
  unsub();
  await svc.handle({ type: 'close', sessionId: A });
  assert.equal(deps.__timer.size(), 0, 'the timer is cleared once the viewer closes with no subscriber left');
});

test('a missing transcript answers a plain error, never a throw', async () => {
  const deps = makeDeps();
  const svc = svcMod.createStepsService(deps);
  const reply = await svc.handle({ type: 'open', requestId: 'r1', sessionId: B });
  assert.equal(reply.type, 'openResult');
  assert.equal(reply.ok, false);
  assert.equal(typeof reply.message, 'string');
  assert.ok(reply.message.length > 0);
});

test('a transcript removed while open answers through a push, not a throw', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  svc.subscribe(A, (msg) => pushes.push(msg));
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  fs.unlinkSync(file);
  await assert.doesNotReject(deps.__timer.fireAll());
  const errs = pushes.filter((m) => m.type === 'stepsChanged' && m.error);
  assert.ok(errs.length >= 1 || pushes.some((m) => m.error));
});

test('with a real ripgrep on this machine, search still maps offsets to the right steps', async (t) => {
  const probe = await core.rgProbe();
  if (!probe.path) { t.skip('no ripgrep on this machine'); return; }
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'a genuinely distinct search phrase appears here'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'nothing of interest in this reply' }]),
  ]);
  const deps = makeDeps({
    rg: { probe: () => core.rgProbe(), run: (cmd, args, opts) => core.run(cmd, args, opts), RG_BASE: core.RG_BASE, jsonEscaped: core.jsonEscaped },
  });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const res = await svc.handle({ type: 'search', sessionId: A, query: 'distinct search phrase', requestId: 's1' });
  assert.equal(res.stepIds.length, 1);
  assert.equal(res.stepIds[0], opened.steps[0].id);
});

// -- notes -----------------------------------------------------------------------------------

test('open carries the session\'s notes', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const stepId = opened.steps[0].id;
  assert.deepEqual(opened.notes, []);
  const added = await svc.handle({ type: 'noteAdd', sessionId: A, stepId, text: 'why this?' });
  assert.equal(added.ok, true);
  assert.equal(added.note.stepId, stepId);
  const reopened = await svc.handle({ type: 'open', requestId: 'r2', sessionId: A });
  assert.equal(reopened.notes.length, 1);
  assert.equal(reopened.notes[0].text, 'why this?');
});

test('noteAdd, noteEdit, noteDelete: typed replies and the note store underneath', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const stepId = opened.steps[0].id;

  const added = await svc.handle({ type: 'noteAdd', sessionId: A, stepId, text: 'first' });
  assert.equal(added.type, 'noteAddResult');
  assert.equal(added.ok, true);
  const noteId = added.note.id;

  const edited = await svc.handle({ type: 'noteEdit', sessionId: A, noteId, text: 'second' });
  assert.equal(edited.type, 'noteEditResult');
  assert.equal(edited.ok, true);
  assert.equal(edited.note.text, 'second');

  const deleted = await svc.handle({ type: 'noteDelete', sessionId: A, noteId });
  assert.equal(deleted.type, 'noteDeleteResult');
  assert.equal(deleted.ok, true);
  assert.equal(deleted.removed, true);

  const after = await svc.handle({ type: 'open', requestId: 'r2', sessionId: A });
  assert.deepEqual(after.notes, []);
});

test('noteAdd rejects empty text with a typed, unsuccessful reply rather than throwing', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const reply = await svc.handle({ type: 'noteAdd', sessionId: A, stepId: opened.steps[0].id, text: '' });
  assert.equal(reply.ok, false);
  assert.equal(typeof reply.message, 'string');
});

test('noteEdit on a note raced out by a delete answers unsuccessful, never revives the note', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const stepId = opened.steps[0].id;
  const added = await svc.handle({ type: 'noteAdd', sessionId: A, stepId, text: 'first' });
  await svc.handle({ type: 'noteDelete', sessionId: A, noteId: added.note.id });
  const edited = await svc.handle({ type: 'noteEdit', sessionId: A, noteId: added.note.id, text: 'revived?' });
  assert.equal(edited.ok, false);
  const reopened = await svc.handle({ type: 'open', requestId: 'r2', sessionId: A });
  assert.deepEqual(reopened.notes, []);
});

test('every note change pushes notesChanged with the full list, to every subscriber of that session', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const stepId = opened.steps[0].id;
  const pushesOne = [];
  const pushesTwo = [];
  svc.subscribe(A, (msg) => pushesOne.push(msg));
  svc.subscribe(A, (msg) => pushesTwo.push(msg));

  const added = await svc.handle({ type: 'noteAdd', sessionId: A, stepId, text: 'seen by both' });
  const notesPushesOne = pushesOne.filter((m) => m.type === 'notesChanged');
  const notesPushesTwo = pushesTwo.filter((m) => m.type === 'notesChanged');
  assert.equal(notesPushesOne.length, 1);
  assert.equal(notesPushesTwo.length, 1);
  assert.equal(notesPushesOne[0].notes.length, 1);
  assert.equal(notesPushesTwo[0].notes[0].text, 'seen by both');

  await svc.handle({ type: 'noteDelete', sessionId: A, noteId: added.note.id });
  assert.equal(pushesOne.filter((m) => m.type === 'notesChanged').length, 2);
  assert.equal(pushesTwo.filter((m) => m.type === 'notesChanged').length, 2);
});

test('search also matches note text; a hit lands on the note\'s step', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'please build the thing'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'nothing relevant here' }]),
  ]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const youStepId = opened.steps[0].id;
  await svc.handle({ type: 'noteAdd', sessionId: A, stepId: youStepId, text: 'a genuinely distinct note phrase' });
  const res = await svc.handle({ type: 'search', sessionId: A, query: 'distinct note phrase', requestId: 's1' });
  assert.ok(res.stepIds.indexOf(youStepId) !== -1);
});

// -- noteSend / notesSendAll ---------------------------------------------------------

function fakeDeliver(result) {
  const calls = [];
  const fn = async (sessionId, text, meta) => { calls.push({ sessionId, text, meta }); return result; };
  fn.calls = calls;
  return fn;
}

test('noteSend: builds the hand-over text, hands it to deliver, writes a sent record on success, and answers deliver\'s own message', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'please fix the login bug'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'looking at it' }]),
  ]);
  const deliver = fakeDeliver({ ok: true, message: 'In the chat box and on the clipboard.' });
  const deps = makeDeps({ deliver });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const stepId = opened.steps[0].id;
  const added = await svc.handle({ type: 'noteAdd', sessionId: A, stepId, text: 'why this approach?' });
  const noteId = added.note.id;

  const sent = await svc.handle({ type: 'noteSend', sessionId: A, noteId });
  assert.equal(sent.type, 'noteSendResult');
  assert.equal(sent.ok, true);
  assert.equal(sent.message, 'In the chat box and on the clipboard.');
  assert.equal(deliver.calls.length, 1);
  assert.equal(deliver.calls[0].sessionId, A);
  assert.ok(deliver.calls[0].text.indexOf('please fix the login bug') !== -1, deliver.calls[0].text);
  assert.ok(deliver.calls[0].text.indexOf('why this approach?') !== -1, deliver.calls[0].text);
  assert.equal(deliver.calls[0].meta.noteId, noteId);

  const reopened = await svc.handle({ type: 'open', requestId: 'r2', sessionId: A });
  assert.equal(reopened.notes[0].sent.length, 1);
  assert.equal(reopened.notes[0].sent[0].kind, 'steer');
});

test('noteSend: a failed deliver answers unsuccessful and writes no sent record', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'please fix the login bug')]);
  const deliver = fakeDeliver({ ok: false, message: 'the session is not reachable' });
  const deps = makeDeps({ deliver });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const stepId = opened.steps[0].id;
  const added = await svc.handle({ type: 'noteAdd', sessionId: A, stepId, text: 'why this?' });

  const sent = await svc.handle({ type: 'noteSend', sessionId: A, noteId: added.note.id });
  assert.equal(sent.ok, false);
  assert.equal(sent.message, 'the session is not reachable');
  const reopened = await svc.handle({ type: 'open', requestId: 'r2', sessionId: A });
  assert.deepEqual(reopened.notes[0].sent, []);
});

test('noteSend on a note that is gone answers unsuccessful without calling deliver', async () => {
  const deliver = fakeDeliver({ ok: true, message: 'ok' });
  const deps = makeDeps({ deliver });
  deps.__files.set(A, newFile());
  fs.writeFileSync(deps.__files.get(A), JSON.stringify(userLine(uuid(1), null, 'hi')) + '\n');
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const sent = await svc.handle({ type: 'noteSend', sessionId: A, noteId: 'f'.repeat(32) });
  assert.equal(sent.ok, false);
  assert.equal(deliver.calls.length, 0);
});

test('notesSendAll: one deliver call with every note in step order, sent records written for all on success', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'first message'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'ack' }]),
    userLine(uuid(3), uuid(2), 'second message'),
    assistantLine(uuid(4), uuid(3), 'm2', [{ type: 'text', text: 'ack again' }]),
  ]);
  const deliver = fakeDeliver({ ok: true, message: 'In the chat box and on the clipboard.' });
  const deps = makeDeps({ deliver });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const firstStepId = opened.steps.find((s) => s.kind === 'you' && s.preview.indexOf('first') !== -1).id;
  const secondStepId = opened.steps.find((s) => s.kind === 'you' && s.preview.indexOf('second') !== -1).id;
  // added out of step order, to prove notesSendAll sorts by step position, not creation time
  const addedSecond = await svc.handle({ type: 'noteAdd', sessionId: A, stepId: secondStepId, text: 'note on the second message' });
  const addedFirst = await svc.handle({ type: 'noteAdd', sessionId: A, stepId: firstStepId, text: 'note on the first message' });

  const result = await svc.handle({ type: 'notesSendAll', sessionId: A });
  assert.equal(result.type, 'notesSendAllResult');
  assert.equal(result.ok, true);
  assert.equal(deliver.calls.length, 1, 'one message for all notes, not one call per note');
  const text = deliver.calls[0].text;
  const firstAt = text.indexOf('first message');
  const secondAt = text.indexOf('second message');
  assert.ok(firstAt !== -1 && secondAt !== -1 && firstAt < secondAt, 'step order, not creation order: ' + text);
  assert.ok(text.indexOf('\n\n') !== -1, 'one paragraph per note: ' + text);

  const reopened = await svc.handle({ type: 'open', requestId: 'r2', sessionId: A });
  const byId = Object.fromEntries(reopened.notes.map((n) => [n.id, n]));
  assert.equal(byId[addedFirst.note.id].sent.length, 1);
  assert.equal(byId[addedSecond.note.id].sent.length, 1);
});

test('notesSendAll: a failed deliver answers unsuccessful and writes no sent records', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'only message')]);
  const deliver = fakeDeliver({ ok: false, message: 'clipboard write failed' });
  const deps = makeDeps({ deliver });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  await svc.handle({ type: 'noteAdd', sessionId: A, stepId: opened.steps[0].id, text: 'a note' });

  const result = await svc.handle({ type: 'notesSendAll', sessionId: A });
  assert.equal(result.ok, false);
  assert.equal(result.message, 'clipboard write failed');
  const reopened = await svc.handle({ type: 'open', requestId: 'r2', sessionId: A });
  assert.deepEqual(reopened.notes[0].sent, []);
});

test('notesSendAll with no notes answers unsuccessful without calling deliver', async () => {
  const deliver = fakeDeliver({ ok: true, message: 'ok' });
  const deps = makeDeps({ deliver });
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hi')]);
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const result = await svc.handle({ type: 'notesSendAll', sessionId: A });
  assert.equal(result.ok, false);
  assert.equal(deliver.calls.length, 0);
});

// -- the hand-over text builder -----------------------------------------------------

test('buildNoteSendText: "About your step at HH:MM (\\"excerpt\\"): note"', () => {
  const at = new Date(2026, 0, 1, 14, 5, 0).toISOString();
  const text = svcMod.buildNoteSendText(at, 'please fix the login bug', 'why this approach?');
  assert.equal(text, 'About your step at 14:05 ("please fix the login bug"): why this approach?');
});

test('buildNoteSendText cuts the step excerpt to 120 characters and collapses newlines to one line', () => {
  const at = new Date(2026, 0, 1, 9, 0, 0).toISOString();
  const long = 'a'.repeat(150);
  const text = svcMod.buildNoteSendText(at, long, 'note');
  const quoted = text.slice(text.indexOf('("') + 2, text.indexOf('"):'));
  assert.equal(quoted.length, 120);
  assert.equal(quoted, 'a'.repeat(120));

  const multiline = 'line one\nline two\n\nline three';
  const text2 = svcMod.buildNoteSendText(at, multiline, 'note');
  assert.ok(text2.indexOf('\n') === -1, 'the step excerpt never carries a newline into the one-line quote: ' + JSON.stringify(text2));
  assert.ok(text2.indexOf('line one line two line three') !== -1, text2);
});

test('buildNoteSendText trims the note text and tolerates an unparsable timestamp', () => {
  const text = svcMod.buildNoteSendText('not a real date', 'a step', '  padded note  ');
  assert.equal(text, 'About your step at  ("a step"): padded note');
});

test('buildNotesSendAllText: one paragraph per note, in the given (step) order, same form as a single send', () => {
  const at1 = new Date(2026, 0, 1, 9, 0, 0).toISOString();
  const at2 = new Date(2026, 0, 1, 9, 5, 0).toISOString();
  const text = svcMod.buildNotesSendAllText([
    { at: at1, stepText: 'first step', noteText: 'first note' },
    { at: at2, stepText: 'second step', noteText: 'second note' },
  ]);
  assert.equal(text,
    'About your step at 09:00 ("first step"): first note\n\n' +
    'About your step at 09:05 ("second step"): second note');
});

test('buildNotesSendAllText on an empty list is an empty string', () => {
  assert.equal(svcMod.buildNotesSendAllText([]), '');
});

// -- findings of the review before the merge -------------------------------------------------

/* A transcript that is replaced by a larger one: the poll that notices it reads the new file
   from its end, a chunk at a time, and gives the loop back between chunks. */
function replacedTranscript(deps) {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'first version')]);
  deps.__files.set(A, file);
  const replace = () => {
    fs.unlinkSync(file);
    const objs = [userLine(uuid(1), null, 'second version')];
    for (let i = 2; i <= 120; i++) objs.push(assistantLine(uuid(i), uuid(i - 1), 'm' + i, [{ type: 'text', text: 'line ' + i + ' ' + 'x'.repeat(3000) }]));
    writeLines(file, objs);
  };
  return { file, replace };
}

test('a follow tick that comes while the poll before it still runs does not start a second read of the transcript', async () => {
  let largestRead = 0;
  const watched = Object.assign({}, fs, { readSync: (fd, buf, off, len, pos) => { if (len > largestRead) largestRead = len; return fs.readSync(fd, buf, off, len, pos); } });
  const deps = makeDeps({ fs: watched, chunkBytes: 4096, tailBytes: 4096 });
  const { file, replace } = replacedTranscript(deps);
  const svc = svcMod.createStepsService(deps);
  svc.subscribe(A, () => {});
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  replace();
  largestRead = 0;
  const first = deps.__timer.fireAll();    // notices the new file and starts to read it
  const second = deps.__timer.fireAll();   // the next tick, a second later, while that read goes on
  await Promise.all([first, second]);
  assert.ok(fs.statSync(file).size > 300 * 1024);
  assert.ok(largestRead <= 64 * 1024, 'no read took the whole file in one piece: ' + largestRead + ' bytes');
});

test('a poll that ends after its viewer was closed tells nothing to the viewer that opened next', async () => {
  const deps = makeDeps({ chunkBytes: 4096, tailBytes: 4096 });
  const { replace } = replacedTranscript(deps);
  const svc = svcMod.createStepsService(deps);
  const closeFirst = svc.subscribe(A, () => {});
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  replace();
  const oldPoll = deps.__timer.fireAll();   // runs for a while: the new file is read in chunks
  closeFirst();                             // the tab is closed meanwhile
  const got = [];
  svc.subscribe(A, (msg) => got.push(msg));   // and opened again
  const reopened = await svc.handle({ type: 'open', requestId: 'r2', sessionId: A });
  await oldPoll;
  assert.equal(reopened.ok, true);
  const foreign = got.filter((m) => m.type === 'stepsChanged' && m.generation !== undefined && m.generation !== reopened.generation);
  assert.deepEqual(foreign.map((m) => m.generation), [], 'no push of the old index reached the new viewer');
  assert.equal(got.some((m) => m.type === 'stepsChanged' && m.error), false, 'and no error of it either');
});

test('a transcript that was moved (stowed or restored) is found again: the viewer is told, and a new open follows the file at its new place', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hello'), assistantLine(uuid(2), uuid(1), 'm2', [{ type: 'text', text: 'first answer' }])]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  svc.subscribe(A, (msg) => pushes.push(msg));
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const moved = newFile();
  fs.renameSync(file, moved);
  deps.__files.set(A, moved);
  await deps.__timer.fireAll();
  const told = pushes.filter((m) => m.type === 'stepsChanged');
  assert.equal(told.some((m) => m.moved === true), true, 'the viewer is told that the transcript moved: ' + JSON.stringify(told));
  assert.equal(told.some((m) => m.error), false, 'not that it is gone');
  await deps.__timer.fireAll();
  assert.equal(pushes.filter((m) => m.moved === true).length, 1, 'and told once');
  const again = await svc.handle({ type: 'open', requestId: 'r2', sessionId: A });
  assert.equal(again.ok, true);
  assert.equal(again.steps.length, 2);
  const text = again.steps.find((st) => st.kind === 'text');
  const bodies = await svc.handle({ type: 'bodies', requestId: 'r3', sessionId: A, stepIds: [text.id], generation: again.generation });
  assert.equal(bodies.items[0].text, 'first answer', 'the texts are read from the new place');
  pushes.length = 0;
  fs.appendFileSync(moved, line(userLine(uuid(3), uuid(2), 'and now?')));
  await deps.__timer.fireAll();
  assert.equal(pushes.some((m) => m.type === 'stepsChanged' && (m.appended || []).length === 1), true, 'and the file is followed there');
});

test('a transcript that is gone from every place is still reported as gone', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hello')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  svc.subscribe(A, (msg) => pushes.push(msg));
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  fs.unlinkSync(file);
  deps.__files.delete(A);
  await deps.__timer.fireAll();
  assert.equal(pushes.some((m) => m.type === 'stepsChanged' && /moved or removed/.test(String(m.error))), true);
});

test('search finds words that lie behind the 200 KB a body shows', async () => {
  const file = newFile();
  const paste = '<pasted_content id="ab12">\n' + 'a line of a long log\n'.repeat(13000) + '</pasted_content>\n';
  writeLines(file, [userLine(uuid(1), null, paste + 'Why does this fail?'), assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'because' }])]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const you = opened.steps.find((st) => st.kind === 'you');
  const res = await svc.handle({ type: 'search', requestId: 's1', sessionId: A, query: 'Why does this fail' });
  assert.deepEqual(res.stepIds, [you.id], 'the heading the page shows can be searched for');
});

test('two viewers of one session search at the same time without cancelling each other; a viewer still replaces its own search', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'find the needle'), assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'a haystack' }])]);
  let letGo = null;
  const held = new Promise((resolve) => { letGo = resolve; });
  let probes = 0;
  const deps = makeDeps();
  // the first search is slow to start, the ones after it are not
  deps.rg.probe = async () => { probes += 1; if (probes === 1) await held; return { path: null }; };
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const slow = svc.handle({ type: 'search', requestId: 's1', sessionId: A, viewerId: 'tab-one', query: 'needle' });
  const quick = await svc.handle({ type: 'search', requestId: 's2', sessionId: A, viewerId: 'tab-two', query: 'haystack' });
  assert.equal(quick.stepIds.length, 1);
  letGo();
  const first = await slow;
  assert.equal(Boolean(first.cancelled), false, 'the search of the other tab was not cancelled');
  assert.equal(first.stepIds.length, 1);
  // clearing the box in one tab leaves the other tab's search alone as well
  let letGo2 = null;
  const held2 = new Promise((resolve) => { letGo2 = resolve; });
  probes = 0;
  deps.rg.probe = async () => { probes += 1; if (probes === 1) await held2; return { path: null }; };
  const slow2 = svc.handle({ type: 'search', requestId: 's3', sessionId: A, viewerId: 'tab-one', query: 'needle' });
  await svc.handle({ type: 'cancelSearch', requestId: 'c1', sessionId: A, viewerId: 'tab-two' });
  letGo2();
  assert.equal(Boolean((await slow2).cancelled), false);
  // the same viewer typing on: its earlier search is dropped
  let letGo3 = null;
  const held3 = new Promise((resolve) => { letGo3 = resolve; });
  probes = 0;
  deps.rg.probe = async () => { probes += 1; if (probes === 1) await held3; return { path: null }; };
  const stale = svc.handle({ type: 'search', requestId: 's4', sessionId: A, viewerId: 'tab-one', query: 'need' });
  const fresh = await svc.handle({ type: 'search', requestId: 's5', sessionId: A, viewerId: 'tab-one', query: 'needle' });
  letGo3();
  assert.equal((await stale).cancelled, true);
  assert.equal(fresh.stepIds.length, 1);
});

test('a ripgrep run that failed or was cut short is not taken for the whole answer: the transcript is scanned instead', async () => {
  const file = newFile();
  writeLines(file, [
    userLine(uuid(1), null, 'the marker word appears here'),
    assistantLine(uuid(2), uuid(1), 'm1', [{ type: 'text', text: 'and the marker word appears here too' }]),
  ]);
  const firstHit = fs.readFileSync(file).indexOf('marker');
  const deps = makeDeps();
  deps.rg.probe = async () => ({ path: 'rg' });
  // stopped at its output limit: what it printed so far names the first hit only
  deps.rg.run = async () => ({ code: -1, stdout: firstHit + ':marker\n', stderr: 'stdout maxBuffer length exceeded', killed: true });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const res = await svc.handle({ type: 'search', requestId: 's1', sessionId: A, query: 'marker' });
  assert.equal(res.stepIds.length, 2, 'both steps are found');
});

test('a session id that is not a full id is refused by the service and by the notes store', async () => {
  const deps = makeDeps();
  const svc = svcMod.createStepsService(deps);
  const added = await svc.handle({ type: 'noteAdd', requestId: 'n1', sessionId: '--------', stepId: 'x:0', text: 'a note under a made-up id' });
  assert.equal(added.ok, false);
  const seen = await svc.handle({ type: 'seen', requestId: 'n2', sessionId: 'deadbeef', stepId: 'x:0' });
  assert.equal(seen.ok, false);
  assert.equal(fs.existsSync(path.join(deps.dataDir, 'notes', '--------')), false, 'nothing was written for it');
  const { createNotesStore } = require('../notes.cjs');
  assert.throws(() => createNotesStore({ dataDir: deps.dataDir }).add('--------', 'x:0', 'text'), /not a session id/);
});

test('search says that there are more hits than it lists also when the hits are in notes', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hello')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  const { createNotesStore } = require('../notes.cjs');
  const store = createNotesStore({ dataDir: deps.dataDir });
  for (let i = 0; i < 501; i++) store.add(A, 'step-' + i + ':0', 'the same remark');
  const res = await svc.handle({ type: 'search', requestId: 's1', sessionId: A, query: 'same remark' });
  assert.equal(res.stepIds.length, 500);
  assert.equal(res.capped, true);
});

test('a note that another window kept, changed or deleted reaches this viewer with the next tick', async () => {
  const file = newFile();
  writeLines(file, [userLine(uuid(1), null, 'hello')]);
  const deps = makeDeps();
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  svc.subscribe(A, (msg) => pushes.push(msg));
  const opened = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  await deps.__timer.fireAll();
  assert.equal(pushes.some((m) => m.type === 'notesChanged'), false, 'nothing changed: nothing is told');
  // the other window writes to the same folder through a store of its own
  const { createNotesStore } = require('../notes.cjs');
  const other = createNotesStore({ dataDir: deps.dataDir });
  const note = other.add(A, opened.steps[0].id, 'kept in the other window');
  await deps.__timer.fireAll();
  let told = pushes.filter((m) => m.type === 'notesChanged');
  assert.equal(told.length, 1);
  assert.deepEqual(told[0].notes.map((n) => n.text), ['kept in the other window']);
  other.edit(A, note.id, 'changed in the other window');
  await deps.__timer.fireAll();
  told = pushes.filter((m) => m.type === 'notesChanged');
  assert.equal(told[told.length - 1].notes[0].text, 'changed in the other window');
  other.delete(A, note.id);
  await deps.__timer.fireAll();
  told = pushes.filter((m) => m.type === 'notesChanged');
  assert.deepEqual(told[told.length - 1].notes, []);
  const before = told.length;
  await deps.__timer.fireAll();
  assert.equal(pushes.filter((m) => m.type === 'notesChanged').length, before, 'and told once per change');
});

test('progress pushes of the indexing get rarer when building one is slow, so they never take most of the time', async () => {
  const file = newFile();
  const objs = [];
  for (let i = 1; i <= 200; i++) {
    objs.push(i === 1 ? userLine(uuid(i), null, 'line ' + i) : assistantLine(uuid(i), uuid(i - 1), 'm' + i, [{ type: 'text', text: 'line ' + i + ' '.repeat(2000) }]));
  }
  writeLines(file, objs);
  // a clock that moves 100 ms with every look at it: a push that costs "100 ms" to build
  let clock = 0;
  const deps = makeDeps({ chunkBytes: 4096, tailBytes: 4096, progressIntervalMs: 0, now: () => { clock += 100; return clock; } });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  let doneSeen;
  const donePromise = new Promise((resolve) => { doneSeen = resolve; });
  svc.subscribe(A, (msg) => { if (msg.type === 'stepsProgress') { pushes.push(msg); if (msg.done) doneSeen(); } });
  await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  await donePromise;
  assert.equal(pushes[pushes.length - 1].done, true, 'the end is always told');
  assert.ok(pushes.length >= 2 && pushes.length <= 20, 'a slow push is followed by a pause: ' + pushes.length + ' pushes for about 100 chunks');
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
