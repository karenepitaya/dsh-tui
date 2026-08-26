/** One user-facing connection method advertised by the mounted DSH provider. */
export interface ProviderConnectionMethod {
  readonly id: string
  readonly label: string
}

export type ProviderCredentialKind =
  | 'api-key'
  | 'oauth'
  | 'reference'
  | 'ambient'
  | 'missing'

/** Secret-free credential state suitable for rendering in the TUI. */
export interface ProviderCredentialState {
  readonly kind: ProviderCredentialKind
  readonly configured: boolean
  readonly writable: boolean
  readonly source?: string
}

/** One dynamic row from DSH's configurable-provider directory. */
export interface ProviderConnectionEntry {
  readonly id: string
  readonly name: string
  readonly active: boolean
  readonly configured: boolean
  readonly connected: boolean
  readonly credential: ProviderCredentialState
  readonly methods: readonly ProviderConnectionMethod[]
  readonly canDisconnect: boolean
}

export interface ProviderConnectionSnapshot {
  readonly providers: readonly ProviderConnectionEntry[]
  readonly writable: boolean
}

/** A running official authorization flow's non-secret progress report. */
export interface ProviderAuthorizationNotice {
  readonly message: string
  readonly url?: string
  readonly code?: string
}

export interface ProviderAuthorizationPromptOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** Provider-neutral prompt vocabulary mirrored from DSH's authorization seam. */
export type ProviderAuthorizationPrompt = {
  readonly signal?: AbortSignal
} & (
  | {
      readonly kind: 'text'
      readonly message: string
      readonly placeholder?: string
    }
  | {
      readonly kind: 'secret'
      readonly message: string
      readonly placeholder?: string
    }
  | {
      readonly kind: 'select'
      readonly message: string
      readonly options: readonly ProviderAuthorizationPromptOption[]
    }
)

export interface ProviderAuthorizationInteraction {
  notify(notice: ProviderAuthorizationNotice): void
  prompt(prompt: ProviderAuthorizationPrompt): Promise<string>
}

/** A human dismissal, kept distinct from a broken interaction surface. */
export class ProviderAuthorizationDeclinedError extends Error {
  constructor(message = 'the provider authorization prompt was declined') {
    super(message)
    this.name = 'ProviderAuthorizationDeclinedError'
  }
}

export type ProviderConnectOutcome =
  | { readonly status: 'connected' }
  | { readonly status: 'cancelled' }

export interface ProviderConnectionOptions {
  readonly signal?: AbortSignal
}

/** Product-side adapter port. Harness types stop at src/dsh/provider-connection.ts. */
export interface ProviderConnectionPort {
  list(options?: ProviderConnectionOptions): Promise<ProviderConnectionSnapshot>

  connect(
    provider: string,
    method: string,
    interaction: ProviderAuthorizationInteraction,
    options?: ProviderConnectionOptions,
  ): Promise<ProviderConnectOutcome>

  disconnect(provider: string, options?: ProviderConnectionOptions): Promise<void>

  /** Provider/settings/credential topology changed; listeners re-read list(). */
  onChanged(listener: () => void): () => void
}
