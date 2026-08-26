import type { Context } from '@deepseek-ai/cordis'
import {
  AuthorizationDeclinedError,
  type AuthorizationEntry,
  type AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import {
  credentialKeyId,
  credentialKeyScope,
  credentialRef,
  type CredentialProvider,
  type CredentialInfo,
  type CredentialRecordInfo,
} from '@deepseek-ai/dsh-credentials'
import {
  assertUsableApiKey,
  type LlmConfigurableProvider,
} from '@deepseek-ai/dsh-llm'
import {
  settingsNamespace,
  type SettingsProvider,
  type SettingsDescriptor,
} from '@deepseek-ai/dsh-settings'
import {
  ProviderAuthorizationDeclinedError,
  type ProviderAuthorizationInteraction,
  type ProviderAuthorizationPrompt,
  type ProviderConnectOutcome,
  type ProviderConnectionEntry,
  type ProviderConnectionOptions,
  type ProviderConnectionPort,
  type ProviderConnectionSnapshot,
  type ProviderCredentialState,
} from '../provider/port.ts'

interface ProviderFacts {
  readonly directory: LlmConfigurableProvider
  readonly descriptor: SettingsDescriptor
  readonly configured: boolean
  readonly removableProfile: boolean
  readonly apiKeyRef?: string
  readonly reference?: CredentialInfo
  readonly flow?: AuthorizationEntry
  readonly record?: CredentialRecordInfo
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root
  for (const segment of path) {
    const record = objectOf(current)
    if (record === undefined || !(segment in record)) return undefined
    current = record[segment]
  }
  return current
}

function hasAt(root: unknown, path: readonly string[]): boolean {
  /* v8 ignore next -- callers ask only about non-root configurable-provider paths */
  if (path.length === 0) return root !== undefined
  let current = root
  for (const segment of path) {
    const record = objectOf(current)
    if (record === undefined || !Object.prototype.hasOwnProperty.call(record, segment)) return false
    current = record[segment]
  }
  return true
}

function apiKeyRefOf(profile: unknown): string | undefined {
  const value = objectOf(profile)?.apiKeyEnv
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

function isConnectionOnlyProfile(value: unknown, apiKeyRef: string | undefined): boolean {
  const profile = objectOf(value)
  /* v8 ignore next -- a present provider profile has already passed its object schema */
  if (profile === undefined) return false
  const keys = Object.keys(profile)
  if (keys.length === 0) return true
  return keys.length === 1
    && keys[0] === 'apiKeyEnv'
    && apiKeyRef !== undefined
    && profile.apiKeyEnv === apiKeyRef
}

function canDisconnect(facts: ProviderFacts, settingsWritable: boolean): boolean {
  if (facts.removableProfile && settingsWritable) return true
  const credentials = [facts.record, facts.reference]
    .filter(item => item?.configured === true)
  return credentials.length > 0 && credentials.every(item => item!.writable)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new Error('Provider operation aborted')
}

function matchingFlow(
  entry: LlmConfigurableProvider,
  flows: readonly AuthorizationEntry[],
): AuthorizationEntry | undefined {
  const exact = flows.find(flow => (
    credentialKeyId(flow.key) === entry.provider
    && credentialKeyScope(flow.key) === entry.settingsNs
  ))
  if (exact !== undefined) return exact
  const byProvider = flows.filter(flow => credentialKeyId(flow.key) === entry.provider)
  return byProvider.length === 1 ? byProvider[0] : undefined
}

function credentialState(
  active: boolean,
  reference: CredentialInfo | undefined,
  record: CredentialRecordInfo | undefined,
): ProviderCredentialState {
  if (record?.configured === true) {
    return {
      kind: record.kind === 'grant' ? 'oauth' : 'api-key',
      configured: true,
      writable: record.writable,
    }
  }
  if (reference?.configured === true) {
    return {
      kind: 'reference',
      configured: true,
      writable: reference.writable,
      ...(reference.source === undefined ? {} : { source: reference.source }),
    }
  }
  if (reference === undefined && active) {
    return { kind: 'ambient', configured: true, writable: false }
  }
  return {
    kind: 'missing',
    configured: false,
    writable: record?.writable ?? reference?.writable ?? false,
  }
}

/**
 * Thin adapter over DSH's official llm/settings/credentials/authorization seams.
 * Provider identities and login methods are discovered at runtime; none are
 * enumerated by the TUI.
 */
export class DshProviderConnection implements ProviderConnectionPort {
  constructor(private readonly ctx: Context) {}

  async list(options: ProviderConnectionOptions = {}): Promise<ProviderConnectionSnapshot> {
    throwIfAborted(options.signal)
    const settings = this.settings()
    const credentials = this.credentials()
    const directory = this.ctx.llm.listConfigurableProviders()
    const active = new Set(this.ctx.llm.listProviders().map(provider => provider.id))
    const descriptors = new Map(
      settings.describe({ redactSecrets: true }).map(item => [String(item.ns), item]),
    )
    const flows = this.ctx.get('authorization')?.list() ?? []
    const providers = await Promise.all(directory.map(async (entry) => {
      const descriptor = descriptors.get(entry.settingsNs)
      if (descriptor === undefined) {
        throw new Error(
          `Provider "${entry.provider}" references unavailable settings namespace "${entry.settingsNs}"`,
        )
      }
      const facts = await this.facts(entry, descriptor, flows, credentials, options.signal)
      const isActive = active.has(entry.provider)
      const credential = credentialState(isActive, facts.reference, facts.record)
      const methods = facts.flow?.methods.map(method => ({ ...method }))
        ?? (facts.apiKeyRef !== undefined || this.canDerivePiAiRef(entry)
          ? [{ id: 'api-key', label: 'Enter API key' }]
          : [])
      return Object.freeze({
        id: entry.provider,
        name: entry.displayName,
        active: isActive,
        configured: facts.configured,
        connected: isActive && credential.configured,
        credential: Object.freeze(credential),
        methods: Object.freeze(methods),
        canDisconnect: canDisconnect(facts, settings.writable),
      }) satisfies ProviderConnectionEntry
    }))
    throwIfAborted(options.signal)
    return Object.freeze({
      providers: Object.freeze(providers),
      writable: settings.writable,
    })
  }

  async connect(
    provider: string,
    method: string,
    interaction: ProviderAuthorizationInteraction,
    options: ProviderConnectionOptions = {},
  ): Promise<ProviderConnectOutcome> {
    const target = await this.target(provider, options.signal)
    const authorization = this.ctx.get('authorization')
    const offered = target.flow?.methods.find(candidate => candidate.id === method)
    if (target.flow !== undefined && offered !== undefined && authorization !== undefined) {
      const outcome = await authorization.begin({
        key: target.flow.key,
        method,
        interaction: {
          notify: notice => { interaction.notify({ ...notice }) },
          prompt: prompt => this.authorizePrompt(interaction, prompt),
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (outcome.status === 'cancelled') return { status: 'cancelled' }
      throwIfAborted(options.signal)
      await this.ensureProfile(target, {})
      return { status: 'connected' }
    }
    if (method !== 'api-key' || target.flow !== undefined) {
      throw new Error(`Provider "${provider}" offers no connection method "${method}"`)
    }
    const ref = target.apiKeyRef
      ?? (this.canDerivePiAiRef(target.directory) ? deriveKeyRef(provider) : undefined)
    if (ref === undefined) {
      throw new Error(`Provider "${provider}" does not expose an API-key credential reference`)
    }
    let answer: string
    try {
      answer = await interaction.prompt({
        kind: 'secret',
        message: `Enter API key for ${target.directory.displayName}`,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (error instanceof ProviderAuthorizationDeclinedError) return { status: 'cancelled' }
      throw error
    }
    throwIfAborted(options.signal)
    const value = assertUsableApiKey(answer, 'dsh-tui', ref)
    await this.credentials().set(credentialRef(ref), value)
    throwIfAborted(options.signal)
    await this.ensureDirectProfile(target, ref)
    return { status: 'connected' }
  }

  async disconnect(provider: string, options: ProviderConnectionOptions = {}): Promise<void> {
    const target = await this.target(provider, options.signal)
    const settings = this.settings()
    const credentials = this.credentials()
    const removeProfile = target.removableProfile && settings.writable
    if (!canDisconnect(target, settings.writable)) {
      throw new Error(`Provider "${provider}" has no removable local connection`)
    }
    const authorization = this.ctx.get('authorization')
    if (target.flow !== undefined) authorization?.cancel(target.flow.key)
    if (removeProfile) {
      await settings.mutate(
        settingsNamespace(target.directory.settingsNs),
        [{ op: 'unset', path: [...target.directory.settingsPath] }],
        target.descriptor.revision,
      )
    }
    throwIfAborted(options.signal)
    if (target.record?.configured === true && target.record.writable) {
      await credentials.deleteRecord(target.flow!.key)
    }
    throwIfAborted(options.signal)
    if (target.reference?.configured === true && target.reference.writable) {
      await credentials.unset(credentialRef(target.apiKeyRef!))
    }
  }

  onChanged(listener: () => void): () => void {
    const stops = [
      this.ctx.on('llm/adapters-updated', () => { listener() }),
      this.ctx.on('settings/document-updated', () => { listener() }),
      this.ctx.on('credentials/reference-updated', () => { listener() }),
      this.ctx.on('credentials/record-updated', () => { listener() }),
      this.ctx.on('authorization/settled', () => { listener() }),
    ]
    return () => { for (const stop of stops) stop() }
  }

  private async authorizePrompt(
    interaction: ProviderAuthorizationInteraction,
    prompt: AuthorizationPrompt,
  ): Promise<string> {
    try {
      return await interaction.prompt(prompt as ProviderAuthorizationPrompt)
    } catch (error) {
      if (error instanceof ProviderAuthorizationDeclinedError) {
        throw new AuthorizationDeclinedError(error.message)
      }
      throw error
    }
  }

  private canDerivePiAiRef(entry: LlmConfigurableProvider): boolean {
    return entry.settingsNs === 'llm-pi-ai' && entry.settingsPath.length > 0
  }

  private settings(): SettingsProvider {
    const settings = this.ctx.get('settings')
    if (settings === undefined) throw new Error('DSH settings service is unavailable')
    return settings
  }

  private credentials(): CredentialProvider {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) throw new Error('DSH credentials service is unavailable')
    return credentials
  }

  private async target(
    provider: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderFacts> {
    throwIfAborted(signal)
    const entry = this.ctx.llm.listConfigurableProviders().find(item => item.provider === provider)
    if (entry === undefined) throw new Error(`Unknown configurable Provider "${provider}"`)
    const settings = this.settings()
    const credentials = this.credentials()
    const descriptor = settings.describe({ redactSecrets: true })
      .find(item => String(item.ns) === entry.settingsNs)
    if (descriptor === undefined) {
      throw new Error(
        `Provider "${provider}" references unavailable settings namespace "${entry.settingsNs}"`,
      )
    }
    const flows = this.ctx.get('authorization')?.list() ?? []
    return await this.facts(entry, descriptor, flows, credentials, signal)
  }

  private async facts(
    directory: LlmConfigurableProvider,
    descriptor: SettingsDescriptor,
    flows: readonly AuthorizationEntry[],
    credentials: CredentialProvider,
    signal: AbortSignal | undefined,
  ): Promise<ProviderFacts> {
    const profile = valueAt(descriptor.value, directory.settingsPath)
    const configured = directory.settingsPath.length === 0 || profile !== undefined
    const userConfigured = directory.settingsPath.length > 0
      && hasAt(descriptor.user, directory.settingsPath)
    const apiKeyRef = apiKeyRefOf(profile)
    const removableProfile = userConfigured
      && isConnectionOnlyProfile(valueAt(descriptor.user, directory.settingsPath), apiKeyRef)
    const flow = matchingFlow(directory, flows)
    const [reference, record] = await Promise.all([
      apiKeyRef === undefined
        ? Promise.resolve(undefined)
        : credentials.describe(credentialRef(apiKeyRef)),
      flow === undefined
        ? Promise.resolve(undefined)
        : credentials.describeRecord(flow.key),
    ])
    throwIfAborted(signal)
    return {
      directory,
      descriptor,
      configured,
      removableProfile,
      ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
      ...(reference === undefined ? {} : { reference }),
      ...(flow === undefined ? {} : { flow }),
      ...(record === undefined ? {} : { record }),
    }
  }

  private async ensureProfile(target: ProviderFacts, value: object): Promise<void> {
    if (target.directory.settingsPath.length === 0 || target.configured) return
    await this.settings().mutate(
      settingsNamespace(target.directory.settingsNs),
      [{ op: 'set', path: [...target.directory.settingsPath], value }],
      target.descriptor.revision,
    )
  }

  private async ensureDirectProfile(target: ProviderFacts, ref: string): Promise<void> {
    const path = target.directory.settingsPath
    if (path.length === 0 || target.apiKeyRef !== undefined) return
    const op = target.configured
      ? { op: 'set' as const, path: [...path, 'apiKeyEnv'], value: ref }
      : { op: 'set' as const, path: [...path], value: { apiKeyEnv: ref } }
    await this.settings().mutate(
      settingsNamespace(target.directory.settingsNs),
      [op],
      target.descriptor.revision,
    )
  }
}
