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
    steps.cjs                 transcript reader of the Steps tab: index, active path, steps, sections
    steps-service.cjs         the Steps tab's messages: open, bodies, search, follow, notes, send
    notes.cjs                 the notes store, one file per note
    pdf.cjs                   the PDF export: finds a Chromium-based browser and prints a page with it
    steps.html                the Steps page; runs in a webview panel and in a browser
    README.md                 Marketplace page
    CHANGELOG.md              one plain line per user-visible change, grouped by version
    media/                    icons and the README screenshots (rendered, never hand-edited)
    tests/                    node --test suites, see "Tests"
    tests/shim/               stand-ins: claude-shim.js (the CLI), vscode.js (the API), host.cjs
    .vscodeignore             keeps tests/ out of the package
  server.cjs                  browser front end over the same core.cjs and index.html
  start.ps1                   runs server.cjs and opens the browser
  build.ps1                   tests, packages the .vsix with vsce 4 and installs it
  tools/screenshot.cjs        renders the README screenshots with example data: the board from
                              index.html, the Steps tab from steps.html over the real steps service
  tools/chrome.cjs            starts, drives and stops a headless Chromium (found by pdf.cjs's
                              findBrowser); used by the screenshot tool and by both page suites
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
cd extension; npm test          # node tests/run.cjs: the suites in parallel, then the two page suites alone; build.ps1 runs this too
node tools/screenshot.cjs       # refresh extension/media/board.png, search.png and steps.png
node tools/screenshot.cjs steps # only the pictures named
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
- `order-host.test.cjs`: the `order`, `sortMode`, `showMode` and `archivePast` messages and their
  replies, and `claudeCode.claudeProcessWrapper` reaching `snapshot()`.
- `ended.test.cjs`: `listedSessions()` (the root's folder and its real path's, no worktree
  folders, programmatic and daemon sessions left out, archived and stowed rows apart, which
  window owns a session), an unreadable Claude Code archive, the show store and its 0.11.2
  file, `archivePast()`.
- `server-order.test.cjs`: `server.cjs` as a child process answering the order, show and archive routes.
- `shim/transcript.cjs`: the transcript line constructors that `steps.test.cjs` and
  `steps-service.test.cjs` share.
- `steps.test.cjs`: `steps.cjs` against JSONL written into a temp dir: the active path across a
  retry and a compaction, split responses, tool results off the path, questions and their
  answers, a message typed mid-turn, backward reading in chunks (progress calls and bytes
  read follow the file size, not the line count), growth, a partial last line, sections,
  active time and the figures of a section's facts line.
- `pdf.test.cjs`: `pdf.cjs` with a function in place of the browser (the arguments, the sealed
  page, no file left after a failed print), and one print with a browser of the machine
  when there is one.
- `steps-service.test.cjs`: `steps-service.cjs` with a fake timer: the first reply before the
  whole index, progress pushes spaced in time, every push carrying the compact records of the
  steps it adds, follow, search (ripgrep faked, the Node scan, the 500 cap, notes), the seen
  marker, the note messages and the hand-over text.
- `notes.test.cjs`: the notes store: one file per note, sent records as files of their own,
  the 16 KB cap, an edit racing a delete, two writers at once, pruning.
- `steps-host.test.cjs`: the Steps panel of `extension.js` against the fake `vscode`: one panel
  per session, links (web, folder, file, Markdown, `file:line`, refused network paths, the
  question for a path outside the trusted folders), `revealHere()` with and without a prompt,
  `deliverToSession()` on every branch, and the `/steer` claim (fresh, stale, replayed).
- `server-steps.test.cjs`: `server.cjs` as a child process: the `/steps` page (nonce, nothing
  injected from the query), `POST /api/steps` with its 64 KB limit, the poll route, notes
  over HTTP and the copy-only answer to a send.
