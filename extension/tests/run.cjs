/**
 * Runs the suites in two steps: everything that does not drive a browser, in parallel as
 * `node --test` does by default, then the two browser-driven page suites one after the other.
 * Run together with two dozen other test processes, the page suites lose requests and time out
 * now and then (about one whole-suite run in eight, in tests that pass alone every time).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PAGE_SUITES = ['page.test.cjs', 'steps-page.test.cjs'];
const dir = __dirname;
const suites = fs.readdirSync(dir).filter((f) => f.endsWith('.test.cjs')).sort();
const files = (keep) => suites.filter(keep).map((f) => path.join('tests', f));

function run(args) {
  const r = spawnSync(process.execPath, ['--test', ...args], { cwd: path.dirname(dir), stdio: 'inherit' });
  return r.status === 0;
}

const unitOk = run(files((f) => !PAGE_SUITES.includes(f)));
const pageOk = run(['--test-concurrency=1', ...files((f) => PAGE_SUITES.includes(f))]);
process.exit(unitOk && pageOk ? 0 : 1);
