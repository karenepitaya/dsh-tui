import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { serviceForAgent } from '@deepseek-ai/dsh-agent-presets'
import { collectApprovalEvidence } from '../src/dsh/approval-evidence.ts'
import { currentPermission, presetPermission } from '../src/dsh/permission-facts.ts'
import { approvalPolicyDescription, permissionWidens } from '../src/permission/policy.ts'
import { approvalEvidenceError, type ApprovalEvidence, type PendingApprovalInteraction } from '../src/interaction/port.ts'

vi.mock('@deepseek-ai/dsh-agent-presets', () => ({
  serviceForAgent: vi.fn(),
}))

beforeEach(() => { vi.resetAllMocks() })

/** Deliberately synthetic events exercise malformed/missing evidence without executing tools. */
function bench(options: {
  readonly events?: unknown[]
  readonly cwd?: string | null
  readonly ownServices?: Record<string, unknown>
  readonly services?: Record<string, unknown>
} = {}) {
  const services: Record<string, unknown> = {
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { overrideOf: () => undefined, config: { policy: 'ask' } },
    permissionPresets: { resolve: () => ({ sandbox: 'read-only', approval: 'never' }) },
    ...options.services,
  }
  const ctx = { get: (name: string) => services[name] } as unknown as Context
  const own = { get: (name: string) => options.ownServices?.[name] } as unknown as Context
  const cwd = options.cwd === null ? undefined : options.cwd ?? 'D:\\workspace'
  const events = options.events ?? [call()]
  const agent = {
    ctx: own,
    session: { header: { cwd }, snapshotEvents: () => events },
  } as unknown as Agent
  return { ctx, agent, services }
}

function call(args = '{}', name = 'pwsh', callId = 'call') {
  return { type: 'tool/call', data: { callId, name, arguments: args } }
}

function evidence(options: Parameters<typeof bench>[0] = {}, tool = 'pwsh'): ApprovalEvidence {
  const { ctx, agent } = bench(options)
  return collectApprovalEvidence(ctx, agent, 'call', tool)
}

describe('approval source evidence', () => {
  it('preserves raw JSON boundaries and reads an absolute or session-relative shell directory', () => {
    const raw = '{ "command": "Write-Output \\\"a;b\\\"", "argv": ["a b", ";", "\\\\"], "workdir": "child", "sandbox_permissions": "danger-full-access" }'
    const result = evidence({ events: [call(raw)] })
    expect(result).toMatchObject({
      source: 'tool/call', arguments: raw, cwd: 'D:\\workspace\\child', missing: [],
      requestedPermission: { kind: 'sandbox-escalation', sandboxMode: 'danger-full-access' },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.missing)).toBe(true)
    expect(Object.isFrozen(result.currentPermission)).toBe(true)
    expect(evidence({ events: [call('{"workdir":"D:\\\\other"}')] }, 'pwsh').cwd).toBe('D:\\other')
    expect(evidence({ events: [call('{"workdir":"child"}', 'bash')] }, 'bash').cwd).toBe('D:\\workspace\\child')
    expect(evidence({ events: [call('{"workdir":"ignored"}', 'write')] }, 'write').cwd).toBe('D:\\workspace')
  })

  it('uses the exact nested dispatch arguments and never the parent run_code payload', () => {
    const nested = { type: 'tool/ptc-dispatch-start', data: { subCallId: 'call', name: 'write', arguments: { file_path: 'a.txt', content: 'a\nb' } } }
    expect(evidence({ events: [call('{"code":"parent"}', 'run_code', 'parent'), nested] }, 'write'))
      .toMatchObject({ source: 'tool/ptc-dispatch-start', arguments: '{"file_path":"a.txt","content":"a\\nb"}', missing: [] })
    expect(evidence({ events: [nested, { type: 'tool/ptc-dispatch', data: { subCallId: 'call' } }] }, 'write').missing)
      .toContain('matching unfinished tool call is missing or ambiguous')
    expect(evidence({ events: [{ type: 'tool/ptc-dispatch-start', data: { subCallId: 'other' } }, call()] }).missing).toEqual([])
  })

  it.each([
    [],
    [call('{}', 'bash')],
    [call(), call()],
    [call(), { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call' } } } }],
  ])('fails closed for missing, mismatched, duplicate, or settled call %#', (...events) => {
    expect(evidence({ events }).missing).toContain('matching unfinished tool call is missing or ambiguous')
  })

  it('ignores unrelated results and fails closed for invalid arguments or incomplete directory facts', () => {
    const unrelated = [
      { type: 'tool/result', data: { message: { source: { kind: 'plugin' } } } },
      { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'other' } } } },
      { type: 'tool/ptc-dispatch', data: { subCallId: 'other' } },
      { type: 'turn/start', data: {} },
    ]
    expect(evidence({ events: [call(), ...unrelated] }).missing).toEqual([])
    expect(evidence({ events: [call('{')] }).missing).toContain('tool arguments are not valid JSON')
    for (const args of ['null', '[]', '1']) {
      expect(evidence({ events: [call(args)] }).requestedPermission).toEqual({ kind: 'tool-call' })
    }
    expect(evidence({ cwd: null }).missing).toContain('working directory is unavailable')
    expect(evidence({ cwd: null, events: [call('{"workdir":"child"}')] }).cwd).toBeUndefined()
    expect(evidence({ events: [call('{"workdir":7}')] }).cwd).toBeUndefined()
    expect(evidence({ events: [call('{"sandbox_permissions":"unrestricted"}')] }).missing)
      .toContain('requested sandbox permission is invalid')
    expect(evidence({ services: { sandboxPolicy: { resolve: () => { throw new Error('offline') } } } }).missing)
      .toContain('current permission policy is unavailable')
  })

  it('does not treat incomplete evidence as allowing even when missing is empty', () => {
    const item = { kind: 'approval', evidence: { missing: [], source: 'tool/call' } } as unknown as PendingApprovalInteraction
    expect(approvalEvidenceError(item)).toContain('tool arguments are unavailable')
    expect(approvalEvidenceError({ ...item, evidence: evidence() })).toBeUndefined()
  })
})

