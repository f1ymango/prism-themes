param([Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$SourceRoot,[switch]$ForceCheck)
. (Join-Path $PSScriptRoot 'common.ps1')
$package=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (!$package -or $package.PackageFullName -notmatch '^OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0$') { throw 'The registered app identity or architecture is unsupported' }
$image=Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$candidate=[pscustomobject]@{package=$package.PackageFullName;image=$image;executableSha256=(Get-PrismFileHash $image);archiveSha256=(Get-PrismFileHash (Join-Path $package.InstallLocation 'app\resources\app.asar'))}
$baseline=Get-Content -LiteralPath (Join-Path $SourceRoot 'native\supported-build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$approved=(!$ForceCheck -and $candidate.package -eq $baseline.package -and $candidate.executableSha256 -eq $baseline.executableSha256 -and $candidate.archiveSha256 -eq $baseline.archiveSha256)
$cachePath=Join-Path $InstallRoot 'state\builds.json'
if ($approved) { $candidate | Add-Member -NotePropertyName compatibilitySource -NotePropertyValue 'verified-cache';return $candidate }
$artifacts=Join-Path ([IO.Path]::GetTempPath()) ('Prism-build-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $artifacts | Out-Null
$inputPath=Join-Path $artifacts 'candidate.json'
$output=Join-Path $artifacts 'approval.json'
Write-PrismJson $inputPath $candidate
$node=Join-Path $InstallRoot 'runtime\node.exe'
if (!(Test-Path -LiteralPath $node)) { $node=(Get-Command node).Source }
if (!$ForceCheck -and (Test-Path -LiteralPath $cachePath)) {
    $lookup=& $node (Join-Path $SourceRoot 'scripts\native\build-cache.mjs') --cache $cachePath --candidate $inputPath
    if ($LASTEXITCODE -ne 0) { throw 'Build approval cache could not be validated' }
    if (($lookup | ConvertFrom-Json).approved) { $candidate | Add-Member -NotePropertyName compatibilitySource -NotePropertyValue 'verified-cache';return $candidate }
}
& $node (Join-Path $SourceRoot 'scripts\native\check-build.mjs') --candidate $inputPath --artifacts (Join-Path $artifacts 'session') --asset (Join-Path $SourceRoot 'assets\prism-night.png') --output $output | Out-Host
if ($LASTEXITCODE -ne 0) { $failure=Get-Content -LiteralPath $output -Raw -Encoding UTF8 | ConvertFrom-Json;throw ('App compatibility check failed: '+$failure.error) }
$proof=Get-Content -LiteralPath $output -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$proof.passed -or !$proof.checks.restored -or !$proof.checks.imageVisible -or !$proof.checks.listenerClosed) { throw 'The renderer compatibility proof did not pass' }
$candidate | Add-Member -NotePropertyName compatibilitySource -NotePropertyValue 'isolated-probe'
$candidate | Add-Member -NotePropertyName approval -NotePropertyValue $proof
$candidate | Add-Member -NotePropertyName approvalPath -NotePropertyValue $output
return $candidate
