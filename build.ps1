# Package and install the Session Board extension.
#
# The extension folder is the single source for core.cjs and index.html; server.cjs (the
# browser front end) reads them from there too, so there is nothing to copy first.
#
#   pwsh -File build.ps1            # package + install
#   pwsh -File build.ps1 -NoInstall # package only

param(
    [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ext = Join-Path $here 'extension'
$manifest = Get-Content (Join-Path $ext 'package.json') -Raw | ConvertFrom-Json
$vsix = Join-Path $here "$($manifest.name)-$($manifest.version).vsix"
$vsce = '@vscode/vsce@4.0.0'

foreach ($f in 'core.cjs', 'extension.js') {
    node --check (Join-Path $ext $f)
    if ($LASTEXITCODE -ne 0) { throw "syntax error in $f" }
}
node --check (Join-Path $here 'server.cjs')
if ($LASTEXITCODE -ne 0) { throw 'syntax error in server.cjs' }

Push-Location $ext
try {
    node --test "tests/*.test.cjs"
    if ($LASTEXITCODE -ne 0) { throw 'tests failed' }
} finally {
    Pop-Location
}

# Only bypass vsce's checks for what is really missing; a published build should pass them.
$flags = @()
if (-not (Test-Path (Join-Path $ext 'LICENSE'))) { $flags += '--skip-license' }
if (-not $manifest.repository) { $flags += '--allow-missing-repository' }

Push-Location $ext
try {
    npx --yes $vsce package --no-dependencies @flags -o $vsix
    if ($LASTEXITCODE -ne 0) { throw 'vsce package failed' }
} finally {
    Pop-Location
}
Write-Host "packaged $vsix" -ForegroundColor Cyan

if (-not $NoInstall) {
    code --install-extension $vsix
    if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed with exit $LASTEXITCODE" }
    $installed = code --list-extensions --show-versions | Where-Object { $_ -like "$($manifest.publisher).$($manifest.name)@*" }
    if (-not $installed) { throw 'installed extension not listed by code --list-extensions' }
    Write-Host "installed $installed" -ForegroundColor Cyan
    Write-Host 'A first install of this id hot-loads into running windows; an update waits for each window to reload.' -ForegroundColor Cyan
    Write-Host 'Do not reload a window whose Claude sessions you still need: the reload restarts their parent process.' -ForegroundColor Yellow
}
