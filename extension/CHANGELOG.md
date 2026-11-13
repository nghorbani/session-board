# Changelog

## 0.11.2

- Ended sessions stay on the board until you archive them, like Claude Code's own session list: each window section lists, under its running sessions, the ended ones of its folder and of that repository's worktrees that are not archived (in Claude Code or on the board), newest first, marked "ended". A click resumes one; ⤓ archives it
- A switch "all | running" in the header hides the ended sessions
- Typing in the search box also searches every session on disk by title after a short pause; the results skip what the board already shows. Enter adds the transcript text as before
- A session without a title no longer shows its agent name twice

## 0.11.1

- Every running session that is not archived stays on the board: the "Show N idle over 2h" fold is gone, so sessions idle for hours or days sit in their window section like the rest. Archived sessions (in Claude Code or with ⤓) are still put away
- A typed filter says so: a line above the sections reads `Filter "<text>": n of N running sessions`, with a clear button
- Rows show the agent name other Claude sessions use for a session (`cuvis-ai-6c`) when it differs from the title, and the details line carries it with a copy button

## 0.11.0

- The board tells you when a session finishes its answer: the focused VS Code window shows a toast "<title>: done" with an Open button, next to the existing toast for a session that starts waiting
- When no VS Code window has focus, one window shows a Windows notification instead, for both ("needs you" and "done"); a click on it opens the session in its window and clears its unseen mark. Several windows never show the same one twice, and a burst shows three and says how many more
- Mute replaces Blind: the bell on a row mutes a session in place. A muted session raises no toast or notification and counts nowhere, but keeps its place, its colour and its order in its section, marked "muted". The folded Blinded groups are gone; sessions blinded under 0.10.0 come up muted
- Settings: `sessionBoard.notifyOnDone` turns the done notifications off, `sessionBoard.systemNotifications` the Windows notifications
- Browser page: a browser notification for a finished answer too; `POST /api/mute/<id>` and `POST /api/unmute/<id>` replace the blind routes
- Every row shows its session id ("Session f8005c0d"); a click folds out the full id, start time, process, window and transcript path, with copy buttons for the id and the path. Search takes an id bare or as Claude Code shows it
- Titles are Claude Code's own: the board keeps none of its own any more. ✎ suggests a title (one short haiku call) and you confirm or edit it; for a session that is not running the board writes it where Claude Code keeps titles, so its sidebar and `claude --resume` show it; for a running session the suggestion goes onto the clipboard and Claude Code's own rename box opens on it. ✎ also works on ended sessions in the search results. Titles set with ✎ in 0.10.x are no longer shown
- Browser page: `POST /api/title/suggest/<id>` and `POST /api/title/<id>?title=` replace `/api/retitle/<id>`
- A window still running 0.10.x shows the formerly blinded sessions unfolded until it reloads

## 0.10.0

- Blinded is per window section: ⊘ keeps the session in its own section, under a folded Blinded group at the bottom of that section, where it stays, waiting or not, until ⊙ brings it back. The group carries its own number (amber when one of its sessions waits); the global Blinded section at the bottom of the board is gone
- A switch in the header picks the order inside the sections: by activity (waiting, working, unseen, idle, then age, as before) or manual. In manual mode every live row gets a ⋮⋮ handle: drag it onto another row of the same section, or focus a row and press Alt+Up or Alt+Down. Waiting and unseen rows keep their colour and their count but stay where you put them; a session you have not placed yet sits on top. The order and the switch are shared by every window and the browser page and survive restarts
- Browser page: `POST /api/order?ids=<comma-joined ids>` and `POST /api/order/mode?mode=activity|manual`
- A window still running 0.9.x keeps the old Blinded section and the activity order until it reloads

## 0.9.1

- The board deletes heartbeat records older than a day from `%TEMP%\claude-sessions-board` while it reads them. Before, one record per window start stayed behind for good and every poll in every window parsed all of them (213 files on one machine after five weeks). A record over 45 s old was and is ignored; it now also goes after a day, as does a `.tmp` file a dying writer left behind
- The 0.9.0 entry below names the blind marker path correctly again (a stray control character had eaten a letter)

## 0.9.0

