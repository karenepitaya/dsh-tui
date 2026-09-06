import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const marker = '[DSH-CONPTY] FLOW_READY_TO_EXIT'
const helperPath = fileURLToPath(
  new URL('../scripts/conpty-screen-snapshot.mjs', import.meta.url),
)

interface SnapshotResult {
  readonly ok: boolean
  readonly bufferType?: string
  readonly lines?: readonly string[]
  readonly error?: string
}

async function inspectCapture(bytes: Uint8Array, expectedMarker = marker): Promise<{
  readonly exitCode: number
  readonly snapshot: SnapshotResult
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-screen-snapshot-'))
  const capturePath = join(directory, 'capture.bin')
  const resultPath = join(directory, 'result.json')
  try {
    await writeFile(capturePath, bytes)
    const exitCode = await new Promise<number>((resolve) => {
      execFile(
        process.execPath,
        [helperPath, capturePath, resultPath, expectedMarker, '20', '4', '80', '10'],
        { windowsHide: true },
        error => resolve(typeof error?.code === 'number' ? error.code : error === null ? 0 : 1),
      )
    })
    const snapshot = JSON.parse(await readFile(resultPath, 'utf8')) as SnapshotResult
    return { exitCode, snapshot }
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

describe('ConPTY headless screen snapshot', () => {
  it('interprets styled UTF-8 as terminal-visible text', async () => {
    const raw = [
      '\u001b[?1049h',
      '\u001b[2J',
      '\u001b[H',
      'initial 20x4 frame',
      '\u001b[8;10;80t',
      '\u001b[2J',
      '\u001b[H',
      'YOU  \u001b[90m\u001b[22m› \u001b[96mConPTY 真实输入\u001b[0m',
      '\r\nDSH    \u001b[94mdurable assistant complete\u001b[0m',
      '\r\n╭─ TOOL  inspect ───────────────────────── ✓ DONE ─╮',
      `\r\n${marker}`,
      '\u001b[?1049lNORMAL BUFFER',
    ].join('')

    const result = await inspectCapture(Buffer.from(raw, 'utf8'))

    expect(result.exitCode).toBe(0)
    expect(result.snapshot.ok).toBe(true)
    expect(result.snapshot.bufferType).toBe('alternate')
    const screen = result.snapshot.lines?.join('\n') ?? ''
    expect(screen).toContain('YOU  › ConPTY 真实输入')
    expect(screen).toContain('DSH    durable assistant complete')
    expect(screen).toContain('TOOL  inspect')
  })

  it('rejects malformed UTF-8 instead of trying a legacy code page', async () => {
    const result = await inspectCapture(Uint8Array.from([0xc3, 0x28]))

    expect(result.exitCode).not.toBe(0)
    expect(result.snapshot.ok).toBe(false)
    expect(result.snapshot.error).toContain('UTF-8')
  })

  it('rejects replacement characters and missing flow markers', async () => {
    const replacement = await inspectCapture(Buffer.from(`bad � ${marker}`, 'utf8'))
    expect(replacement.exitCode).not.toBe(0)
    expect(replacement.snapshot.error).toContain('replacement character')

    const missingMarker = await inspectCapture(Buffer.from('plain UTF-8', 'utf8'))
    expect(missingMarker.exitCode).not.toBe(0)
    expect(missingMarker.snapshot.error).toContain('flow marker')

    const duplicateMarker = await inspectCapture(
      Buffer.from(`${marker}\r\n${marker}`, 'utf8'),
    )
    expect(duplicateMarker.exitCode).not.toBe(0)
    expect(duplicateMarker.snapshot.error).toContain('not unique')
  }, 15_000)
})
