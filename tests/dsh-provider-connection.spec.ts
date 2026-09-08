import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import { describe, expect, it, vi } from 'vitest'
import { DshProviderConnection } from '../src/dsh/provider-connection.ts'
import { ProviderAuthorizationDeclinedError } from '../src/provider/port.ts'

function descriptor(
  ns: string,
  value: unknown,
  user: unknown,
  revision: number,
): Record<string, unknown> {
  return { ns, schema: {}, value, user, revision, applies: 'live' }
}

function context(options: {
  active?: string[]
  directory?: Array<Record<string, unknown>>
  descriptors?: Array<Record<string, unknown>>
  flows?: Array<Record<string, unknown>>
  refConfigured?: boolean
  refWritable?: boolean
  refSource?: string | null
  refAbsent?: boolean
  recordConfigured?: boolean
  recordWritable?: boolean
  recordKind?: 'api-key' | 'grant'
  recordAbsent?: boolean
  settingsWritable?: boolean
  authorization?: boolean
  models?: Array<{ provider: string; id: string; name: string }>
  modelFailure?: boolean
} = {}): {
  readonly ctx: Context
  readonly mutate: ReturnType<typeof vi.fn>
  readonly set: ReturnType<typeof vi.fn>
  readonly unset: ReturnType<typeof vi.fn>
  readonly deleteRecord: ReturnType<typeof vi.fn>
  readonly begin: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly describeCredential: ReturnType<typeof vi.fn>
  readonly describeRecord: ReturnType<typeof vi.fn>
  readonly authorization: Record<string, unknown>
  readonly fake: Record<string, unknown>
  readonly listeners: Map<string, Set<(...args: unknown[]) => void>>
  readonly active: Set<string>
} {
  const active = new Set(options.active ?? ['deepseek-official'])
  const directory = options.directory ?? [
    {
      provider: 'deepseek-official', displayName: 'DeepSeek',
      settingsNs: 'llm-deepseek', settingsPath: [],
    },
    {
      provider: 'anthropic', displayName: 'Anthropic',
      settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: false,
    },
  ]
  const descriptors = options.descriptors ?? [
    descriptor('llm-deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY' }, {}, 3),
    descriptor('llm-pi-ai', { providers: {} }, { providers: {} }, 7),
  ]
  const flows = options.flows ?? [{
    key: 'llm-pi-ai/anthropic',
    label: 'Anthropic',
    methods: [
      { id: 'oauth', label: 'Sign in with Anthropic' },
      { id: 'api-key', label: 'Anthropic API key' },
    ],
    inFlight: false,
  }]
  const mutate = vi.fn(async (_ns: unknown, ops: Array<{ op: string; path: string[] }>) => {
    const setProfile = ops.find(op => op.op === 'set' && op.path.at(-1) === 'anthropic')
    const unsetProfile = ops.find(op => op.op === 'unset' && op.path.at(-1) === 'anthropic')
    if (setProfile !== undefined) active.add('anthropic')
    if (unsetProfile !== undefined) active.delete('anthropic')
  })
  const set = vi.fn(async () => undefined)
  const unset = vi.fn(async () => undefined)
  const deleteRecord = vi.fn(async () => undefined)
  const begin = vi.fn(async () => ({ status: 'authorized' as const }))
  const cancel = vi.fn()
  const authorization = { list: () => flows, begin, cancel }
  const describeCredential = vi.fn(async (ref: string) => options.refAbsent === true
    ? undefined
    : ({
        configured: options.refConfigured ?? ref === 'DEEPSEEK_API_KEY',
        ...(options.refSource === null
          ? {}
          : { source: options.refSource ?? 'file' }),
        writable: options.refWritable ?? true,
      }))
  const describeRecord = vi.fn(async () => options.recordAbsent === true
    ? undefined
    : ({
        configured: options.recordConfigured ?? false,
        kind: options.recordConfigured === true
          ? options.recordKind ?? 'grant'
          : undefined,
        writable: options.recordWritable ?? true,
      }))
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const settings = {
    writable: options.settingsWritable ?? true,
    describe: () => descriptors,
    mutate,
  }
  const credentials = {
    describe: describeCredential,
    set,
    unset,
    describeRecord,
    deleteRecord,
  }
  const fake = {
    llm: {
      listConfigurableProviders: () => directory,
      listProviders: () => [...active].map(id => ({ id, name: id })),
      listModels: vi.fn(async (provider: string) => {
        if (options.modelFailure === true) throw new Error('catalog failed with private detail')
        return options.models?.filter(model => model.provider === provider) ?? []
      }),
    },
    settings,
    credentials,
    get: (name: string) => {
      if (name === 'settings') return settings
      if (name === 'credentials') return credentials
      return name === 'authorization' && options.authorization !== false
        ? authorization
        : undefined
    },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      const group = listeners.get(name) ?? new Set()
      group.add(listener)
      listeners.set(name, group)
      return () => { group.delete(listener) }
    },
  }
  return {
    ctx: fake as unknown as Context,
    mutate,
    set,
    unset,
    deleteRecord,
    begin,
    cancel,
    describeCredential,
    describeRecord,
    authorization,
    fake,
    listeners,
    active,
  }
}

