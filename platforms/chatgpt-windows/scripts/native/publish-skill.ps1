param([string]$InstallRoot=(Join-Path $env:LOCALAPPDATA 'PrismChatGPT'),[string]$BackupDirectory='')
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$skillRoot=Join-Path $env:USERPROFILE '.codex\skills\prism'
$skillFile=Join-Path $skillRoot 'SKILL.md'
if (Test-Path -LiteralPath $skillFile) {
    $previous=Get-Content -LiteralPath $skillFile -Raw -Encoding UTF8
    if ($previous -notmatch '# Prism (command probe|desktop wallpaper)') { throw 'A different Prism skill was preserved' }
    if ($BackupDirectory) {
        New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
        $backup=Join-Path $BackupDirectory 'skill-before.md'
        if (!(Test-Path -LiteralPath $backup)) { [IO.File]::WriteAllText($backup,$previous,[Text.UTF8Encoding]::new($false)) }
    }
}
New-Item -ItemType Directory -Path (Join-Path $skillRoot 'agents') -Force | Out-Null
$skill=(Get-Content -LiteralPath (Join-Path $source 'native\prism-skill.md') -Raw -Encoding UTF8).Replace('__PRISM_INSTALL_ROOT__',$InstallRoot).Replace('__PRISM_SOURCE_ROOT__',$source)
[IO.File]::WriteAllText($skillFile,$skill,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $skillRoot 'agents\openai.yaml'),('interface:'+"`n"+'  display_name: "Prism"'+"`n"+'  short_description: "Set and manage wallpaper inside ChatGPT"'+"`n"+'  default_prompt: "Use $prism to show wallpaper status."'+"`n"),[Text.UTF8Encoding]::new($false))
