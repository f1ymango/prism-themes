param([Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'common.ps1')
$probe=Join-Path $workspace ('.prism-probe\p'+[Guid]::NewGuid().ToString('N').Substring(0,8))
$extracted=Join-Path $probe (([string][char]0x6e90)+' code')
$fixture=Join-Path $probe ('install '+[char]0x754c)
New-Item -ItemType Directory -Path $extracted -Force|Out-Null
$package=Get-AppxPackage -Name OpenAI.Codex|Sort-Object Version -Descending|Select-Object -First 1
$runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
function PersonalRegistrations {
 $callbacks=@();foreach($key in (Get-PrismDebugKeys $package.PackageFullName)){if(Test-Path -LiteralPath $key){$callbacks+=,(Get-Item -LiteralPath $key).GetValue('')}else{$callbacks+=,$null}}
 [ordered]@{callbacks=$callbacks;startup=(Get-ItemProperty -LiteralPath $runKey -Name PrismChatGPTWallpaper -ErrorAction SilentlyContinue).PrismChatGPTWallpaper}|ConvertTo-Json -Compress
}
$personalBefore=PersonalRegistrations
$report=[ordered]@{result='failed';checks=[ordered]@{};error=$null}
$source=$null
try{
 Expand-Archive -LiteralPath $Archive -DestinationPath $extracted
 $source=(Get-ChildItem -LiteralPath $extracted -Directory|Select-Object -First 1).FullName
 $manifest=Get-Content -LiteralPath (Join-Path $source 'source-manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
 foreach($entry in $manifest.files){if((Get-PrismFileHash (Join-Path $source $entry.path)) -ne $entry.sha256){throw ('Archive hash mismatch: '+$entry.path)}}
 if(@(Get-ChildItem -LiteralPath $source -File -Recurse).Count -ne @($manifest.files).Count+1){throw 'Archive contains unexpected files'}
 $report.checks.archiveManifestVerified=$true
 Push-Location -LiteralPath $source
 try{& node.exe --test (Get-ChildItem -LiteralPath test -Filter '*.test.mjs').FullName;if($LASTEXITCODE -ne 0){throw 'Extracted source tests failed'}}finally{Pop-Location}
 $report.checks.extractedSourceTests=$true
 $arguments=@{InstallRoot=$fixture;NoStartup=$true;NoSkill=$true;NoHook=$true;TestProfile=(Join-Path $fixture 'profile');TestBackend=(Join-Path $fixture 'backend');MaxSeconds=90;Image=(Join-Path $source 'assets\prism-night.png')}
 & (Join-Path $source 'scripts\native\install.ps1') @arguments
 $installation=Read-PrismInstallation $fixture
 if(!$installation.enabled -or !$installation.testNoHook){throw 'Isolated installation did not become enabled'}
 $first=Get-Content -LiteralPath (Join-Path $fixture 'state\worker.json') -Raw -Encoding UTF8|ConvertFrom-Json
 $report.checks.nonAsciiInstallation=$true
 & (Join-Path $source 'scripts\native\install.ps1') @arguments
 $second=Get-Content -LiteralPath (Join-Path $fixture 'state\worker.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($first.pid -ne $second.pid -or $first.created -ne $second.created){throw 'Repeated extracted setup replaced the live fixture worker'}
 $report.checks.idempotentSetup=$true
 & (Join-Path $source 'scripts\native\remove.ps1') -InstallRoot $fixture -NoStartup
 if((Read-PrismInstallation $fixture).enabled){throw 'Fixture removal did not disable the installation'}
 $report.checks.isolatedRemoval=$true
 $report.result='passed'
}catch{$report.error=$_.Exception.Message}
finally{
 if($source -and (Test-Path -LiteralPath (Join-Path $fixture 'installation.json'))){try{if((Read-PrismInstallation $fixture).enabled){& (Join-Path $source 'scripts\native\remove.ps1') -InstallRoot $fixture -NoStartup|Out-Null}}catch{$report.error=[string]$report.error+'; cleanup: '+$_.Exception.Message;$report.result='failed'}}
 $report.checks.personalRegistrationsPreserved=($personalBefore -eq (PersonalRegistrations))
 if(!$report.checks.personalRegistrationsPreserved){$report.result='failed'}
 Write-PrismJson (Join-Path $probe 'package-report.json') $report
 $report|ConvertTo-Json -Depth 6 -Compress
}
if($report.result -ne 'passed'){exit 1}
