$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js 18 or newer is required for the Yahoo Finance data proxy. Install Node.js 18+ and run this script again.'
}

$versionText = (& node --version).Trim().TrimStart('v')
$majorVersion = [int]($versionText.Split('.')[0])
if ($majorVersion -lt 18) {
    throw "Node.js 18 or newer is required. Detected Node.js $versionText."
}

Write-Host 'Starting DeepLive at http://localhost:4173' -ForegroundColor Cyan
Write-Host 'Stock search: NYSE / Nasdaq common equities only (Yahoo Finance public search endpoint).' -ForegroundColor Yellow
Write-Host 'Live OHLCV source: Yahoo Finance public chart endpoint (unofficial).' -ForegroundColor Yellow
Write-Host 'Optional local AI: configure LM Studio in Dashboard > Settings (default http://127.0.0.1:1234/v1).' -ForegroundColor Green
node .\server.js
