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

test('open on a multi-chunk file pushes stepsProgress while indexing, then stops', async () => {
  const file = newFile();
  const objs = [];
  for (let i = 1; i <= 40; i++) {
    objs.push(i === 1 ? userLine(uuid(i), null, 'line ' + i) : assistantLine(uuid(i), uuid(i - 1), 'm' + i, [{ type: 'text', text: 'line ' + i + ' '.repeat(2000) }]));
  }
  writeLines(file, objs);
  const deps = makeDeps({ chunkBytes: 4096, tailBytes: 4096 });
  deps.__files.set(A, file);
  const svc = svcMod.createStepsService(deps);
  const pushes = [];
  svc.subscribe(A, (msg) => pushes.push(msg));
  const reply = await svc.handle({ type: 'open', requestId: 'r1', sessionId: A });
  assert.equal(reply.ok, true);
  assert.ok(pushes.some((m) => m.type === 'stepsProgress' && m.sessionId === A));
  const last = pushes.filter((m) => m.type === 'stepsProgress').pop();
  assert.equal(last.done, true);
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

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
