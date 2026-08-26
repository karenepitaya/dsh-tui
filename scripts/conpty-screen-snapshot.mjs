import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function positiveDimension(value, name) {
  const dimension = Number(value)
  if (!Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return dimension
}

async function inspectCapture(
  capturePath,
  marker,
  initialColumns,
  initialRows,
  finalColumns,
  finalRows,
) {
  const bytes = await readFile(capturePath)
  let captured
  try {
    captured = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('ConPTY capture was not valid UTF-8.')
  }
  if (captured.includes('\uFFFD')) {
    throw new Error('ConPTY capture contained the Unicode replacement character U+FFFD.')
  }

  const markerBytes = Buffer.from(marker, 'utf8')
  const markerOffset = bytes.indexOf(markerBytes)
  if (markerOffset < 0) {
    throw new Error(`ConPTY flow marker was not present: ${marker}`)
  }
  if (bytes.indexOf(markerBytes, markerOffset + markerBytes.length) >= 0) {
    throw new Error(`ConPTY flow marker was not unique: ${marker}`)
  }

  const resizeBytes = Buffer.from(`\u001b[8;${finalRows};${finalColumns}t`, 'ascii')
  const resizeOffset = bytes.indexOf(resizeBytes)
  if (resizeOffset < 0 || resizeOffset >= markerOffset) {
    throw new Error('ConPTY resize sequence was not present before the flow marker.')
  }
  if (bytes.indexOf(resizeBytes, resizeOffset + resizeBytes.length) >= 0) {
    throw new Error('ConPTY resize sequence was not unique.')
  }
  const afterResize = resizeOffset + resizeBytes.length

  const require = createRequire(import.meta.url)
  const { Terminal } = require('@xterm/headless')
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: initialColumns,
    rows: initialRows,
    scrollback: 0,
  })
  try {
    await new Promise(resolve => terminal.write(bytes.subarray(0, afterResize), resolve))
    terminal.resize(finalColumns, finalRows)
    await new Promise(resolve => terminal.write(bytes.subarray(afterResize, markerOffset), resolve))
    const buffer = terminal.buffer.active
    const lines = Array.from({ length: finalRows }, (_, row) => (
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    ))
    return {
      ok: true,
      bufferType: buffer.type,
      columns: finalColumns,
      rows: finalRows,
      lines,
    }
  } finally {
    terminal.dispose()
  }
}

async function main() {
  const [
    capturePath,
    resultPath,
    marker,
    initialColumnsValue,
    initialRowsValue,
    finalColumnsValue,
    finalRowsValue,
  ] = process.argv.slice(2)
  if (resultPath === undefined) {
    throw new Error(
      'Usage: conpty-screen-snapshot.mjs <capture> <result> <marker>'
      + ' <initial-columns> <initial-rows> <final-columns> <final-rows>',
    )
  }

  let result
  try {
    if (capturePath === undefined || marker === undefined) {
      throw new Error('Capture path and flow marker are required.')
    }
    result = await inspectCapture(
      capturePath,
      marker,
      positiveDimension(initialColumnsValue, 'initial columns'),
      positiveDimension(initialRowsValue, 'initial rows'),
      positiveDimension(finalColumnsValue, 'final columns'),
      positiveDimension(finalRowsValue, 'final rows'),
    )
  } catch (error) {
    result = { ok: false, error: errorMessage(error) }
    process.exitCode = 1
  }
  await writeFile(resultPath, JSON.stringify(result), 'utf8')
}

await main()
