[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../suraksha-app'))
if (-not (Test-Path "$target/src/proxy.ts")) { throw 'Expected sibling suraksha-app backend.' }
$source = Join-Path $PSScriptRoot 'src'
$files = @(
  'lib/guardCors.ts', 'lib/guardPhone.ts', 'lib/guardSession.ts', 'lib/guardOtp.ts', 'lib/guardSms.ts',
  'lib/models/GuardAppProfile.ts',
  'app/api/guard/auth/send-otp/route.ts', 'app/api/guard/auth/verify-otp/route.ts',
  'app/api/guard/auth/refresh/route.ts', 'app/api/guard/auth/logout/route.ts',
  'app/api/guard/auth/register/route.ts',
  'app/api/guard/version/route.ts', 'app/api/guard/i18n/route.ts'
)
$existingProxy = [IO.File]::ReadAllText("$target/src/proxy.ts")
$referenceProxy = [IO.File]::ReadAllText("$source/proxy.ts")
if ($existingProxy.Contains('guardApiGate')) { throw 'Backend already has guard gate; review before applying again.' }
$prefixEnd = $referenceProxy.IndexOf('export async function proxy')
$prefix = $referenceProxy.Substring(0, $prefixEnd)
$branchStart = $referenceProxy.IndexOf("  if (pathname.startsWith('/api/guard/'))")
$branchEnd = $referenceProxy.IndexOf('  // API calls', $branchStart)
$branch = $referenceProxy.Substring($branchStart, $branchEnd - $branchStart)
$oldStart = $existingProxy.IndexOf('export async function proxy')
$updatedProxy = $prefix + $existingProxy.Substring($oldStart)
$marker = '  // API calls and static assets'
if (-not $updatedProxy.Contains($marker)) { throw 'Proxy insertion marker not found.' }
$updatedProxy = $updatedProxy.Replace($marker, $branch + $marker)
Write-Output "Target: $target"
$files | ForEach-Object { Write-Output "Install: src/$_" }
Write-Output 'Patch: src/proxy.ts (preserve portal routing; add guard CORS/session gate)'
if (-not $Apply) { return }
$backup = Join-Path $PSScriptRoot ('local-login-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($relative in ($files + 'proxy.ts')) {
  $destination = Join-Path "$target/src" $relative
  if (Test-Path $destination) {
    $saved = Join-Path $backup $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $saved) | Out-Null
    Copy-Item -LiteralPath $destination -Destination $saved
  }
}
foreach ($relative in $files) {
  $destination = Join-Path "$target/src" $relative
  New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
  Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $destination
}
[IO.File]::WriteAllText("$target/src/proxy.ts", $updatedProxy)
Write-Output "Applied. Backups: $backup"
