import type { PermissionPolicy } from './port.ts'

const sandboxRank = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

export function permissionWidens(current: PermissionPolicy, target: PermissionPolicy): boolean {
  return sandboxRank[target.sandboxMode] > sandboxRank[current.sandboxMode]
    || (current.approvalPolicy === 'never' && target.approvalPolicy === 'ask')
}

export function approvalPolicyDescription(policy: PermissionPolicy['approvalPolicy']): string {
  return policy === 'never'
    ? 'never: approval requests are rejected automatically'
    : 'ask: approval requests ask the user; unavailable answerers fail closed'
}