describe('official permission facts', () => {
  it('prefers exact Agent services and reads official host policy services with the exact Session', () => {
    const local = bench({ ownServices: { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } } })
    expect(currentPermission(local.ctx, local.agent)).toEqual({ sandboxMode: 'read-only', approvalPolicy: 'ask' })
    vi.mocked(serviceForAgent).mockImplementation((_ctx, _agent, name) => local.services[name] as never)
    expect(presetPermission(local.ctx, local.agent, 'named-by-deployment'))
      .toEqual({ sandboxMode: 'read-only', approvalPolicy: 'never' })
    expect(serviceForAgent).toHaveBeenCalledWith(local.ctx, local.agent, 'permissionPresets')
    vi.mocked(serviceForAgent).mockReturnValue(undefined)
    const resolve = vi.fn(() => ({ mode: 'workspace-write' }))
    const host = bench({ services: { sandboxPolicy: { resolve } } })
    expect(currentPermission(host.ctx, host.agent)?.sandboxMode).toBe('workspace-write')
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ session: host.agent.session })
  })

  it('handles policy overrides, configured/default ask, and invalid or absent official metadata', () => {
    const configured = bench({ services: { approval: { overrideOf: () => 'never', config: { policy: 'ask' } } } })
    expect(currentPermission(configured.ctx, configured.agent)?.approvalPolicy).toBe('never')
    const defaultAsk = bench({ services: { approval: { overrideOf: () => undefined, config: {} } } })
    expect(currentPermission(defaultAsk.ctx, defaultAsk.agent)?.approvalPolicy).toBe('ask')
    for (const services of [
      { sandboxPolicy: undefined },
      { approval: undefined },
      { sandboxPolicy: { resolve: () => ({ mode: 'invalid' }) } },
      { approval: { overrideOf: () => 'auto-allow', config: {} } },
    ]) {
      const b = bench({ services })
      expect(currentPermission(b.ctx, b.agent)).toBeUndefined()
    }
    for (const permissionPresets of [undefined, { resolve: () => ({ sandbox: 'workspace-write', approval: 'bad' }) }]) {
      const b = bench({ services: { permissionPresets } })
      expect(presetPermission(b.ctx, b.agent, 'arbitrary')).toBeUndefined()
    }
  })

  it('treats sandbox growth and never-to-ask as widening without interpreting preset names', () => {
    expect(permissionWidens({ sandboxMode: 'read-only', approvalPolicy: 'ask' }, { sandboxMode: 'workspace-write', approvalPolicy: 'never' })).toBe(true)
    expect(permissionWidens({ sandboxMode: 'workspace-write', approvalPolicy: 'never' }, { sandboxMode: 'read-only', approvalPolicy: 'ask' })).toBe(true)
    expect(permissionWidens({ sandboxMode: 'danger-full-access', approvalPolicy: 'ask' }, { sandboxMode: 'read-only', approvalPolicy: 'never' })).toBe(false)
    expect(permissionWidens({ sandboxMode: 'read-only', approvalPolicy: 'never' }, { sandboxMode: 'read-only', approvalPolicy: 'never' })).toBe(false)
    expect(approvalPolicyDescription('never')).toContain('rejected automatically')
    expect(approvalPolicyDescription('ask')).toContain('fail closed')
  })
})
