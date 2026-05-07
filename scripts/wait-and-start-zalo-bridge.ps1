$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logPath = Join-Path $root 'zalo-login-followup.log'
$qrLogPath = Join-Path $root 'zalo-login-qr.log'

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f ([DateTime]::Now.ToString('s')), $Message
  Add-Content -LiteralPath $logPath -Value $line
}

Write-Log 'Watcher started.'

$deadline = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $qrLogPath) {
    $qrLog = Get-Content $qrLogPath -Raw
    if ($qrLog -match 'Saved credential .*updated \.env\.local') {
      Write-Log 'Detected successful QR login save. Starting bridge.'
      powershell -ExecutionPolicy Bypass -File (Join-Path $root 'start-zalo-bridge.ps1') | Out-Host
      Write-Log 'Bridge start command executed.'
      exit 0
    }
    if ($qrLog -match 'Failed to save credential' -or $qrLog -match 'QR expired' -or $qrLog -match 'QR declined') {
      Write-Log 'QR login ended with failure.'
      exit 1
    }
  }
  Start-Sleep -Seconds 3
}

Write-Log 'Watcher timed out waiting for QR login.'
exit 1