- `steps-page.test.cjs`: `steps.html` in headless Chrome like `page.test.cjs`, against scripted
  replies. A few tests set `fake.service` to the real `steps-service.cjs` over a transcript
  written in the test, so the page is checked against what the reader really sends; the
  sampler's `notices` lists every notice the page showed, which names the cause of a timeout.
  One test covers the VS Code transport end to end: it serves the panel's own html with a
  stand-in for `acquireVsCodeApi` and passes the page's messages through the panel handler
  of `extension.js` (booted by the host shim), with the real service and reader behind it.
  The page matches a reply to its request by `requestId` there, so a reply without it hangs.

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
  and `openPast` go through `unarchiveSession()`: it awaits a pending end of the id, runs
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
- **Ended and archived sessions**: each board writes its window's first workspace folder into
  its heartbeat (`root`). Claude Code (2.1.322, 2.1.323) builds its Local list from the root's
  folder only (`sessionListOptions()` passes `includeWorktrees: false`; `candidateProjectDirs`
  with the worktrees only serves single-session lookups), plus the folder of the root's real
  path, and hides programmatic sessions: an `entrypoint` of `sdk-cli`, `sdk-ts` or `sdk-py`
  (head, else tail) or a `sessionKind` of `daemon` or `daemon-worker`, unless
  `claudeCode.claudeProcessWrapper` is set. `listedSessions()` (core.cjs) follows that: every
  fresh heartbeat becomes those folder keys (`projectFolderName()`: every character outside
  `[A-Za-z0-9]` becomes `-`; compared case-insensitively on Windows), and each transcript there
  is sorted once: running, programmatic or without a user message is skipped; archived in
  Claude Code, on the board or stowed goes to `archived` (only asked for with "all", so the
  other modes read no extra heads); the rest to `ended`. The snapshot carries them as `ended`
  and `archivedEnded`; badges, counts and notifications read `sessions` only. A folder two
  heartbeats share goes to the lower window id, and an id in two places shows once, from its
  newest file. The host passes the wrapper setting as `snapshot({ includeProgrammatic })`; the
  browser server has no VS Code settings and always leaves them out. Until Claude Code's archive
  has been read once (`readClaudeArchived().known`), the snapshot lists no ended rows, since
  every archived session would look ended. The header switch "running | open | all" lives in
  `show.json` as `{ show, v: 2 }` (`setShowMode()`); a file without `v` is from 0.11.2, whose
  "all" reads as "open" (a 0.11.2 window that writes "all" therefore shows "open" in 0.11.3
  windows until it reloads). ⤓ on an ended row is `archivePast()`: the archive marker, then
  `stowTranscript()`. Typing in the search box filters the sections and, after 400 ms without a
  key, runs the title search (`startSearch(false)`); Enter adds content.
- **Ids copy on click**: the agent name and "Session <8>" on a row, and every value in the
  details line (ⓘ), are `copyval` buttons; the page sends `copyText` to the host or uses
  `navigator.clipboard` on the browser page. The resume command is copied only where a click
  cannot open the session (no mapped window, the browser page, a folder that is not open).
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

