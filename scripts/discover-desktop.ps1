$ErrorActionPreference='Stop'
# Discover only the running desktop backend, never a leftover installed version.
$processes=@(Get-CimInstance Win32_Process)
$backends=@($processes | Where-Object {$_.Name -eq 'codex.exe' -and $_.CommandLine -match 'app-server --analytics'})
if($backends.Count -ne 1){throw 'Expected exactly one desktop backend'}
$backend=$backends[0]
$pipe=[regex]::Match($backend.CommandLine,'codex-browser-use-[0-9a-f-]{36}').Value
$processById=@{}
foreach($entry in $processes){$processById[[int]$entry.ProcessId]=$entry}
$ancestorId=[int]$backend.ParentProcessId
$desktopExecutable=$null
$visited=@{}
for($depth=0;$depth -lt 12;$depth++){
  if($visited.ContainsKey($ancestorId) -or !$processById.ContainsKey($ancestorId)){break}
  $visited[$ancestorId]=$true
  $ancestor=$processById[$ancestorId]
  if($ancestor.Name -eq 'ChatGPT.exe'){$desktopExecutable=$ancestor.ExecutablePath;break}
  $ancestorId=[int]$ancestor.ParentProcessId
}
if(!$desktopExecutable -or ![IO.Path]::IsPathRooted($desktopExecutable)){throw 'Cannot identify owning Codex desktop installation'}
# New desktop builds no longer put the pipe in app-server arguments.
# Check OS pipe ownership against the already verified desktop ancestor.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RemoteControlPipeOwner {
 [DllImport("kernel32.dll", SetLastError=true)]
 public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);
}
'@
$candidates=if($pipe){@($pipe)}else{@([IO.Directory]::GetFiles('\\.\pipe\') | ForEach-Object {[IO.Path]::GetFileName($_)} | Where-Object {$_ -match '^codex-browser-use-[0-9a-f-]{36}$'})}
$verified=@()
foreach($candidate in $candidates){
  $connection=[IO.Pipes.NamedPipeClientStream]::new('.', $candidate, [IO.Pipes.PipeDirection]::InOut)
  try{
    $connection.Connect(300)
    [uint32]$ownerId=0
    if([RemoteControlPipeOwner]::GetNamedPipeServerProcessId($connection.SafePipeHandle,[ref]$ownerId) -and $ownerId -eq $ancestorId){$verified+= $candidate}
  }catch{}finally{$connection.Dispose()}
}
if($verified.Count -lt 1){throw 'No IPC pipe owned by the desktop'}
$pipe=($verified | Sort-Object)[0]
$appDirectory=[IO.Path]::GetDirectoryName($desktopExecutable)
$server=Join-Path $appDirectory 'resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs'
if(!(Test-Path -LiteralPath $server -PathType Leaf)){throw 'Desktop App Tools entry point unavailable'}
$sha=[Security.Cryptography.SHA256]::Create()
try{$hash=[BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($server))).Replace('-','')}finally{$sha.Dispose()}
if($hash -notin @('DD94FC583C708EEC64D3611899EB2CC440A63F46FAB07BB8E3B845EAEAB211A8','72738D48D14057665260F59A7BE80C6A5BF11A3896587B4A2ADB1789C62742A9')){throw 'Desktop tools changed; revalidation required'}
@{pipe=('\\.\pipe\'+$pipe);pipes=@($verified | Sort-Object | ForEach-Object {'\\.\pipe\'+$_});server=$server} | ConvertTo-Json -Compress


