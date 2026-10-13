# Contributing to Session Board

This page is for you if you want to change or extend the board from a fork of this
repository: what you need, how the pieces fit, where a change goes, how to test it and what a
pull request should bring. The user-facing pages are [README.md](README.md) (repository) and
[extension/README.md](extension/README.md) (the Marketplace listing).

## What you need

- Windows for the full feature set. The window mapping and ending a session use
  `Win32_Process` and `taskkill`; on macOS and Linux the list, the search and the usage strip
  work, and a click copies the resume command instead of jumping.
- Node 22 or newer (the page tests use the global `WebSocket`).
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
    extension.js              VS Code host: polling, badge, toasts, open/end/search, URI handler
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
`POST /api/end/<id>[?force=1][&archive=1]`, `POST /api/unarchive/<id>`,
`GET /api/search?q=&content=0|1`, `POST /api/usage/refresh`, `POST /api/seen/<id>`,
`POST /api/retitle/<id>`.

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
fixture folders. Nothing in the suites touches your real sessions or needs Claude Code installed.

- `usage.test.cjs`: the usage and account path of `core.cjs` against `tests/shim/claude-shim.js`,
  which stands in for the CLI. `SB_SHIM_MODE` picks the usage reply (`ok`, `hang`, `garbage`,
  `exit2`, `error`), `SB_SHIM_AUTH` the `auth status` reply (`ok`, `notice`, `loggedout`,
  `fail`, `hang`), `SB_SHIM_TITLE` the title call's reply (`ok`, `fail`, `empty`, `hang`);
  `SB_SHIM_BODY` substitutes a whole usage body.
- `refresh-usage.test.cjs` and `archive-host.test.cjs`: `extension.js` booted by
  `tests/shim/host.cjs` against `tests/shim/vscode.js`, which records registered commands,
  status-bar messages, warnings and log lines so a test can assert on them.
- `archive.test.cjs`: the archive marker store and the end path of `core.cjs`, with registry
  records and processes faked through the shim's `stop` branch.
- `page.test.cjs`: `index.html` in headless Chrome over the DevTools protocol against an
  in-test HTTP server that plays scripted `/api` answers. Skipped when no Chromium is found.
- `manifest.test.cjs`: pins `publisher`, `name` and `displayName`; see "Conventions".
- `release-notes.test.cjs`: the changelog has a section for the manifest version and the
  release-notes script prints it.
- `unseen.test.cjs`: the unseen and seen markers, `noteAnswer()` and the `unseen` flag on
  snapshot rows, and how a board title ranks against the generated and the renamed title.
- `retitle.test.cjs`: the transcript excerpt (also with a prompt buried behind megabytes of
  tool output), the cleaning of the model's reply and `retitleSession()` against the shim.
- `unseen-host.test.cjs`: opening marks a session seen, the `seen` message, and the
  `retitle` message's replies.

A change comes with a test in the matching suite. New CLI behaviour gets a shim mode, not a
real `claude` call; new page behaviour gets a scripted snapshot in the page suite.

## How it works

- `core.cjs` runs `claude agents --json` (the built-in agent view renders only background
  sessions; the JSON lists every one) with `CLAUDE*` env vars stripped so it is not treated
  as a nested session, validates the row shape, and enriches rows.
- Live rows join their transcript `~/.claude/projects/<slug>/<sessionId>.jsonl` via a
  filename index (deriving the path from the cwd matches only two thirds of sessions).
  Context tokens come from the tail of the transcript, the same formula the context-guard
  hook uses; the heading is the `custom-title` line (`/rename`), else the registry's
  user-set name, else the `ai-title` line; the last prompt comes from `last-prompt` lines.
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
  filtered to ids VS Code lists as installed), else Claude Code's own handler, which always
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
  back as `ok` with `archived: false` and `archiveError`. `snapshot()` and `searchSessions()`
  read the markers into `archived` on every row; the page hides archived rows unless they are
  waiting, and ⤒ or a click on the row (or a pick in the command palette) unlinks the marker.
  The flag is the board's own; Claude Code's archive is its private extension state.
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
  Markers older than two weeks are dropped on read. The page keeps those rows in their own
  group, never folds them, and flips the flag at once on a click.
- **Titles**: ✎ sends `retitle`; `retitleSession()` collects the last six prompts and the
  newest answer with `transcriptExcerpt()`, which reads the transcript from its end in 1 MB
  steps until it has them (a long tool run can push the last prompt megabytes back; after
  16 MB without a prompt it gives up) and skips injected `isMeta` lines, text starting with
  `<`, tool results and thinking. It then runs
  `claude -p --model haiku --output-format text --no-session-persistence --tools "" --settings
  <file> --disable-slash-commands --strict-mcp-config --mcp-config <file>` with the
  instruction and the excerpt on stdin, keeps the last non-empty stdout line (settings
  warnings come first) unquoted and without a trailing period, and stores it in
  `titles\<id>.json` with the renamed title seen at that moment. `snapshot()` shows the board
  title while that renamed title is unchanged, so a later `/rename` wins again. Outcomes:
  `invalid`, `no-transcript`, `timeout` (90 s, process tree killed), `failed`, `empty`.

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
