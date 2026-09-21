[CmdletBinding()]
param(
    [string]$ProbePath = (Join-Path $PSScriptRoot 'conpty-probe.mjs'),
    [ValidateSet('driver', 'controller-flow', 'controller-force')]
    [string]$Scenario = 'driver',
    [ValidateRange(1000, 60000)]
    [int]$TimeoutMilliseconds = 10000,
    [string]$NodeExecutable,
    [switch]$EncodingFailureProbe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

if ($EncodingFailureProbe) {
    throw 'ConPTY UTF-8 diagnostic probe: 真实错误'
}

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'The ConPTY smoke gate requires PowerShell 7 or newer.'
}

if (-not $IsWindows) {
    Write-Output "CONPTY_SMOKE_SKIP platform=$([System.Runtime.InteropServices.RuntimeInformation]::OSDescription)"
    exit 0
}

$resolvedProbe = (Resolve-Path -LiteralPath $ProbePath).Path
$nativeSource = Join-Path $PSScriptRoot 'conpty-smoke-native.cs'
$screenSnapshotScript = (Resolve-Path -LiteralPath (
    Join-Path $PSScriptRoot 'conpty-screen-snapshot.mjs'
)).Path
$nodePath = if ([string]::IsNullOrWhiteSpace($NodeExecutable)) {
    (Get-Command node.exe -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source
} else {
    (Resolve-Path -LiteralPath $NodeExecutable).Path
}

if (-not ('DshConPtySmoke' -as [type])) {
    Add-Type -Path $nativeSource
}

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$logDirectory = Join-Path $temporaryRoot "dsh-tui-conpty-$([System.Guid]::NewGuid().ToString('N'))"
$temporaryPrefix = $temporaryRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $logDirectory.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to create a ConPTY log directory outside the OS temp root: $logDirectory"
}
[System.IO.Directory]::CreateDirectory($logDirectory) | Out-Null
$previousLogDirectory = [System.Environment]::GetEnvironmentVariable('DSH_CONPTY_LOG_DIR', 'Process')
try {
    [System.Environment]::SetEnvironmentVariable('DSH_CONPTY_LOG_DIR', $logDirectory, 'Process')
    $result = [DshConPtySmoke]::Run(
        $nodePath,
        $resolvedProbe,
        (Split-Path -Parent $resolvedProbe),
        $Scenario,
        $TimeoutMilliseconds
    )
}
finally {
    [System.Environment]::SetEnvironmentVariable('DSH_CONPTY_LOG_DIR', $previousLogDirectory, 'Process')
    if ([System.IO.Directory]::Exists($logDirectory)) {
        [System.IO.Directory]::Delete($logDirectory, $true)
    }
}
$temporaryCleanupConfirmed = -not [System.IO.Directory]::Exists($logDirectory)
$strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
try {
    $output = $strictUtf8.GetString($result.Output)
}
catch [System.Text.DecoderFallbackException] {
    throw 'ConPTY output was not valid UTF-8.'
}
if ($output.Contains([char]0xfffd)) {
    throw 'ConPTY output contained the Unicode replacement character U+FFFD.'
}

function Assert-Contains {
    param(
        [Parameter(Mandatory)] [string]$Haystack,
        [Parameter(Mandatory)] [string]$Needle
    )

    if (-not $Haystack.Contains($Needle, [System.StringComparison]::Ordinal)) {
        $escaped = $Haystack.Replace("`e", '<ESC>').Replace("`r", '<CR>').Replace("`n", '<LF>')
        throw "ConPTY output did not contain '$Needle'. Captured: $escaped"
    }
}

