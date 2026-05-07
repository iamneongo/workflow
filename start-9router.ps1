$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$routerCmd = 'C:\Users\tuan\AppData\Roaming\npm\9router.ps1'
$hostAddress = '127.0.0.1'
$port = 20128

if (-not (Test-Path $routerCmd)) {
  throw "9router is not installed at $routerCmd"
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($owner -and $owner.CommandLine -like '*9router*') {
    Write-Output "9router is already listening on http://$hostAddress`:$port (PID $($listener.OwningProcess))."
    exit 0
  }
}

$process = Start-Process `
  -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $routerCmd, '--no-browser', '--host', $hostAddress `
  -WorkingDirectory $root `
  -PassThru `
  -WindowStyle Hidden

Write-Output "Started 9router on http://$hostAddress`:$port (PID $($process.Id))."
