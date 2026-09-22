[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../suraksha-app'))
$source = Join-Path $PSScriptRoot 'src'
if (-not (Test-Path "$target/package.json")) { throw 'Expected sibling suraksha-app backend.' }
$files = @(
  'app/api/guard/today/route.ts',
  'lib/guardRoster.ts', 'lib/guardDevice.ts', 'lib/guardDocuments.ts',
  'lib/models/GuardAttendance.ts', 'lib/models/GuardWakeSchedule.ts',
  'lib/models/GuardReplacement.ts', 'lib/models/GuardSiteConfig.ts', 'lib/models/GuardMedia.ts'
)
# Check every local import before installing; retain the backend's existing portal models.
foreach ($relative in $files) {
  $content = [IO.File]::ReadAllText((Join-Path $source $relative))
  foreach ($match in [regex]::Matches($content, "from ['"" ]@/([^'""]+)['""]")) {
    $dependency = $match.Groups[1].Value + '.ts'
    if ($dependency -notin $files -and -not (Test-Path (Join-Path "$target/src" $dependency))) {
      throw "Missing dependency: $dependency (from $relative)"
    }
  }
}
Write-Output "Target: $target"
$files | ForEach-Object { Write-Output "Install: src/$_" }
if (-not $Apply) { return }
$backup = Join-Path $PSScriptRoot ('local-duty-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($relative in $files) {
  $destination = Join-Path "$target/src" $relative
  if (Test-Path $destination) {
    $saved = Join-Path $backup $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $saved) | Out-Null
    Copy-Item -LiteralPath $destination -Destination $saved
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
  Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $destination
}
Write-Output 'Duty bundle installed.'
