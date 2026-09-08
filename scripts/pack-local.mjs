#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const orbsRoot = resolve(root, 'packages', 'pi-tui-orbs')
const artifacts = join(root, '.artifacts')
await mkdir(artifacts, { recursive: true })

const npmExecPath = process.env.npm_execpath
const command = npmExecPath === undefined ? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm') : process.execPath

function pnpmArgs(args) {
  return npmExecPath === undefined ? args : [npmExecPath, ...args]
}

function runPnpm(cwd, args, label) {
  const result = spawnSync(command, pnpmArgs(args), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`)
  }
}

async function packContentAddressed(packageRoot) {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const packedPath = join(artifacts, `${manifest.name}-${manifest.version}.tgz`)
  runPnpm(
    packageRoot,
    ['pack', '--pack-destination', artifacts],
    `pnpm pack ${manifest.name}`,
  )
  const bytes = await readFile(packedPath)
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const contentPath = join(
    artifacts,
    `${manifest.name}-${manifest.version}-${digest}.tgz`,
  )
  if (contentPath !== packedPath) {
    await rm(contentPath, { force: true })
    await rename(packedPath, contentPath)
  }
  return resolve(contentPath)
}

runPnpm(root, ['run', 'build'], 'dsh-tui build')
const orbsTarball = await packContentAddressed(orbsRoot)
const dshTuiTarball = await packContentAddressed(root)
process.stdout.write(`DSH_TUI_ORBS_TARBALL=${orbsTarball}\n`)
process.stdout.write(`DSH_TUI_TARBALL=${dshTuiTarball}\n`)
