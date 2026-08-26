param(
    [ValidatePattern('^[a-zA-Z0-9._-]+$')]
    [string]$Profile = 'tui',
    [string]$HarnessRoot = (Join-Path $PSScriptRoot '..\..\deepseek-harness'),
    [switch]$Launch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$resolvedHarness = (Resolve-Path -LiteralPath $HarnessRoot).Path
$cliPath = Join-Path $resolvedHarness 'apps\cli\lib\bin.js'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "Built DSH CLI not found at $cliPath. Build deepseek-harness first."
}

$packOutput = & pnpm run pack:local
if ($LASTEXITCODE -ne 0) {
    throw "DSH-TUI local pack failed with exit code $LASTEXITCODE."
}
$tarballLine = $packOutput | Where-Object { $_ -like 'DSH_TUI_TARBALL=*' } | Select-Object -Last 1
if ($null -eq $tarballLine) {
    throw 'Local pack did not report its content-addressed tarball.'
}
$tarball = $tarballLine.Substring('DSH_TUI_TARBALL='.Length)
if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) {
    throw "Local tarball does not exist: $tarball"
}

& node $cliPath plugin --profile $Profile add --force --prefer-offline $tarball
if ($LASTEXITCODE -ne 0) {
    throw "DSH profile installation failed with exit code $LASTEXITCODE."
}

$dshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
} else {
    $env:DSH_HOME
}
$installedRoot = Join-Path $dshHome "profiles\$Profile\node_modules\dsh-tui"
& node (Join-Path $PSScriptRoot 'verify-installed-package.mjs') $projectRoot $installedRoot
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
