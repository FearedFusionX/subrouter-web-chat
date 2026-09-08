# desktop/native/build.ps1
#
# Builds the portable WPF/WebView2 shell (desktop/native/SubrouterNative) as a
# self-contained, single-file win-x64 executable, then bundles the machine's
# currently-installed node.exe alongside it (there is no offline way to fetch
# a pinned Node distribution here, so this vendors whatever `node --version`
# reports below - worth revisiting if a reproducible/offline build matters).
#
# Usage:  pwsh desktop/native/build.ps1
param(
    [string]$Configuration = "Release",
    [string]$Runtime = "win-x64"
)
$ErrorActionPreference = "Stop"

$nativeDir = $PSScriptRoot
$project = Join-Path $nativeDir "SubrouterNative\SubrouterNative.csproj"
$publishDir = Join-Path $nativeDir "publish"

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "node.exe not found on PATH; cannot bundle a backend runtime." }
$nodeVersion = (& $nodeCmd.Source --version).Trim()
Write-Host "Bundling node.exe from $($nodeCmd.Source) ($nodeVersion)"

$icoPath = Join-Path $nativeDir "SubrouterNative\Assets\icon.ico"
if (-not (Test-Path $icoPath)) {
    Write-Host "No icon.ico found - rendering it from public/icon.svg first..."
    & (Join-Path $nativeDir "tools\make-icon.ps1")
}

if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }

dotnet publish $project -c $Configuration -r $Runtime --self-contained true -o $publishDir
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)" }

$nodeDir = Join-Path $publishDir "node"
New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
Copy-Item $nodeCmd.Source (Join-Path $nodeDir "node.exe") -Force

$exePath = Join-Path $publishDir "Subrouter.exe"
if (-not (Test-Path $exePath)) { throw "Publish completed but $exePath was not produced." }

Write-Host ""
Write-Host "Portable build ready: $exePath"
Write-Host "Bundled node.exe: $nodeVersion"
