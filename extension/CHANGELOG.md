# Changelog

## 0.3.0

First public build.

- Renamed to Session Board (`nima-ghorbani.session-board`).
- ✕ on a row ends that session: inline confirm, an extra confirmation when the session is
  busy or waiting, process identity verified against the session registry before the kill.
- Search box: type to narrow the live list; Enter searches every session on disk by title,
  and with **content** ticked by transcript text (ripgrep). Past sessions resume in place
  when their folder is open in the window, otherwise the resume command is copied.
- Runs as a UI extension so remote workspaces still see the local machine's sessions.
- Context bar only when `autoCompactWindow` is configured in `~/.claude/settings.json`.
- Optional browser front end requires a per-run token on every API route.

## 0.2.0 (as `nima-ghorbani.claude-sessions`)

- Cross-window jumps route through the board in the target window, so sessions open the
  way Claude Code is configured (sidebar or editor tab).

## 0.1.x (as `nima-ghorbani.claude-sessions-board`)

- Sidebar list of live sessions across windows, badge with the waiting count, jump to a
  session via `windowId` URI routing.
