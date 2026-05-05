$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $root 'scripts\zalo-webhook-bridge.js'
$stdoutLog = Join-Path $root 'zalo-bridge.log'
$stderrLog = Join-Path $root 'zalo-bridge-error.log'
$nodePath = 'C:\Program Files\nodejs\node.exe'

function Get-DotenvAssignments {
  param([string]$Path)

  $assignments = @()
  if (-not (Test-Path $Path)) {
    return $assignments
  }

  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) {
      continue
    }

    $separatorIndex = $trimmed.IndexOf('=')
    if ($separatorIndex -lt 1) {
      continue
    }

    $name = $trimmed.Substring(0, $separatorIndex).Trim()
    $value = $trimmed.Substring($separatorIndex + 1).Trim()

    if (
      (($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))) -and
      $value.Length -ge 2
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    $escapedValue = $value.Replace("'", "''")
    $assignments += "`$env:$name = '$escapedValue'"
  }

  return $assignments
}

$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like "*scripts\\zalo-webhook-bridge.js*" } |
  Select-Object -First 1

if ($existing) {
  Write-Output "Zalo bridge is already running (PID $($existing.ProcessId))."
  exit 0
}

if (Test-Path $stdoutLog) { Remove-Item -LiteralPath $stdoutLog -Force }
if (Test-Path $stderrLog) { Remove-Item -LiteralPath $stderrLog -Force }

$dotenvAssignments = @()
$dotenvAssignments += Get-DotenvAssignments (Join-Path $root '.env')
$dotenvAssignments += Get-DotenvAssignments (Join-Path $root '.env.local')

$envScript = @(
  $dotenvAssignments
  "`$env:ZALO_BRIDGE_QUEUE_TABLE = if (`$env:ZALO_BRIDGE_QUEUE_TABLE) { `$env:ZALO_BRIDGE_QUEUE_TABLE } else { 'data_table_user_dad3ca9f-2474-4abc-bbf8-51e85f81eafa' }"
  "& '$nodePath' '$scriptPath'"
) -join '; '

$process = Start-Process `
  -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $envScript `
  -WorkingDirectory $root `
  -PassThru `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog

Write-Output "Started Zalo bridge (PID $($process.Id))."
