# Changelog

## 0.3.2

- The search row is just the box. Enter searches every session on disk by title, folder, id
  and transcript text; the content checkbox and the clear button are gone (Esc or an emptied
  box clears). The "N sessions · updated" and hint lines under the header are gone too.
- Description and tagline lead with Claude Code.

## 0.3.1

- Usage limits at the top of the view: the 5-hour and 7-day windows with their reset times,
  plus a spend limit when one applies. Claude Code hands these numbers only to a status
  line, so **Connect** copies a `statusLine` snippet for `~/.claude/settings.json` that runs
  a small Session Board script; the script prints the limits in every session's footer and
  saves them for this view. You paste the snippet yourself; the board never edits
  settings.json. No credentials are read; the data stays on this machine.
- Status chips ("input needed", "busy") no longer wrap or overflow in a narrow sidebar; long
  titles ellipsize instead.

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
