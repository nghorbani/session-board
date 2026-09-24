// Stand-in for the Claude Code CLI in the usage tests. Reads the control request from stdin
// and answers according to SB_SHIM_MODE: ok (default), hang, garbage, exit2, error.
'use strict';
const fs = require('fs');

const mode = process.env.SB_SHIM_MODE || 'ok';
if (process.env.SB_SHIM_PIDFILE) fs.writeFileSync(process.env.SB_SHIM_PIDFILE, String(process.pid));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const m = input.match(/"request_id":"([^"]+)"/);
  const id = m ? m[1] : 'unknown';
  if (mode === 'hang') { setTimeout(() => {}, 120000); return; }
  if (mode === 'garbage') { process.stdout.write('not json at all\n'); process.exit(0); }
  if (mode === 'exit2') { process.stderr.write('boom: bad flag\nmore\n'); process.exit(2); }
  if (mode === 'error') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'get_usage is not supported in this context' } }) + '\n');
    process.exit(0);
  }
  const body = process.env.SB_SHIM_BODY ? JSON.parse(process.env.SB_SHIM_BODY) : {
    subscription_type: 'team',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42.4, resets_at: '2026-09-24T16:30:00+00:00' },
      seven_day: { utilization: 14, resets_at: '2026-09-30T05:59:59+00:00' },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    },
  };
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'commands_changed', commands: [] }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: body } }) + '\n');
  process.exit(0);
});
