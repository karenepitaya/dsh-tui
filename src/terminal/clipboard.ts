import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import type { ClipboardContent, ClipboardPort } from '../attachment/port.ts'

const DEFAULT_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_TEXT_BYTES = 1024 * 1024
const READ_TIMEOUT_MS = 5000

/** Injectable process boundary: tests never access the user's clipboard. */
export type ClipboardExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown

function windowsClipboardScript(maxImageBytes: number): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $clipboardImage = [System.Windows.Forms.Clipboard]::GetImage()
  if ($null -ne $clipboardImage) {
    $clipboardStream = [System.IO.MemoryStream]::new()
    try {
      $clipboardImage.Save($clipboardStream, [System.Drawing.Imaging.ImageFormat]::Png)
      if ($clipboardStream.Length -gt ${maxImageBytes}) { throw 'Image exceeds clipboard read limit' }
      $clipboardPayload = @{ kind = 'image'; mediaType = 'image/png'; data = [Convert]::ToBase64String($clipboardStream.ToArray()) }
    } finally {
      $clipboardStream.Dispose()
      $clipboardImage.Dispose()
    }
  } elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
    $clipboardText = [System.Windows.Forms.Clipboard]::GetText()
    if ([System.Text.Encoding]::UTF8.GetByteCount($clipboardText) -gt ${MAX_TEXT_BYTES}) { throw 'Text exceeds clipboard read limit' }
    $clipboardPayload = @{ kind = 'text'; text = $clipboardText }
  } else {
    $clipboardPayload = @{ kind = 'empty' }
  }
  [Console]::Out.Write(($clipboardPayload | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.WriteLine('Windows clipboard read failed.')
  exit 1
}
`.trim()
}

function parseClipboard(stdout: string, maxImageBytes: number): ClipboardContent {
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new Error('Clipboard helper returned malformed data')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Clipboard helper returned malformed data')
  }
  const value = payload as Readonly<Record<string, unknown>>
  if (value.kind === 'empty') return { kind: 'empty' }
  if (value.kind === 'text' && typeof value.text === 'string') {
    if (Buffer.byteLength(value.text, 'utf8') > MAX_TEXT_BYTES) {
      throw new Error('Clipboard text exceeds the read limit')
    }
    return { kind: 'text', text: value.text }
  }
  if (value.kind !== 'image' || value.mediaType !== 'image/png' || typeof value.data !== 'string') {
    throw new Error('Clipboard helper returned an unsupported payload')
  }
  const data = Buffer.from(value.data, 'base64')
  if (data.byteLength === 0 || data.toString('base64') !== value.data) {
    throw new Error('Clipboard helper returned invalid image bytes')
  }
  if (data.byteLength > maxImageBytes) throw new Error('Clipboard image exceeds the read limit')
  return {
    kind: 'image',
    image: { name: 'clipboard.png', mediaType: 'image/png', data: new Uint8Array(data) },
  }
}

/** Reads once through an STA Windows helper. No polling, persistence, or temporary files. */
export function createSystemClipboardPort(dependencies: {
  readonly platform?: NodeJS.Platform
  readonly execFile?: ClipboardExecFile
} = {}): ClipboardPort {
  const platform = dependencies.platform ?? process.platform
  const run = dependencies.execFile ?? execFile
  return {
    async read(options = {}) {
      options.signal?.throwIfAborted()
      if (platform !== 'win32') throw new Error('Clipboard image paste is only available on Windows')
      const requested = options.maxImageBytes ?? DEFAULT_IMAGE_BYTES
      if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new Error('Clipboard image byte limit must be a positive integer')
      }
      const maxImageBytes = Math.min(requested, MAX_IMAGE_BYTES)
      // JSON text can expand control characters to six ASCII bytes each.
      const maxBuffer = Math.max(4 * Math.ceil(maxImageBytes / 3), MAX_TEXT_BYTES * 6) + 1024
      const stdout = await new Promise<string>((resolve, reject) => {
        run('pwsh', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden',
          '-Command', windowsClipboardScript(maxImageBytes),
        ], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: READ_TIMEOUT_MS,
          maxBuffer,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }, (error, output) => {
          if (error !== null) {
            reject(options.signal?.aborted ? options.signal.reason : new Error('Could not read Windows clipboard', { cause: error }))
          } else if (Buffer.byteLength(output, 'utf8') > maxBuffer) {
            reject(new Error('Clipboard content exceeds the read limit'))
          } else {
            resolve(output)
          }
        })
      })
      options.signal?.throwIfAborted()
      return parseClipboard(stdout, maxImageBytes)
    },
  }
}
