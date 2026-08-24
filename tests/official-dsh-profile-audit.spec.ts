import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- this test-only MJS plugin intentionally has no public declaration file
import { apply, ownPublicationGeneration, writeEvidenceAtomically } from '../scripts/official-dsh-profile-audit.mjs'

const CORDIS_FIBER_LOADING = 1
const CORDIS_FIBER_ACTIVE = 2

interface EffectOwner {
  readonly ctx: {
    effect(callback: () => Promise<() => Promise<void>>): () => void
  }
  dispose(): Promise<void>
}

function createEffectOwner(): EffectOwner {
  let setup: Promise<() => Promise<void>> | undefined
  return {
    ctx: {
      effect(callback) {
        setup = Promise.resolve().then(callback)
        void setup.catch(() => {})
        return () => {}
      },
    },
    async dispose() {
      const cleanup = await setup
      await cleanup?.()
    },
  }
}

function setAuditPath(path: string): () => void {
  const previous = process.env.DSH_TUI_E2E_PROFILE_AUDIT_PATH
  process.env.DSH_TUI_E2E_PROFILE_AUDIT_PATH = path
  return () => {
    if (previous === undefined) {
      delete process.env.DSH_TUI_E2E_PROFILE_AUDIT_PATH
    } else {
      process.env.DSH_TUI_E2E_PROFILE_AUDIT_PATH = previous
    }
  }
}

function auditContext(owner: EffectOwner, onAgentCreated: () => void) {
  return {
    ...owner.ctx,
    on(event: string) {
      if (event === 'agent/created') onAgentCreated()
      return () => {}
    },
  }
}

