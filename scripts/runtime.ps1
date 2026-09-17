function Get-RemoteControlRuntime {
 param([switch]$NeedNpm)
 $root=Split-Path $PSScriptRoot -Parent
 $candidates=@()
 $existing=Get-Command node -ErrorAction SilentlyContinue
 if($existing){$candidates+=$existing.Source}
 $candidates+=(Join-Path $root '.runtime\node-v24.19.0-win-x64\node.exe')
 $candidates+=(Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
 foreach($candidate in $candidates){
  if(!(Test-Path -LiteralPath $candidate)){continue}
  $version=& $candidate --version
  $valid=$version -match '^v24\.(\d+)\.' -and [int]$Matches[1] -ge 19
  $npm=Join-Path (Split-Path $candidate -Parent) 'node_modules\npm\bin\npm-cli.js'
  if($valid -and (!$NeedNpm -or (Test-Path -LiteralPath $npm))){return @{Node=$candidate;Npm=$npm}}
 }
 if($env:PROCESSOR_ARCHITECTURE -ne 'AMD64'){throw 'Automatic runtime download currently supports Windows x64 only. Install Node 24.19+ (24.x) with npm first.'}
 $cache=Join-Path $root '.runtime'
 New-Item -ItemType Directory -Force -Path $cache | Out-Null
 $zip=Join-Path $cache ('node-'+[guid]::NewGuid().ToString()+'.zip')
 Write-Host 'Preparing local Node.js runtime (no system installation)...'
 $previousProgress=$ProgressPreference
 try{
  $ProgressPreference='SilentlyContinue'
  Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip' -OutFile $zip -UseBasicParsing -TimeoutSec 180
 }catch{
  if(Test-Path -LiteralPath $zip){Remove-Item -LiteralPath $zip}
  throw 'Node download failed. Check access to nodejs.org, then retry Start.cmd, or install Node 24.19+ (24.x) with npm manually.'
 }finally{$ProgressPreference=$previousProgress}
 if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'){throw 'Node archive checksum mismatch; not extracted'}
 $folder=Join-Path $cache 'node-v24.19.0-win-x64'
 if(Test-Path -LiteralPath $folder){throw 'Local runtime exists but failed validation. Inspect .runtime before retrying.'}
 Expand-Archive -LiteralPath $zip -DestinationPath $cache
 Remove-Item -LiteralPath $zip
 return @{Node=(Join-Path $folder 'node.exe');Npm=(Join-Path $folder 'node_modules\npm\bin\npm-cli.js')}
}
