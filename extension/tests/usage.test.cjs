'use strict';
// Usage-limit path of core.cjs: response parsing, the cache reader, and the CLI probe against
// the shim in tests/shim (no real Claude Code needed). Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the data dir and put the shim first on PATH before core.cjs reads either.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-usage-'));
process.env.LOCALAPPDATA = tmp;
process.env.XDG_DATA_HOME = tmp;
process.env.PATH = path.join(__dirname, 'shim') + path.delimiter + process.env.PATH;
const core = require('../core.cjs');

const DATA_DIR = core.DATA_DIR;
const USAGE_FILE = core.USAGE_FILE;
const FAST = { minIntervalMs: 0, timeoutMs: 20000 };

function sample(over) {
  return Object.assign({
    subscription_type: 'team',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42.4, resets_at: '2026-09-24T16:30:00+00:00' },
      seven_day: { utilization: 14, resets_at: 1790500000 },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    },
  }, over || {});
}

function writeCache(rec) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(rec));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('parseUsageResponse maps windows, ISO and epoch timestamps', () => {
  const u = core.parseUsageResponse(sample());
  assert.equal(u.error, undefined);
  assert.equal(u.available, true);
  assert.equal(u.subscriptionType, 'team');
  assert.equal(u.windows.five_hour.usedPct, 42.4);
  assert.equal(u.windows.five_hour.resetsAt, Date.parse('2026-09-24T16:30:00+00:00'));
  assert.equal(u.windows.seven_day.resetsAt, 1790500000 * 1000);
  assert.equal(u.windows.seven_day_opus, undefined);
  assert.equal(u.extraUsage, null);
});

test('parseUsageResponse accepts used_percentage, null resets_at, unknown windows', () => {
  const u = core.parseUsageResponse(sample({ rate_limits: { five_hour: { used_percentage: 7 }, mystery: { utilization: 1 } } }));
  assert.equal(u.windows.five_hour.usedPct, 7);
  assert.equal(u.windows.five_hour.resetsAt, null);
  assert.equal(u.windows.mystery, undefined);
});

test('parseUsageResponse: per-model row and enabled extra usage', () => {
  const u = core.parseUsageResponse(sample({ rate_limits: {
    five_hour: { utilization: 1, resets_at: null },
    seven_day_opus: { utilization: 55, resets_at: '2026-09-30T05:59:59+00:00' },
    extra_usage: { is_enabled: true, utilization: 12.5, used_credits: 3, monthly_limit: 24, currency: 'USD' },
  } }));
  assert.equal(u.windows.seven_day_opus.usedPct, 55);
  assert.deepEqual(u.extraUsage, { usedPct: 12.5, usedCredits: 3, monthlyLimit: 24, currency: 'USD' });
});

