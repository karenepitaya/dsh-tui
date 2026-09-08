import type { SettingsCatalogSnapshot, SettingsMutationRequest } from './port.ts'

export interface ProviderCustomDraft {
  readonly displayName: string
  readonly api: string
  readonly baseURL: string
  readonly modelId: string
}

type Data = Record<string, unknown>
const data = (value: unknown): Data => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Data : {}
const LABELS: Readonly<Record<string, string>> = {
  'openai-completions': 'OpenAI 兼容服务', 'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic 兼容服务', 'google-generative-ai': 'Google Gemini 兼容服务',
}

/** Protocol choices are taken from the mounted provider schema, not a second catalog. */
export function providerCustomApiChoices(snapshot: SettingsCatalogSnapshot): readonly { readonly id: string; readonly label: string }[] {
  const graph = data(snapshot.namespaces.find(entry => entry.namespace === 'llm-pi-ai')?.schema)
  const refs = data(graph.refs)
  const resolve = (node: unknown): Data => data(typeof node === 'number' ? refs[String(node)] : node)
  const root = graph.uid === undefined ? graph : resolve(graph.uid)
  const providers = resolve(data(root.dict).providers)
  const profile = resolve(providers.inner)
  const api = resolve(data(profile.dict).api)
  const choices = Array.isArray(api.list) ? api.list : []
  return choices.flatMap(input => {
    const choice = resolve(input)
    if (choice.type !== 'const' || typeof choice.value !== 'string') return []
    const description = data(choice.meta).description
    const label = typeof description === 'string' ? description : data(description).zh
    return [{ id: choice.value, label: typeof label === 'string' ? label : LABELS[choice.value] ?? choice.value }]
  })
}

export function createProviderCustomDraft(snapshot: SettingsCatalogSnapshot): ProviderCustomDraft {
  return { displayName: '', api: providerCustomApiChoices(snapshot)[0]?.id ?? '', baseURL: '', modelId: '' }
}

export function prepareProviderCustomCreation(snapshot: SettingsCatalogSnapshot, draft: ProviderCustomDraft):
  | { readonly providerId: string; readonly request: SettingsMutationRequest }
  | { readonly error: string; readonly field: keyof ProviderCustomDraft } {
  const namespace = snapshot.namespaces.find(entry => entry.namespace === 'llm-pi-ai')
  if (!snapshot.available || !snapshot.writable || snapshot.stale === true || namespace === undefined) {
    return { field: 'displayName', error: '当前无法添加提供商，请检查设置服务后重试。' }
  }
  const displayName = draft.displayName.trim()
  if (displayName === '' || /[\x00-\x1f\x7f]/u.test(displayName)) return { field: 'displayName', error: '请输入单行显示名称。' }
  if (!providerCustomApiChoices(snapshot).some(choice => choice.id === draft.api)) return { field: 'api', error: '请选择可用的服务类型。' }
  const baseURL = draft.baseURL.trim()
  try {
    const url = new URL(baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new Error()
  } catch {
    return { field: 'baseURL', error: '请输入 HTTP(S) 服务地址，不含登录信息、查询参数或片段。' }
  }
  const modelId = draft.modelId.trim()
  if (modelId === '' || /\s/u.test(modelId)) return { field: 'modelId', error: '请输入一个不含空格的模型 ID。' }
  const existing = new Set([...Object.keys(data(data(namespace.value).providers)), ...Object.keys(data(data(namespace.user).providers))])
  const name = displayName.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
  const base = 'custom-' + (name || 'service')
  let providerId = base
  for (let suffix = 2; existing.has(providerId); suffix++) providerId = `${base}-${suffix}`
  return { providerId, request: { namespace: namespace.namespace, path: ['providers', providerId], expectedRevision: namespace.revision,
    operation: 'set', value: { displayName, api: draft.api, baseURL, models: [{ id: modelId }] } } }
}