function Get-HexEvidence {
    param(
        [Parameter(Mandatory)] [string]$CapturedOutput,
        [Parameter(Mandatory)] [string]$Label
    )

    $escapedLabel = [System.Text.RegularExpressions.Regex]::Escape($Label)
    $chunks = [System.Collections.Generic.SortedDictionary[int, string]]::new()
    $chunkMatches = [System.Text.RegularExpressions.Regex]::Matches(
        $CapturedOutput,
        ('\[DSH-CONPTY\] {0}_HEX ([0-9]+):([0-9a-f]+)' -f $escapedLabel)
    )
    foreach ($match in $chunkMatches) {
        $chunkIndex = [int]$match.Groups[1].Value
        $chunkValue = $match.Groups[2].Value
        if ($chunks.ContainsKey($chunkIndex) -and $chunks[$chunkIndex] -ne $chunkValue) {
            throw "ConPTY returned conflicting $Label chunks for index $chunkIndex."
        }
        $chunks[$chunkIndex] = $chunkValue
    }

    $hex = [string]::Join('', $chunks.Values)
    $lengthMatch = [System.Text.RegularExpressions.Regex]::Match(
        $CapturedOutput,
        ('\[DSH-CONPTY\] {0}_DONE ([0-9]+)' -f $escapedLabel)
    )
    if (-not $lengthMatch.Success -or [int]$lengthMatch.Groups[1].Value -ne $hex.Length) {
        throw "ConPTY $Label byte evidence was incomplete."
    }
    return $hex
}

function Assert-InOrder {
    param(
        [Parameter(Mandatory)] [string]$CapturedOutput,
        [Parameter(Mandatory)] [string[]]$Markers
    )

    $previous = -1
    foreach ($marker in $Markers) {
        $position = $CapturedOutput.IndexOf(
            $marker,
            $previous + 1,
            [System.StringComparison]::Ordinal
        )
        if ($position -lt 0) {
            throw "ConPTY lifecycle omitted or reordered '$marker'."
        }
        $previous = $position
    }
}

function Get-ConPtyScreenSnapshot {
    param(
        [Parameter(Mandatory)] [byte[]]$Bytes,
        [Parameter(Mandatory)] [string]$Marker,
        [Parameter(Mandatory)] [int]$Columns,
        [Parameter(Mandatory)] [int]$Rows
    )

    $token = [System.Guid]::NewGuid().ToString('N')
    $capturePath = [System.IO.Path]::GetFullPath(
        (Join-Path $temporaryRoot "dsh-tui-conpty-capture-$token.bin")
    )
    $snapshotPath = [System.IO.Path]::GetFullPath(
        (Join-Path $temporaryRoot "dsh-tui-conpty-snapshot-$token.json")
    )
    foreach ($path in @($capturePath, $snapshotPath)) {
        if (-not $path.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to create a ConPTY snapshot file outside the OS temp root: $path"
        }
    }

    try {
        [System.IO.File]::WriteAllBytes($capturePath, $Bytes)
        & $nodePath `
            $screenSnapshotScript `
            $capturePath `
            $snapshotPath `
            $Marker `
            '80' `
            '24' `
            ([string]$Columns) `
            ([string]$Rows) *> $null
        $snapshotExitCode = $LASTEXITCODE
        if (-not [System.IO.File]::Exists($snapshotPath)) {
            throw "Headless terminal snapshot did not produce a result (exit $snapshotExitCode)."
        }
        $snapshot = [System.IO.File]::ReadAllText($snapshotPath, $strictUtf8) |
            ConvertFrom-Json
        if ($snapshotExitCode -ne 0 -or $snapshot.ok -ne $true) {
            throw "Headless terminal snapshot failed: $($snapshot.error)"
        }
        return $snapshot
    }
    finally {
        foreach ($path in @($capturePath, $snapshotPath)) {
            if ([System.IO.File]::Exists($path)) {
                [System.IO.File]::Delete($path)
            }
        }
    }
}

$escape = [char]0x1b
$ready = '[DSH-CONPTY] READY 80x24'
$resized = '[DSH-CONPTY] RESIZE 100x30'
$recoveryPrefix = '[DSH-CONPTY] RECOVERY_HEX '
$recoveryDone = '[DSH-CONPTY] RECOVERY_DONE '
$restorePrefix = '[DSH-CONPTY] RESTORE_HEX '
$restoreDone = '[DSH-CONPTY] RESTORE_DONE '
$recoveryMatch = '[DSH-CONPTY] RECOVERY_MATCH exact'
$restored = '[DSH-CONPTY] RESTORED'

Assert-Contains -Haystack $output -Needle $ready
Assert-Contains -Haystack $output -Needle $resized
Assert-Contains -Haystack $output -Needle $recoveryPrefix
Assert-Contains -Haystack $output -Needle $recoveryDone
Assert-Contains -Haystack $output -Needle $restorePrefix
Assert-Contains -Haystack $output -Needle $restoreDone
Assert-Contains -Haystack $output -Needle $recoveryMatch
Assert-Contains -Haystack $output -Needle $restored

