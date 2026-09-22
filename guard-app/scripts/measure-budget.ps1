<#
.SYNOPSIS
  Battery and data release gate for the Guard App (SUR-GAP-032, PRD 18.15.7).

.DESCRIPTION
  Budgets (both are release gates):
    * battery  <= 6 % per 12-hour shift on the reference 4000 mAh device
    * data     <= 40 MB per month of non-media traffic (26 shifts)

  The measurement is a real shift, so it runs in two halves and the phone does not have to stay
  attached to the PC in between:

    -Start   resets Android's battery statistics and writes a start record
    -Stop    reads the statistics, scales them to a 12-hour shift and a 26-shift month,
             prints PASS/FAIL and exits 1 when a budget is exceeded

  Rules for a valid run (see docs/BATTERY-DATA-BUDGET.md):
    * phone UNPLUGGED the whole time (Android does not count usage while charging;
      use wireless debugging, not a cable)
    * the guard is checked in, so the on-duty location service is running
    * at least 2 hours; the full 12 hours before a release
    * no other heavy app used on the phone during the run

  Only reads statistics. It never sends taps or key presses to the phone.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\measure-budget.ps1 -Start
  # ... work the shift ...
  powershell -ExecutionPolicy Bypass -File scripts\measure-budget.ps1 -Stop
#>
param(
  [switch]$Start,
  [switch]$Stop,
  [string]$Device = '',
  [string]$Package = 'in.surakshaguards.guard',
  [int]$CapacityMah = 4000,
  # Media bytes the app itself reports on App health for the run; subtracted from the data total.
  # Leave at 0 for a conservative result (media counted as ordinary data).
  [double]$MediaMB = 0,
  [string]$Adb = 'adb',
  [string]$StateFile = "$PSScriptRoot\..\.budget-run.json"
)

$ErrorActionPreference = 'Stop'
$BatteryBudgetPct = 6
$DataBudgetMB = 40
$ShiftsPerMonth = 26

function A {
  if ($Device) { & $Adb -s $Device @args } else { & $Adb @args }
}

function Level {
  $out = A shell dumpsys battery
  $level = [int](($out | Select-String 'level:\s*(\d+)').Matches[0].Groups[1].Value)
  $scale = [int](($out | Select-String 'scale:\s*(\d+)').Matches[0].Groups[1].Value)
  $plugged = ($out | Select-String '(AC|USB|Wireless) powered:\s*true').Count -gt 0
  [pscustomobject]@{ Pct = 100.0 * $level / $scale; Plugged = $plugged }
}

function AppUid {
  $line = (A shell dumpsys package $Package | Select-String 'userId=(\d+)' | Select-Object -First 1)
  if (-not $line) { throw "$Package is not installed on the device." }
  [int]$line.Matches[0].Groups[1].Value
}

if (-not ($Start -xor $Stop)) { throw 'Pass exactly one of -Start or -Stop.' }

if ($Start) {
  $uid = AppUid
  $b = Level
  if ($b.Plugged) { throw 'The phone is charging. Unplug it and use wireless debugging - Android does not count usage while charging.' }
  A shell dumpsys batterystats --reset | Out-Null
  @{ startedAt = (Get-Date).ToString('o'); level = $b.Pct; uid = $uid } | ConvertTo-Json | Set-Content $StateFile -Encoding utf8
  Write-Output ("Started at {0:HH:mm}, battery {1:N0} %. Check in on the phone and work normally; run -Stop at the end." -f (Get-Date), $b.Pct)
  exit 0
}

if (-not (Test-Path $StateFile)) { throw "No start record at $StateFile - run -Start first." }
$run = Get-Content $StateFile -Raw | ConvertFrom-Json
$hours = ((Get-Date) - [datetime]$run.startedAt).TotalHours
if ($hours -lt 0.5) { throw ("Only {0:N1} h measured; run for at least 2 h." -f $hours) }
$b = Level
$uid = [int]$run.uid

# --- data: the checkin dump carries exact per-uid byte counters ("nt" rows)
#     9,<uid>,l,nt,mobileRx,mobileTx,wifiRx,wifiTx,...
$rx = 0.0; $tx = 0.0
foreach ($row in (A shell dumpsys batterystats --checkin)) {
  $f = $row -split ','
  if ($f.Count -gt 7 -and $f[0] -eq '9' -and $f[1] -eq "$uid" -and $f[3] -eq 'nt') {
    $rx += [double]$f[4] + [double]$f[6]
    $tx += [double]$f[5] + [double]$f[7]
  }
}
$dataMB = [math]::Max(0, ($rx + $tx) / 1MB - $MediaMB)
$monthMB = $dataMB / $hours * 12 * $ShiftsPerMonth

# --- battery: whole-device drop is the gate; the app's own estimate is shown for context
$dropPct = [double]$run.level - $b.Pct
$shiftPct = $dropPct / $hours * 12
$appMah = $null
$label = 'u0a' + ($uid - 10000)
$m = (A shell dumpsys batterystats $Package | Select-String -Pattern "(?i)uid\s+$label\s*:\s*([\d.]+)" | Select-Object -First 1)
if ($m) { $appMah = [double]$m.Matches[0].Groups[1].Value }

$batteryOk = $shiftPct -le $BatteryBudgetPct
$dataOk = $monthMB -le $DataBudgetMB

Write-Output ''
Write-Output ("Measured {0:N1} h  (battery {1:N0} % -> {2:N0} %{3})" -f $hours, $run.level, $b.Pct, $(if ($b.Plugged) { ', NOW CHARGING - result unreliable' } else { '' }))
Write-Output ("Battery : {0:N1} % per 12 h shift   budget {1} %   {2}" -f $shiftPct, $BatteryBudgetPct, $(if ($batteryOk) { 'PASS' } else { 'FAIL' }))
if ($null -ne $appMah) {
  Write-Output ("          app's own share: {0:N1} mAh = {1:N2} % of {2} mAh over the run" -f $appMah, (100 * $appMah / $CapacityMah), $CapacityMah)
}
Write-Output ("Data    : {0:N2} MB in run -> {1:N1} MB per {2}-shift month   budget {3} MB   {4}" -f $dataMB, $monthMB, $ShiftsPerMonth, $DataBudgetMB, $(if ($dataOk) { 'PASS' } else { 'FAIL' }))
if ($MediaMB -eq 0) { Write-Output '          (media not subtracted - pass -MediaMB to exclude photo/voice uploads)' }
if ($hours -lt 2) { Write-Output 'WARNING: under 2 h - the extrapolation is rough. Use a full shift before a release.' }

$report = [ordered]@{
  measuredAt = (Get-Date).ToString('o'); hours = [math]::Round($hours, 2)
  batteryPer12h = [math]::Round($shiftPct, 2); appMah = $appMah
  dataMB = [math]::Round($dataMB, 3); dataPerMonthMB = [math]::Round($monthMB, 2)
  pass = ($batteryOk -and $dataOk)
}
$report | ConvertTo-Json | Set-Content ($StateFile -replace '\.json$', '-result.json') -Encoding utf8
if (-not ($batteryOk -and $dataOk)) { exit 1 }
