import { describe, expect, it } from 'vitest'
import { createProviderCustomDraft, prepareProviderCustomCreation, providerCustomApiChoices } from '../src/settings/provider-custom.ts'
import type { SettingsCatalogSnapshot } from '../src/settings/port.ts'

function catalog(refs = false): SettingsCatalogSnapshot {
  const api = { type: 'union', list: [{ type: 'const', value: 'openai-completions' }, { type: 'const', value: 'new-protocol', meta: { description: '新协议' } }] }
  const schema = refs ? { uid: 1, refs: { 1: { type: 'object', dict: { providers: 2 } }, 2: { type: 'dict', inner: 3 }, 3: { type: 'object', dict: { api: 4 } }, 4: api } }
    : { type: 'object', dict: { providers: { type: 'dict', inner: { type: 'object', dict: { api } } } } }
  return { available: true, writable: true, documentBacked: true, generation: 1, namespaces: [{ namespace: 'llm-pi-ai', schema, value: { providers: { 'custom-service': {} } }, user: { providers: { 'custom-service-2': {} } }, revision: 8, applies: 'live', secrets: [] }] }
}
const draft = { displayName: '我的服务', api: 'openai-completions', baseURL: 'https://example.test/v1', modelId: 'chat-v1' }

describe('custom provider creation', () => {
  it.each([false, true])('reads only the mounted schema protocols and builds a secret-free draft (refs=%s)', refs => {
    expect(providerCustomApiChoices(catalog(refs))).toEqual([{ id: 'openai-completions', label: 'OpenAI 兼容服务' }, { id: 'new-protocol', label: '新协议' }])
    expect(createProviderCustomDraft(catalog(refs))).toEqual({ displayName: '', api: 'openai-completions', baseURL: '', modelId: '' })
    const result = prepareProviderCustomCreation(catalog(refs), draft)
    expect(result).toEqual({ providerId: 'custom-service-3', request: { namespace: 'llm-pi-ai', expectedRevision: 8, path: ['providers', 'custom-service-3'], operation: 'set', value: { displayName: '我的服务', api: 'openai-completions', baseURL: 'https://example.test/v1', models: [{ id: 'chat-v1' }] } } })
  })

  it.each([
    ['displayName', ''], ['displayName', 'line\nbreak'], ['api', 'unknown'],
    ['baseURL', 'not-a-url'], ['baseURL', 'file:///tmp'], ['baseURL', 'https://user:pass@example.test'],
    ['baseURL', 'https://example.test/?key=secret'], ['baseURL', 'https://example.test/#secret'],
    ['modelId', ''], ['modelId', 'two models'],
  ] as const)('rejects invalid %s without returning raw input', (field, value) => {
    const result = prepareProviderCustomCreation(catalog(), { ...draft, [field]: value })
    expect(result).toMatchObject({ field, error: expect.any(String) })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('does not mutate the catalog and keeps a stable ASCII id separate from the label', () => {
    const source = catalog()
    const before = JSON.stringify(source)
    expect(prepareProviderCustomCreation(source, { ...draft, displayName: '  My Service! ' })).toMatchObject({ providerId: 'custom-my-service', request: { value: { displayName: 'My Service!' } } })
    expect(JSON.stringify(source)).toBe(before)
  })

  it.each([{ available: false }, { writable: false }, { stale: true }, { namespaces: [] }])('does not create a provider when the settings service cannot accept writes (%j)', changes => {
    expect(prepareProviderCustomCreation({ ...catalog(), ...changes }, draft)).toMatchObject({ error: expect.any(String) })
  })

  it('has no guessed protocol when the provider schema is absent or does not expose a string enum', () => {
    const empty = { ...catalog(), namespaces: [] }
    expect(providerCustomApiChoices(empty)).toEqual([])
    expect(createProviderCustomDraft(empty).api).toBe('')
    expect(providerCustomApiChoices({ ...empty, namespaces: [{ ...catalog().namespaces[0]!, schema: { dict: { providers: { inner: { dict: { api: { list: [
      { type: 'const', value: 'third-party-protocol' },
      { type: 'const', value: 'localized', meta: { description: { zh: '本地化协议' } } },
    ] } } } } } } }] })).toEqual([
      { id: 'third-party-protocol', label: 'third-party-protocol' }, { id: 'localized', label: '本地化协议' },
    ])
    const source = catalog()
    const changed = { ...source, namespaces: [{ ...source.namespaces[0]!, schema: { type: 'object', dict: { providers: { type: 'dict', inner: { type: 'object', dict: { api: { type: 'union', list: [{ type: 'const', value: 1 }, { type: 'string' }] } } } } } } }] }
    expect(providerCustomApiChoices(changed)).toEqual([])
  })
})
