param([switch]$Repair)
$ErrorActionPreference='Stop'
if(![Environment]::Is64BitOperatingSystem){throw 'Prism requires 64-bit Windows'}
if(!(Get-Command node.exe -ErrorAction SilentlyContinue)){throw 'Install Node.js 22 or later, then run this installer again'}
$version=& node.exe -p 'process.versions.node'
if($LASTEXITCODE -ne 0 -or [int]($version.Split('.')[0]) -lt 22){throw 'Prism requires Node.js 22 or later'}
$installer=Join-Path $PSScriptRoot 'scripts\native\install.ps1'
$arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$installer)
if($Repair){$arguments+='-Upgrade'}
& (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') @arguments
exit $LASTEXITCODE
