$ErrorActionPreference='Stop'
$root=Join-Path $env:LOCALAPPDATA 'PrismChatGPT'
if(!(Test-Path -LiteralPath (Join-Path $root 'installation.json'))){Write-Output 'Prism is not installed';exit 0}
& (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'app\scripts\native\remove.ps1') -InstallRoot $root
exit $LASTEXITCODE
