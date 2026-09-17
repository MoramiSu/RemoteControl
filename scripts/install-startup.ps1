param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory 'RemoteControl Feishu Bridge.lnk'
if ($Remove) {
  if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
  Write-Output 'Login startup disabled. The running bridge is unaffected.'
  return
}
$launcherPath = Join-Path $PSScriptRoot 'start.ps1'
$privateDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) '.private'
if (!(Test-Path -LiteralPath (Join-Path $privateDirectory 'secret.xml'))) { throw 'Complete local setup first.' }
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
if (!(Test-Path -LiteralPath $shortcut.TargetPath)) { $shortcut.TargetPath = Join-Path $PSHOME 'pwsh.exe' }
$shortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $launcherPath + '"'
$shortcut.WorkingDirectory = Split-Path $PSScriptRoot -Parent
$shortcut.WindowStyle = 7
$shortcut.Description = 'Feishu bridge in the signed-in Windows user session'
$shortcut.Save()
Write-Output 'Login startup enabled for the current Windows user.'