describe('DshProviderConnection', () => {
  it('exposes detached model and redacted settings metadata without copying profile secrets', async () => {
    const models = [{ provider: 'deepseek-official', id: 'chat', name: 'Chat' }]
    const fixture = context({
      models,
      descriptors: [
        descriptor('llm-deepseek', {
          baseURL: 'https://username:password@proxy.test/v1?api_key=private#secret',
          displayName: 'My gateway',
          api: 'openai-completions',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          headers: { Authorization: 'secret-header' },
        }, {}, 4),
        descriptor('llm-pi-ai', { providers: {} }, {}, 9),
      ],
    })
    const result = await new DshProviderConnection(fixture.ctx).list()
    expect(result.providers[0]).toMatchObject({
      models: [{ id: 'chat', name: 'Chat' }],
      configuration: {
        baseURL: 'https://proxy.test/v1',
        displayName: 'My gateway',
        api: 'openai-completions',
        namespace: 'llm-deepseek', path: [], revision: 4, writable: true,
      },
    })
    expect(result.providers[1]).toMatchObject({
      models: [],
      configuration: { namespace: 'llm-pi-ai', path: ['providers', 'anthropic'], revision: 9, writable: true },
    })
    models[0]!.name = 'mutated'
    expect(result.providers[0]?.models?.[0]?.name).toBe('Chat')
    expect(JSON.stringify(result)).not.toMatch(/password|private|secret-header|Authorization/)
    expect(fixture.mutate).not.toHaveBeenCalled()
  })

  it.each(['not a URL', 'file:///private/config'])('omits unusable endpoint metadata: %s', async baseURL => {
    const fixture = context({
      directory: [{ provider: 'route', displayName: 'Route', settingsNs: 'route', settingsPath: [] }],
      descriptors: [descriptor('route', { baseURL }, {}, 1)],
      active: ['route'],
      flows: [],
    })
    expect((await new DshProviderConnection(fixture.ctx).list()).providers[0]?.configuration?.baseURL).toBeUndefined()
  })

  it('keeps configuration available when a provider model catalog fails', async () => {
    const fixture = context({ modelFailure: true })
    const result = await new DshProviderConnection(fixture.ctx).list()
    expect(result.providers[0]).toMatchObject({
      models: [], modelError: 'Provider model catalog is unavailable',
    })
    expect(result.providers[1]?.modelError).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('private detail')
  })

  it('joins DSH official directory, live routes, settings, credentials, and authorization methods', async () => {
    const { ctx } = context()
    const adapter = new DshProviderConnection(ctx)

    const result = await adapter.list()

    expect(result.providers).toEqual([
      expect.objectContaining({
        id: 'deepseek-official',
        active: true,
        configured: true,
        connected: true,
        credential: {
          kind: 'reference', configured: true, source: 'file', writable: true,
        },
        methods: [{ id: 'api-key', label: 'Enter API key' }],
      }),
      expect.objectContaining({
        id: 'anthropic',
        active: false,
        configured: false,
        connected: false,
        methods: [
          { id: 'oauth', label: 'Sign in with Anthropic' },
          { id: 'api-key', label: 'Anthropic API key' },
        ],
      }),
    ])
  })

  it('runs an official authorization flow and materializes its dormant route', async () => {
    const { ctx, begin, mutate } = context()
    begin.mockImplementationOnce(async (request: {
      interaction: {
        notify(value: { message: string; url?: string }): void
        prompt(value: unknown): Promise<string>
      }
    }) => {
      request.interaction.notify({ message: 'Open browser', url: 'https://auth.test' })
      expect(await request.interaction.prompt({ kind: 'secret', message: 'API key' })).toBe('sk-test')
      return { status: 'authorized' as const }
    })
    const adapter = new DshProviderConnection(ctx)
    const notify = vi.fn()
    const abort = new AbortController()

    const result = await adapter.connect('anthropic', 'api-key', {
      notify,
      prompt: vi.fn(async () => 'sk-test'),
    }, { signal: abort.signal })

    expect(result).toEqual({ status: 'connected' })
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({
      key: 'llm-pi-ai/anthropic',
      method: 'api-key',
      signal: abort.signal,
    }))
    expect(notify).toHaveBeenCalledWith({
      message: 'Open browser', url: 'https://auth.test',
    })
    expect(mutate).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'anthropic'], value: {} }],
      7,
    )
  })

  it('uses the resolved native credential reference for a direct DeepSeek key', async () => {
    const { ctx, set, mutate } = context()
    const adapter = new DshProviderConnection(ctx)

    await adapter.connect('deepseek-official', 'api-key', {
      notify: vi.fn(),
      prompt: vi.fn(async prompt => {
        expect(prompt.kind).toBe('secret')
        return '  sk-deepseek  '
      }),
    })

    expect(set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-deepseek')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('maps a TUI decline into the official authorization cancellation vocabulary', async () => {
    const { ctx, begin } = context()
    begin.mockImplementationOnce(async (request: {
      interaction: { prompt(value: unknown): Promise<string> }
    }) => {
      await expect(request.interaction.prompt({ kind: 'text', message: 'Code' }))
        .rejects.toBeInstanceOf(AuthorizationDeclinedError)
      return { status: 'cancelled' as const }
    })
    const adapter = new DshProviderConnection(ctx)

    const result = await adapter.connect('anthropic', 'oauth', {
      notify: vi.fn(),
      prompt: vi.fn(async () => { throw new ProviderAuthorizationDeclinedError() }),
    })

    expect(result).toEqual({ status: 'cancelled' })
  })

  it('disconnects the official record and user profile without touching secret values', async () => {
    const { ctx, cancel, deleteRecord, mutate } = context({
      active: ['deepseek-official', 'anthropic'],
      recordConfigured: true,
      descriptors: [
        descriptor('llm-deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY' }, {}, 3),
        descriptor(
          'llm-pi-ai',
          { providers: { anthropic: {} } },
          { providers: { anthropic: {} } },
          8,
        ),
      ],
    })
    const adapter = new DshProviderConnection(ctx)

    await adapter.disconnect('anthropic')

    expect(cancel).toHaveBeenCalledWith('llm-pi-ai/anthropic')
    expect(deleteRecord).toHaveBeenCalledWith('llm-pi-ai/anthropic')
    expect(mutate).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{ op: 'unset', path: ['providers', 'anthropic'] }],
      8,
    )
  })

  it('projects OAuth, API-key, ambient, missing, and read-only credential states without secrets', async () => {
    const directory = [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'native', settingsPath: [] },
      { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'pi', settingsPath: ['providers', 'anthropic'] },
      { provider: 'openai', displayName: 'OpenAI', settingsNs: 'pi', settingsPath: ['providers', 'openai'] },
      { provider: 'amazon-bedrock', displayName: 'Bedrock', settingsNs: 'pi', settingsPath: ['providers', 'amazon-bedrock'] },
      { provider: 'missing', displayName: 'Missing', settingsNs: 'pi', settingsPath: ['providers', 'missing'] },
      { provider: 'dormant', displayName: 'Dormant', settingsNs: 'other', settingsPath: ['providers', 'dormant'] },
    ]
    const flows = [
      { key: 'pi/anthropic', label: 'Anthropic', methods: [{ id: 'oauth', label: 'OAuth' }] },
      { key: 'pi/openai', label: 'OpenAI', methods: [{ id: 'api-key', label: 'API key' }] },
    ]
    const fixture = context({
      active: ['deepseek-official', 'anthropic', 'openai', 'amazon-bedrock', 'missing'],
      directory,
      descriptors: [
        descriptor('native', { apiKeyEnv: 'DEEPSEEK_API_KEY' }, {}, 1),
        descriptor('pi', { providers: {
          anthropic: {},
          openai: {},
          'amazon-bedrock': {},
          missing: { apiKeyEnv: 'MISSING_API_KEY' },
        } }, { providers: {
          anthropic: {},
          openai: {},
          'amazon-bedrock': { region: 'us-east-1' },
          missing: { apiKeyEnv: 'MISSING_API_KEY' },
        } }, 2),
        descriptor('other', { providers: {} }, {}, 3),
      ],
      flows,
      refAbsent: true,
      recordAbsent: true,
    })
    fixture.describeCredential.mockImplementation(async (ref: string) => {
      if (ref === 'DEEPSEEK_API_KEY') return { configured: true, writable: false }
      if (ref === 'MISSING_API_KEY') return { configured: false, writable: true }
      return undefined
    })
    fixture.describeRecord.mockImplementation(async (key: string) => {
      if (key === 'pi/anthropic') return { configured: true, kind: 'grant', writable: true }
      if (key === 'pi/openai') return { configured: true, kind: 'api-key', writable: false }
      return undefined
    })

    const result = await new DshProviderConnection(fixture.ctx).list()
    const byId = new Map(result.providers.map(row => [row.id, row]))

    expect(byId.get('deepseek-official')?.credential).toEqual({
      kind: 'reference', configured: true, writable: false,
    })
    expect(byId.get('deepseek-official')?.canDisconnect).toBe(false)
    expect(byId.get('anthropic')?.credential.kind).toBe('oauth')
    expect(byId.get('anthropic')?.canDisconnect).toBe(true)
    expect(byId.get('openai')?.credential.kind).toBe('api-key')
    expect(byId.get('openai')?.canDisconnect).toBe(true)
    expect(byId.get('amazon-bedrock')?.credential).toEqual({
      kind: 'ambient', configured: true, writable: false,
    })
    expect(byId.get('amazon-bedrock')?.canDisconnect).toBe(false)
    expect(byId.get('missing')?.credential).toEqual({
      kind: 'missing', configured: false, writable: true,
    })
    expect(byId.get('dormant')?.credential).toEqual({
      kind: 'missing', configured: false, writable: false,
    })
  })

  it('uses a unique provider-id authorization fallback but rejects ambiguous flow ownership', async () => {
    const entry = {
      provider: 'anthropic', displayName: 'Anthropic',
      settingsNs: 'alternate', settingsPath: ['providers', 'anthropic'],
    }
    const single = context({
      active: [],
      directory: [entry],
      descriptors: [descriptor('alternate', { providers: {} }, {}, 1)],
      flows: [{
        key: 'llm-pi-ai/anthropic', label: 'Anthropic',
        methods: [{ id: 'oauth', label: 'OAuth' }],
      }],
    })
    expect((await new DshProviderConnection(single.ctx).list()).providers[0]?.methods)
      .toEqual([{ id: 'oauth', label: 'OAuth' }])

    const ambiguous = context({
      active: [],
      directory: [entry],
      descriptors: [descriptor('alternate', { providers: {} }, {}, 1)],
      flows: [
        { key: 'one/anthropic', label: 'One', methods: [{ id: 'oauth', label: 'One' }] },
        { key: 'two/anthropic', label: 'Two', methods: [{ id: 'oauth', label: 'Two' }] },
      ],
    })
    expect((await new DshProviderConnection(ambiguous.ctx).list()).providers[0]?.methods)
      .toEqual([])
  })

  it('fails closed on unavailable settings and observes aborts before and after list starts', async () => {
    const missing = context({
      directory: [{
        provider: 'orphan', displayName: 'Orphan',
        settingsNs: 'missing', settingsPath: ['providers', 'orphan'],
      }],
      descriptors: [],
      flows: [],
    })
    await expect(new DshProviderConnection(missing.ctx).list())
      .rejects.toThrow('unavailable settings namespace')

    const adapter = new DshProviderConnection(context({ directory: [] }).ctx)
    const noReason = { aborted: true, reason: undefined } as AbortSignal
    await expect(adapter.list({ signal: noReason })).rejects.toThrow('Provider operation aborted')

    const abort = new AbortController()
    const pending = adapter.list({ signal: abort.signal })
    abort.abort('late-list-abort')
    await expect(pending).rejects.toBe('late-list-abort')
  })

  it('names absent settings and credentials seams in optional Host compositions', async () => {
    const missingSettings = context()
    missingSettings.fake.get = () => undefined
    await expect(new DshProviderConnection(missingSettings.ctx).list())
      .rejects.toThrow('DSH settings service is unavailable')

    const missingCredentials = context()
    const settings = missingCredentials.fake.settings
    missingCredentials.fake.get = (name: unknown) => name === 'settings' ? settings : undefined
    await expect(new DshProviderConnection(missingCredentials.ctx).list())
      .rejects.toThrow('DSH credentials service is unavailable')
  })

  it('derives and persists direct pi-ai key references for dormant and configured routes', async () => {
    const route = {
      provider: 'acme-cloud', displayName: 'Acme Cloud',
      settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme-cloud'],
    }
    const dormant = context({
      active: [],
      directory: [route],
      descriptors: [descriptor('llm-pi-ai', { providers: {} }, { providers: {} }, 4)],
      flows: [],
      authorization: false,
    })
    const signal = new AbortController().signal
    const dormantAdapter = new DshProviderConnection(dormant.ctx)
    expect((await dormantAdapter.list()).providers[0]?.methods)
      .toEqual([{ id: 'api-key', label: 'Enter API key' }])
    await dormantAdapter.connect('acme-cloud', 'api-key', {
      notify: vi.fn(),
      prompt: vi.fn(async prompt => {
        expect(prompt.signal).toBe(signal)
        return ' acme-secret '
      }),
    }, { signal })
    expect(dormant.set).toHaveBeenCalledWith('ACME_CLOUD_API_KEY', 'acme-secret')
    expect(dormant.mutate).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{
        op: 'set', path: ['providers', 'acme-cloud'],
        value: { apiKeyEnv: 'ACME_CLOUD_API_KEY' },
      }],
      4,
    )

    const configured = context({
      active: ['acme-cloud'],
      directory: [route],
      descriptors: [descriptor(
        'llm-pi-ai',
        { providers: { 'acme-cloud': { baseURL: 'https://local.test/v1' } } },
        { providers: { 'acme-cloud': { baseURL: 'https://local.test/v1' } } },
        5,
      )],
      flows: [],
      authorization: false,
    })
    await new DshProviderConnection(configured.ctx).connect('acme-cloud', 'api-key', {
      notify: vi.fn(), prompt: vi.fn(async () => 'configured-secret'),
    })
    expect(configured.mutate).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'acme-cloud', 'apiKeyEnv'], value: 'ACME_CLOUD_API_KEY' }],
      5,
    )

    const alreadyNamed = context({
      active: ['acme-cloud'],
      directory: [route],
      descriptors: [descriptor(
        'llm-pi-ai',
        { providers: { 'acme-cloud': { apiKeyEnv: 'ACME_KEY' } } },
        { providers: { 'acme-cloud': { apiKeyEnv: 'ACME_KEY' } } },
        6,
      )],
      flows: [],
      authorization: false,
      refConfigured: false,
    })
    await new DshProviderConnection(alreadyNamed.ctx).connect('acme-cloud', 'api-key', {
      notify: vi.fn(), prompt: vi.fn(async () => 'named-secret'),
    })
    expect(alreadyNamed.set).toHaveBeenCalledWith('ACME_KEY', 'named-secret')
    expect(alreadyNamed.mutate).not.toHaveBeenCalled()
  })

  it('rejects unsupported direct methods, missing references, declined prompts, and prompt failures', async () => {
    const root = context({
      directory: [{
        provider: 'root-native', displayName: 'Root Native',
        settingsNs: 'root', settingsPath: [],
      }],
      descriptors: [descriptor('root', {}, {}, 1)],
      flows: [],
      authorization: false,
      active: ['root-native'],
    })
    const adapter = new DshProviderConnection(root.ctx)
    await expect(adapter.connect('root-native', 'oauth', {
      notify: vi.fn(), prompt: vi.fn(),
    })).rejects.toThrow('offers no connection method')
    await expect(adapter.connect('root-native', 'api-key', {
      notify: vi.fn(), prompt: vi.fn(),
    })).rejects.toThrow('does not expose an API-key credential reference')

    const direct = new DshProviderConnection(context({ flows: [], authorization: false }).ctx)
    await expect(direct.connect('deepseek-official', 'api-key', {
      notify: vi.fn(),
      prompt: vi.fn(async () => { throw new ProviderAuthorizationDeclinedError() }),
    })).resolves.toEqual({ status: 'cancelled' })
    await expect(direct.connect('deepseek-official', 'api-key', {
      notify: vi.fn(),
      prompt: vi.fn(async () => { throw new Error('prompt transport failed') }),
    })).rejects.toThrow('prompt transport failed')
  })

  it('keeps existing provider configuration during auth reconnects and disconnects', async () => {
    const configured = context({
      active: ['deepseek-official', 'anthropic'],
      recordConfigured: true,
      descriptors: [
        descriptor('llm-deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY' }, {}, 3),
        descriptor(
          'llm-pi-ai',
          { providers: { anthropic: { baseURL: 'https://proxy.test/v1' } } },
          { providers: { anthropic: { baseURL: 'https://proxy.test/v1' } } },
          9,
        ),
      ],
    })
    const adapter = new DshProviderConnection(configured.ctx)
    await adapter.connect('anthropic', 'oauth', {
      notify: vi.fn(), prompt: vi.fn(async () => 'unused'),
    })
    expect(configured.mutate).not.toHaveBeenCalled()

    await adapter.disconnect('anthropic')
    expect(configured.deleteRecord).toHaveBeenCalledWith('llm-pi-ai/anthropic')
    expect(configured.mutate).not.toHaveBeenCalled()
  })

  it('deactivates a connection-only profile before deleting writable credentials', async () => {
    const fixture = context({
      active: ['deepseek-official', 'anthropic'],
      recordConfigured: true,
      recordWritable: false,
      descriptors: [
        descriptor('llm-deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY' }, {}, 3),
        descriptor(
          'llm-pi-ai',
          { providers: { anthropic: {} } },
          { providers: { anthropic: {} } },
          10,
        ),
      ],
    })
    const adapter = new DshProviderConnection(fixture.ctx)
    expect((await adapter.list()).providers[1]?.canDisconnect).toBe(true)
    await adapter.disconnect('anthropic')
    expect(fixture.mutate).toHaveBeenCalled()
    expect(fixture.deleteRecord).not.toHaveBeenCalled()

    const readOnly = context({
      refConfigured: true,
      refWritable: false,
      settingsWritable: false,
      flows: [],
      authorization: false,
    })
    const readOnlyAdapter = new DshProviderConnection(readOnly.ctx)
    expect((await readOnlyAdapter.list()).providers[0]?.canDisconnect).toBe(false)
    await expect(readOnlyAdapter.disconnect('deepseek-official'))
      .rejects.toThrow('no removable local connection')
  })

  it('removes writable direct credentials and refuses unknown or settings-orphan targets', async () => {
    const direct = context({ flows: [], authorization: false })
    await new DshProviderConnection(direct.ctx).disconnect('deepseek-official')
    expect(direct.unset).toHaveBeenCalledWith('DEEPSEEK_API_KEY')

    await expect(new DshProviderConnection(direct.ctx).connect('unknown', 'api-key', {
      notify: vi.fn(), prompt: vi.fn(),
    })).rejects.toThrow('Unknown configurable Provider')

    const orphan = context({
      directory: [{
        provider: 'orphan', displayName: 'Orphan',
        settingsNs: 'missing', settingsPath: ['providers', 'orphan'],
      }],
      descriptors: [],
      flows: [],
    })
    await expect(new DshProviderConnection(orphan.ctx).disconnect('orphan'))
      .rejects.toThrow('unavailable settings namespace')
  })

  it('maps only deliberate TUI declines and propagates other official prompt failures', async () => {
    const fixture = context()
    fixture.begin.mockImplementationOnce(async (request: {
      interaction: { prompt(value: unknown): Promise<string> }
    }) => {
      await request.interaction.prompt({ kind: 'text', message: 'Code' })
      return { status: 'authorized' as const }
    })
    const adapter = new DshProviderConnection(fixture.ctx)
    await expect(adapter.connect('anthropic', 'oauth', {
      notify: vi.fn(),
      prompt: vi.fn(async () => { throw new Error('surface failed') }),
    })).rejects.toThrow('surface failed')
  })

  it('fans official topology events into one disposable change subscription', () => {
    const { ctx, listeners } = context()
    const adapter = new DshProviderConnection(ctx)
    const changed = vi.fn()
    const stop = adapter.onChanged(changed)

    for (const group of listeners.values()) for (const listener of group) listener()
    expect(changed).toHaveBeenCalledTimes(5)

    stop()
    for (const group of listeners.values()) for (const listener of group) listener()
    expect(changed).toHaveBeenCalledTimes(5)
  })
})