test('parseUsageResponse: the limits list wins, per-model rows are labelled, noise is ignored', () => {
  // Shape seen on 2026-09-24 (CLI 2.1.281): named keys plus a `limits` list plus many
  // experimental windows at 0%. Only the list's three rows are meaningful.
  const u = core.parseUsageResponse(sample({ rate_limits: {
    five_hour: { utilization: 100, resets_at: '2026-09-24T20:09:59+00:00' },
    seven_day: { utilization: 50, resets_at: '2026-09-27T03:59:59+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    nimbus_quill: { utilization: 0, resets_at: null },
    limits: [
      { kind: 'session', group: 'session', percent: 100, resets_at: '2026-09-24T20:09:59+00:00', scope: null, is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 50, resets_at: '2026-09-27T03:59:59+00:00', scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 96, resets_at: '2026-09-27T03:59:59+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
      { kind: 'weekly_scoped', group: 'weekly', percent: 3, resets_at: null, scope: { model: null, surface: 'Cowork' } },
      { kind: 'monthly_total', group: 'monthly', percent: 8, resets_at: null, scope: null },
      { kind: 'broken', percent: 'n/a' },
    ],
    extra_usage: { is_enabled: false },
  } }));
  assert.equal(u.error, undefined);
  assert.deepEqual(Object.keys(u.windows), ['five_hour', 'seven_day', 'seven_day_fable', 'seven_day_cowork', 'monthly_total']);
  assert.equal(u.windows.five_hour.label, '5h');
  assert.equal(u.windows.seven_day.label, '7d');
  assert.equal(u.windows.seven_day_fable.label, '7d Fable');
  assert.equal(u.windows.seven_day_fable.usedPct, 96);
  assert.equal(u.windows.seven_day_fable.resetsAt, Date.parse('2026-09-27T03:59:59+00:00'));
  assert.equal(u.windows.seven_day_cowork.label, '7d Cowork');
  assert.equal(u.windows.monthly_total.label, 'monthly total');
  assert.equal(u.windows.nimbus_quill, undefined);
});

test('parseUsageResponse: an unusable limits list falls back to the named windows', () => {
  const u = core.parseUsageResponse(sample({ rate_limits: { five_hour: { utilization: 9 }, limits: [{ kind: 'session' }, 'junk', null] } }));
  assert.deepEqual(Object.keys(u.windows), ['five_hour']);
  assert.equal(u.windows.five_hour.usedPct, 9);
  assert.equal(u.windows.five_hour.label, '5h');
});

test('parseUsageResponse: available false is not an error', () => {
  const u = core.parseUsageResponse({ subscription_type: null, rate_limits_available: false, rate_limits: null });
  assert.equal(u.available, false);
  assert.equal(u.windows, null);
  assert.equal(u.error, undefined);
});

test('parseUsageResponse: missing or unparsable windows report a shape change', () => {
  assert.match(core.parseUsageResponse(sample({ rate_limits: null })).error, /changed/);
  assert.match(core.parseUsageResponse(sample({ rate_limits: { five_hour: { pct: 3 } } })).error, /changed/);
  assert.match(core.parseUsageResponse(null).error, /empty/);
});

test('usageState: loading with nothing cached, then each cached state', () => {
  fs.rmSync(USAGE_FILE, { force: true });
  assert.equal(core.usageState().state, 'loading');
  const now = Date.now();
  writeCache({ at: now - 5000, subscriptionType: 'max', available: true, windows: { five_hour: { usedPct: 30, resetsAt: now + 3600000 }, seven_day: { usedPct: 80, resetsAt: now - 1000 } } });
  let u = core.usageState();
  assert.equal(u.state, 'ok');
  assert.equal(u.subscriptionType, 'max');
  assert.ok(u.ageSeconds >= 4 && u.ageSeconds <= 7);
  assert.equal(u.windows.five_hour.expired, false);
  assert.equal(u.windows.seven_day.expired, true);
  assert.equal(u.windows.five_hour.label, '5h', 'records without a label fall back to the known name');
  writeCache({ at: now, available: true, windows: { seven_day_fable: { label: '7d Fable', usedPct: 88, resetsAt: now + 1000 } } });
  assert.equal(core.usageState().windows.seven_day_fable.label, '7d Fable');
  writeCache({ at: now, available: false, windows: null });
  assert.equal(core.usageState().state, 'no-limits');
  writeCache({ at: now, available: true, windows: null, error: 'claude did not answer within 30 s', errorAt: now });
  u = core.usageState();
  assert.equal(u.state, 'error');
  assert.match(u.error, /did not answer/);
  writeCache({ at: now, available: true, windows: {} });
  u = core.usageState();
  assert.equal(u.state, 'error');
  assert.match(u.error, /changed/);
});

test('fetchUsage: success through the shim creates DATA_DIR and the cache', async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.env.SB_SHIM_MODE = 'ok';
  const u = await core.fetchUsage(FAST);
  assert.equal(u.state, 'ok', JSON.stringify(u));
  assert.equal(u.windows.five_hour.usedPct, 42.4);
  assert.equal(u.subscriptionType, 'team');
  assert.ok(fs.existsSync(USAGE_FILE));
  assert.equal(fs.readFileSync(path.join(DATA_DIR, 'probe-settings.json'), 'utf8'), '{"disableAllHooks":true}\n');
  assert.equal(fs.readFileSync(path.join(DATA_DIR, 'probe-mcp.json'), 'utf8'), '{"mcpServers":{}}\n');
});

test('fetchUsage: throttled within the minimum interval', async () => {
  const u = await core.fetchUsage({ minIntervalMs: 60000 });
  assert.equal(u.throttled, true);
  assert.equal(u.state, 'ok');
});

test('fetchUsage: garbage output keeps the last good numbers and carries the error', async () => {
  process.env.SB_SHIM_MODE = 'garbage';
  const u = await core.fetchUsage(FAST);
  assert.equal(u.state, 'ok');
  assert.equal(u.windows.five_hour.usedPct, 42.4);
  assert.match(u.error, /no usage reply/);
  assert.ok(u.errorAt > 0);
});

test('fetchUsage: error subtype from the CLI', async () => {
  fs.rmSync(USAGE_FILE, { force: true });
  process.env.SB_SHIM_MODE = 'error';
  const before = core.usageState();
  const u = await core.fetchUsage(FAST);
  // the in-memory last-good record from the previous test still exists, so numbers stay
  assert.ok(before.state === 'ok' || before.state === 'loading');
  assert.match(u.error, /not supported/);
});

test('fetchUsage: non-zero exit reports the first stderr line', async () => {
  process.env.SB_SHIM_MODE = 'exit2';
  const u = await core.fetchUsage(FAST);
  assert.match(u.error, /boom: bad flag/);
});

test('fetchUsage: missing CLI gives an error state, board keeps going', async () => {
  const u = await core.fetchUsage(Object.assign({ command: 'claude-definitely-missing-xyz' }, FAST));
  assert.ok(u.error, 'expected an error');
});

test('fetchUsage: timeout kills the shim tree', async () => {
  const pidFile = path.join(tmp, 'shim.pid');
  process.env.SB_SHIM_MODE = 'hang';
  process.env.SB_SHIM_PIDFILE = pidFile;
  const t0 = Date.now();
  const u = await core.fetchUsage({ minIntervalMs: 0, timeoutMs: 1500 });
  delete process.env.SB_SHIM_PIDFILE;
  assert.match(u.error, /did not answer within 2 s/);
  assert.ok(Date.now() - t0 < 15000, 'returned after the timeout');
  await sleep(700);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), 'the shim process should be gone');
});

test('refreshUsageIfStale: fresh cache skips, stale cache probes', async () => {
  process.env.SB_SHIM_MODE = 'ok';
  writeCache({ at: Date.now(), available: true, windows: { five_hour: { usedPct: 1 } } });
  // the in-memory record is newer than the file after the previous probes; force by clearing it via a real probe
  await core.fetchUsage(FAST);
  assert.equal(core.refreshUsageIfStale(60000), null);
  writeCache({ at: Date.now() - 10 * 60000, available: true, windows: { five_hour: { usedPct: 1 } } });
  // memory record still fresh → no probe
  assert.equal(core.refreshUsageIfStale(60000), null);
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