$recoveryHex = Get-HexEvidence -CapturedOutput $output -Label 'RECOVERY'
$restoreHex = Get-HexEvidence -CapturedOutput $output -Label 'RESTORE'
if (-not $restoreHex.EndsWith($recoveryHex, [System.StringComparison]::Ordinal)) {
    throw "Product TerminalDriver restore did not end with its exported recovery contract. Captured hex: $restoreHex"
}

$recoveryText = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromHexString($recoveryHex)
)
$requiredRecoveryOrder = @(
    "${escape}[?2026l"
    "${escape}[0m"
    "${escape}[?2004l"
    "${escape}[?7h"
    "${escape}[?1049l"
    "${escape}[?25h"
)
$previousRecoveryEnd = 0
foreach ($sequence in $requiredRecoveryOrder) {
    $position = $recoveryText.IndexOf(
        $sequence,
        $previousRecoveryEnd,
        [System.StringComparison]::Ordinal
    )
    if ($position -lt 0) {
        throw "Exported product recovery contract omitted or reordered '$sequence'."
    }
    $previousRecoveryEnd = $position + $sequence.Length
}

$setupSequences = @(
    "${escape}[?1049h"
    "${escape}[?2004h"
    "${escape}[?2026h"
)
foreach ($sequence in $setupSequences) {
    Assert-Contains -Haystack $output -Needle $sequence
}

$shutdownMode = 'driver'
$shutdownAnchor = '[DSH-CONPTY] CTRL_C'
switch ($Scenario) {
    'controller-flow' {
        $shutdownMode = 'graceful'
        $shutdownAnchor = '[DSH-CONPTY] LIFECYCLE stop-input'
        $prompt = 'ConPTY 真实输入'
        $promptHex = [System.Convert]::ToHexString(
            [System.Text.Encoding]::UTF8.GetBytes($prompt)
        ).ToLowerInvariant()
        Assert-Contains -Haystack $output -Needle "[DSH-CONPTY] SUBMIT_EVIDENCE delivery=followup text_hex=$promptHex"
        $screen = Get-ConPtyScreenSnapshot `
            -Bytes $result.Output `
            -Marker '[DSH-CONPTY] FLOW_READY_TO_EXIT' `
            -Columns 100 `
            -Rows 30
        if ($screen.bufferType -ne 'alternate') {
            throw "ConPTY flow snapshot was not in the alternate buffer: $($screen.bufferType)"
        }
        $screenText = [string]::Join("`n", [string[]]$screen.lines)
        Assert-Contains -Haystack $screenText -Needle "› $prompt"
        Assert-Contains -Haystack $screenText -Needle '✓ Completed 1 execution step · request succeeded · Ctrl+O for details'
        Assert-Contains -Haystack $screenText -Needle 'durable assistant complete'
        if ($screenText.Contains('durable assistant draft') -or $screenText.Contains('TOOLS · 1')) {
            throw 'Compact ConPTY screen leaked intermediate or legacy Tool detail output.'
        }
        Assert-Contains -Haystack $output -Needle '[DSH-CONPTY] DURABLE_SEQS 0,1,2,3,4,5,6,7'
        Assert-Contains -Haystack $output -Needle '[DSH-CONPTY] APP_EXIT request restore=exact'
        Assert-Contains -Haystack $output -Needle '[DSH-CONPTY] CONTROLLER_RESULT ok=true reason=user shutdown=graceful'
        Assert-Contains -Haystack $output -Needle '[DSH-CONPTY] COUNTS submit=1 cancel=1 settle=1 whenIdle=1 flush=1 dispose=1 requestExit=1 forceExit=0'
        Assert-InOrder -CapturedOutput $output -Markers @(
            '[DSH-CONPTY] LIFECYCLE stop-input'
            '[DSH-CONPTY] LIFECYCLE settle-interactions'
            '[DSH-CONPTY] LIFECYCLE cancel-agent kind=user'
            '[DSH-CONPTY] LIFECYCLE when-idle'
            '[DSH-CONPTY] LIFECYCLE flush-session'
            '[DSH-CONPTY] LIFECYCLE dispose-runtime'
            '[DSH-CONPTY] LIFECYCLE restore-terminal'
            '[DSH-CONPTY] APP_EXIT request restore=exact'
            '[DSH-CONPTY] LIFECYCLE request-app-exit'
        )
        if (-not $result.PromptInputWritten) {
            throw 'Native ConPTY host did not confirm raw UTF-8 prompt + CR input.'
        }
    }
    'controller-force' {
        $shutdownMode = 'forced'
        $shutdownAnchor = '[DSH-CONPTY] LIFECYCLE stop-input'
        Assert-Contains -Haystack $output -Needle '[DSH-CONPTY] WHEN_IDLE_BLOCKED'
        Assert-Contains -Haystack $output -Needle '[DSH-CONPTY] QUIESCING_INPUT submit=0'
        Assert-Contains -Haystack $output -Needle '[DSH-CONPTY] APP_EXIT force restore=exact'
        Assert-Contains -Haystack $output -Needle '[DSH-CONPTY] CONTROLLER_RESULT ok=false reason=forced shutdown=forced'
        Assert-Contains -Haystack $output -Needle '[DSH-CONPTY] COUNTS submit=0 cancel=1 settle=1 whenIdle=1 flush=0 dispose=0 requestExit=0 forceExit=1'
        Assert-InOrder -CapturedOutput $output -Markers @(
            '[DSH-CONPTY] LIFECYCLE stop-input'
            '[DSH-CONPTY] LIFECYCLE settle-interactions'
            '[DSH-CONPTY] LIFECYCLE cancel-agent kind=user'
            '[DSH-CONPTY] LIFECYCLE when-idle'
            '[DSH-CONPTY] WHEN_IDLE_BLOCKED'
            '[DSH-CONPTY] LIFECYCLE restore-terminal'
            '[DSH-CONPTY] APP_EXIT force restore=exact'
            '[DSH-CONPTY] LIFECYCLE force-exit'
        )
        if (-not $result.QuiescingInputWritten) {
            throw 'Native ConPTY host did not confirm ordinary input during quiescing.'
        }
    }
    default {
        Assert-Contains -Haystack $output -Needle $shutdownAnchor
    }
}

