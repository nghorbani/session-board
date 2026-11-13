# Contributing to Session Board

This page is for you if you want to change or extend the board from a fork of this
repository: what you need, how the pieces fit, where a change goes, how to test it and what a
pull request should bring. The user-facing pages are [README.md](README.md) (repository) and
[extension/README.md](extension/README.md) (the Marketplace listing).

## What you need

- Windows for the full feature set. The window mapping and ending a session use
  `Win32_Process` and `taskkill`; on macOS and Linux the list, the search and the usage strip
  work, and a click copies the resume command instead of jumping.
- Node 22.13 or newer (the page tests use the global `WebSocket`; the board reads VS Code's
  state database with `node:sqlite`).
- VS Code 1.100 or newer with the Claude Code extension installed, and the `claude` command
  line on the PATH VS Code sees.
- ripgrep (`rg`) on PATH for content search; VS Code's bundled copy is found automatically.
- Chrome or Edge for the page tests and the README screenshots. Without one the page suite is
  skipped with a reason; set `SCREENSHOT_BROWSER` to any Chromium executable otherwise.
- PowerShell 7 for `build.ps1` and `start.ps1`.

## Layout

```
session-board/
  extension/                  the VS Code extension; everything the package ships lives here
    package.json              manifest: activity-bar container "Session Board", webview view, commands
    extension.js              VS Code host: polling, badge, open/end/search, URI handler
    notify.cjs                which waiting and done events a window announces, and where
    core.cjs                  data layer: sessions, transcript facts, window mapping, jump, end,
                              archive, search, usage limits and the signed-in account
    index.html                the page; runs in the webview and in a browser
    README.md                 Marketplace page
    CHANGELOG.md              one plain line per user-visible change, grouped by version
    media/                    icons and the README screenshots (rendered, never hand-edited)
    tests/                    node --test suites, see "Tests"
    tests/shim/               stand-ins: claude-shim.js (the CLI), vscode.js (the API), host.cjs
    .vscodeignore             keeps tests/ out of the package
  server.cjs                  browser front end over the same core.cjs and index.html
  start.ps1                   runs server.cjs and opens the browser
  build.ps1                   tests, packages the .vsix with vsce 4 and installs it
  tools/screenshot.cjs        renders the README screenshots from index.html with example data
  tools/release-notes.cjs     prints one CHANGELOG section, used by the release workflow
  .github/workflows/release.yml   builds and attaches the .vsix to a GitHub Release on a version tag
  LICENSE                     MIT, covers the root files too
```

## Running your changes

There are two loops, and most work happens in the first.

**Page and data layer in a browser.** `pwsh -File start.ps1` serves `index.html` over
`core.cjs` through `server.cjs` at <http://127.0.0.1:4317>. Edit and reload the tab; VS Code
itself needs no reload, and the page is the same file the webview shows. Every `/api/*` route needs the
per-run token the page embeds (`X-Board-Token`) and a matching Host/Origin; JSON replies are
`no-store`. Routes: `GET /api/sessions`, `POST /api/focus/<id>`,
`POST /api/end/<id>[?force=1][&archive=1]`, `POST /api/unarchive/<id>` (replies with `restoredTo`),
`GET /api/search?q=&content=0|1`, `POST /api/usage/refresh`, `POST /api/seen/<id>`,
`POST /api/title/suggest/<id>`, `POST /api/title/<id>?title=`, `POST /api/mute/<id>`, `POST /api/unmute/<id>`,
`POST /api/order?ids=<comma-joined ids>`, `POST /api/order/mode?mode=activity|manual`,
`POST /api/order/show?show=all|running`, `POST /api/archive/<id>` (an ended session).

**The VS Code host.** `pwsh -File build.ps1` runs the tests, packages the `.vsix` and installs
it (`-NoInstall` stops after packaging). What to expect from VS Code (seen on 1.138): a first
install of a new extension id hot-loads into every running window within seconds; an update to
an extension already activated in a window waits for that window to reload, and VS Code refuses
to replace a running extension. A reload restarts the window's extension host, which is the
parent process of every `claude.exe` in it, so do not reload a window whose sessions you still
need; a new window runs the newest installed version and shows every session anyway. The
Output panel channel **Session Board** logs each decision the host makes.

