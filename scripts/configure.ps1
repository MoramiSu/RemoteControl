param([switch]$CredentialsOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$privateRoot = Join-Path $projectRoot '.private'
if(Test-Path -LiteralPath (Join-Path $privateRoot 'config.json')){throw 'Configuration exists. Back it up and edit locally instead of overwriting a paired installation.'}
New-Item -ItemType Directory -Force $privateRoot | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $privateRoot /inheritance:r /grant:r "*${identity}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict local credential directory.' }
$appId = Read-Host 'Feishu App ID (cli_...)'
if ($appId -notmatch '^cli_[A-Za-z0-9]+$') { throw 'Invalid App ID' }
$secret = Read-Host 'Feishu App Secret (hidden input; never send to chat)' -AsSecureString
if(!$CredentialsOnly){
$sourceId = Read-Host 'Existing Codex source/control task UUID'
$targetId = Read-Host 'Existing dedicated test task UUID'
$targetTitle = Read-Host 'Exact title of the dedicated test task'
$uuidPattern = '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$'
if($sourceId -notmatch $uuidPattern -or $targetId -notmatch $uuidPattern -or [string]::IsNullOrWhiteSpace($targetTitle)){throw 'Invalid desktop task identity'}
}
if ($secret.Length -eq 0) { throw 'Secret is empty' }
$secret | Export-Clixml -LiteralPath (Join-Path $privateRoot 'secret.xml')
$settings=@{appId=$appId;mode='receive-only'}
if(!$CredentialsOnly){$settings.sourceThreadId=$sourceId;$settings.targetThreadId=$targetId;$settings.targetTitle=$targetTitle}
$settings | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $privateRoot 'config.json') -Encoding utf8
Write-Host 'Saved locally using Windows user encryption. Run scripts\start.ps1 next.'
