$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (!$package -or $package.PackageFullName -notmatch '^OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0$') { throw 'Expected Windows x64 package was not found' }
$image = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$archive = Join-Path $package.InstallLocation 'app\resources\app.asar'
$keys = @(
    ('Registry::HKEY_CURRENT_USER\Software\Classes\ActivatableClasses\Package\' + $package.PackageFullName + '\DebugInformation'),
    ('Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\PackagedAppXDebug\' + $package.PackageFullName)
)
foreach ($key in $keys) { if (Test-Path -LiteralPath $key) { throw 'An existing package debugger was preserved; probe cancelled' } }
$existing = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object { $_.ExecutablePath -eq $image -and $_.CommandLine -notmatch '(?:^|\s)--type=' } | Select-Object ProcessId, CreationDate)
$hashBefore = @((Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash, (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash)
$runDir = Join-Path $workspace ('.prism-probe\native-activation-' + [Guid]::NewGuid().ToString('N'))
$profile = Join-Path $runDir 'profile'
$backend = Join-Path $runDir 'backend'
New-Item -ItemType Directory -Path $profile, $backend -Force | Out-Null
$callback = Join-Path $runDir 'ActivationProbe.exe'
$aliasRoot = Join-Path $workspace ('.prism-probe\a' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Junction -Path $aliasRoot -Target (Join-Path $package.InstallLocation 'app') | Out-Null
$imageAlias = Join-Path $aliasRoot 'ChatGPT.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /platform:x64 /r:System.Web.Extensions.dll ('/out:' + $callback) (Join-Path $PSScriptRoot 'ActivationProbe.cs')
if ($LASTEXITCODE -ne 0) { throw 'Callback compilation failed' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public sealed class PrismActivationScope : IDisposable {
    [ComImport, Guid("F27C3930-8029-4AD1-94E3-3DBA417810C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Settings {
        [PreserveSig] int EnableDebugging([MarshalAs(UnmanagedType.LPWStr)] string package, [MarshalAs(UnmanagedType.LPWStr)] string debugger, IntPtr environment);
        [PreserveSig] int DisableDebugging([MarshalAs(UnmanagedType.LPWStr)] string package);
    }
    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Activation {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string app, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint pid);
    }
    Settings settings; string package; Timer timer; int disposed; IntPtr environment;
    public int? CleanupResult { get; private set; }
    public PrismActivationScope(string name, string callback, string environmentBlock) {
        package=name;
        settings=(Settings)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("B1AEC16F-2383-4852-B0E9-8F0B1DC66B4D")));
        environment=Marshal.StringToHGlobalUni(environmentBlock);
        int result=settings.EnableDebugging(package,callback,environment);
        if(result<0) { Marshal.FreeHGlobal(environment); environment=IntPtr.Zero; Marshal.FinalReleaseComObject(settings); settings=null; Marshal.ThrowExceptionForHR(result); }
        timer=new Timer(_=>Dispose(),null,35000,Timeout.Infinite);
    }
    public static uint Activate(string app, string arguments) {
        var activation=(Activation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
        try { uint pid; Marshal.ThrowExceptionForHR(activation.ActivateApplication(app,arguments,2,out pid)); return pid; }
        finally { Marshal.FinalReleaseComObject(activation); }
    }
    public void Dispose() {
        if(Interlocked.Exchange(ref disposed,1)!=0) return;
        if(timer!=null) timer.Dispose();
        try { CleanupResult=settings.DisableDebugging(package); }
        finally { Marshal.FinalReleaseComObject(settings); settings=null; if(environment!=IntPtr.Zero) Marshal.FreeHGlobal(environment); }
    }
}
'@

$config = Join-Path $runDir 'callback-config.json'
$log = Join-Path $runDir 'callback.jsonl'
[ordered]@{
    package = $package.PackageFullName
    image = $image
    imageAlias = $imageAlias
    profile = $profile
    notBefore = [DateTime]::UtcNow.AddSeconds(-1).ToFileTimeUtc()
    expires = [DateTime]::UtcNow.AddSeconds(35).ToFileTimeUtc()
    log = $log
} | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8

$scope = $null
$child = $null
$port = $null
$report = [ordered]@{ result = 'failed'; package = $package.PackageFullName; checks = [ordered]@{}; error = $null }
try {
    $environmentBlock = 'CODEX_ELECTRON_USER_DATA_PATH=' + $profile + [char]0 + 'CODEX_HOME=' + $backend + [char]0 + [char]0
    $scope = [PrismActivationScope]::new($package.PackageFullName, ('"' + $callback + '" --config "' + $config + '"'), $environmentBlock)
    # Use Windows' normal package activation contract, with no debugging flags.
    $activationTime = [DateTime]::UtcNow
    $activatedPid = [PrismActivationScope]::Activate(($package.PackageFamilyName + '!App'), ('"--user-data-dir=' + $profile + '"'))
    if (@($existing | Where-Object ProcessId -eq $activatedPid).Count) { throw 'Activation returned an existing process; it was preserved' }
    $activatedProcess = Get-Process -Id $activatedPid
    if ($activatedProcess.StartTime.ToUniversalTime() -lt $activationTime.AddSeconds(-2)) { throw 'Activation returned an older process; it was preserved' }
    $identity = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $activatedPid)
    if (!$identity.CommandLine.Contains($profile)) { throw 'Activation did not return the isolated profile; it was preserved' }
    $child = $activatedProcess
    $startedUtc = $child.StartTime.ToUniversalTime()
    $report.pid = $child.Id
    $report.checks.launchRequestHadNoDebuggingFlags = $true
    $portFile = Join-Path $profile 'DevToolsActivePort'
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    while (!(Test-Path -LiteralPath $portFile) -and [DateTime]::UtcNow -lt $deadline) {
        if ($child.HasExited) { $report.exitCode = $child.ExitCode; throw ('Isolated app exited before exposing its renderer: ' + $child.ExitCode) }
        Start-Sleep -Milliseconds 200
    }
    if (!(Test-Path -LiteralPath $portFile)) { throw 'Activation callback did not produce a debugging endpoint' }
    $scope.Dispose()
    if ($scope.CleanupResult -ne 0) { throw ('Package-debug cleanup failed: ' + $scope.CleanupResult) }
    foreach ($key in $keys) { if (Test-Path -LiteralPath $key) { throw 'Package-debug registration remained after cleanup' } }
    $report.checks.temporaryRegistrationRemoved = $true
    $port = [int](Get-Content -LiteralPath $portFile -TotalCount 1)
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne $child.Id) { throw 'Endpoint ownership or loopback binding did not match the isolated child' }
    $report.checks.loopbackEndpointOwnedByTestChild = $true
    $callbacks = @(Get-Content -LiteralPath $log | ForEach-Object { $_ | ConvertFrom-Json })
    $report.callback = $callbacks | Where-Object { $_.pid -eq $child.Id } | Select-Object -Last 1
    if (!$report.callback.patched -or !$report.callback.resumed) { throw 'No successful callback record for the isolated child' }
    & node (Join-Path $PSScriptRoot 'verify.mjs') $runDir
    if ($LASTEXITCODE -ne 0) { throw 'Renderer wallpaper verification failed' }
    $report.renderer = Get-Content -LiteralPath (Join-Path $runDir 'renderer-result.json') -Raw | ConvertFrom-Json
    $report.result = 'passed'
} catch {
    $report.error = $_.Exception.Message
} finally {
    if ($scope) { $scope.Dispose(); $report.checks.packageDebugDisabled = ($scope.CleanupResult -eq 0) }
    if ($child -and !$child.HasExited) {
        $current = Get-Process -Id $child.Id -ErrorAction SilentlyContinue
        if ($current -and $current.StartTime.ToUniversalTime() -eq $startedUtc) {
            & taskkill.exe /PID $child.Id /T /F | Out-Null
        } else { $report.error = 'Test PID identity changed; cleanup was skipped'; $report.result = 'failed' }
    }
    if (Test-Path -LiteralPath $log) { $report.callbacks = @(Get-Content -LiteralPath $log | ForEach-Object { $_ | ConvertFrom-Json }) }
    $preserved = $true
    foreach ($original in $existing) {
        $same = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $original.ProcessId) -ErrorAction SilentlyContinue
        if (!$same -or $same.CreationDate -ne $original.CreationDate) { $preserved = $false }
    }
    $report.checks.originalAppProcessesPreserved = $preserved
    $hashAfter = @((Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash, (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash)
    $report.checks.installedFilesUnchanged = (($hashBefore -join ',') -eq ($hashAfter -join ','))
    $report.checks.registrationAbsent = (@($keys | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0)
    if ($port) { $report.checks.testListenerClosed = (@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -eq $port).Count -eq 0) }
    if ($report.checks.Values -contains $false) { $report.result = 'failed' }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir 'report.json') -Encoding UTF8
    [ordered]@{ result=$report.result; report=(Join-Path $runDir 'report.json'); checks=$report.checks; error=$report.error } | ConvertTo-Json -Depth 8 -Compress
}
if ($report.result -ne 'passed') { exit 1 }
