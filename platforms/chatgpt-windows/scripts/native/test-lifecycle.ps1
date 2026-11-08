$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$root=Join-Path $workspace ('.prism-probe\n'+[Guid]::NewGuid().ToString('N').Substring(0,8))
$profile=Join-Path $root 'test-profile'
$backend=Join-Path $root 'test-backend'
$package=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
$image=Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$before=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object { $_.ExecutablePath -eq $image -and $_.CommandLine -notmatch '(?:^|\s)--type=' } | Select-Object ProcessId,CreationDate)
$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startupBefore=(Get-ItemProperty -LiteralPath $runKey -Name 'PrismChatGPTWallpaper' -ErrorAction SilentlyContinue).PrismChatGPTWallpaper
$owned=@()
$report=[ordered]@{result='failed';checks=[ordered]@{};error=$null;root=$root}
try {
    & (Join-Path $PSScriptRoot 'install.ps1') -InstallRoot $root -NoStartup -NoSkill -Image (Join-Path $workspace 'assets\prism-night.png') -TestProfile $profile -TestBackend $backend -MaxSeconds 180
    if ($LASTEXITCODE -ne 0) { throw 'Fixture setup failed' }
    $report.checks.fixtureSetup=$true
    Add-Type -Path (Join-Path $root 'app\native\PackageSession.cs')
    foreach ($round in @('full','saved')) {
        if ($round -eq 'saved') {
            & (Join-Path $PSScriptRoot 'install.ps1') -InstallRoot $root -NoStartup -NoSkill -TestProfile $profile -TestBackend $backend -MaxSeconds 180
            if ($LASTEXITCODE -ne 0) { throw 'Fixture reinstall failed' }
        }
        $time=[DateTime]::UtcNow
        $testPid=[PrismPackageSession]::Activate(($package.PackageFamilyName+'!App'),('"--user-data-dir='+$profile+'"'))
        if (@($before | Where-Object ProcessId -eq $testPid).Count) { throw 'An existing app was returned and preserved' }
        $process=Get-Process -Id $testPid
        if ($process.StartTime.ToUniversalTime() -lt $time.AddSeconds(-2)) { throw 'An old process was returned and preserved' }
        $identity=Get-CimInstance Win32_Process -Filter ('ProcessId='+$testPid)
        if (!$identity.CommandLine.Contains($profile)) { throw 'Activation was not isolated' }
        $owned+=@([pscustomobject]@{pid=$testPid;created=$process.StartTime.ToUniversalTime()})
        $deadline=[DateTime]::UtcNow.AddSeconds(30)
        while (!(Test-Path -LiteralPath (Join-Path $profile 'DevToolsActivePort')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
        & node (Join-Path $PSScriptRoot 'verify-session.mjs') $root $profile $round
        if ($LASTEXITCODE -ne 0) { throw ('Session verification failed: '+$round) }
        $report.checks[$round+'Session']=$true
        if ($round -eq 'full') {
            $firstWorker=Get-Content -LiteralPath (Join-Path $root 'state\worker.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            & (Join-Path $PSScriptRoot 'install.ps1') -InstallRoot $root -NoStartup -NoSkill -TestProfile $profile -TestBackend $backend -MaxSeconds 180
            $secondWorker=Get-Content -LiteralPath (Join-Path $root 'state\worker.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($firstWorker.pid -ne $secondWorker.pid -or $firstWorker.created -ne $secondWorker.created) { throw 'Repeated setup replaced the live worker' }
            $report.checks.repeatedSetupIsIdempotent=$true
        }
        & (Join-Path $PSScriptRoot 'remove.ps1') -InstallRoot $root -NoStartup
        & node (Join-Path $PSScriptRoot 'verify-session.mjs') $root $profile removed
        if ($LASTEXITCODE -ne 0) { throw 'Removal did not restore the live app appearance' }
        $report.checks.removalRestoresAppearance=$true
        if (!(Get-Process -Id $testPid -ErrorAction SilentlyContinue)) { throw 'Removal closed the app process' }
        $report.checks.removalPreservesApp=$true
        foreach ($key in (Get-PrismDebugKeys $package.PackageFullName)) { if (Test-Path -LiteralPath $key) { throw 'Callback remained after fixture removal' } }
        $report.checks.callbackRemoved=$true
        & taskkill.exe /PID $testPid /T /F | Out-Null
        $portFile=Join-Path $profile 'DevToolsActivePort'
        if (Test-Path -LiteralPath $portFile) { Remove-Item -LiteralPath $portFile }
    }
    $report.result='passed'
} catch { $report.error=$_.Exception.Message }
finally {
    if (Test-Path -LiteralPath (Join-Path $root 'installation.json')) {
        try { & (Join-Path $PSScriptRoot 'remove.ps1') -InstallRoot $root -NoStartup | Out-Null } catch { $report.error=[string]$report.error+'; cleanup: '+$_.Exception.Message;$report.result='failed' }
    }
    foreach ($p in $owned) { $current=Get-Process -Id $p.pid -ErrorAction SilentlyContinue;if ($current -and $current.StartTime.ToUniversalTime() -eq $p.created) { & taskkill.exe /PID $p.pid /T /F | Out-Null } }
    $preserved=$true
    foreach ($original in $before) { $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$original.ProcessId);if(!$current -or $current.CreationDate -ne $original.CreationDate){$preserved=$false} }
    $report.checks.originalProcessesPreserved=$preserved
    $startupAfter=(Get-ItemProperty -LiteralPath $runKey -Name 'PrismChatGPTWallpaper' -ErrorAction SilentlyContinue).PrismChatGPTWallpaper
    $report.checks.loginStartupUnchanged=($startupBefore -eq $startupAfter)
    if ($report.checks.Values -contains $false) { $report.result='failed' }
    if (Test-Path -LiteralPath $root) { Write-PrismJson (Join-Path $root 'lifecycle-report.json') $report }
    $report | ConvertTo-Json -Depth 8 -Compress
}
if ($report.result -ne 'passed') { exit 1 }
