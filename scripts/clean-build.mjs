import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsRoot = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptsRoot, '..')
const outputRoot = resolve(projectRoot, 'lib')

if (outputRoot === projectRoot || dirname(outputRoot) !== projectRoot) {
  throw new Error(`refusing to clean unexpected build output: ${outputRoot}`)
}

await rm(outputRoot, {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
})
