# Changelog

## 0.3.3

- Sessions renamed with `/rename` now show that name as their heading
- Each row shows one name; the internal agent name moved to the hover tooltip
- Search results highlight the match in titles the same soft way as in snippets

## 0.3.2

- The search row is now just the search box: Enter searches titles and transcript text, Esc clears
- Removed the session count and the hint line under the header

## 0.3.1

- Added your usage limits at the top of the view: the 5-hour and 7-day windows with their reset times. Connect walks you through a one-time paste into `~/.claude/settings.json`
- Fixed status labels wrapping or spilling out of the card in a narrow sidebar

## 0.3.0

- Renamed to Session Board
- Added ✕ on each row to end that session, with an extra confirmation when it is busy or waiting for you
- Added search across every session on disk, by title and by transcript content
- Remote workspaces now see the sessions of your local machine
- The context bar now needs `autoCompactWindow` in `~/.claude/settings.json`; without it the row shows the token count

## 0.2.0

- Jumping to a session in another window now opens it where you keep Claude Code, sidebar or editor tab

## 0.1.0

- First version: every live Claude Code session across all VS Code windows, a badge with the number waiting for you, click to jump
