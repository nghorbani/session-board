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
    statusline/         Claude Code status line scripts (statusline.ps1 for Windows,
                        statusline.sh for macOS/Linux) that record the usage limits
  server.cjs            optional browser front end over the same core.cjs + index.html
  start.ps1             runs server.cjs and opens the browser (optional)
  build.ps1             packages the .vsix with vsce 4 and installs it
  tools/screenshot.cjs  renders the README screenshots from index.html with example sessions
  LICENSE               MIT, covers the root files too
```

## Build and install

```powershell
pwsh -File build.ps1            # package + install
pwsh -File build.ps1 -NoInstall # package only
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
- **Usage limits**: Claude Code passes `rate_limits` (five_hour, seven_day, spend_limit;
  `used_percentage` and `resets_at`) to the status line command on stdin after every reply,
  and to nothing else. Connect copies `extension/statusline/statusline.ps1` to
  `%LOCALAPPDATA%\SessionBoard\` (a version-independent path) and puts the matching
  `statusLine` entry on the clipboard; the user pastes it into `~/.claude/settings.json`.
  The script writes `usage.json` next to itself; `usageState()` in core.cjs reads it on every
  poll and the page renders the strip. The board never writes settings.json. On activation
  the copied script is refreshed when the packaged one changed.

## Optional browser page

```powershell
pwsh -File start.ps1
```

Serves the same page at <http://127.0.0.1:4317>. Every `/api/*` route requires the per-run
token embedded in the page (`X-Board-Token`) and a matching Host/Origin; JSON responses are
`no-store`. Routes: `GET /api/sessions`, `POST /api/focus/<id>`, `POST /api/end/<id>[?force=1]`,
`GET /api/search?q=&content=0|1`, `POST /api/usage/connect`.

## Publishing (as of 2026-09)

1. Create a publisher at <https://marketplace.visualstudio.com/manage> with the
   authentication the current publishing documentation prescribes (global Personal Access
   Tokens are announced to retire on 2026-12-01).
2. If the publisher id differs from `nima-ghorbani`, change `publisher` in
   `extension/package.json`; the extension id used for URIs and heartbeats follows it.
3. From `extension/`: `npx @vscode/vsce@4.0.0 login <publisher>` then
   `npx @vscode/vsce@4.0.0 publish`, or upload the `.vsix` on the manage page. The
   Marketplace runs automated security checks before and after listing.

Anthropic's rule for third parties: say in plain text that a product works with Claude
Code, but do not use the Claude Code or Anthropic names or logos as part of the product
name or logo. The name "Session Board" and the description follow that.
