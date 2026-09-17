$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$privateRoot = Join-Path $projectRoot '.private'
. (Join-Path $PSScriptRoot 'runtime.ps1')
$runtime=Get-RemoteControlRuntime
$nodePath=$runtime.Node
$secret = Import-Clixml -LiteralPath (Join-Path $privateRoot 'secret.xml')
$secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:RC_APP_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr)
  & $nodePath (Join-Path $projectRoot 'src\receiver.mjs')
} finally {
  Remove-Item Env:RC_APP_SECRET -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr)
}
