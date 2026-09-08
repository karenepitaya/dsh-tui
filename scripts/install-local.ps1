param(
    [ValidatePattern('^[a-zA-Z0-9._-]+$')]
    [string]$Profile = 'tui',
    [string]$HarnessRoot = (Join-Path $PSScriptRoot '..\..\deepseek-harness'),
    [switch]$Launch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$orbsRoot = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'packages\pi-tui-orbs')).Path
$resolvedHarness = (Resolve-Path -LiteralPath $HarnessRoot).Path
$cliPath = Join-Path $resolvedHarness 'apps\cli\lib\bin.js'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "Built DSH CLI not found at $cliPath. Build deepseek-harness first."
}

$packOutput = & pnpm --dir $projectRoot run pack:local
if ($LASTEXITCODE -ne 0) {
    throw "DSH-TUI local pack failed with exit code $LASTEXITCODE."
}
$tarballLine = $packOutput | Where-Object { $_ -like 'DSH_TUI_TARBALL=*' } | Select-Object -Last 1
$orbsTarballLine = $packOutput | Where-Object { $_ -like 'DSH_TUI_ORBS_TARBALL=*' } | Select-Object -Last 1
if ($null -eq $tarballLine) {
    throw 'Local pack did not report its content-addressed tarball.'
}
if ($null -eq $orbsTarballLine) {
    throw 'Local pack did not report the pi-tui-orbs companion tarball.'
}
$tarball = $tarballLine.Substring('DSH_TUI_TARBALL='.Length)
$orbsTarball = $orbsTarballLine.Substring('DSH_TUI_ORBS_TARBALL='.Length)
if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) {
    throw "Local tarball does not exist: $tarball"
}
if (-not (Test-Path -LiteralPath $orbsTarball -PathType Leaf)) {
    throw "pi-tui-orbs tarball does not exist: $orbsTarball"
}

& node $cliPath plugin --profile $Profile add --force --prefer-offline $orbsTarball $tarball
if ($LASTEXITCODE -ne 0) {
    throw "DSH profile installation failed with exit code $LASTEXITCODE."
}

$dshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
} else {
    $env:DSH_HOME
}
$installedRoot = Join-Path $dshHome "profiles\$Profile\node_modules\dsh-tui"
$installedOrbsRoot = Join-Path $dshHome "profiles\$Profile\node_modules\pi-tui-orbs"
if (-not (Test-Path -LiteralPath $installedOrbsRoot -PathType Container)) {
    throw "Installed pi-tui-orbs package is missing: $installedOrbsRoot"
}
$installedOrbsPackage = Get-Content -LiteralPath (Join-Path $installedOrbsRoot 'package.json') -Raw |
    ConvertFrom-Json
$sourceOrbsPackage = Get-Content -LiteralPath (Join-Path $orbsRoot 'package.json') -Raw |
    ConvertFrom-Json
if ($installedOrbsPackage.name -ne $sourceOrbsPackage.name -or
    $installedOrbsPackage.version -ne $sourceOrbsPackage.version) {
    throw "Unexpected pi-tui-orbs package identity: $($installedOrbsPackage.name)@$($installedOrbsPackage.version)"
}
& node (Join-Path $PSScriptRoot 'verify-installed-package.mjs') `
    $projectRoot $installedRoot $orbsRoot $installedOrbsRoot
if ($LASTEXITCODE -ne 0) {
    throw "Installed package verification failed with exit code $LASTEXITCODE."
}

$startCommand = "node `"$cliPath`" --profile $Profile"
Write-Output "Start with: $startCommand"
if ($Launch) {
    Write-Output "DSH_TUI_LAUNCH profile=$Profile"
    & node $cliPath --profile $Profile
    if ($LASTEXITCODE -ne 0) {
        throw "DSH profile exited with code $LASTEXITCODE."
    }
}
