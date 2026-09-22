<#
.SYNOPSIS
  Bring up everything the Guard App needs to run on a phone against the staging backend.

.DESCRIPTION
  The app on the phone needs three things alive at once. If any one of them is down the app
  hangs on a loading screen or shows "Something went wrong", because it cannot fetch its
  JavaScript bundle:

    1. the staging Next.js server on the VPS (port 4546, isolated `suraksha_guardtest` database)
    2. an SSH tunnel bringing that port to this machine's localhost
    3. the Metro bundler on port 8081

  and then `adb reverse` so the phone's own localhost reaches this machine — which is what
  sidesteps the Windows firewall blocking inbound LAN connections on a "Public" network.

  Everything here is idempotent: run it as often as you like, it only starts what is down.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-test-rig.ps1

.EXAMPLE
  # Skip the phone and just bring the servers up
  powershell -ExecutionPolicy Bypass -File scripts\start-test-rig.ps1 -NoDevice
#>
[CmdletBinding()]
param(
  # Defaults to the guard-app folder this script lives under. Resolved in the body, because
  # $PSScriptRoot is not yet populated while parameter defaults are being evaluated.
  [string]$ProjectRoot = '',
  [string]$VpsHost = 'ke@69.62.82.222',
  [int]$VpsPort = 2222,
  [string]$SshKey = '',
  [int]$ApiPort = 4546,
  [int]$MetroPort = 8081,
  [string]$Adb = '',
  [string]$NodeExe = '',
  [switch]$NoDevice
)

$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "    $msg" -ForegroundColor Red }

function Test-Port([int]$Port) {
  [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path (Join-Path $ProjectRoot 'package.json'))) {
  throw "No package.json under $ProjectRoot. Pass -ProjectRoot <path to guard-app>."
}

# The repo root holds the SSH key by default; allow an override for a key kept elsewhere.
if (-not $SshKey) { $SshKey = Join-Path (Split-Path -Parent $ProjectRoot) 'id_ed25519_new' }
if (-not (Test-Path $SshKey)) { throw "SSH key not found at $SshKey. Pass -SshKey <path>." }