If the Session Board icon is missing from the activity bar of one workspace only, and not in
its "..." overflow either, while "View: Show Session Board" still opens the view: VS Code keeps
a per-workspace visibility list for activity-bar containers
(`workbench.activity.viewletsWorkspaceState` in that workspace's `state.vscdb`) and a stale
`visible: false` there is re-applied whenever the bar is rebuilt from storage. Reload that
window and, as soon as the icon appears, drag it one slot in the activity bar; the drag saves
the flag back as visible.

## Tests

```powershell
cd extension; npm test          # node --test "tests/*.test.cjs"; build.ps1 runs this too
node tools/screenshot.cjs       # refresh extension/media/board.png and search.png
```

Every suite isolates the board's data directory by setting `LOCALAPPDATA` and `XDG_DATA_HOME`
before it requires `core.cjs`; `SB_PROJECTS_DIR` and `SB_SESSIONS_DIR` point the data layer at
fixture folders, `SB_HEARTBEAT_DIR` moves the board heartbeats out of the OS temp dir, and
`SB_WINDOW_MAP` (`{"<pid>": {"windowId": N, "exthostPid": P}}`) gives rows a window without
PowerShell or `exthost.log`, and `SB_VSCODE_EXTENSIONS_JSON` stands in for the list of extensions
VS Code has installed. Nothing in the suites touches your real sessions or needs Claude Code
installed.

- `usage.test.cjs`: the usage and account path of `core.cjs` against `tests/shim/claude-shim.js`,
  which stands in for the CLI. `SB_SHIM_MODE` picks the usage reply (`ok`, `hang`, `garbage`,
  `exit2`, `error`), `SB_SHIM_AUTH` the `auth status` reply (`ok`, `notice`, `loggedout`,
  `fail`, `hang`), `SB_SHIM_TITLE` the title call's reply (`ok`, `fail`, `empty`, `hang`);
  `SB_SHIM_BODY` substitutes a whole usage body.
- `refresh-usage.test.cjs` and `archive-host.test.cjs`: `extension.js` booted by
  `tests/shim/host.cjs` against `tests/shim/vscode.js`, which records registered commands,
  status-bar messages, warnings and log lines so a test can assert on them.
- `archive.test.cjs`: the archive marker store, the end path of `core.cjs` (registry records
  and processes faked through the shim's `stop` branch), and the transcript stow and restore
  with their recovery paths (`link` and `unlink` failures injected).
- `claude-archive.test.cjs`: Claude Code's archive read from a `state.vscdb` built in the test
  (`SB_CODE_USER_DIR`), its cache and failure paths, and `archivedBy` on rows. Every suite
  points `SB_CODE_USER_DIR` at a temp dir so none reads the real database.
- `page.test.cjs`: `index.html` in headless Chrome over the DevTools protocol against an
  in-test HTTP server that plays scripted `/api` answers. Skipped when no Chromium is found.
- `manifest.test.cjs`: pins `publisher`, `name` and `displayName`; see "Conventions".
- `release-notes.test.cjs`: the changelog has a section for the manifest version and the
  release-notes script prints it.
- `unseen.test.cjs`: the unseen and seen markers, `noteAnswer()` and the `unseen` flag on
  snapshot rows, and which title a row shows (custom-title line, sidecar, generated).
- `title.test.cjs`: the transcript excerpt (also with a prompt buried behind megabytes of
  tool output), the cleaning of the model's reply, `suggestTitle()` against the shim, and
  `renameSession()`: the line and the sidecar for a session that is not running, `claude-owned`
  for a running one.
- `unseen-host.test.cjs`: opening marks a session seen, the `seen` and `copyText` messages, and
  ✎: the prefilled box and the write, the hand-over to Claude Code's rename box for a running
  session (here, through the `/rename` route of the board in its window, or a message).
- `server-title.test.cjs`: `server.cjs` answering the title write route.
- `muted.test.cjs`: the muted marker store (existence is the flag), the move of 0.10.0
  `blinded\` markers (and its race), pruning by liveness and transcript presence, the `muted`
  flag on rows, heartbeat names, the window label and `focusedPeerAt()`.
- `muted-host.test.cjs`: the `mute` and `unmute` messages, the badge, the notifier as the host
  wires it (VS Code toasts, the Windows path), `handleUri` marking a session seen, the focus
  heartbeat, and `thisWindowId` on the posted snapshot.
- `server-mute.test.cjs`: `server.cjs` as a child process answering the mute routes.
- `notify.test.cjs`: `notify.cjs` with plain fakes: which events are announced, the routing
  table (focused, focused peer, pending, Windows path), batching, release and retry.
- `notices.test.cjs`: notice claims, the toast XML and the PowerShell script (no session text
  in it), through the `SB_TOAST_LOG` dry run.
- `heartbeats.test.cjs`: the heartbeat readers delete records older than a day and leftover
  `.tmp` files, keep fresh and merely stale ones, and `boardAlive()` answers against a temp
  installed-extension list.
- `order.test.cjs`: the order store (`setOrder()` checks the whole list before the first
  write, `readOrder()`), the sort-mode file, pruning shared with the muted store, and
  `rank` and `order.mode` on the snapshot.
- `order-host.test.cjs`: the `order`, `sortMode`, `showMode` and `archivePast` messages and their replies.
- `ended.test.cjs`: `endedSessions()` (folders from the heartbeat root and its worktrees, what is
  left out, which window owns a session, a root without git), the show store, `archivePast()`.
- `server-order.test.cjs`: `server.cjs` as a child process answering the order, show and archive routes.

A change comes with a test in the matching suite. New CLI behaviour gets a shim mode, not a
real `claude` call; new page behaviour gets a scripted snapshot in the page suite.

## How it works

- `core.cjs` runs `claude agents --json` (the built-in agent view renders only background
  sessions; the JSON lists every one) with `CLAUDE*` env vars stripped so it is not treated
  as a nested session, validates the row shape, and enriches rows.
- Live rows join their transcript `~/.claude/projects/<slug>/<sessionId>.jsonl` via a
  filename index (deriving the path from the cwd matches only two thirds of sessions).
  Context tokens come from the tail of the transcript, the same formula the context-guard
  hook uses; the heading is Claude Code's name: the newest `custom-title` line in the tail,
  else `<project dir>\<id>\custom-title.json` (the order Claude Code's own list uses), else
  the registry's user-set name, else the `ai-title` line; the last prompt comes from
  `last-prompt` lines. The facts cache keys on the transcript's size and mtime and the
  sidecar's mtime.
- **Window mapping**: a session's `claude.exe` is a child of its window's extension host
  (`Code.exe --type=utility --utility-sub-type=node.mojom.NodeService`); one `Win32_Process`
  query gives parents, evicted when a pid disappears. VS Code logs each window's extension-
  host pid in `%APPDATA%\Code\logs\<run>\window<N>\exthost\exthost.log`. Inside the
  extension, "this window owns it" is `parent === process.pid`.
- **Jump**: own window → `claude-vscode.editor.open(sessionId, …, { programmatic:
  'honor-preferred-location' })`; the sixth argument matters, since called bare that command
  opens an editor tab and rewrites `claudeCode.preferredLocation` to `panel`. Other window
  → `code --open-url "vscode://<board id>/open?session=<id>&windowId=<N>"` when that window
  runs the board (heartbeats in `%TEMP%\claude-sessions-board\board-<exthostPid>-<id>.json`,
  filtered to ids VS Code lists as installed; a record older than a day is deleted by the next
  board that reads it), else Claude Code's own handler, which always
  opens an editor tab. VS Code's `URLHandlerRouter` routes on `windowId=<N>` and the handling
  window force-focuses itself.
- **End**: registry record `~/.claude/sessions/<pid>.json` must name the session, its status
  is re-read (busy/waiting needs an explicit force), the process must be `claude.exe` with a
  creation time within 5 s of the record (`procStart` FILETIME), then `taskkill /PID /T /F`
  and a wait until the pid is gone. Outcomes: `ended`, `needs-force`, `gone`, `mismatch`,
  `denied`, `partial`, `timeout`, `pending`, `unsupported`, `failed`. `gone` is only said
  about a pid that is not running: a missing record or a failed inspection of a live pid
  is refused (`mismatch` / `failed`). A row of `kind: background` (`claude --bg`) is not
  killed: those jobs belong to `claude daemon`, which runs each one under a pty host and
  respawns a killed process, so the board runs `claude stop <job id>` (the row's 8-character
  `id`) and waits for the pid to go; the conversation is kept and `claude --bg --resume
  <session id>` continues it under the same id.
- **Archive**: ⤓ is `endSession(id, { archive: true })`. `applyArchive()` records the id
  when the outcome is `ended`, `gone` or `unknown` (all "not running") as one marker file
  `%LOCALAPPDATA%\SessionBoard\archived\<id>.json` (no shared list, so windows and the
  browser page never overwrite each other); a marker write that fails after the kill comes
  back as `ok` with `archived: false` and `archiveError`. Then `stowTranscript()` moves
  `~/.claude/projects/<slug>/<id>.jsonl` to `%LOCALAPPDATA%\SessionBoard\transcripts\<slug>\<id>.jsonl`
  with `linkMove()` (a hard link, then the old name is unlinked; never a copy of a file a
  resumed session may still be writing, so a stow across volumes is refused). That is what
  makes Claude Code's sidebar drop the session: it lists the top-level `.jsonl` files of the
  project folder (seen on 2.1.299; an implementation detail, so check it after a Claude Code
  upgrade). The stowed location is the record and the marker stays `{at}`: a crash between
  the link and the unlink leaves one file under two names, which the next stow or restore
  completes. The move is refused, with `moveError` in the result and a warning, when the id
  sits in two project folders, when a registry record names it under a live pid (checked
  twice, the last time right before the link; a resume that starts after that keeps writing
  the same file under its new name), when a different file already sits at the archived path,
  or when the marker is gone (an unarchive in between; a marker that goes after the link is
  honoured by moving the file back, and one that goes after that last check leaves the file
  stowed until the next open restores it, since restoration keys on the stowed file, not the
  marker). ⤒, a click on a live archived row,
  `openPast` and ⧉ go through `unarchiveSession()`: it awaits a pending end of the id, runs
  `restoreTranscript()` (`linkMove` back by slug, or `copyMove` through a `.part` file across
  volumes) and unlinks the marker only after; a restore onto a different file throws with
  both paths and keeps the marker, so ⤒ can retry. `snapshot()` and `searchSessions()` set
  `archived` and `archivedBy` (`board`, `claude-code`, `both`) on every row from the markers
  and from Claude Code's own `hiddenSessionIds`, read read-only from
  `%APPDATA%\Code\User\globalStorage\state.vscdb` (row `Anthropic.claude-code` of
  `ItemTable`, the default profile only, `node:sqlite`, one read per change of the file's stat
  and at least every 30 s; a failed read keeps the previous ids and is logged once per change).
  Only that row is read and nothing from it is logged beyond the ids. The page puts archived
  rows away unless they are waiting and offers ⤒ only for the board's own flag; a move or
  restore failure shows on the notice line above the groups.
- **Search**: ripgrep reads the transcripts, whole files, as a child process: one pass for
  the newest `aiTitle` per file, one for the newest `customTitle`, one for the first `cwd`,
  all with constant patterns; the content pass is `rg -i -l -F` with the query and its
  JSON-escaped form; snippets come from `rg --json -F` byte offsets sliced in JS, decoded
  from `message.content` when the match is conversation text. Results merge the live
  snapshot (union, so a live session without a transcript still appears), cap at 50, report
  `total`, `shown`, `partial`, `skipped`. All children are tracked per request and killed on
  cancel or supersede.
- **Usage limits**: `fetchUsage()` in core.cjs runs `claude -p --input-format stream-json
  --output-format stream-json --verbose --no-session-persistence --settings <file>
  --disable-slash-commands --strict-mcp-config --mcp-config <file>` (both files live in
  `%LOCALAPPDATA%\SessionBoard`, holding `{"disableAllHooks":true}` and `{"mcpServers":{}}`;
  files, not inline JSON, because the spawn goes through `cmd.exe` and Node does not quote
  arguments in shell mode) and writes one line on stdin:
  `{"type":"control_request","request_id":"…","request":{"subtype":"get_usage","skip_behaviors":true}}`.
  The CLI answers with a `control_response` carrying `rate_limits` and exits; no model
  call, no hooks, no MCP servers, no transcript. `rate_limits.limits` is the list Claude
  Code's own usage panel renders (`kind` session / weekly_all / weekly_scoped with
  `scope.model.display_name`, `percent`, `resets_at`); the board reads that list first and
  falls back to the named objects (`five_hour`, `seven_day`, `seven_day_opus`, …) of the
  older shape. Everything else in `rate_limits` (experimental windows at 0%, `spend`,
  `seven_day_breakdown`) is ignored. This is the request the VS Code extension itself sends
  for its usage panel; the CLI's schema marks it experimental, so `parseUsageResponse()` is
  tolerant and reports a shape change explicitly. The result is cached in `usage-cli.json`
  (a failed probe keeps the last good windows and carries the error); `refreshUsageIfStale()`
  runs from the extension's poll (5 min visible, 15 hidden) and from the browser server's
  sessions route; probes are throttled to one per 15 s and a timeout kills the process tree.
  ↻ on the page sends `refreshUsage` with a request id and the host answers `usageResult`
  with the same id (throttled or error flags included); the page keeps the button spinning
  and disabled until that reply or a 45 s watchdog, and only a reply carrying its own id ends
  the busy state.
- **Account**: `probeAccount()` runs `claude auth status --json` in parallel with the usage
  probe (same stripped environment and cwd, its own 15 s timeout with the same process-tree
  kill) and keeps `loggedIn`, `authMethod`, `apiProvider`, `email`, `orgName` and
  `subscriptionType` as `account` in the same `usage-cli.json` record. A failed account
  probe (an older CLI answers `error: unknown command 'auth'`) keeps the previous `account`
  and carries the reason as `accountError`; it never changes the usage `state`. The page
  shows the email in the strip head and the rest on hover; the host logs an `accountError`
  once per change.
- **Unseen**: each process remembers the registry's `statusUpdatedAt` per session. When an
  idle row shows a newer value than the one last seen (an answer ended, even in a turn
  shorter than a poll interval), `noteAnswer()` writes `%LOCALAPPDATA%\SessionBoard\unseen\<id>.json`
  with that time; the time comes from the registry, so every window writes the same value
  and a slow window cannot bring back a flag the user already cleared. Opening the session
  from the board (the host's `openSession()`, the `seen` message, `/api/focus` and
  `/api/seen`) writes `seen\<id>.json` with the current time. A row is `unseen` while it is
  idle and its unseen time is newer than its seen time; a session first observed idle is never
  flagged, and a new prompt makes it busy, so the flag only returns with the next answer.
  Markers older than two weeks are dropped on read. The page shows those rows with the
  unseen status inside their window's section, counts them on its badge, and flips the flag
  at once on a click.
- **Ended sessions**: each board writes its window's first workspace folder into its heartbeat
  (`root`). `endedSessions()` (core.cjs) turns every fresh heartbeat into the folder set Claude
  Code's own list uses: the root plus the repository's worktrees (`git worktree list --porcelain
  -z`, refreshed in the background every 60 s; a poll never waits for git), each mapped to its
  folder under `~/.claude/projects` (`projectFolderName()`: every character outside
  `[A-Za-z0-9]` becomes `-`; compared case-insensitively on Windows). It returns the transcripts
  there that are not running, not in Claude Code's `hiddenSessionIds`, not board-archived and
  have a user message, newest first, as `snapshot().ended`; badges, counts and notifications read
  `sessions` only. A session two windows would list goes to the window whose root is its folder,
  else the window of the repository's main folder, else the lower window id. The header switch
  "all | running" lives in `show.json` (`setShowMode()`); ⤓ on an ended row is `archivePast()`:
  the archive marker, then `stowTranscript()`. Typing in the search box filters the sections and,
  after 400 ms without a key, runs the title search (`startSearch(false)`); Enter adds content.
- **Sections and Muted**: the page groups live rows with `groupSessions()` (index.html):
  one section per `window.id` (`Elsewhere` for rows without one), this window first
  (`thisWindowId`, set by the host from `windowIdForExthost(process.pid)`), then by waiting
  and unseen rows and label. A section's label is the workspace name the board in that
  window writes into its heartbeat (`writeHeartbeat(pid, id, vscode.workspace.name, focused)`,
  read back with `heartbeatNames()`), else the most common folder name of its sessions. The
  bell writes `%LOCALAPPDATA%\SessionBoard\muted\<id>.json` (`muteSession()`; existence is the
  flag, the content is never parsed, so a half-written file seen by another window is never
  deleted); the struck bell unlinks it. `readMuted()` first renames any 0.10.0 marker from
  `blinded\` into `muted\` (one atomic rename each, so a racing window cannot bring back a mute
  removed meanwhile). `snapshot()` sets `muted` on every row and drops a marker whose session is
  neither live nor has a transcript under either root (`pruneDead()`), so a mute lasts as long
  as a resume is possible. A muted row stays in its section, dimmed, with a chip; the page
  holds a click in `state.pendingMute` until a snapshot agrees (10 s at most) and leaves muted
  rows out of the section badge, the counts line, the title and the browser notification; the
  host leaves them out of the activity-bar badge and the notifier. A typed filter shows every
  match in place, sections unfolded.
- **Notifications**: `notify.cjs` (no vscode import; the host injects focus, toasts, settings and
  the core calls) sees every snapshot. Events: a row that starts waiting (keyed by its
  `statusUpdatedAt`) and a known row whose `unseenAt` moved (the time `noteAnswer()` wrote into
  the unseen marker, so every window keys one answer the same way). A focused window shows a
  VS Code toast. Otherwise `focusedPeerAt()` reads the heartbeats: a focused window that wrote
  after the event has seen it; an older focused record keeps the event pending up to 60 s (that
  window may have died); with no focused window, `claimNotice(id, kind, at)` creates
  `notices\<id>.<kind>.<at>` exclusively and the window that wins calls `showSystemToast()`:
  one `powershell.exe -EncodedCommand` per batch whose script holds the toast XML only as
  base64 (session text never becomes PowerShell source), shown under PowerShell's
  AppUserModelID, with the session's `openUri()` as a protocol launch. A failed batch releases
  its claims and is retried once, then reported once. `SB_TOAST_LOG` writes the script to a file
  instead of spawning (tests).
- **Manual order**: the header switch (`#sortMode`, `applyMode()`) writes
  `%LOCALAPPDATA%\SessionBoard\sort.json` through `setSortMode()` (tmp then rename); `snapshot()`
  reads it back as `order.mode`. In manual mode `rowOrder()` sorts a section
  by `rank` (a row without one sits on top, newest first); by activity it is waiting,
  busy, unseen, idle, then age. A move (the ⋮⋮ handle, HTML5 drag and drop on the handle
  only, or Alt+Up/Down on the focused row) ends in `applyOrder(key, ids)`: the whole group's
  ids in their new order, held in
  `state.pendingOrder[key]` until a snapshot agrees or 10 s pass, sent as `order` to the host
  or `POST /api/order?ids=` (comma-joined, 8000 characters at most; core caps the list at
  500). `setOrder()` checks every id before the first write, then writes
  `order\<id>.json` = `{ rank: index, at }`; ids outside the list keep their ranks, and a marker is
  pruned like a mute marker. Ranks are global by id and read inside whichever section the
  row is in, so a session resumed in another window lands somewhere plausible there until its
  next move; two windows reordering one group at once settle on the last write. A typed
  filter disables moving, and so does the activity mode. The per-file read runs once per
  snapshot like the other stores; revisit it when `order\` holds about 1000 files (a 90-day
  expiry through `readMarkers()` is the cheap mitigation).
- **Titles**: the board keeps none of its own (0.10.x boards wrote `titles\<id>.json`; it is
  no longer read and is left on disk). ✎ sends `retitle`; `suggestTitle()` collects the last six prompts and the
  newest answer with `transcriptExcerpt()`, which reads the transcript from its end in 1 MB
  steps until it has them (a long tool run can push the last prompt megabytes back; after
  16 MB without a prompt it gives up) and skips injected `isMeta` lines, text starting with
  `<`, tool results and thinking. It then runs
  `claude -p --model haiku --output-format text --no-session-persistence --tools "" --settings
  <file> --disable-slash-commands --strict-mcp-config --mcp-config <file>` with the
  instruction and the excerpt on stdin, keeps the last non-empty stdout line (settings
  warnings come first) unquoted and without a trailing period. Outcomes: `invalid`,
  `no-transcript`, `timeout` (90 s, process tree killed), `failed`, `empty`. The host then
  routes by whether the session runs in a VS Code window: if it does, `handToClaude()` puts the
  suggestion on the clipboard and opens `claude-vscode.renameSessionTab` on the revealed
  session (here, or through `vscode://<board>/rename?session=&windowId=` when the board in the
  owning window reports version 0.11.0 or newer in its heartbeat), because a running CLI
  writes its own `custom-title` after every answer and only Claude Code's rename tells it.
  Otherwise an input box prefilled with the suggestion; Enter calls `renameSession()`, which
  appends `{"type":"custom-title","sessionId","customTitle"}` to the transcript (what Claude
  Code's rename appends; a resumed CLI reads it and writes it on) and then writes the sidecar
  (tmp then rename). It answers `claude-owned` for a session running in a window or in a
  terminal whose registry record says `nameSource: "user"`.

## Where a change goes

- To show something new on a row, enrich the row in `snapshot()` (core.cjs), render it in
  `render()` (index.html), and assert it in the page suite with a scripted snapshot. Rows are
  plain objects that cross `postMessage` and HTTP unchanged, so keep them JSON.
- A new action on a row needs a message `type` in `onMessage()` (extension.js), a route in
  `server.cjs`, and the page's `send()`/`api()` pair. The host answers with a `<name>Result`
  message that carries the session id or request id the page used, so a late or foreign reply
  never changes the page's state; the ↻ lifecycle comment in index.html shows the pattern.
- The usage strip is `parseUsageResponse()`, `parseAuthStatus()` and `usageState()` in
  core.cjs plus `renderUsage()` in index.html; each new reply shape gets a shim mode.
- Anything that reads Claude Code's files or CLI output reads undocumented internals. Validate
  the shape, keep the last good data when a probe fails, and say "shape changed" in the UI
  instead of guessing. The board reads no credentials and sends nothing anywhere; keep it
  that way.
- Platform-specific code goes behind `IS_WINDOWS`, with the "copy the resume command"
  fallback the other platforms get today.

## Conventions

- Plain language in the UI, the docs and the changelog; name the file, the command and the
  user-visible effect.
- `extension/CHANGELOG.md` gets one line per user-visible change under the next version;
  `extension/README.md` changes with the behaviour it describes. Screenshots come from
  `tools/screenshot.cjs` with its example data, never from a real board.
- Say in plain text that the board works with Claude Code, but do not use the Claude Code or
  Anthropic names or logos as part of a product name or logo (Anthropic's rule for third
  parties). The name "Session Board" and the description follow that.
- `publisher`, `name` and `displayName` in `extension/package.json` identify the Marketplace
  listing and the extension id the heartbeat files and the cross-window URI route carry;
  `tests/manifest.test.cjs` pins them. A fork that publishes its own listing changes the
  manifest and that test together.

## Pull requests

Branch from `main`, one topic per pull request, `npm test` green, a changelog line, and in the
description how you checked it in VS Code (VS Code and Claude Code versions) with a screenshot
for anything visible. Claude Code releases change the shapes the board reads, so say which
version you ran against.

## Releases

These are the maintainer's steps. Bump `version` in `extension/package.json`, add the `## X.Y.Z` section to
`extension/CHANGELOG.md`, commit as `Session Board X.Y.Z: <what changed>`, tag `vX.Y.Z` and
push the tag. The Release workflow (`.github/workflows/release.yml`) runs on a Windows runner:
it checks the tag against the manifest, runs `build.ps1 -NoInstall` (tests and package) and
attaches `session-board-vscode-X.Y.Z.vsix` to a GitHub Release whose notes are that changelog
section (`tools/release-notes.cjs`).

The Marketplace listing `nima-ghorbani.session-board-vscode` is published by the maintainer
from the same `.vsix` (`npx @vscode/vsce@4.0.0 publish` from `extension/`, or an upload on the
manage page); the Marketplace runs its own security checks before and after listing. A fork
publishes under its own publisher and name. Names and display names are unique across all
publishers and a removed listing's name stays reserved, so unpublish a listing you no longer
want, never remove it.
