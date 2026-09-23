#!/usr/bin/env bash
# Session Board status line for Claude Code (macOS, Linux). Needs python3.
#
# Claude Code runs this after each reply with the session JSON on stdin. It prints one line
# for the session footer and records the latest usage limits (rate_limits) under
# ${XDG_DATA_HOME:-~/.local/share}/session-board/usage.json, which the Session Board view
# reads. Nothing else is read or written and nothing leaves the machine.

DIR="${XDG_DATA_HOME:-$HOME/.local/share}/session-board"

python3 -c "$(cat <<'PY'
import json, os, sys, time

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(d, dict):
    sys.exit(0)

out_dir = sys.argv[1]
path = os.path.join(out_dir, 'usage.json')
rl = d.get('rate_limits')
ctx = (d.get('context_window') or {}).get('used_percentage')
model = (d.get('model') or {}).get('display_name')


def pct(w):
    try:
        return int(round(float(w['used_percentage'])))
    except Exception:
        return None


def paint(p):
    if p >= 90:
        return '\033[31m%d%%\033[0m' % p
    if p >= 70:
        return '\033[33m%d%%\033[0m' % p
    return '%d%%' % p


def record(limits):
    try:
        os.makedirs(out_dir, exist_ok=True)
        tmp = '%s.tmp.%d' % (path, os.getpid())
        with open(tmp, 'w') as fh:
            json.dump({'at': int(time.time() * 1000), 'session_id': d.get('session_id'),
                       'model': model, 'rate_limits': limits}, fh)
        os.replace(tmp, path)
    except Exception:
        pass


parts = []
if isinstance(rl, dict):
    for key, label in (('five_hour', '5h'), ('seven_day', '7d'), ('spend_limit', 'spend')):
        p = pct(rl.get(key) or {})
        if p is not None:
            parts.append('%s %s' % (label, paint(p)))
    record(rl)
elif not os.path.exists(path):
    record(None)

if ctx is not None:
    try:
        parts.append('ctx %d%%' % int(round(float(ctx))))
    except Exception:
        pass
line = ' | '.join(parts)
if model:
    line = ('[%s] %s' % (model, line)) if line else '[%s]' % model
print(line)
PY
)" "$DIR"