$shutdownPosition = $output.IndexOf($shutdownAnchor, [System.StringComparison]::Ordinal)
$restoreSequences = @(
    "${escape}[?2026l"
    "${escape}[?2004l"
    "${escape}[?1049l"
    "${escape}[?25h"
)
$previousRestorePosition = $shutdownPosition
foreach ($sequence in $restoreSequences) {
    $position = $output.IndexOf($sequence, $previousRestorePosition, [System.StringComparison]::Ordinal)
    if ($position -lt 0) {
        throw "ConPTY did not expose restoration behavior '$sequence' after Ctrl+C."
    }
    $previousRestorePosition = $position
}

Assert-InOrder -CapturedOutput $output -Markers @(
    $ready
    $resized
    $shutdownAnchor
    $restorePrefix
    $restored
)

if ($result.ExitCode -ne 0) {
    throw "ConPTY child exited with code $($result.ExitCode)."
}
if (-not $result.ProcessGone) {
    throw "ConPTY child process $($result.ProcessId) remained active after teardown."
}
if (-not $result.OutputPipeClosed) {
    throw 'ConPTY output pipe did not close after pseudoconsole teardown.'
}
if (-not $result.NativeHandlesClosed) {
    throw 'ConPTY native process, pipe, attribute, or pseudoconsole handles were not all closed.'
}
if (Get-Process -Id $result.ProcessId -ErrorAction SilentlyContinue) {
    throw "ConPTY child process $($result.ProcessId) is still visible after handle cleanup."
}
if (-not $temporaryCleanupConfirmed) {
    throw "ConPTY temporary log directory remained after teardown: $logDirectory"
}

Write-Output "CONPTY_SMOKE_OK scenario=$Scenario shutdown=$shutdownMode initial=80x24 resized=100x30 pid=$($result.ProcessId) exit=$($result.ExitCode) process=gone pipe=closed handles=closed temp=confirmed bytes=$($result.Output.Length)"
