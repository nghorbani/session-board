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
function assistantLine(u, parent, msgId, content, extra) {
  return Object.assign({ type: 'assistant', uuid: u, parentUuid: parent, timestamp: new Date(2026, 0, 1, 0, 2, Number(u.slice(-2)) || 0).toISOString(),
    message: { id: msgId, role: 'assistant', content } }, extra);
}

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

// -- B2: noteSend / notesSendAll ---------------------------------------------------------

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

// -- B1: the hand-over text builder -----------------------------------------------------

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

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
