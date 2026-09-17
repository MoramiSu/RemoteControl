$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
$root=Split-Path $PSScriptRoot -Parent
$runtime=Get-RemoteControlRuntime
$stamp=Join-Path $root '.runtime\dependencies.sha256'
$hash=(Get-FileHash -LiteralPath (Join-Path $root 'package-lock.json') -Algorithm SHA256).Hash
if((Test-Path -LiteralPath $stamp) -and (Test-Path -LiteralPath (Join-Path $root 'node_modules')) -and (Get-Content -LiteralPath $stamp -Raw).Trim() -eq $hash){return}
# Never replace dependencies underneath a running receiver.
$configPath=Join-Path $root '.private\config.json'
if(Test-Path -LiteralPath $configPath){
 $config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
 $sha=[Security.Cryptography.SHA256]::Create()
 try{$key=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($config.appId)))).Replace('-','').ToLowerInvariant().Substring(0,24)}finally{$sha.Dispose()}
 if([IO.Directory]::GetFiles('\\.\pipe\') -contains ('\\.\pipe\remotecontrol-feishu-'+$key)){throw 'Receiver already running. Close it before updating dependencies.'}
}
$runtime=Get-RemoteControlRuntime -NeedNpm
$oldPath=$env:PATH
Push-Location $root
try{
 $env:PATH=(Split-Path $runtime.Node -Parent)+';'+$oldPath
 Write-Host 'Installing locked dependencies. First installation needs Internet access...'
 & $runtime.Node $runtime.Npm ci --no-audit --no-fund
 if($LASTEXITCODE -ne 0){throw 'Dependency installation failed. Check network access, then retry Start.cmd.'}
 New-Item -ItemType Directory -Force -Path (Split-Path $stamp -Parent) | Out-Null
 Set-Content -LiteralPath $stamp -Value $hash -Encoding ascii
}finally{$env:PATH=$oldPath;Pop-Location}
