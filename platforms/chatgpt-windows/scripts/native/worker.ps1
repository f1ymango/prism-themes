param([Parameter(Mandatory=$true)][string]$InstallRoot, [string]$TestProfile='', [string]$TestBackend='', [int]$MaxSeconds=0, [switch]$NoHook)
. (Join-Path $PSScriptRoot 'common.ps1')
$installation=Read-PrismInstallation $InstallRoot
if (!$installation.enabled) { exit 0 }
$state=Join-Path $InstallRoot 'state'
$statusPath=Join-Path $state 'worker.json'
$self=Get-Process -Id $PID
$created=$self.StartTime.ToUniversalTime().ToString('o')
$mutex=[Threading.Mutex]::new($false,('Local\PrismChatGPT-'+$installation.id))
$locked=$false
try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
if (!$locked) { $mutex.Dispose(); exit 0 }
$session=$null
$hostProcess=$null
$command='"'+(Join-Path $InstallRoot 'app\native\ActivationCallback.exe')+'" --config "'+(Join-Path $state 'callback.json')+'"'
$outcome='stopped'
$failure=$null
if ($NoHook -and (!$installation.fixture -or !$TestProfile -or $MaxSeconds -lt 1 -or $MaxSeconds -gt 300)) { throw 'NoHook is restricted to bounded fixture installations' }
function Write-WorkerStatus([string]$Stage, [string]$Message) {
    Write-PrismJson $statusPath ([ordered]@{state=$Stage;pid=$PID;created=$created;at=[DateTime]::UtcNow.ToString('o');package=$installation.package;hostStarts=$starts;message=$Message})
}
try {
    Write-WorkerStatus 'starting' 'Checking the installed app'
    if (!('PrismPackageSession' -as [type])) { Add-Type -Path (Join-Path $InstallRoot 'app\native\PackageSession.cs') }
    $package=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (!$package -or $package.PackageFullName -ne $installation.package) { $outcome='unsupported';throw 'App updated. Run /prism repair to check and adapt to the new build' }
    $image=Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    if ((Get-PrismFileHash $image) -ne $installation.executableSha256 -or (Get-PrismFileHash (Join-Path $package.InstallLocation 'app\resources\app.asar')) -ne $installation.archiveSha256) { $outcome='unsupported';throw 'Installed app hashes no longer match the verified build' }
    if (!$NoHook) { [void](Test-PrismHookOwnership $installation.package $command) }
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { $slot=[BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($package.PackageFullName))).Replace('-','').Substring(0,8) } finally { $algorithm.Dispose() }
    # Keep the versioned alias directly under the installation root: every extra
    # character consumes the native startup buffer needed for the debugging flag.
    $aliasRoot=Join-Path $InstallRoot $slot
    $imageAlias=Join-Path $aliasRoot 'ChatGPT.exe'
    if (!$NoHook -and !$TestProfile -and $imageAlias.Length+' --remote-debugging-port=0'.Length -gt $image.Length) { throw 'Installation path is too long for ordinary app activation; use the default Prism installation directory' }
    if (Test-Path -LiteralPath $aliasRoot) {
        $link=Get-Item -LiteralPath $aliasRoot
        if ($link.LinkType -ne 'Junction' -or @($link.Target).Count -ne 1 -or @($link.Target)[0] -ne (Join-Path $package.InstallLocation 'app')) { throw 'Unexpected image alias was preserved' }
    } else { New-Item -ItemType Junction -Path $aliasRoot -Target (Join-Path $package.InstallLocation 'app') | Out-Null }
    Write-PrismJson (Join-Path $state 'callback.json') ([ordered]@{
        package=$installation.package;image=$image;imageAlias=$imageAlias;profile=$TestProfile
        notBefore=[DateTime]::UtcNow.AddSeconds(-30).ToFileTimeUtc();expires=0;heartbeat=$statusPath;log=(Join-Path $state 'activations.jsonl')
    })
    $environmentBlock=$null
    if ($TestProfile) {
        if (!$TestBackend -or $MaxSeconds -lt 1 -or $MaxSeconds -gt 300) { throw 'Test isolation requires a backend and a bounded lifetime' }
        $environmentBlock='CODEX_ELECTRON_USER_DATA_PATH='+$TestProfile+[char]0+'CODEX_HOME='+$TestBackend+[char]0+[char]0
    }
    if (!$NoHook) { $session=[PrismPackageSession]::new($installation.package,$command,$environmentBlock) }
    $hostStop=Join-Path $state 'host-stop'
    if (Test-Path -LiteralPath $hostStop) { Remove-Item -LiteralPath $hostStop }
    $started=[DateTime]::UtcNow
    $lastPackageCheck=$started
    $starts=0
    $hostStarted=[DateTime]::UtcNow
    while ($true) {
        if (Test-Path -LiteralPath (Join-Path $state 'stop')) { break }
        if ($MaxSeconds -gt 0 -and ([DateTime]::UtcNow-$started).TotalSeconds -ge $MaxSeconds) { break }
        if (!$NoHook -and !(Test-PrismHookOwnership $installation.package $command)) { throw 'Package callback registration disappeared' }
        if (!$hostProcess -or $hostProcess.HasExited) {
            $starts++
            if ($starts -gt 5) { throw 'Renderer helper exited repeatedly; inspect host-error.log before repair' }
            $node=Join-Path $InstallRoot 'runtime\node.exe'
            $hostScript=Join-Path $InstallRoot 'app\scripts\native\host.mjs'
            $hostProcess=Start-Process -FilePath $node -ArgumentList @(('"'+$hostScript+'"'),'--root',('"'+$InstallRoot+'"'),'--parent',([string]$PID)) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $state 'host-output.log') -RedirectStandardError (Join-Path $state 'host-error.log')
            $hostStarted=[DateTime]::UtcNow
        }
        if (([DateTime]::UtcNow-$hostStarted).TotalSeconds -gt 60) { $starts=0 }
        Write-WorkerStatus 'armed' 'Ready for ordinary app activation'
        if (([DateTime]::UtcNow-$lastPackageCheck).TotalSeconds -ge 15) {
            $latest=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
            if (!$latest -or $latest.PackageFullName -ne $installation.package) { $outcome='unsupported';throw 'App updated. Run /prism repair to check and adapt to the new build' }
            $lastPackageCheck=[DateTime]::UtcNow
        }
        Start-Sleep -Seconds 2
    }
} catch { if($outcome -ne 'unsupported'){$outcome='error'};$failure=$_.Exception.Message }
finally {
    if ($session) {
        try {
            if (Test-PrismHookOwnership $installation.package $command) { $session.Dispose() }
            else { $session.ReleaseWithoutDisabling() }
        } catch { $session.ReleaseWithoutDisabling();$outcome='error';$failure=$_.Exception.Message }
    }
    [IO.File]::WriteAllText((Join-Path $state 'host-stop'),$installation.id)
    if ($hostProcess -and !$hostProcess.HasExited) {
        if (!$hostProcess.WaitForExit(8000)) { $hostProcess.Kill() }
    }
    Write-WorkerStatus $outcome $(if($failure){$failure}else{'Integration stopped; app windows remain open'})
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
if ($outcome -eq 'error' -or $outcome -eq 'unsupported') { exit 1 }