- Live sessions are grouped by VS Code window: one collapsible section per window, named after its workspace (the window's folder, or the name of a multi-root workspace), the window this board runs in first, the rest by activity; sessions started outside VS Code sit under Elsewhere. The Needs you, Working, Unseen and Idle groups are gone; inside a section the rows keep that order, and "Show N idle over 2h" folds per section
- Every section heading carries a number: the sessions in it that wait for you (amber) or are unseen (green)
- ⊘ on a row blinds the session: it moves under the folded Blinded section at the bottom and stays there, waiting or not, until ⊙ brings it back. Blinded sessions count on the Blinded heading only; the counts line, the tab title, the activity-bar badge, the toast and the browser notification leave them out. The flag lives in `%LOCALAPPDATA%\SessionBoard\blinded\<id>.json`, is shared by every window and the browser page, and goes once the session can no longer be resumed
- A typed filter shows blinded and archived matches in their window section, every section unfolded
- A window names its section through the heartbeat its board writes; a window still running an older board keeps the folder name until it reloads
- Browser page: `POST /api/blind/<id>` and `POST /api/unblind/<id>`

## 0.8.0

- Sessions archived in Claude Code's own sidebar are put away on the board too. The board reads Claude Code's archive list from VS Code's state database (read-only, through Node's built-in SQLite) and marks those rows "archived in Claude Code"; they return when Claude Code unarchives them, and ⤒ is not offered for them
- ⤓ now also moves the transcript out of `~/.claude/projects` into `%LOCALAPPDATA%\SessionBoard\transcripts\<folder>\<id>.jsonl` (a hard link, then the old name goes), so Claude Code's session list drops the session at its next refresh. ⤒, a click on the row or ⧉ moves it back before anything resumes it. While it is stowed, `claude --resume <id>` and Claude Code's own picker do not find the session; the board's search still does
- A move or a restore that fails says so on a notice line above the groups, and as a VS Code warning; the session stays archived on the board
- ✕ is unchanged: Claude Code keeps an ended session in its list until its own auto-archive (`claudeCode.archiveInactiveSessions`, 14 days by default; sessions that are open, waiting or unread are never auto-archived)
- The browser page needs Node 22.13 or newer for the state-database read

## 0.7.0

- New group Unseen between Working and Idle: a session whose answer ended while the board was running and that you have not opened since. Its row says "unseen" with a green mark; opening it from the board, or sending it a new prompt, moves it back to Idle. Sessions that were already idle when the board started are not flagged
- ✎ on a row asks for a new title from the session's progress: one short haiku call over the recent prompts and the last answer, hook-free and without tools. The title is the board's own; Claude Code's files are not written, and a later /rename wins again

## 0.6.1

- The Marketplace page shows its screenshot again; the image link pointed one folder too high

## 0.6.0

- The usage strip now names the account the `claude` command is signed in with: the email, with organisation and plan on hover. It comes from `claude auth status --json`, run beside the usage probe. A logged-out CLI shows "not logged in"; a CLI without that command shows no account and the Output channel says why

## 0.5.0

- ⤓ on a row archives the session: it ends like ✕ does and stays off the board afterwards. An archived session comes back on its own only when it needs you; "Show N archived" lists the rest, and ⤒ or a click on the row brings one back. The board's archive is its own and does not touch Claude Code's
- A session whose record cannot be read or whose process cannot be inspected is no longer reported as gone while its process still runs; ✕ and ⤓ refuse instead
- Background sessions (`claude --bg`) are ended through `claude stop`; killing their process only made the CLI's daemon start it again

## 0.4.3

- ↻ in the usage strip now spins and stays disabled until the refresh has finished; a click within 15 s of the last refresh says "refreshed a moment ago" in the strip, and a failed refresh says why there too

## 0.4.2

- The extension id is now `nima-ghorbani.session-board-vscode` and the Marketplace display name "Session Board for VS Code"; the previous listing was removed by mistake and the Marketplace never releases a removed name or display name. The sidebar still says Session Board. If you installed an earlier build from source, uninstall the old Session Board entry in the Extensions view

## 0.4.1

- Per-model weekly windows (for example "7d Fable") now show up; the strip reads the same limits list as Claude Code's own usage screen

## 0.4.0

- Usage limits now come straight from the Claude Code CLI, refreshed every 5 minutes and on ↻; no status line setup any more. If you pasted the `statusLine` entry for 0.3.1, remove it from `~/.claude/settings.json`
- The strip shows per-model weekly windows and extra usage when your plan has them, and keeps the last numbers with a warning when a refresh fails
- Fixed: the strip stayed on "waiting for the first Claude reply" for sessions run inside VS Code

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
