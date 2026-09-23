# Session Board status line for Claude Code (Windows).
#
# Claude Code runs this after each reply with the session JSON on stdin. It prints one line
# for the session footer and records the latest usage limits (rate_limits) under
# %LOCALAPPDATA%\SessionBoard\usage.json, which the Session Board view reads. Nothing else is
# read or written and nothing leaves the machine. ASCII only: PowerShell 5.1 renders
# non-ASCII from an unmarked script file unreliably.

$ErrorActionPreference = 'SilentlyContinue'

try { $d = ($input | Out-String) | ConvertFrom-Json } catch { exit 0 }
if ($null -eq $d) { exit 0 }

$dir = Join-Path $env:LOCALAPPDATA 'SessionBoard'
$file = Join-Path $dir 'usage.json'
$rl = $d.rate_limits
$ctx = $d.context_window.used_percentage
$model = $d.model.display_name
$esc = [char]27

function Get-Pct($w) {
    if ($null -eq $w -or $null -eq $w.used_percentage) { return $null }
    return [int][math]::Round([double]$w.used_percentage)
}

function Format-Pct([int]$p) {
    if ($p -ge 90) { return "$esc[31m$p%$esc[0m" }
    if ($p -ge 70) { return "$esc[33m$p%$esc[0m" }
    return "$p%"
}

function Write-Record($limits) {
    try {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $rec = [ordered]@{
            at          = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            session_id  = $d.session_id
            model       = $model
            rate_limits = $limits
        }
        $tmp = "$file.tmp.$PID"
        [IO.File]::WriteAllText($tmp, ($rec | ConvertTo-Json -Depth 6 -Compress), (New-Object Text.UTF8Encoding($false)))
        Move-Item -Force $tmp $file
    } catch { }
}

$parts = @()
if ($null -ne $rl) {
    $five = Get-Pct $rl.five_hour
    $week = Get-Pct $rl.seven_day
    $spend = Get-Pct $rl.spend_limit
    if ($null -ne $five) { $parts += "5h $(Format-Pct $five)" }
    if ($null -ne $week) { $parts += "7d $(Format-Pct $week)" }
    if ($null -ne $spend) { $parts += "spend $(Format-Pct $spend)" }
    Write-Record $rl
} elseif (-not (Test-Path $file)) {
    # First run before any reply, or a plan without limits: leave a marker so the board can
    # tell "status line works, no limits reported" from "status line never ran".
    Write-Record $null
}

if ($null -ne $ctx) { $parts += "ctx $([int][math]::Round([double]$ctx))%" }
$line = $parts -join ' | '
if ($model) { $line = if ($line) { "[$model] $line" } else { "[$model]" } }
Write-Output $line
