param([string]$OutputDirectory='')
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if(!$OutputDirectory){$OutputDirectory=Join-Path $source '.prism-release'}
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force|Out-Null
$version=(Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json).version
$name='prism-desktop-'+$version+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'-source-preview'
$stage=Join-Path $OutputDirectory $name
New-Item -ItemType Directory -Path $stage|Out-Null
$extensions=@('.mjs','.ps1','.cs','.json','.png','.md')
foreach($folder in @('src','native','scripts','test','assets','examples')){
 foreach($file in (Get-ChildItem -LiteralPath (Join-Path $source $folder) -File -Recurse)){
  if($file.Extension -notin $extensions){continue}
  $relative=$file.FullName.Substring($source.Length+1)
  $destination=Join-Path $stage $relative
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force|Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination $destination
 }
}
New-Item -ItemType Directory -Path (Join-Path $stage 'docs')|Out-Null
Copy-Item -LiteralPath (Join-Path $source 'docs\preview-readme.md') -Destination (Join-Path $stage 'README.md')
Copy-Item -LiteralPath (Join-Path $source 'docs\preview-readme.md') -Destination (Join-Path $stage 'docs\preview-readme.md')
foreach($file in @('package.json','Install.ps1','Uninstall.ps1')){Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $stage $file)}
. (Join-Path $source 'scripts\native\common.ps1')
$manifest=@()
foreach($file in (Get-ChildItem -LiteralPath $stage -File -Recurse)){
 if($file.Extension -in @('.mjs','.ps1','.cs','.json','.md')){
  $text=[IO.File]::ReadAllText($file.FullName)
  if($text -match '(?i)[a-z]:[\\/]+Users[\\/]+(?!Public[\\/])'){throw ('Personal absolute path found in '+$file.FullName.Substring($stage.Length+1))}
 }
 $manifest+=,[ordered]@{path=$file.FullName.Substring($stage.Length+1).Replace('\','/');bytes=$file.Length;sha256=(Get-PrismFileHash $file.FullName)}
}
Write-PrismJson (Join-Path $stage 'source-manifest.json') ([ordered]@{product='prism-chatgpt';version=$version;status='MIT-licensed engineering preview; standalone release not published';files=$manifest})
$archive=Join-Path $OutputDirectory ($name+'.zip')
Compress-Archive -LiteralPath $stage -DestinationPath $archive -CompressionLevel Optimal
[ordered]@{archive=$archive;sha256=(Get-PrismFileHash $archive);source=$stage;files=$manifest.Count}|ConvertTo-Json -Compress
