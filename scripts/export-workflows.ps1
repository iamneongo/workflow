$root = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $root 'workflows\exported'
$n8nCmd = Join-Path $root 'node_modules\.bin\n8n.cmd'

if (-not (Test-Path $n8nCmd)) {
  throw "Khong tim thay n8n CLI tai $n8nCmd. Hay chay npm install truoc."
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$env:N8N_USER_FOLDER = Join-Path $root '.n8n'

& $n8nCmd export:workflow --backup --output=$outputDir

if ($LASTEXITCODE -ne 0) {
  throw "Export workflow that bai."
}

Write-Output "Da export workflow vao $outputDir"
