$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'VERSION') -Raw).Trim()
if ($version -notmatch '^[0-9A-Za-z.+-]+$') { throw 'Invalid VERSION' }
$source = Join-Path $projectRoot 'release\win-unpacked'
if (-not (Test-Path -LiteralPath (Join-Path $source 'Stack Junkie Paint.exe'))) { throw 'Run npm run package:windows first.' }
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stage = Join-Path $tempRoot ('sj-paint-package-' + [guid]::NewGuid().ToString('N'))
try {
    $appStage = Join-Path $stage 'sj-paint'
    New-Item -ItemType Directory -Path $appStage | Out-Null
    Get-ChildItem -LiteralPath $source | Copy-Item -Destination $appStage -Recurse
    foreach ($name in @('README.md','PARITY.md','LICENSE','ATTRIBUTION.md','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md','docs')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $appStage -Recurse
    }
    $archiveName = "sj-paint-$version-windows-x64.zip"
    $archive = Join-Path $projectRoot "release\$archiveName"
    Compress-Archive -LiteralPath $appStage -DestinationPath $archive -Force
    $stream = [IO.File]::OpenRead($archive)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha256.Dispose() }
    [IO.File]::WriteAllText("$archive.sha256", "$digest  $archiveName`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Created release/$archiveName and its SHA-256 checksum"
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if (-not $resolvedStage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $resolvedStage -Leaf) -notlike 'sj-paint-package-*') { throw 'Refusing unsafe staging cleanup.' }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
