$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$userFolder = Join-Path $root '.n8n'
$stdoutLog = Join-Path $root 'n8n.log'
$stderrLog = Join-Path $root 'n8n-error.log'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$n8nBin = Join-Path $root 'node_modules\n8n\bin\n8n'

New-Item -ItemType Directory -Force -Path $userFolder | Out-Null

$listener = Get-NetTCPConnection -LocalPort 5678 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($owner -and $owner.CommandLine -like '*n8n*') {
    Write-Output "n8n is already listening on http://127.0.0.1:5678 (PID $($listener.OwningProcess))."
    exit 0
  }

  throw "Port 5678 is already in use by PID $($listener.OwningProcess)."
}

if (Test-Path $stdoutLog) { Remove-Item -LiteralPath $stdoutLog -Force }
if (Test-Path $stderrLog) { Remove-Item -LiteralPath $stderrLog -Force }

$envScript = @(
  "`$env:N8N_USER_FOLDER = '$userFolder'"
  "`$env:N8N_HOST = '127.0.0.1'"
  "`$env:N8N_PORT = '5678'"
  "`$env:N8N_PROTOCOL = 'http'"
  "`$env:DB_SQLITE_POOL_SIZE = '4'"
  "`$env:N8N_RUNNERS_ENABLED = 'true'"
  "`$env:N8N_BLOCK_ENV_ACCESS_IN_NODE = 'false'"
  "`$env:N8N_GIT_NODE_DISABLE_BARE_REPOS = 'true'"
  "& '$nodePath' '$n8nBin' start"
) -join '; '

$process = Start-Process `
  -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $envScript `
  -WorkingDirectory $root `
  -PassThru `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog

Write-Output "Started n8n on http://127.0.0.1:5678 (PID $($process.Id))."
