$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='RemoteControl - Setup and start'
$setupLock=$null
try{
 $root=Split-Path $PSScriptRoot -Parent
 $privateRoot=Join-Path $root '.private'
 New-Item -ItemType Directory -Force -Path $privateRoot | Out-Null
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 & icacls.exe $privateRoot /inheritance:r /grant:r "*${identity}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot restrict local configuration directory.'}
 $setupLock=[IO.File]::Open((Join-Path $privateRoot 'setup.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $configPath=Join-Path $privateRoot 'config.json'
 $hasConfig=Test-Path -LiteralPath $configPath
 $hasSecret=Test-Path -LiteralPath (Join-Path $privateRoot 'secret.xml')
 if($hasConfig -ne $hasSecret){throw 'Configuration is incomplete. Restore config.json and secret.xml locally; existing files will not be overwritten.'}
 if($hasConfig){
  $config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$key=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($config.appId)))).Replace('-','').ToLowerInvariant().Substring(0,24)}finally{$sha.Dispose()}
  if([IO.Directory]::GetFiles('\\.\pipe\') -contains ('\\.\pipe\remotecontrol-feishu-'+$key)){
   Write-Host 'RemoteControl is already running. You can use your Feishu bot.'
   Read-Host 'Press Enter to close this window' | Out-Null
   return
  }
 }
 & (Join-Path $PSScriptRoot 'prepare.ps1')
 . (Join-Path $PSScriptRoot 'runtime.ps1')
 $runtime=Get-RemoteControlRuntime
 if(!$hasConfig){& (Join-Path $PSScriptRoot 'configure.ps1') -CredentialsOnly}
 $config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
 if(!$config.sourceThreadId -or !$config.targetThreadId -or !$config.targetTitle){
  Write-Host 'Keep Codex open. Next, select the task you want to control.'
  & $runtime.Node (Join-Path $PSScriptRoot 'setup-desktop.mjs')
  if($LASTEXITCODE -ne 0){throw 'Task setup failed. Open Codex and retry Start.cmd.'}
 }
 $complete=Join-Path $privateRoot 'setup-complete'
 if(!(Test-Path -LiteralPath $complete)){
  $answer=Read-Host 'Start automatically when you sign in to Windows? [y/N]'
  if($answer -match '^(y|yes)$'){& (Join-Path $PSScriptRoot 'install-startup.ps1')}
  Set-Content -LiteralPath $complete -Value '1' -Encoding ascii
 }
 Write-Host 'Starting. If a /rc pair command appears, send it to your bot in Feishu private chat.'
 Write-Host 'Then send one harmless test task and verify the reply in both Codex and Feishu.'
 $setupLock.Dispose();$setupLock=$null
 & (Join-Path $PSScriptRoot 'start.ps1')
 if($LASTEXITCODE -ne 0){throw 'Receiver stopped with an error.'}
}catch{
 Write-Host $_.Exception.Message -ForegroundColor Red
 exit 1
}finally{if($setupLock){$setupLock.Dispose()}}
