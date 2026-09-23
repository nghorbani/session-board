# Launch the Claude Code session dashboard and open it in the default browser.
#
# The dashboard shells out to `claude agents --json`, which must not inherit a parent
# session's environment, so this deliberately clears the CLAUDE* vars before starting.

param(
    [int]$Port = 4317,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Get-ChildItem Env: |
    Where-Object { $_.Name -eq 'CLAUDECODE' -or $_.Name -like 'CLAUDE_*' } |
    ForEach-Object { Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue }

$env:SESSION_DASHBOARD_PORT = $Port
$url = "http://127.0.0.1:$Port"

if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
        param($u)
        Start-Sleep -Seconds 2
        Start-Process $u
    } -ArgumentList $url | Out-Null
}

Write-Host "Session dashboard starting at $url (Ctrl+C to stop)" -ForegroundColor Cyan
node (Join-Path $here 'server.cjs')
