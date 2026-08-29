export const CUSTOM_PERMISSION_VALUE = 'custom'

/** Detached presentation metadata from the official `permissions` projection. */
export interface SessionPermissionOption {
  readonly value: string
  readonly name: string
  readonly description?: string
  /** False for official derived states such as `custom`; they are never write targets. */
  readonly selectable: boolean
}

/** Last-good permission projection plus the availability of its official write command. */
export interface SessionPermissionSnapshot {
  readonly available: boolean
  readonly writable: boolean
  readonly stale: boolean
  readonly generation: number
  readonly selecting: boolean
  readonly currentValue?: string
  readonly options: readonly SessionPermissionOption[]
  readonly error?: string
}

export interface SessionPermissionSelectOptions {
  readonly signal?: AbortSignal
}

/** Product-owned seam over one exact Agent's official projection and command write path. */
export interface SessionPermissionPort {
  permissionSnapshot(): SessionPermissionSnapshot
  selectPermission(
    value: string,
    options?: SessionPermissionSelectOptions,
  ): Promise<void>
  onPermissionsChanged(listener: () => void): () => void
  disposePermissions(): void
}

const UNAVAILABLE_PERMISSION_SNAPSHOT: SessionPermissionSnapshot = Object.freeze({
  available: false,
  writable: false,
  stale: false,
  generation: 0,
  selecting: false,
  options: Object.freeze([]),
})

/** Compatibility seam for non-DSH tests and embedders. */
export function createUnavailableSessionPermissionPort(): SessionPermissionPort {
  return {
    permissionSnapshot: () => UNAVAILABLE_PERMISSION_SNAPSHOT,
    selectPermission: async () => {
      throw new Error('Permission presets are unavailable in this Session composition')
    },
    onPermissionsChanged: () => () => {},
    disposePermissions: () => {},
  }
}
