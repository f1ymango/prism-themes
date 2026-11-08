param(
    [string]$InstallRoot=(Join-Path $env:LOCALAPPDATA 'PrismChatGPT'),
    [switch]$NoStartup,
    [string]$Image='',
    [string]$TestProfile='',
    [string]$TestBackend='',
    [int]$MaxSeconds=0,
    [switch]$NoSkill,
    [switch]$NoHook,
    [switch]$Upgrade,
    [switch]$CheckBuild
)
. (Join-Path $PSScriptRoot 'common.ps1')
$source=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$markerPath=Join-Path $InstallRoot 'installation.json'
$state=Join-Path $InstallRoot 'state'
$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName='PrismChatGPTWallpaper'
$shell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$bootstrap=Join-Path $InstallRoot 'PrismHelper.exe'
$startupCommand='"'+$bootstrap+'"'
if ($startupCommand.Length -gt 260) { throw 'Installation path is too long for Windows login startup' }
$implementationVersion=8
$mustStop=$false
if ($TestProfile) {
    if (!$NoStartup -or !$NoSkill -or $MaxSeconds -lt 1 -or $MaxSeconds -gt 300) { throw 'Fixture installs must be bounded and may not register login startup or a skill' }
    foreach ($path in @($TestProfile,$TestBackend)) { if (![IO.Path]::GetFullPath($path).StartsWith($InstallRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture state must stay inside its installation root' } }
}
if ($NoHook -and !$TestProfile) { throw 'NoHook is restricted to an isolated fixture' }
$existingRun=(Get-ItemProperty -LiteralPath $runKey -Name $runName -ErrorAction SilentlyContinue).$runName
$installation=$null
if (Test-Path -LiteralPath $InstallRoot) {
    if (!(Test-Path -LiteralPath $markerPath)) { throw 'The installation directory already contains unowned files; it was preserved' }
    $installation=Read-PrismInstallation $InstallRoot
    if (!$NoStartup -and $existingRun -and $existingRun -ne $startupCommand -and $existingRun -ne $installation.startupCommand) { throw 'A different Prism startup entry was preserved' }
    $workerStatusPath=Join-Path $state 'worker.json'
    if (Test-Path -LiteralPath $workerStatusPath) {
        $workerStatus=Get-Content -LiteralPath $workerStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $running=Get-Process -Id $workerStatus.pid -ErrorAction SilentlyContinue
        if (!$Upgrade -and !$CheckBuild -and $installation.implementationVersion -eq $implementationVersion -and $installation.enabled -and $running -and $running.StartTime.ToUniversalTime().ToString('o') -eq $workerStatus.created -and $workerStatus.state -eq 'armed' -and ([DateTime]::UtcNow-[DateTime]::Parse($workerStatus.at)).TotalSeconds -lt 15) {
            if (!$NoStartup) { New-Item -Path $runKey -Force | Out-Null; New-ItemProperty -LiteralPath $runKey -Name $runName -Value $startupCommand -PropertyType String -Force | Out-Null }
            Start-Process -FilePath $bootstrap -WindowStyle Hidden | Out-Null
            & (Join-Path $InstallRoot 'runtime\node.exe') (Join-Path $InstallRoot 'app\scripts\native\control.mjs') --root $InstallRoot status
            exit $LASTEXITCODE
        }
        $mustStop=$true
    }
}
if (!$installation -and !$NoStartup -and $existingRun) { throw 'An unowned Prism startup entry was preserved' }
$candidate=& (Join-Path $PSScriptRoot 'approve-build.ps1') -InstallRoot $InstallRoot -SourceRoot $source -ForceCheck:$CheckBuild
$package=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (!$package -or $package.PackageFullName -ne $candidate.package) { throw 'App changed while checking compatibility; run repair again' }
$imagePath=$candidate.image
$callbackCommand='"'+(Join-Path $InstallRoot 'app\native\ActivationCallback.exe')+'" --config "'+(Join-Path $state 'callback.json')+'"'
if (!$NoHook) { [void](Test-PrismHookOwnership $candidate.package $callbackCommand) }
if ($mustStop) { Stop-PrismWorker $InstallRoot $installation }
New-Item -ItemType Directory -Path $state,(Join-Path $InstallRoot 'runtime'),(Join-Path $InstallRoot 'app') -Force | Out-Null
if (!$installation) {
    $installation=[pscustomobject]@{schema=1;product='prism-chatgpt';id=[Guid]::NewGuid().ToString();root=$InstallRoot;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;enabled=$false;package=$candidate.package;image=$imagePath;executableSha256=$candidate.executableSha256;archiveSha256=$candidate.archiveSha256;startupCommand=$startupCommand}
}
$installation.package=$candidate.package;$installation.image=$imagePath
$installation.executableSha256=$candidate.executableSha256;$installation.archiveSha256=$candidate.archiveSha256
$installation.startupCommand=$startupCommand
foreach ($entry in @{implementationVersion=$implementationVersion;compatibilitySource=$candidate.compatibilitySource;fixture=[bool]$TestProfile;testNoHook=[bool]$NoHook;testProfile=$TestProfile;testBackend=$TestBackend;maxSeconds=$MaxSeconds}.GetEnumerator()) { $installation | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value -Force }
Write-PrismJson $markerPath $installation
if ($candidate.approval) {
    $cacheNode=Join-Path $InstallRoot 'runtime\node.exe'
    if (!(Test-Path -LiteralPath $cacheNode)) { $cacheNode=(Get-Command node).Source }
    & $cacheNode (Join-Path $source 'scripts\native\build-cache.mjs') --cache (Join-Path $state 'builds.json') --approval $candidate.approvalPath
    if ($LASTEXITCODE -ne 0) { throw 'Passing build approval could not be saved' }
}
$deployed=$false
try {
    foreach ($directory in @('src','native','scripts\native')) {
        $from=Join-Path $source $directory
        foreach ($file in (Get-ChildItem -LiteralPath $from -File -Recurse)) {
            $relative=$file.FullName.Substring($source.Length+1)
            $destination=Join-Path $InstallRoot ('app\'+$relative)
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
            if ($file.FullName -ne $destination) { Copy-Item -LiteralPath $file.FullName -Destination $destination -Force }
        }
    }
    New-Item -ItemType Directory -Path (Join-Path $InstallRoot 'app\assets') -Force | Out-Null
    foreach ($name in @('prism-night.png','prism-plum.png')) {
        $from=Join-Path $source ('assets\'+$name); $to=Join-Path $InstallRoot ('app\assets\'+$name)
        if ($from -ne $to) { Copy-Item -LiteralPath $from -Destination $to -Force }
    }
    $nodeTarget=Join-Path $InstallRoot 'runtime\node.exe'
    if (!(Test-Path -LiteralPath $nodeTarget)) { $node=(Get-Command node).Source; Copy-Item -LiteralPath $node -Destination $nodeTarget }
    $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:winexe /platform:x64 /r:System.Web.Extensions.dll ('/out:'+(Join-Path $InstallRoot 'app\native\ActivationCallback.exe')) (Join-Path $InstallRoot 'app\native\ActivationCallback.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Callback compilation failed' }
    & $compiler /nologo /target:winexe /platform:x64 /r:System.Web.Extensions.dll ('/out:'+$bootstrap) (Join-Path $InstallRoot 'app\native\PrismHelper.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Supervisor compilation failed' }
    $installation.enabled=$true
    Write-PrismJson $markerPath $installation
    if (!(Test-Path -LiteralPath (Join-Path $state 'preferences.json'))) {
        if (!$Image) {
            $legacy=Join-Path $source '.prism-user\settings.json'
            if (Test-Path -LiteralPath $legacy) { $old=Get-Content -LiteralPath $legacy -Raw -Encoding UTF8 | ConvertFrom-Json; if (Test-Path -LiteralPath $old.image) { $Image=$old.image } }
            if (!$Image) { $Image=Join-Path $InstallRoot 'app\assets\prism-night.png' }
        }
        & $nodeTarget (Join-Path $InstallRoot 'app\scripts\native\control.mjs') --root $InstallRoot bg $Image | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Initial wallpaper validation failed' }
    }
    foreach ($stop in @('stop','host-stop')) { $path=Join-Path $state $stop; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path } }
    if (!$NoSkill) {
        & (Join-Path $PSScriptRoot 'publish-skill.ps1') -InstallRoot $InstallRoot -BackupDirectory $state
    }
    if (!$NoStartup) { New-Item -Path $runKey -Force | Out-Null; New-ItemProperty -LiteralPath $runKey -Name $runName -Value $startupCommand -PropertyType String -Force | Out-Null }
    if ($TestProfile) { New-Item -ItemType Directory -Path $TestProfile,$TestBackend -Force | Out-Null }
    $launchedAt=[DateTime]::UtcNow
    Start-Process -FilePath $bootstrap -WindowStyle Hidden | Out-Null
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 300
        if (Test-Path -LiteralPath (Join-Path $state 'worker.json')) {
            $status=Get-Content -LiteralPath (Join-Path $state 'worker.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([DateTime]::Parse($status.created).ToUniversalTime() -lt $launchedAt) { continue }
            if ($status.state -eq 'error' -or $status.state -eq 'unsupported') { throw $status.message }
            if ($status.state -eq 'armed' -and ([DateTime]::UtcNow-[DateTime]::Parse($status.at)).TotalSeconds -lt 10) { $deployed=$true;break }
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$deployed) { throw 'Background helper did not become ready; inspect worker-error.log' }
    & $nodeTarget (Join-Path $InstallRoot 'app\scripts\native\control.mjs') --root $InstallRoot status
} catch {
    $failure=$_.Exception.Message
    try { & (Join-Path $InstallRoot 'app\scripts\native\remove.ps1') -InstallRoot $InstallRoot -NoStartup:$NoStartup | Out-Null } catch { $failure+='; cleanup: '+$_.Exception.Message }
    throw $failure
}