- **Steps**: ≡ sends `steps`; the host opens one webview panel per session as a tab in the
  editor group in use (`ViewColumn.Active`, so the editor area is not split;
  `retainContextWhenHidden`, not restored after a reload) on `steps.html` and passes every
  page message to `createStepsService().handle()`, whose pushes go back through
  `subscribe()`. `server.cjs` mounts the same service behind `POST /api/steps` (JSON body,
  64 KB, the one route that parses a body) and `GET /api/steps/poll?session=&after=<seq>`.
  A browser tab cannot say that it closed, so `server.cjs` knows a viewer by its requests
  and releases it after ten 30 s ticks without one (ticks, not the clock, so a machine that
  slept does not wake to released tabs). Only an `open` starts a viewer; the next poll of a
  released tab, or its next request that reads the transcript, answers `expired`, and the
  page opens the session again, keeping the reader's place.
  - Reader (`steps.cjs`, no `vscode`): `createStepIndex(file)` reads the transcript from its
    end, the last 2 MB first and then 1 MB chunks with a `setImmediate` between them, always
    whole lines. Per tree line (`user`, `assistant`, `system`, `attachment` with a `uuid`) it
    keeps a small node (parent ids, offset, length) and the step records that line gives,
    worked out once while the parsed line is in hand; texts and tool results stay on disk
    and are read by offset when the page asks (`body()`), a tool result through the offset
    of the line that carries it. The tip is the newest non-sidechain node in file order;
    the path runs back through `parentUuid` and, across a compaction, `logicalParentUuid`.
    `poll()` reads what the file gained; a changed file identity or a smaller size starts a
    new generation and a body asked for with an old one answers `stale`. A poll also names
    the steps already on the path whose result came in with it (`updated`): the answer to
    a question, a plan's approval, a tool's output, a subagent's report. `fullText()` is a
    step's whole text, past the 200 KB at which `body()` cuts.
  - Step kinds: `you` (also a message typed mid-turn, stored as a `queued_command`
    attachment with a human origin), `text`, `update` (a `thinking` block that has text: the
    reworded short line the chat showed between tool calls), `reasoning` (an empty
    `thinking` block), `tool`, `subagent`, `question`, `plan`, `compaction`, `error`,
    `interrupted`, `other` (a kind the reader does not know).
  - `buildSections()` cuts the steps where the owner said something: section kinds `lead`,
    `you`, `question` (an answered one), `approve`. Rows are `text`, `update`, `question`,
    `plan`, `error`, `compaction`, `interrupted` and `work` (a run of `tool`, `reasoning`,
    `subagent` and `other` steps, named by id). A section carries its active time, tool calls
    and files changed; the strip carries the totals. Active time is the sum of the gaps
    between consecutive steps, each counted up to 10 minutes.
  - Service: `open` answers after the tail pass with `indexing: true`; the rest arrives as
    `stepsProgress` pushes, at most one per 500 ms, the last with `done: true`. While a viewer
    is open a timer polls the file once a second and pushes `stepsChanged`, also for a
    result that adds no step. Every push carries the generation of its steps and the ids of
    the updated ones; the page drops the bodies it holds for those, and all of them on a
    new generation, and reads them again. A section list
    names steps by id only, so every push carries the compact records (kind, time, preview,
    title) of the steps it adds; the page draws rows and Work lines from those and asks for
    texts in batches (`bodies`) for the sections in view. The index lives while a viewer
    is subscribed.
  - Search: `rg --byte-offset --only-matching --fixed-strings --ignore-case` with the query
    and its JSON-escaped form (never `--json`: one stored line can run to megabytes); the
    offset of a hit names every step whose text comes from that line (`sourceRanges()`: the
    step's own line, the line of its result, the line a subagent's report came in), found
    by bisection over the sorted offsets; candidates are confirmed against the text the
    page shows, 500 at most. Without ripgrep the same scan runs in Node over the bytes of
    the file, one line at a time, so memory stays at one line and offsets stay byte
    offsets. Notes are searched too.
  - Page (`steps.html`): text is inserted as text nodes; the Markdown renderer builds DOM
    nodes and there is no `innerHTML` assignment. Both hosts serve it with a CSP whose
    script source is a per-response nonce. Only the sections around the anchor hold their
    rows: about 400 rows (`ROW_BUDGET`), never fewer than three sections and never more
    than 60 on each side; two spacers of estimated height stand for the rest. Rows and
    heights are counted as the view in use draws them (`drawnBody`: under Decisions a
    section is its opening message, its questions and its plans). Scrolling
    toward a spacer draws the window anew around the section at the top of the viewport
    and holds that row where it was; a jump into a spacer draws the window around the
    section that place names. The mark on the current hit or note is state
    (`curHitStep`), drawn after every redraw. Which texts to fetch is decided by bounding boxes against
    the reader's, never by `offsetTop` (that is relative to the row). A text cut at 200 KB
    is opened in full by naming its step: `openText` with a `stepId`, which the host reads
    through `fullText`. An open note box keeps its draft in the page state, because every
    push redraws the reader.
  - Export: both formats are built in the page, from the sections of the view in use
    (`visibleSections`, `drawnBody`), so an export holds what the view shows, in the same
    words, the notes off the current path of the Notes view included. The view (lens, Tool
    calls, opened Work lines) is taken once when the export starts (`exportView`) and put
    in place of the state only while the export picks its sections and builds
    (`withExportState`), so a switch of the tab while the texts are read changes nothing.
    A transcript that is still being indexed is not exported. The page reads the bodies it
    needs in batches with `bodies` and `forExport` (every text whole, a tool call without
    its result; `exportBody` in `steps.cjs`) into a map of its own, which stands in for
    `state.bodies` while it builds, so the reader keeps the cut texts it shows. The
    Markdown is written by `buildExportMarkdown`; headings inside a text are made smaller,
    except inside a code fence, which only its own marker closes. The PDF starts as a page:
    `buildExportPage` runs every section through the row builders the reader uses and
    serialises the result with the page's own style sheet (`html.export` rules: light
    colours, nothing folded, nothing scrolls), without buttons and without script. On
    paper each kind of row has a colour of its own (a filled chip, a tint, an edge; the
    `--claude`, `--work` and `*-tint` values exist only under `html.export`), and
    `print-color-adjust: exact` keeps them when a print dialog would drop backgrounds. In VS
    Code the page sends `exportSave` with the content; the host asks where to save
    (`showSaveDialog`), writes Markdown as it is, and prints a PDF through `pdf.cjs`:
    the page is sealed with a content policy that lets nothing run or load, written to a
    temp folder and printed by a headless Chrome, Edge or Chromium on a profile of its
    own (`findBrowser`, `SESSION_BOARD_BROWSER` to name one); the PDF is copied to its
    place only when it starts and ends as one. The host looks for the browser before it
    asks where to save: without one the dialog asks for an `.html` file and says why, the
    sealed page is saved there and opened in the default browser. The only file an export
    writes is the one the dialog named. A browser needs no
    host for this: it downloads the Markdown and prints the page from a window of its own
    (the 64 KB limit of `POST /api/steps` would not take the content anyway).
  - Links: the page sends `openLink` with a kind. `http` and `https` go to `openExternal`.
    A path is transcript text, not something the user typed: it is resolved against the
    session's folder, must then be a drive-letter path on Windows (one leading slash
    elsewhere), is refused and copied when it is a network or device path, asks first when
    it lies outside the session's folder, the workspace folders and the home folder, and
    is then revealed (folder), previewed (Markdown) or opened in the editor. Nothing is run.
  - Notes (`notes.cjs`): `notes\<sessionId>\<noteId>.json` = `{ id, stepId, at, text }`, tmp
    then rename, 16 KB at most; a send is recorded as `<noteId>.sent.<at>-<random>.json`, so
    two windows never rewrite one list. An edit is last writer wins and writes only while
    the note file exists. A delete writes `<noteId>.deleted` before it removes the files,
    and an edit or a send record that finds that mark after its own write removes what it
    wrote, so a delete in between never brings a note back. Notes go when the transcript is
    gone from both roots: `snapshot()` prunes them, after `transcriptGone()` has looked at
    the disk itself, because the filename index is up to a minute old and a root that
    cannot be read proves nothing. The last step in view is kept in `steps-seen\<id>.json`.
  - Send to session: the text is `About your step at <HH:MM> ("<first 120 chars>"): <note>`
    and always goes to the clipboard. In the owning window `revealHere(sessionId, prompt)`
    passes it as the second argument of `claude-vscode.editor.open`, which fills the chat
    input from Claude Code 2.1.322 on (`STEER_MIN_CLAUDE_VERSION`); the call without a prompt
    keeps its six arguments. For another window the sender writes a one-shot claim
    `steers\<claimId>.json` and opens `vscode://<board>/steer?session=&windowId=&note=<claimId>`;
    the owning board (0.12.0 or newer, by its heartbeat) takes the claim when it is younger
    than 30 s and deletes it, so the text never rides in a URL and a replayed URI does
    nothing. It then writes `steers\<claimId>.ack` with whether the text reached its chat
    box; the sender waits up to 8 s (`waitSteerAck()`) and marks the note as sent only on a
    yes. `revealHere()` answers `'without-prompt'` when only `primaryEditor.open` worked,
    which takes no text, and that is not a sent note either. An ended session has no
    process and is placed by the window its row names. Everything else (older Claude Code,
    a terminal session, an old board, the browser page) is clipboard plus the existing
    open.

## Where a change goes

- To show something new on a row, enrich the row in `snapshot()` (core.cjs), render it in
  `render()` (index.html), and assert it in the page suite with a scripted snapshot. Rows are
  plain objects that cross `postMessage` and HTTP unchanged, so keep them JSON.
- A new action on a row needs a message `type` in `onMessage()` (extension.js), a route in
  `server.cjs`, and the page's `send()`/`api()` pair. The host answers with a `<name>Result`
  message that carries the session id or request id the page used, so a late or foreign reply
  never changes the page's state; the ↻ lifecycle comment in index.html shows the pattern.
- Something new in the Steps tab: a new step kind starts in `stepSpecsOf()` (steps.cjs), is
  placed by `buildSections()` and drawn in `steps.html`; a new action is a message type in
  `steps-service.cjs`, which both hosts already route. Check it once in the page suite with
  `fake.service` set to the real service: scripted replies alone let the page and the reader
  drift apart.
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
