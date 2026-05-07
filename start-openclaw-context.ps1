$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stdoutLog = Join-Path $root 'openclaw-context.log'
$stderrLog = Join-Path $root 'openclaw-context-error.log'
$scriptPath = Join-Path $root 'scripts\openclaw-context-service.js'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$port = 20129

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

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($owner -and $owner.CommandLine -like '*openclaw-context-service.js*') {
    Write-Output "OpenClaw context service is already listening on http://127.0.0.1:$port (PID $($listener.OwningProcess))."
    exit 0
  }

  throw "Port $port is already in use by PID $($listener.OwningProcess)."
}

if (Test-Path $stdoutLog) { Remove-Item -LiteralPath $stdoutLog -Force }
if (Test-Path $stderrLog) { Remove-Item -LiteralPath $stderrLog -Force }

$dotenvAssignments = @()
$dotenvAssignments += Get-DotenvAssignments (Join-Path $root '.env')
$dotenvAssignments += Get-DotenvAssignments (Join-Path $root '.env.local')

$envScript = @(
  $dotenvAssignments
  "`$env:OPENCLAW_CONTEXT_PORT = '$port'"
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

Write-Output "Started OpenClaw context service on http://127.0.0.1:$port (PID $($process.Id))."
