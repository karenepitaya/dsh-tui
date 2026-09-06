import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- this acceptance-only MJS plugin has no public declaration file
import ReadonlyAcceptanceCredentials from '../scripts/real-llm-readonly-credentials.mjs'

const artifacts = resolve('.artifacts')
const reference = 'ACCEPTANCE_TEST_KEY'
const roots: string[] = []
const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const root of roots.splice(0)) {
    expect(resolve(root).startsWith(artifacts + sep)).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(document = 'version: 1\nrefs:\n  ACCEPTANCE_TEST_KEY: fixture-only-secret\n  OTHER_TEST_KEY: hidden-fixture-secret\n') {
  await mkdir(artifacts, { recursive: true })
  const root = await mkdtemp(resolve(artifacts, 'credential-seam-'))
  roots.push(root)
  const path = resolve(root, 'credentials.yaml')
  await writeFile(path, document)
  const ctx = new Context()
  const fiber = ctx.plugin(ReadonlyAcceptanceCredentials, { path, reference })
  await fiber
  disposers.push(async () => { await fiber.dispose() })
  return { provider: ctx.get('credentials') as InstanceType<typeof ReadonlyAcceptanceCredentials>, path, document }
}

describe('real LLM acceptance credential boundary', () => {
  it('resolves only the selected reference without exposing values through describe', async () => {
    const { provider, path, document } = await fixture()
    expect(await provider.resolve(reference)).toEqual({ value: 'fixture-only-secret', source: 'acceptance-readonly-file' })
    expect(await provider.describe(reference)).toEqual({ configured: true, writable: false, source: 'acceptance-readonly-file' })
    expect(await provider.resolve('OTHER_TEST_KEY')).toBeUndefined()
    expect(await provider.describe('OTHER_TEST_KEY')).toEqual({ configured: false, writable: false })
    expect(await readFile(path, 'utf8')).toBe(document)
  })

  it('refuses all writes and record access without modifying the document', async () => {
    const { provider, path, document } = await fixture()
    await expect(provider.set()).rejects.toThrow('read only')
    await expect(provider.unset()).rejects.toThrow('read only')
    await expect(provider.modifyRecord()).rejects.toThrow('read only')
    await expect(provider.deleteRecord()).rejects.toThrow('read only')
    expect(await provider.readRecord()).toBeUndefined()
    expect(await provider.listRecords()).toEqual([])
    expect(await provider.describeRecord()).toEqual({ configured: false, writable: false })
    expect(await readFile(path, 'utf8')).toBe(document)
  })

  it('rejects the old flat layout without invoking migration', async () => {
    const { provider, path, document } = await fixture('ACCEPTANCE_TEST_KEY: fixture-only-secret\n')
    await expect(provider.resolve(reference)).rejects.toThrow('pre-release flat layout')
    expect(await readFile(path, 'utf8')).toBe(document)
  })

  it('reports an absent selected reference as unconfigured', async () => {
    const { provider } = await fixture('version: 1\nrefs: {}\n')
    expect(await provider.resolve(reference)).toBeUndefined()
    expect(await provider.describe(reference)).toEqual({ configured: false, writable: false })
  })
})
