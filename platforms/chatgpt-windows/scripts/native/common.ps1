$ErrorActionPreference = 'Stop'
function Get-PrismFileHash([string]$Path) {
    $stream=[IO.File]::OpenRead($Path)
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose();$stream.Dispose() }
}
function Read-PrismInstallation([string]$Root) {
    $absolute = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $marker = Get-Content -LiteralPath (Join-Path $absolute 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($marker.product -ne 'prism-chatgpt' -or $marker.schema -ne 1 -or $marker.sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $marker.root -ne $absolute) { throw 'Installation ownership check failed' }
    if ((Get-Item -LiteralPath $absolute).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation root must not be a reparse point' }
    return $marker
}
function Get-PrismDebugKeys([string]$Package) {
    if ($Package -notmatch '^OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0$') { throw 'Unsupported package name' }
    @(
        ('Registry::HKEY_CURRENT_USER\Software\Classes\ActivatableClasses\Package\' + $Package + '\DebugInformation'),
        ('Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\PackagedAppXDebug\' + $Package)
    )
}
function Test-PrismHookOwnership([string]$Package, [string]$Expected) {
    $found=$false
    foreach ($key in (Get-PrismDebugKeys $Package)) {
        if (Test-Path -LiteralPath $key) {
            if ((Get-Item -LiteralPath $key).GetValue('') -ne $Expected) { throw 'Another package debugger is installed; it was preserved' }
            $found=$true
        }
    }
    return $found
}
function Write-PrismJson([string]$Path, $Value) {
    $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    try {
        for($attempt=0;$true;$attempt++) {
            try {
                if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) } else { [IO.File]::Move($temporary,$Path) }
                break
            } catch {
                if($attempt -ge 7 -or ($_.Exception.InnerException -isnot [IO.IOException] -and $_.Exception.InnerException -isnot [UnauthorizedAccessException])) { throw }
                Start-Sleep -Milliseconds (20 * [Math]::Pow(2,[Math]::Min($attempt,3)))
            }
        }
    } finally { if(Test-Path -LiteralPath $temporary){[IO.File]::Delete($temporary)} }
}
function Stop-PrismWorker([string]$Root, $Installation) {
    $state=Join-Path $Root 'state'
    [IO.File]::WriteAllText((Join-Path $state 'stop'),$Installation.id)
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    do {
        $alive=$false
        foreach ($name in @('worker.json','supervisor.json')) {
            $statusPath=Join-Path $state $name
            if (Test-Path -LiteralPath $statusPath) {
                $status=Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $process=Get-Process -Id $status.pid -ErrorAction SilentlyContinue
                if ($process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $status.created) { $alive=$true }
            }
        }
        if (!$alive) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($alive) { throw 'Helpers did not stop gracefully; no app processes were terminated' }
}
