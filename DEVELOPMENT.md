# Development

Layout, build, how the pieces work, and publishing. The user-facing pages are
[README.md](README.md) (repository) and [extension/README.md](extension/README.md)
(Marketplace).

## Layout

```
session-dashboard/
  extension/            the VS Code extension (single source for everything below)
    package.json        manifest: activity-bar container "Session Board", webview view, commands
    extension.js        VS Code host: polling, badge, toasts, open/end/search, URI handler
    core.cjs            data layer: sessions, transcript facts, window mapping, jump, end, search
    index.html          the page; runs in the webview or in a browser
    README.md           Marketplace page
    CHANGELOG.md        release notes, one plain line per change
    LICENSE
    media/icon.svg      activity-bar icon (mask)
    media/icon.png      gallery icon, 128x128
    media/board.png     README screenshots, rendered by tools/screenshot.cjs
    media/search.png
    tests/              node --test suite: usage path (tests/shim/ stands in for the CLI) and manifest identity
    .vscodeignore       keeps tests/ out of the package
  server.cjs            optional browser front end over the same core.cjs + index.html
  start.ps1             runs server.cjs and opens the browser (optional)
  build.ps1             packages the .vsix with vsce 4 and installs it
  tools/screenshot.cjs  renders the README screenshots from index.html with example sessions
  LICENSE               MIT, covers the root files too
```

## Build and install

```powershell
pwsh -File build.ps1            # tests + package + install
pwsh -File build.ps1 -NoInstall # tests + package only
cd extension; npm test          # node --test "tests/*.test.cjs" (the build runs this too)
node tools/screenshot.cjs       # refresh extension/media/board.png and search.png
```

Verified on VS Code 1.138: a **first install of a new extension id** hot-loads into every
running window within seconds; an **update to an extension already activated** in a window
waits for that window to reload, and VS Code refuses to replace a running extension. Reload
restarts the window's extension host, which is the parent process of every `claude.exe` in
it, so do not reload a window whose sessions you still need. A new window runs the newest
installed version and shows every session anyway.

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
  `denied`, `partial`, `timeout`, `pending`, `unsupported`.
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
  tolerant and reports a shape change explicitly. The result is
  cached in `usage-cli.json` (a failed probe keeps the last good windows and carries the
  error); `refreshUsageIfStale()` runs from the extension's poll (5 min visible, 15 hidden)
  and from the browser server's sessions route; probes are throttled to one per 15 s and a
  timeout kills the process tree. The status line route of 0.3.1 never ran for sessions
  started by the VS Code extension (no terminal UI there) and was removed.

## Optional browser page

```powershell
pwsh -File start.ps1
```

Serves the same page at <http://127.0.0.1:4317>. Every `/api/*` route requires the per-run
token embedded in the page (`X-Board-Token`) and a matching Host/Origin; JSON responses are
`no-store`. Routes: `GET /api/sessions`, `POST /api/focus/<id>`, `POST /api/end/<id>[?force=1]`,
`GET /api/search?q=&content=0|1`, `POST /api/usage/refresh`.

## Publishing (as of 2026-09)

1. Create a publisher at <https://marketplace.visualstudio.com/manage> with the
   authentication the current publishing documentation prescribes (global Personal Access
   Tokens are announced to retire on 2026-12-01).
2. The Marketplace listing `nima-ghorbani.session-board-vscode` owns the name; publish every
   update to that listing under that publisher. Never change `publisher` or `name` of a
   published extension: names are unique across all publishers and a removed name is reserved
   forever, so Unpublish a listing, never Remove it. Display names are reserved the same way.
   The original name `session-board` and display name "Session Board" were removed on
   2026-09-24 and cannot come back (release requests go to VSMarketplace@microsoft.com).
   `tests/manifest.test.cjs` fails the build on a rename.
3. From `extension/`: `npx @vscode/vsce@4.0.0 login <publisher>` then
   `npx @vscode/vsce@4.0.0 publish`, or upload the `.vsix` on the manage page. The
   Marketplace runs automated security checks before and after listing.

Anthropic's rule for third parties: say in plain text that a product works with Claude
Code, but do not use the Claude Code or Anthropic names or logos as part of the product
name or logo. The name "Session Board" and the description follow that.
