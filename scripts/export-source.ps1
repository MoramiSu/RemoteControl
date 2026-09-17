$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$dist=Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$name='remotecontrol-source-'+(Get-Date -Format 'yyyyMMdd-HHmmss')
$destination=Join-Path $dist $name
if(Test-Path -LiteralPath $destination){throw 'Export destination already exists'}
New-Item -ItemType Directory -Path $destination | Out-Null
$files=@('Start.cmd','README.md','FEISHU_SETUP.md','config.example.json','package.json','package-lock.json','.gitignore')
foreach($file in $files){Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $destination $file)}
foreach($folder in @('src','test','docs')){
 $target=Join-Path $destination $folder
 New-Item -ItemType Directory -Path $target | Out-Null
 $extensions=if($folder -eq 'docs'){@('.md')}else{@('.mjs','.ts')}
 foreach($file in Get-ChildItem -LiteralPath (Join-Path $root $folder) -File){
  if($extensions -contains $file.Extension){Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $target $file.Name)}
 }
}
$scripts=Join-Path $destination 'scripts'
$imagesSource=Join-Path $root 'docs\images'
if(Test-Path -LiteralPath $imagesSource){
 $imagesTarget=Join-Path $destination 'docs\images'
 New-Item -ItemType Directory -Path $imagesTarget -Force | Out-Null
 foreach($file in Get-ChildItem -LiteralPath $imagesSource -File){
  if($file.Extension -in @('.png','.svg')){Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $imagesTarget $file.Name)}
 }
}
New-Item -ItemType Directory -Path $scripts | Out-Null
foreach($file in @('runtime.ps1','prepare.ps1','setup-desktop.mjs','configure.ps1','start.ps1','setup-and-start.ps1','install-startup.ps1','discover-desktop.ps1','check-desktop.mjs','enable-desktop.ps1','export-source.ps1')){
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $scripts $file)
}
$zip=Join-Path $dist ($name+'.zip')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
try{
 foreach($file in Get-ChildItem -LiteralPath $destination -Recurse -File -Force){
  $relative=$file.FullName.Substring($destination.Length+1).Replace('\','/')
  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,($name+'/'+$relative))
 }
}finally{$archive.Dispose()}
Write-Output $destination
Write-Output $zip

