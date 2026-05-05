$root = Split-Path -Parent $MyInvocation.MyCommand.Path

powershell -ExecutionPolicy Bypass -File (Join-Path $root 'start-n8n.ps1') | Out-Host

$deadline = (Get-Date).AddSeconds(45)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:5678/healthz' -TimeoutSec 5
    if ($health.Content -match '"status":"ok"') {
      $ready = $true
      break
    }
  } catch {}
  Start-Sleep -Seconds 2
}

if (-not $ready) {
  throw 'n8n did not become healthy within 45 seconds.'
}

powershell -ExecutionPolicy Bypass -File (Join-Path $root 'start-zalo-bridge.ps1') | Out-Host