$sshArgs = @('-p', $VpsPort, '-i', $SshKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes')

# --------------------------------------------------------------- 1. staging API
Step "Staging API on the VPS (port $ApiPort)"
$remote = @"
sudo ss -ltn | grep -q $ApiPort && echo ALREADY_UP || {
  sudo -u suraksha bash -lc 'cd /tmp/guard-tc && setsid nohup node node_modules/next/dist/bin/next dev -p $ApiPort -H 127.0.0.1 > /tmp/guard-tc/dev.log 2>&1 < /dev/null &' > /dev/null 2>&1
  sleep 14
  sudo ss -ltn | grep -q $ApiPort && echo STARTED || echo FAILED
}
"@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($remote -replace "`r", '')))
$result = & ssh -n @sshArgs $VpsHost "echo $b64 | base64 -d | bash" 2>&1 | Select-Object -Last 1

switch -Wildcard ($result) {
  '*ALREADY_UP*' { Ok 'already running' }
  '*STARTED*'    { Ok 'started' }
  default {
    Fail "could not start: $result"
    Fail 'If /tmp/guard-tc is gone (the VPS rebooted), the staging copy must be recreated.'
    exit 1
  }
}

# ------------------------------------------------------------------- 2. tunnel
Step "SSH tunnel localhost:$ApiPort -> VPS:$ApiPort"
if (Test-Port $ApiPort) {
  Ok 'already open'
} else {
  $tunnelArgs = @('-N') + $sshArgs + @(
    '-o', 'ExitOnForwardFailure=yes',
    # Without a keepalive the tunnel dies silently on an idle NAT, which is the failure that
    # presents as "the app suddenly stopped loading".
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', "127.0.0.1:${ApiPort}:127.0.0.1:$ApiPort",
    $VpsHost
  )
  Start-Process -FilePath 'ssh' -ArgumentList $tunnelArgs -WindowStyle Hidden
  Start-Sleep -Seconds 6
  if (Test-Port $ApiPort) { Ok 'opened' } else { Fail 'tunnel did not open'; exit 1 }
}

try {
  $code = (Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/guard/version" -UseBasicParsing -TimeoutSec 15).StatusCode
  Ok "backend reachable (HTTP $code)"
} catch {
  Fail 'tunnel is open but the backend did not answer'
  exit 1
}

# -------------------------------------------------------------------- 3. Metro
Step "Metro bundler (port $MetroPort)"
if (Test-Port $MetroPort) {
  Ok 'already running'
} else {
  if (-not $NodeExe) {
    $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $NodeExe) {
      # Fall back to the portable Node in the scratchpad, if one was unpacked there.
      $portable = Get-ChildItem -Path $env:TEMP -Recurse -Depth 6 -Filter 'node.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'node-v\d+.*-win-x64' } | Select-Object -First 1
      if ($portable) { $NodeExe = $portable.FullName }
    }
  }
  if (-not $NodeExe) { throw 'node.exe not found. Install Node 20+ or pass -NodeExe <path>.' }

  # Point the app at the tunnelled backend. `localhost` on the phone is this machine, via
  # `adb reverse` below.
  $env:EXPO_PUBLIC_API_BASE_URL = "http://localhost:$ApiPort"
  $env:EXPO_PUBLIC_SOCKET_URL = "http://localhost:$ApiPort"
  $env:REACT_NATIVE_PACKAGER_HOSTNAME = 'localhost'

  $logDir = Join-Path $env:TEMP 'suraksha-rig'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $log = Join-Path $logDir 'metro.log'
  $err = Join-Path $logDir 'metro.err'

  Push-Location $ProjectRoot
  Start-Process -FilePath $NodeExe `
    -ArgumentList @('node_modules\expo\bin\cli', 'start', '--port', $MetroPort) `
    -RedirectStandardOutput $log -RedirectStandardError $err -WindowStyle Hidden
  Pop-Location

  $up = $false
  foreach ($i in 1..15) {
    Start-Sleep -Seconds 4
    if (Test-Port $MetroPort) { $up = $true; break }
  }
  if ($up) { Ok "started (log: $log)" } else { Fail "did not start. See $err"; exit 1 }
}

# -------------------------------------------------------------------- 4. phone
if ($NoDevice) {
  Step 'Skipping the phone (-NoDevice)'
  Write-Host ''
  Ok 'Servers are up.'
  exit 0
}

Step 'Phone'
if (-not $Adb) {
  $Adb = (Get-Command adb -ErrorAction SilentlyContinue).Source
  if (-not $Adb) {
    $found = Get-ChildItem -Path $env:TEMP -Recurse -Depth 6 -Filter 'adb.exe' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) { $Adb = $found.FullName }
  }
}
if (-not $Adb) {
  Warn 'adb not found — skipping the phone. Pass -Adb <path to adb.exe>.'
  exit 0
}

# Wireless debugging re-advertises on a NEW port every time it is toggled, so discover it
# rather than remembering the last one. Pairing itself survives; only the port moves.
$svc = & $Adb mdns services 2>&1 | Select-String '_adb-tls-connect'
if (-not $svc) {
  Warn 'No device advertising.'
  Warn 'On the phone: Developer options -> Wireless debugging -> ON, then run this again.'
  Warn 'Or connect by USB with USB debugging enabled.'
  exit 0
}

$hostPort = ($svc -split "`t")[-1].Trim()
& $Adb connect $hostPort | Out-Null
Start-Sleep -Seconds 2

$serial = (& $Adb devices | Select-String "^\S+\s+device$" | Select-Object -First 1) -split '\s+' | Select-Object -First 1
if (-not $serial) { Warn "could not connect to $hostPort"; exit 0 }
Ok "connected: $serial"

# This is what lets the phone reach this machine at all: it maps the phone's own localhost
# back over the debug bridge, bypassing the firewall entirely.
& $Adb -s $serial reverse "tcp:$MetroPort" "tcp:$MetroPort" | Out-Null
& $Adb -s $serial reverse "tcp:$ApiPort" "tcp:$ApiPort" | Out-Null
Ok "reverse ports mapped ($MetroPort, $ApiPort)"

& $Adb -s $serial shell "am force-stop host.exp.exponent; exit 0" | Out-Null
Start-Sleep -Seconds 2
& $Adb -s $serial shell "am start -a android.intent.action.VIEW -d 'exp://localhost:$MetroPort'; exit 0" | Out-Null
Ok 'app launched — first bundle takes about a minute'

Write-Host ''
Ok 'Rig is up.'
Write-Host '    If the app later hangs on loading, one of the three went down. Just run this again.'
