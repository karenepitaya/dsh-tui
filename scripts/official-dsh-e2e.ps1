[CmdletBinding()]
param(
    [string]$DshTuiRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$HarnessRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '..\deepseek-harness'),
    [ValidateRange(1000, 300000)]
    [int]$TimeoutMilliseconds = 90000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'The official DSH-TUI E2E gate requires PowerShell 7 or newer.'
}

if (-not $IsWindows) {
    Write-Output "OFFICIAL_DSH_E2E_SKIP platform=$([System.Runtime.InteropServices.RuntimeInformation]::OSDescription)"
    exit 0
}

$resolvedDshTuiRoot = (Resolve-Path -LiteralPath $DshTuiRoot).Path
$resolvedHarnessRoot = (Resolve-Path -LiteralPath $HarnessRoot).Path
$runnerPath = Join-Path $PSScriptRoot 'official-dsh-e2e.mjs'
$nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop |
    Select-Object -First 1).Source
$corepackCommand = Get-Command corepack.cmd -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($null -ne $corepackCommand) {
    $packageManagerPath = $corepackCommand.Source
    $packageManagerPrefix = @('pnpm')
}
else {
    $packageManagerPath = (Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source
    $packageManagerPrefix = @()
}

function Assert-ProjectName {
    param(
        [Parameter(Mandatory)] [string]$Root,
        [Parameter(Mandatory)] [string]$Expected
    )

    $manifestPath = Join-Path $Root 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Missing package manifest: $manifestPath"
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.name -ne $Expected) {
        throw "Expected package $Expected at $Root, found $($manifest.name)."
    }
}

function Test-BuildRequired {
    param(
        [Parameter(Mandatory)] [string]$Root,
        [Parameter(Mandatory)] [string[]]$Artifacts,
        [Parameter(Mandatory)] [string[]]$SourceDirectories
    )

    $resolvedArtifacts = foreach ($artifact in $Artifacts) {
        Join-Path $Root $artifact
    }
    foreach ($artifact in $resolvedArtifacts) {
        if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
            return $true
        }
    }

    $oldestArtifact = $resolvedArtifacts |
        ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } |
        Sort-Object |
        Select-Object -First 1
    foreach ($sourceDirectory in $SourceDirectories) {
        $sourceRoot = Join-Path $Root $sourceDirectory
        if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
            continue
        }
        $newerSource = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File |
            Where-Object {
                $_.FullName -notmatch '[\\/]node_modules[\\/]' -and
                $_.FullName -notmatch '[\\/]lib[\\/]' -and
                ($_.Extension -in @('.ts', '.json', '.yml', '.yaml')) -and
                $_.LastWriteTimeUtc -gt $oldestArtifact
            } |
            Select-Object -First 1
        if ($null -ne $newerSource) {
            return $true
        }
    }
    return $false
}

function Invoke-ProjectBuild {
    param(
        [Parameter(Mandatory)] [string]$Root,
        [Parameter(Mandatory)] [string]$Label
    )

    Write-Output "OFFICIAL_DSH_E2E_BUILD target=$Label action=build"
    Push-Location -LiteralPath $Root
    try {
        & $packageManagerPath @packageManagerPrefix run build
        if ($LASTEXITCODE -ne 0) {
            throw "$Label build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

Assert-ProjectName -Root $resolvedDshTuiRoot -Expected 'dsh-tui'
Assert-ProjectName -Root $resolvedHarnessRoot -Expected '@deepseek-ai/dsh-root'
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "Missing official E2E runner: $runnerPath"
}

$harnessArtifacts = @(
    'apps\cli\lib\bin.js'
    'packages\boot\app-boot\lib\index.js'
    'packages\bundle\base\lib\index.js'
    'packages\core\agent-loop\lib\index.js'
    'packages\llm\llm-deepseek\lib\index.js'
    'packages\session\session-persistence-jsonl\lib\index.js'
)
$harnessNeedsBuild = Test-BuildRequired `
    -Root $resolvedHarnessRoot `
    -Artifacts $harnessArtifacts `
    -SourceDirectories @('apps', 'packages')
if ($harnessNeedsBuild) {
    throw 'Harness artifacts are missing or stale. Build deepseek-harness explicitly before the DSH-TUI read-only gate.'
}
else {
    Write-Output 'OFFICIAL_DSH_E2E_BUILD target=harness action=reuse'
}

$dshTuiArtifacts = @(
    'lib\index.js'
    'lib\plugin.js'
    'lib\app\controller.js'
    'lib\terminal\driver.js'
)
$dshTuiNeedsBuild = Test-BuildRequired `
    -Root $resolvedDshTuiRoot `
    -Artifacts $dshTuiArtifacts `
    -SourceDirectories @('src')
if ($dshTuiNeedsBuild) {
    Invoke-ProjectBuild -Root $resolvedDshTuiRoot -Label 'dsh-tui'
}
else {
    Write-Output 'OFFICIAL_DSH_E2E_BUILD target=dsh-tui action=reuse'
}

foreach ($artifact in $harnessArtifacts) {
    $artifactPath = Join-Path $resolvedHarnessRoot $artifact
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
        throw "Harness build omitted required artifact: $artifactPath"
    }
}
foreach ($artifact in $dshTuiArtifacts) {
    $artifactPath = Join-Path $resolvedDshTuiRoot $artifact
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
        throw "DSH-TUI build omitted required artifact: $artifactPath"
    }
}

& $nodePath $runnerPath `
    --harness-root $resolvedHarnessRoot `
    --dsh-tui-root $resolvedDshTuiRoot `
    --timeout-ms $TimeoutMilliseconds
if ($LASTEXITCODE -ne 0) {
    throw "Official DSH-TUI E2E runner failed with exit code $LASTEXITCODE."
}
