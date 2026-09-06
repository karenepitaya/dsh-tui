#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function filesUnder(root) {
  const output = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) output.push(path)
    }
  }
  await visit(root)
  return output
}

async function treeManifest(root) {
  const absolute = resolve(root)
  const files = await filesUnder(absolute)
  return Promise.all(files.map(async path => ({
    path: relative(absolute, path).split(sep).join('/'),
    hash: createHash('sha256').update(await readFile(path)).digest('hex'),
  })))
}

function manifestDigest(manifest) {
  const hash = createHash('sha256')
  for (const entry of manifest) hash.update(`${entry.path}\0${entry.hash}\n`)
  return hash.digest('hex')
}

function assertMatchingTree(label, sourceManifest, installedManifest) {
  const sourceJson = JSON.stringify(sourceManifest)
  const installedJson = JSON.stringify(installedManifest)
  if (sourceJson === installedJson) return
  const sourceByPath = new Map(sourceManifest.map(entry => [entry.path, entry.hash]))
  const installedByPath = new Map(installedManifest.map(entry => [entry.path, entry.hash]))
  const paths = [...new Set([...sourceByPath.keys(), ...installedByPath.keys()])].sort()
  const differences = paths.filter(path => sourceByPath.get(path) !== installedByPath.get(path))
  throw new Error(
    `installed ${label} build is stale (${differences.length} differing files): `
    + differences.slice(0, 8).join(', '),
  )
}

/**
 * Proves that the profile is loading this checkout's complete built tree, not
 * an older pnpm copy that happens to share package name and version.
 */
export async function verifyInstalledPackage(sourceRoot, installedRoot) {
  const source = resolve(sourceRoot)
  const installed = resolve(installedRoot)
  const sourceManifest = await treeManifest(join(source, 'lib'))
  const installedManifest = await treeManifest(join(installed, 'lib'))
  const sourcePatch = await readFile(join(source, 'cordis.patch.yml'))
  const installedPatch = await readFile(join(installed, 'cordis.patch.yml'))
  const installedPackage = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))

  if (installedPackage.name !== 'dsh-tui') {
    throw new Error(`installed package name is ${JSON.stringify(installedPackage.name)}, expected "dsh-tui"`)
  }
  assertMatchingTree('dsh-tui', sourceManifest, installedManifest)
  if (!sourcePatch.equals(installedPatch)) {
    throw new Error('installed dsh-tui cordis.patch.yml does not match this checkout')
  }
  await import(pathToFileURL(join(installed, 'lib', 'index.js')).href)
  return {
    files: sourceManifest.length,
    digest: manifestDigest(sourceManifest),
  }
}

/** Proves that the independently packaged motion runtime matches this checkout. */
export async function verifyInstalledOrbsPackage(sourceRoot, installedRoot) {
  const source = resolve(sourceRoot)
  const installed = resolve(installedRoot)
  const sourcePackage = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const installedPackage = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  if (sourcePackage.name !== 'pi-tui-orbs') {
    throw new Error(`source companion package name is ${JSON.stringify(sourcePackage.name)}, expected "pi-tui-orbs"`)
  }
  if (installedPackage.name !== sourcePackage.name
    || installedPackage.version !== sourcePackage.version) {
    throw new Error(
      `installed companion identity is ${JSON.stringify(installedPackage.name)}@${JSON.stringify(installedPackage.version)}, `
      + `expected ${sourcePackage.name}@${sourcePackage.version}`,
    )
  }
  const sourceManifest = await treeManifest(join(source, 'dist'))
  const installedManifest = await treeManifest(join(installed, 'dist'))
  assertMatchingTree('pi-tui-orbs', sourceManifest, installedManifest)
  await import(pathToFileURL(join(installed, 'dist', 'index.js')).href)
  return {
    files: sourceManifest.length,
    digest: manifestDigest(sourceManifest),
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const sourceRoot = process.argv[2]
  const installedRoot = process.argv[3]
  const orbsSourceRoot = process.argv[4]
  const installedOrbsRoot = process.argv[5]
  if (sourceRoot === undefined || installedRoot === undefined) {
    throw new Error(
      'usage: node scripts/verify-installed-package.mjs <source-root> <installed-root> '
      + '[<orbs-source-root> <orbs-installed-root>]',
    )
  }
  if ((orbsSourceRoot === undefined) !== (installedOrbsRoot === undefined)) {
    throw new Error('pi-tui-orbs verification requires both source and installed roots')
  }
  const result = await verifyInstalledPackage(sourceRoot, installedRoot)
  const orbsResult = orbsSourceRoot === undefined
    ? undefined
    : await verifyInstalledOrbsPackage(orbsSourceRoot, installedOrbsRoot)
  process.stdout.write(
    `DSH_TUI_INSTALL_OK files=${result.files} digest=${result.digest.slice(0, 16)}\n`,
  )
  if (orbsResult !== undefined) {
    process.stdout.write(
      `DSH_TUI_ORBS_INSTALL_OK files=${orbsResult.files} digest=${orbsResult.digest.slice(0, 16)}\n`,
    )
  }
}
