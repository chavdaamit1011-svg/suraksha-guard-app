[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../suraksha-app'))
$source = Join-Path $PSScriptRoot 'src'
$files = @('lib/guardAccess.ts', 'app/api/guard/access/route.ts', 'app/api/guard/auth/check/route.ts',
  'app/api/guard/auth/send-otp/route.ts', 'app/api/guard/auth/verify-otp/route.ts',
  'app/api/guard/auth/refresh/route.ts', 'app/api/guard/auth/register/route.ts')
$existing = [IO.File]::ReadAllText("$target/src/proxy.ts")
$reference = [IO.File]::ReadAllText("$source/proxy.ts")
$marker = 'export async function proxy'
# Replace only the guard helper/imports, preserving the backend's portal routing.
$proxy = $reference.Substring(0, $reference.IndexOf($marker)) + $existing.Substring($existing.IndexOf($marker))
$files | ForEach-Object { Write-Output "Install: src/$_" }
Write-Output 'Update only the guard access gate in src/proxy.ts'
if (-not $Apply) { return }
$backup = Join-Path $PSScriptRoot ('local-access-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
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
[IO.File]::WriteAllText("$target/src/proxy.ts", $proxy)
Write-Output 'Access fix installed.'
