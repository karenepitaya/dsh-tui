#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, '.artifacts')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packedName = `${manifest.name}-${manifest.version}.tgz`
const packedPath = join(artifacts, packedName)
await mkdir(artifacts, { recursive: true })

const npmExecPath = process.env.npm_execpath
const command = npmExecPath === undefined ? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm') : process.execPath
const args = npmExecPath === undefined
  ? ['pack', '--pack-destination', artifacts]
  : [npmExecPath, 'pack', '--pack-destination', artifacts]
const packed = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
if (packed.status !== 0) throw new Error(`pnpm pack failed with exit code ${packed.status ?? 'unknown'}`)

const bytes = await readFile(packedPath)
const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
const contentPath = join(artifacts, `${manifest.name}-${manifest.version}-${digest}.tgz`)
if (contentPath !== packedPath) {
  await rm(contentPath, { force: true })
  await rename(packedPath, contentPath)
}
process.stdout.write(`DSH_TUI_TARBALL=${resolve(contentPath)}\n`)
