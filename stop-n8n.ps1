$listener = Get-NetTCPConnection -LocalPort 5678 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $listener) {
  Write-Output 'No process is listening on port 5678.'
  exit 0
}

$owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
if (-not $owner -or $owner.CommandLine -notlike '*n8n*') {
  throw "Port 5678 is in use by PID $($listener.OwningProcess), but it does not look like n8n."
}

Stop-Process -Id $listener.OwningProcess -Force
Write-Output "Stopped n8n process on port 5678 (PID $($listener.OwningProcess))."
