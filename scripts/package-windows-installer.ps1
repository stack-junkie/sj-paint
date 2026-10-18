$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    $version = (Get-Content -LiteralPath VERSION -Raw).Trim()
    if ($version -notmatch '^[0-9A-Za-z.+-]+$') { throw 'Invalid VERSION' }
    if (-not (Test-Path -LiteralPath 'release/win-unpacked/Stack Junkie Paint.exe')) {
        throw 'Run npm run package:windows before creating the installer.'
    }
    $packagedVersion = & node --input-type=module -e "import {extractFile} from '@electron/asar'; console.log(JSON.parse(extractFile('release/win-unpacked/resources/app.asar', 'package.json')).version)"
    if ($LASTEXITCODE -ne 0 -or $packagedVersion -ne $version) {
        throw 'The packaged app version differs from VERSION. Run npm run package:windows first.'
    }
    # Wrap the same application payload used by the portable package and checks.
    & node node_modules/electron-builder/cli.js --win nsis --x64 --prepackaged release/win-unpacked --publish never
    if ($LASTEXITCODE -ne 0) { throw "Installer build failed ($LASTEXITCODE)." }
    $name = "sj-paint-$version-windows-x64-setup.exe"
    $installer = Join-Path $projectRoot "release/$name"
    $stream = [IO.File]::OpenRead($installer)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
    [IO.File]::WriteAllText("$installer.sha256", "$digest  $name`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Created release/$name and its SHA-256 checksum"
} finally { Pop-Location }
