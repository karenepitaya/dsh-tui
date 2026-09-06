import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harness = fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))
const baseRequire = createRequire(join(harness, 'packages/bundle/base/package.json'))
const localPath = baseRequire.resolve('@deepseek-ai/dsh-credentials-local')
const localRequire = createRequire(localPath)
const { CredentialProvider } = await import(pathToFileURL(localRequire.resolve('@deepseek-ai/dsh-credentials')).href)
const { parseCredentialsDocument } = await import(pathToFileURL(localPath).href)

/** Acceptance-only credential seam. No migration, watcher, environment copy, or writes. */
export default class ReadonlyAcceptanceCredentials extends CredentialProvider {
  constructor(ctx, config) {
    super(ctx)
    this.path = config.path
    this.reference = config.reference
  }

  async resolve(reference) {
    if (reference !== this.reference) return undefined
    const document = parseCredentialsDocument(await readFile(this.path, 'utf8'), this.path)
    const value = document.refs.get(reference)
    return value ? { value, source: 'acceptance-readonly-file' } : undefined
  }

  async describe(reference) {
    const configured = (await this.resolve(reference)) !== undefined
    return { configured, writable: false, ...(configured ? { source: 'acceptance-readonly-file' } : {}) }
  }

  async readRecord() { return undefined }
  async describeRecord() { return { configured: false, writable: false } }
  async listRecords() { return [] }
  async set() { throw new Error('Acceptance credentials are read only') }
  async unset() { throw new Error('Acceptance credentials are read only') }
  async modifyRecord() { throw new Error('Acceptance credentials are read only') }
  async deleteRecord() { throw new Error('Acceptance credentials are read only') }
}
