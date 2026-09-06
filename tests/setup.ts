import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { afterAll } from 'vitest'

// Establish isolation before any test imports a DSH service. Individual fixtures
// may use a narrower temporary root, but an omitted option must never reach the
// developer's real sessions, settings, credentials or attachment storage.
const temporaryParent = resolve(tmpdir())
const directory = mkdtempSync(join(temporaryParent, 'dsh-tui-test-home-'))
const child = relative(temporaryParent, directory)
if (isAbsolute(child) || child.startsWith(`..${sep}`) || child === '..'
  || !basename(directory).startsWith('dsh-tui-test-home-')) {
  throw new Error('Refusing to use a non-isolated DSH test home')
}
const previousHome = process.env.DSH_HOME
const previousAgents = process.env.DSH_AGENTS_HOME
process.env.DSH_HOME = join(directory, 'dsh')
process.env.DSH_AGENTS_HOME = join(directory, 'agents')
mkdirSync(process.env.DSH_HOME)
mkdirSync(process.env.DSH_AGENTS_HOME)

afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousAgents === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = previousAgents
  // directory is the explicit mkdtemp result validated above, never a home or
  // a path obtained from the environment after a fixture has changed it.
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
})
