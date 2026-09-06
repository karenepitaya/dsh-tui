import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, win32 } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

/** Execute the real setup body with fake IO; no negative case can touch a user directory. */
function setupHarness(
  directory = 'C:\\Temp\\dsh-tui-test-home-fixture',
  env: Record<string, string | undefined> = {},
) {
  const mkdir = vi.fn()
  const remove = vi.fn()
  const cleanups: Array<() => void> = []
  const source = readFileSync(new URL('./setup.ts', import.meta.url), 'utf8')
    .replace(/^import .*$/gmu, '')
  return {
    env, mkdir, remove, cleanups,
    run: () => runInNewContext(source, {
      ...win32,
      tmpdir: () => 'C:\\Temp',
      mkdtempSync: () => directory,
      mkdirSync: mkdir,
      rmSync: remove,
      process: { env },
      afterAll: (callback: () => void) => { cleanups.push(callback) },
    }),
  }
}

describe('DSH test process isolation', () => {
  it('establishes separate session/settings/attachments and agent homes before imports', () => {
    const dshHome = process.env.DSH_HOME!
    const agentsHome = process.env.DSH_AGENTS_HOME!
    expect(dshHome).toBeTruthy()
    expect(agentsHome).toBeTruthy()
    expect(dshHome).not.toBe(agentsHome)
    expect(dirname(dshHome)).toBe(dirname(agentsHome))
    expect(relative(resolve(tmpdir()), dshHome)).toMatch(/^dsh-tui-test-home-/u)
    expect(existsSync(dshHome)).toBe(true)
    expect(existsSync(agentsHome)).toBe(true)
  })

  it.each([
    'C:\\Temp',
    'C:\\Temp\\ordinary-user-directory',
    'C:\\Users\\fixture\\dsh-tui-test-home-outside',
    'C:\\Temp-other\\dsh-tui-test-home-sibling',
    'D:\\Temp\\dsh-tui-test-home-other-drive',
  ])('rejects an unexpected temporary target %s before any directory write or cleanup', directory => {
    const fixture = setupHarness(directory, { DSH_HOME: 'C:\\Users\\fixture\\real-home' })
    expect(() => fixture.run()).toThrow('non-isolated DSH test home')
    expect(fixture.mkdir).not.toHaveBeenCalled()
    expect(fixture.remove).not.toHaveBeenCalled()
    expect(fixture.cleanups).toEqual([])
    expect(fixture.env.DSH_HOME).toBe('C:\\Users\\fixture\\real-home')
  })

  it.each([true, false])('restores inherited environment=%s and never cleans a later environment target', inherited => {
    const previous = inherited ? { DSH_HOME: 'C:\\Users\\fixture\\prior-dsh', DSH_AGENTS_HOME: 'C:\\Users\\fixture\\prior-agents' } : {}
    const fixture = setupHarness(undefined, { ...previous })
    fixture.run()
    expect(fixture.mkdir.mock.calls).toEqual([
      ['C:\\Temp\\dsh-tui-test-home-fixture\\dsh'],
      ['C:\\Temp\\dsh-tui-test-home-fixture\\agents'],
    ])
    fixture.env.DSH_HOME = 'C:\\Users\\fixture\\do-not-delete'
    fixture.env.DSH_AGENTS_HOME = 'C:\\Users\\fixture\\also-do-not-delete'
    fixture.cleanups[0]!()
    expect(fixture.env).toEqual(previous)
    expect(fixture.remove).toHaveBeenCalledExactlyOnceWith('C:\\Temp\\dsh-tui-test-home-fixture', {
      recursive: true, force: true, maxRetries: 3,
    })
  })
})
