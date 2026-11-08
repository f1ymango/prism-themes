param([string]$InstallRoot=(Join-Path $env:LOCALAPPDATA 'PrismChatGPT'), [switch]$NoStartup)
. (Join-Path $PSScriptRoot 'common.ps1')
$installation=Read-PrismInstallation $InstallRoot
if (!('PrismPackageSession' -as [type])) { Add-Type -Path (Join-Path $InstallRoot 'app\native\PackageSession.cs') }
Stop-PrismWorker $InstallRoot $installation
$command='"'+(Join-Path $InstallRoot 'app\native\ActivationCallback.exe')+'" --config "'+(Join-Path $InstallRoot 'state\callback.json')+'"'
if (!$installation.testNoHook -and (Test-PrismHookOwnership $installation.package $command)) { [PrismPackageSession]::Disable($installation.package) }
if (!$NoStartup) {
    $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $value=(Get-ItemProperty -LiteralPath $key -Name 'PrismChatGPTWallpaper' -ErrorAction SilentlyContinue).PrismChatGPTWallpaper
    if ($value -and $value -ne $installation.startupCommand) { throw 'Startup entry belongs to another installation; it was preserved' }
    if ($value) { Remove-ItemProperty -LiteralPath $key -Name 'PrismChatGPTWallpaper' }
}
$installation.enabled=$false
Write-PrismJson (Join-Path $InstallRoot 'installation.json') $installation
[ordered]@{removed=$true;packageCallbackAbsent=$(if($installation.testNoHook){$null}else{!(Test-PrismHookOwnership $installation.package $command)});appRestartNeededToCloseDebugEndpoint=$true;wallpaperFilesRetained=$true} | ConvertTo-Json -Compress