async function readEvidence(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

describe('official profile audit publication generations', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(
      root => rm(root, { recursive: true, force: true }),
    ))
  })

  it('serializes fixed-path replacement so stale writes and cleanup cannot remove the current evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-audit-generation-'))
    roots.push(root)
    const evidencePath = join(root, 'profile-audit.json')
    const firstOwner = createEffectOwner()
    const first = ownPublicationGeneration(firstOwner.ctx, evidencePath, () => {})
    await first.ready

    const firstWrite = writeEvidenceAtomically(evidencePath, { marker: 'first' }, first)
    first.publicationTask = firstWrite
    await firstWrite
    expect((await readEvidence(evidencePath))?.auditGeneration).toBe(first.nonce)

    const secondOwner = createEffectOwner()
    const second = ownPublicationGeneration(secondOwner.ctx, evidencePath, () => {})
    await second.ready
    expect(first.isCurrent()).toBe(false)
    expect(await readEvidence(evidencePath)).toBeUndefined()
    expect(second.nonce).not.toBe(first.nonce)
    expect(second.stagingPath).not.toBe(first.stagingPath)

    const staleWrite = writeEvidenceAtomically(evidencePath, { marker: 'stale' }, first)
    first.publicationTask = staleWrite
    await staleWrite
    expect(await readEvidence(evidencePath)).toBeUndefined()

    const secondWrite = writeEvidenceAtomically(evidencePath, { marker: 'second' }, second)
    second.publicationTask = secondWrite
    await secondWrite
    expect(await readEvidence(evidencePath)).toMatchObject({
      marker: 'second',
      auditGeneration: second.nonce,
    })

    await firstOwner.dispose()
    expect((await readEvidence(evidencePath))?.auditGeneration).toBe(second.nonce)
    await secondOwner.dispose()
    expect(await readEvidence(evidencePath)).toBeUndefined()
  })

  it('makes disposal await and suppress an in-flight unpublished write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-audit-dispose-'))
    roots.push(root)
    const evidencePath = join(root, 'profile-audit.json')
    const owner = createEffectOwner()
    const generation = ownPublicationGeneration(owner.ctx, evidencePath, () => {})
    await generation.ready

    const publication = writeEvidenceAtomically(evidencePath, { marker: 'late' }, generation)
    generation.publicationTask = publication
    let staleFailureFired = false
    generation.failureImmediate = setImmediate(() => { staleFailureFired = true })
    await owner.dispose()
    await publication
    await new Promise(resolveImmediate => setImmediate(resolveImmediate))

    expect(await readEvidence(evidencePath)).toBeUndefined()
    expect(await readEvidence(generation.stagingPath)).toBeUndefined()
    expect(staleFailureFired).toBe(false)
  })

  it('keeps apply pending and registers no Agent listener until a slow generation install is ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-audit-slow-install-'))
    roots.push(root)
    const evidencePath = join(root, 'profile-audit.json')
    const restoreAuditPath = setAuditPath(evidencePath)
    const installGate = Promise.withResolvers<void>()
    const owner = createEffectOwner()
    let listenerRegistrations = 0
    let settled = false

    try {
      const applying = apply(
        auditContext(owner, () => { listenerRegistrations += 1 }),
        { beforeInstall: () => installGate.promise },
      )
      void applying.finally(() => { settled = true })
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(listenerRegistrations).toBe(0)

      installGate.resolve()
      await applying
      expect(listenerRegistrations).toBe(1)
      await owner.dispose()
    } finally {
      restoreAuditPath()
    }
  })

  it('keeps a real Cordis plugin fiber loading until the generation install barrier resolves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-audit-cordis-barrier-'))
    roots.push(root)
    const evidencePath = join(root, 'profile-audit.json')
    const restoreAuditPath = setAuditPath(evidencePath)
    const installGate = Promise.withResolvers<void>()
    const ctx = new Context()
    let observedFiber: Fiber | undefined
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.name === 'official-audit-barrier-probe') observedFiber = fiber
    })

    try {
      const mounting = ctx.plugin({
        name: 'official-audit-barrier-probe',
        apply(inner) {
          return apply(inner, { beforeInstall: () => installGate.promise })
        },
      })
      let mounted = false
      void mounting.then(() => { mounted = true })
      await Promise.resolve()
      await Promise.resolve()
      expect(mounted).toBe(false)
      expect(observedFiber?.state).toBe(CORDIS_FIBER_LOADING)

      installGate.resolve()
      const fiber = await mounting
      expect(fiber.state).toBe(CORDIS_FIBER_ACTIVE)
      await fiber.dispose()
    } finally {
      restoreAuditPath()
    }
  })

  it('rejects apply and never registers the Agent listener when fixed-path invalidation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-audit-install-failure-'))
    roots.push(root)
    const evidencePath = join(root, 'non-empty-directory')
    await mkdir(evidencePath)
    await writeFile(join(evidencePath, 'keep.txt'), 'keep')
    const restoreAuditPath = setAuditPath(evidencePath)
    const owner = createEffectOwner()
    let listenerRegistrations = 0

    try {
      await expect(apply(
        auditContext(owner, () => { listenerRegistrations += 1 }),
      )).rejects.toThrow()
      expect(listenerRegistrations).toBe(0)
    } finally {
      restoreAuditPath()
    }
  })

  it('restores the prior current generation when the next install fails before invalidation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-audit-install-rollback-'))
    roots.push(root)
    const evidencePath = join(root, 'profile-audit.json')
    const firstOwner = createEffectOwner()
    const first = ownPublicationGeneration(firstOwner.ctx, evidencePath, () => {})
    await first.ready
    const firstWrite = writeEvidenceAtomically(evidencePath, { marker: 'first' }, first)
    first.publicationTask = firstWrite
    await firstWrite

    const failedOwner = createEffectOwner()
    const failed = ownPublicationGeneration(
      failedOwner.ctx,
      evidencePath,
      () => {},
      { beforeInstall: async () => { throw new Error('install rejected') } },
    )
    await expect(failed.ready).rejects.toThrow('install rejected')

    expect(failed.disposed).toBe(true)
    expect(failed.isCurrent()).toBe(false)
    expect(first.isCurrent()).toBe(true)
    expect(await readEvidence(evidencePath)).toMatchObject({
      marker: 'first',
      auditGeneration: first.nonce,
    })
    await firstOwner.dispose()
  })
})
