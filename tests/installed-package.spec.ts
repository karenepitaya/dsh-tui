import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- this repository script intentionally has no public declaration file
import { verifyInstalledOrbsPackage, verifyInstalledPackage } from '../scripts/verify-installed-package.mjs'

const roots: string[] = []

async function fixture(): Promise<{ source: string; installed: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-installed-package-'))
  roots.push(root)
  const source = join(root, 'source')
  const installed = join(root, 'installed')
  for (const directory of [source, installed]) {
    await mkdir(join(directory, 'lib', 'ui'), { recursive: true })
    await writeFile(join(directory, 'lib', 'index.js'), 'export const build = 1\n')
    await writeFile(join(directory, 'lib', 'ui', 'conversation.js'), 'export const surface = 2\n')
    await writeFile(join(directory, 'cordis.patch.yml'), 'config: []\n')
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-tui', type: 'module' }))
  }
  return { source, installed }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('installed package identity', () => {
  it('accepts only a complete byte-for-byte built tree', async () => {
    const { source, installed } = await fixture()
    await expect(verifyInstalledPackage(source, installed)).resolves.toMatchObject({ files: 2 })

    await writeFile(join(installed, 'lib', 'ui', 'conversation.js'), 'export const surface = 1\n')
    await expect(verifyInstalledPackage(source, installed)).rejects.toThrow(
      'installed dsh-tui build is stale (1 differing files): ui/conversation.js',
    )
  })

  it('rejects missing files, patch drift, and a package-name mismatch', async () => {
    const { source, installed } = await fixture()
    await rm(join(installed, 'lib', 'index.js'))
    await expect(verifyInstalledPackage(source, installed)).rejects.toThrow('index.js')

    await writeFile(join(installed, 'lib', 'index.js'), 'export const build = 1\n')
    await writeFile(join(installed, 'cordis.patch.yml'), 'config: changed\n')
    await expect(verifyInstalledPackage(source, installed)).rejects.toThrow('cordis.patch.yml')

    await writeFile(join(installed, 'cordis.patch.yml'), 'config: []\n')
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'other' }))
    await expect(verifyInstalledPackage(source, installed)).rejects.toThrow('expected "dsh-tui"')
  })

  it('verifies the companion identity, complete dist tree, and import entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-installed-orbs-'))
    roots.push(root)
    const source = join(root, 'source')
    const installed = join(root, 'installed')
    for (const directory of [source, installed]) {
      await mkdir(join(directory, 'dist', 'nested'), { recursive: true })
      await writeFile(join(directory, 'dist', 'index.js'), 'export const runtime = true\n')
      await writeFile(join(directory, 'dist', 'nested', 'bar.js'), 'export const bar = true\n')
      await writeFile(join(directory, 'package.json'), JSON.stringify({
        name: 'pi-tui-orbs',
        version: '0.1.0',
        type: 'module',
      }))
    }

    await expect(verifyInstalledOrbsPackage(source, installed)).resolves.toMatchObject({ files: 2 })

    await writeFile(join(installed, 'dist', 'nested', 'bar.js'), 'export const bar = false\n')
    await expect(verifyInstalledOrbsPackage(source, installed)).rejects.toThrow(
      'installed pi-tui-orbs build is stale (1 differing files): nested/bar.js',
    )

    await writeFile(join(installed, 'package.json'), JSON.stringify({
      name: 'pi-tui-orbs',
      version: '0.2.0',
      type: 'module',
    }))
    await expect(verifyInstalledOrbsPackage(source, installed)).rejects.toThrow(
      'expected pi-tui-orbs@0.1.0',
    )

    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'other',
      version: '0.1.0',
      type: 'module',
    }))
    await expect(verifyInstalledOrbsPackage(source, installed)).rejects.toThrow(
      'expected "pi-tui-orbs"',
    )
  })
})
