import { describe, expect, it, vi } from 'vitest'
import { createSystemClipboardPort, type ClipboardExecFile } from '../src/terminal/clipboard.ts'

function fakeReader(stdout: string, error: Error | null = null) {
  const run = vi.fn<ClipboardExecFile>((_file, _args, _options, callback) => {
    callback(error, stdout, '')
  })
  return { run, port: createSystemClipboardPort({ platform: 'win32', execFile: run }) }
}

describe('Windows clipboard reader', () => {
  it('constructs the default reader without starting a clipboard read', () => {
    expect(createSystemClipboardPort().read).toBeTypeOf('function')
  })

  it('returns PNG bytes through a hidden bounded STA helper with no image files', async () => {
    const { port, run } = fakeReader(JSON.stringify({
      kind: 'image', mediaType: 'image/png', data: 'AQID',
    }))
    const signal = new AbortController().signal
    await expect(port.read({ maxImageBytes: 16, signal })).resolves.toEqual({
      kind: 'image',
      image: { name: 'clipboard.png', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) },
    })
    expect(run).toHaveBeenCalledOnce()
    const [file, args, options] = run.mock.calls[0]!
    expect(file).toBe('pwsh')
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden']))
    expect(options).toMatchObject({ windowsHide: true, encoding: 'utf8', timeout: 5000, signal })
    expect(options.maxBuffer).toBeLessThan(7 * 1024 * 1024)
    const script = args.at(-1)!
    expect(script).toContain('MemoryStream')
    expect(script).toContain('ImageFormat]::Png')
    expect(script).not.toMatch(/WriteAllBytes|GetTempFileName|Save\([^,]*path/iu)
  })

  it.each([
    [{ kind: 'empty' }, { kind: 'empty' }],
    [{ kind: 'text', text: '普通文本\nunchanged' }, { kind: 'text', text: '普通文本\nunchanged' }],
  ])('preserves clipboard payload %j', async (payload, expected) => {
    await expect(fakeReader(JSON.stringify(payload)).port.read()).resolves.toEqual(expected)
  })

  it.each(['', '{', 'null', '[]', '1'])('rejects malformed JSON %j', async stdout => {
    await expect(fakeReader(stdout).port.read()).rejects.toThrow('malformed data')
  })

  it.each([
    { kind: 'other' },
    { kind: 'text', text: 1 },
    { kind: 'image', mediaType: 'image/jpeg', data: 'AQID' },
    { kind: 'image', mediaType: 'image/png', data: [1, 2, 3] },
  ])('rejects unsupported payload %j', async payload => {
    await expect(fakeReader(JSON.stringify(payload)).port.read()).rejects.toThrow('unsupported payload')
  })

  it.each(['', '!!!', 'AQI', 'AQID\n'])('rejects invalid base64 bytes %j', async data => {
    await expect(fakeReader(JSON.stringify({
      kind: 'image', mediaType: 'image/png', data,
    })).port.read()).rejects.toThrow('invalid image bytes')
  })

  it('enforces image, text, and total output bounds', async () => {
    const payload = { kind: 'image', mediaType: 'image/png', data: 'AQID' }
    await expect(fakeReader(JSON.stringify(payload)).port.read({ maxImageBytes: 2 }))
      .rejects.toThrow('Clipboard image exceeds the read limit')
    await expect(fakeReader(JSON.stringify({ kind: 'text', text: 'a'.repeat(1024 * 1024 + 1) })).port.read())
      .rejects.toThrow('Clipboard text exceeds the read limit')
    await expect(fakeReader('a'.repeat(7 * 1024 * 1024)).port.read({ maxImageBytes: 1 }))
      .rejects.toThrow('Clipboard content exceeds the read limit')
    const { port, run } = fakeReader(JSON.stringify({ kind: 'empty' }))
    await port.read({ maxImageBytes: 128 * 1024 * 1024 })
    expect(run.mock.calls[0]![2].maxBuffer).toBeLessThan(45 * 1024 * 1024)
  })

  it.each([0, -1, 0.5, Number.NaN])('rejects invalid image limit %s before spawning', async maxImageBytes => {
    const { port, run } = fakeReader('{}')
    await expect(port.read({ maxImageBytes })).rejects.toThrow('positive integer')
    expect(run).not.toHaveBeenCalled()
  })

  it('does not spawn on unsupported platforms or an already aborted read', async () => {
    const { run } = fakeReader('{}')
    await expect(createSystemClipboardPort({ platform: 'linux', execFile: run }).read())
      .rejects.toThrow('only available on Windows')
    const abort = new AbortController()
    abort.abort(new Error('read cancelled'))
    await expect(createSystemClipboardPort({ platform: 'win32', execFile: run }).read({ signal: abort.signal }))
      .rejects.toThrow('read cancelled')
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    Object.assign(new Error('exit 1'), { code: 1 }),
    Object.assign(new Error('spawn failed'), { code: 'ENOENT' }),
    Object.assign(new Error('output bound'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
    Object.assign(new Error('timeout'), { killed: true }),
  ])('contains process failure %s without revealing helper output', async error => {
    const { port } = fakeReader('private clipboard contents', error)
    await expect(port.read()).rejects.toMatchObject({ message: 'Could not read Windows clipboard', cause: error })
  })

  it('passes abort to the process and rejects results arriving after cancellation', async () => {
    for (const error of [null, new Error('process aborted')]) {
      const abort = new AbortController()
      let complete: Parameters<ClipboardExecFile>[3] | undefined
      const run: ClipboardExecFile = (_file, _args, options, callback) => {
        expect(options.signal).toBe(abort.signal)
        complete = callback
      }
      const pending = createSystemClipboardPort({ platform: 'win32', execFile: run }).read({ signal: abort.signal })
      const rejected = expect(pending).rejects.toThrow('binding changed')
      abort.abort(new Error('binding changed'))
      complete!(error, JSON.stringify({ kind: 'empty' }), '')
      await rejected
    }
  })
})
