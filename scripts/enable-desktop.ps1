$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$nodeCommand=Get-Command node -ErrorAction SilentlyContinue
$nodePath=if($nodeCommand){$nodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
& $nodePath (Join-Path $PSScriptRoot 'check-desktop.mjs')
if($LASTEXITCODE -ne 0){throw 'Desktop identity check failed; mode unchanged'}
$path=Join-Path $projectRoot '.private\config.json'
$config=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
$config.mode='desktop-test'
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $path -Encoding utf8
Write-Output 'Desktop mode enabled. Restart the receiver to apply. Validate one harmless message in the test task before regular use.'
