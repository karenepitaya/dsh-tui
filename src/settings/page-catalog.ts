import type { SettingsCatalogSnapshot, SettingsNamespaceSnapshot } from './port.ts'
import type { SettingsField, SettingsFieldControl, SettingsSection } from './page-contracts.ts'

type Data = Record<string, unknown>
const GROUPS: Readonly<Record<string, string>> = {
  'dsh-tui': '界面与交互', permission: '权限', 'agent-presets': 'Agent 预设',
  'llm-deepseek': 'DeepSeek', 'llm-pi-ai': '模型提供方', shell: '终端',
  'agent-default-model': '新会话默认模型',
  'agent-loop': 'Agent 循环', 'web-search-deepseek': '网页搜索',
}
const LABELS: Readonly<Record<string, string>> = {
  preset: '主题', density: '显示密度', navigationKeys: '导航键', reducedMotion: '减少动画',
  layoutMode: '页面布局', defaultTranscriptMode: '对话显示', defaultPreset: '默认权限',
  default: '默认 Agent 预设', timeoutMs: '命令超时（毫秒）', maxTimeoutMs: '最长命令超时（毫秒）',
  maxOutputBytes: '单流输出上限（字节）', maxSpillBytes: '转存文件上限（字节）',
  graceMs: '结束等待时间（毫秒）', cwd: '工作目录', pwshPath: 'PowerShell 路径',
  maxParallelToolCalls: '并行工具调用数', baseURL: '服务地址', maxUses: '每次请求搜索上限',
  apiKey: 'API 密钥', apiKeyEnv: '认证凭据', displayName: '显示名称', api: 'API 协议',
  models: '模型目录', modelOverrides: '模型覆盖设置', headers: '请求头',
  maxTokens: '输出 token 上限', defaultMaxTokens: '默认输出 token 上限',
  defaultContextWindow: '默认上下文容量', retryPolicy: '重试策略',
  streamIdleTimeoutMs: '响应空闲超时（毫秒）', thinking: '思考模式', reasoningEffort: '推理强度',
  reasoning: '推理等级', transport: '连接方式', cacheRetention: '缓存保留',
  provider: '模型提供方', model: '模型 ID', defaultInput: '默认输入类型', compat: '协议兼容设置',
  thinkingBudgets: '思考预算', websocketConnectTimeoutMs: 'WebSocket 连接超时（毫秒）',
  maxRequestFilesBytes: '每次请求文件上限（字节）', maxInlineRequestImageBytes: '内联图片总上限（字节）',
  maxImagesPerRequest: '每次请求图片上限', imageOffloadByteQuantum: '图片转存字节粒度',
  inlineImageOffloadByteQuantum: '内联图片转存字节粒度', imageOffloadCountQuantum: '图片转存数量粒度',
  filesApiTimeoutMs: '文件服务超时（毫秒）', fileExpiresAfterSeconds: '文件有效期（秒）',
  fileRefreshMarginSeconds: '文件提前更新间隔（秒）', fileQuotaCleanupBatch: '每次清理文件数',
  maxRequestImageBytes: '每次请求图片总上限（字节）', requestImagePixelBudget: '图片像素预算',
  requestImageMaxBytes: '单张图片上限（字节）', palette: '自定义配色', colors: '兼容配色',
}
const TUI_COPY: Readonly<Record<string, string>> = {
  preset: '自动适配终端颜色能力。',
  density: '调整内容之间的间距。', navigationKeys: '选择常用的导航键位。',
  reducedMotion: '减少动画和动态效果。', layoutMode: '选择自动、单栏或分栏。',
  defaultTranscriptMode: '新会话默认使用精简或完整的对话显示。',
}
const OPTION_LABELS: Readonly<Record<string, string>> = {
  auto: '自动', cordis: 'Cordis', mono: '单色', compact: '紧凑', comfortable: '宽松',
  arrows: '方向键', vim: 'Vim 键位', both: '两者均可', single: '单栏', split: '分栏', verbose: '完整',
}
const TUI_ORDER: Readonly<Record<string, number>> = {
  'theme.preset': 0, density: 1, layoutMode: 2, navigationKeys: 3, reducedMotion: 4, defaultTranscriptMode: 5,
}
const TUI_GROUP: Readonly<Record<string, string>> = {
  'theme.preset': '外观', density: '外观', layoutMode: '外观',
  navigationKeys: '交互', reducedMotion: '交互', defaultTranscriptMode: '交互',
}
const HIDDEN: readonly string[] = Object.freeze(['version', 'namespace', 'revision', 'revisions', 'generation'])
const WEB_ONLY: readonly string[] = Object.freeze(['locale', 'ui-theme', 'ui-conversation', 'welcome-notice'])

function data(value: unknown): Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Data : {}
}

function at(value: unknown, path: readonly string[]): unknown {
  for (const key of path) value = data(value)[key]
  return value
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const localized = data(value)
  return typeof localized.zh === 'string' ? localized.zh : undefined
}

function section(namespace: string): SettingsSection {
  if (namespace === 'dsh-tui' || namespace === 'permission') return 'general'
  if (namespace.startsWith('llm-') || namespace === 'agent-default-model') return 'models'
  if (namespace === 'agent-presets') return 'presets'
  return 'plugins'
}

function scalar(value: unknown): boolean {
  return value === null || ['string', 'boolean', 'number'].includes(typeof value)
}

/** Project only the detached Settings schema; no Harness or credential service enters presentation. */
export function buildSettingsFields(snapshot: SettingsCatalogSnapshot): readonly SettingsField[] {
  const fields: SettingsField[] = []
  for (const namespace of snapshot.namespaces) {
    if (WEB_ONLY.includes(namespace.namespace)) continue
    projectNamespace(namespace, fields, snapshot.presetChoices)
  }
  const order = (field: SettingsField): number => field.namespace === 'dsh-tui' ? TUI_ORDER[field.path.join('.')] ?? 100 : 1000
  return Object.freeze(fields.sort((left, right) => order(left) - order(right)))
}

function projectNamespace(namespace: SettingsNamespaceSnapshot, fields: SettingsField[], presetChoices: SettingsCatalogSnapshot['presetChoices']): void {
  const graph = data(namespace.schema)
  const refs = data(graph.refs)
  const resolve = (node: unknown): Data => typeof node === 'number' ? data(refs[String(node)]) : data(node)
  const root = graph.uid === undefined ? graph : resolve(graph.uid)
  const group = GROUPS[namespace.namespace] ?? namespace.namespace
  const visit = (input: unknown, path: readonly string[], parentDefault?: unknown, ancestors: readonly Data[] = []): void => {
    const node = resolve(input)
    const meta = data(node.meta)
    const key = path.at(-1) ?? ''
    if (meta.hidden === true || key.startsWith('$') || HIDDEN.includes(key)) return
    const inherited = [at(namespace.base, path), parentDefault, meta.default].find(value => value !== undefined)
    const value = [at(namespace.value, path), inherited].find(entry => entry !== undefined)
    if (node.type === 'object' && !ancestors.includes(node)) {
      for (const [child, childNode] of Object.entries(data(node.dict))) {
        visit(childNode, [...path, child], data(parentDefault ?? meta.default)[child], [...ancestors, node])
      }
      return
    }
    if (node.type === 'dict' && namespace.namespace === 'llm-pi-ai' && path.join('.') === 'providers') {
      const providers = new Set([...Object.keys(data(value)), ...Object.keys(data(data(namespace.user).providers))])
      for (const provider of providers) visit(node.inner, [...path, provider])
      return
    }
    if (path.length === 0) return
    const secret = namespace.secrets.find(slot => slot.path.length === path.length && slot.path.every((part, index) => part === path[index]))
    const sensitive = secret !== undefined || meta.role === 'secret'
      || /^(?:api[_-]?key|password|secret|token|access[_-]?token|refresh[_-]?token|authorization)$/iu.test(key)
    const choices = Array.isArray(node.list) ? node.list.map(resolve) : []
    const enumeration = node.type === 'union' && choices.length > 0 && choices.every(choice => choice.type === 'const' && scalar(choice.value))
    let control: SettingsFieldControl = sensitive ? 'secret' : enumeration ? 'select'
      : node.type === 'boolean' ? 'boolean' : node.type === 'number' ? 'number' : node.type === 'string' ? 'text' : 'readonly'
    const credential = meta.role === 'credential-ref'
    const preset = namespace.namespace === 'agent-presets' && key === 'default'
    const presetOptions = preset ? presetChoices?.map(choice => ({ label: choice.name, value: choice.id })) : undefined
    if (presetOptions !== undefined && presetOptions.length > 0) control = 'select'
    if (meta.disabled === true || credential || (preset && control !== 'select')) control = 'readonly'
    const aggregate = typeof value === 'object' && value !== null
    if (!sensitive && aggregate && !Array.isArray(value) && Object.keys(value).length === 0) return
    if (aggregate) control = 'readonly'
    const summary = aggregate ? `${Object.keys(value).length} 项` : scalar(value) ? value : undefined
    const description = credential ? '密钥由凭据服务管理；请在连接设置中配置，不在此处填写密钥。'
      : preset ? '仅影响新会话，已有会话保持原预设；此页不编辑预设组成文件。'
        : namespace.namespace === 'permission' ? '仅影响此后新建的会话；当前会话权限保持不变。'
          : aggregate ? '复杂集合暂不支持逐项编辑；请使用专用设置入口或配置文件。'
            : namespace.namespace === 'dsh-tui' ? TUI_COPY[key] ?? '终端界面设置。'
              : text(meta.description) ?? (control === 'readonly' ? '此字段由当前部署管理。' : '保存后应用当前设置；恢复默认会移除用户覆盖。')
    fields.push(Object.freeze({
      id: JSON.stringify([namespace.namespace, ...path]), namespace: namespace.namespace, path: Object.freeze([...path]),
      section: section(namespace.namespace), group: namespace.namespace === 'llm-pi-ai' && path[0] === 'providers'
        ? `${group} · ${path[1]}` : namespace.namespace === 'dsh-tui' ? TUI_GROUP[path.join('.')] ?? group : group,
      label: LABELS[key] ?? key, description, control,
      value: sensitive ? undefined : credential ? '由凭据服务管理' : summary,
      ...(!sensitive && !credential && inherited !== undefined && scalar(inherited) ? { inheritedValue: inherited } : {}),
      overridden: at(namespace.user, path) !== undefined,
      ...(sensitive ? { secretSet: secret?.set ?? value !== undefined } : {}),
      ...(presetOptions !== undefined ? { options: Object.freeze(presetOptions) } : enumeration && !sensitive ? { options: Object.freeze(choices.map(choice => Object.freeze({
        label: text(data(choice.meta).description) ?? (namespace.namespace === 'dsh-tui' ? OPTION_LABELS[String(choice.value)] : undefined) ?? String(choice.value), value: choice.value,
      }))) } : {}),
      ...(typeof meta.min === 'number' ? { minimum: meta.min } : {}),
      ...(typeof meta.max === 'number' ? { maximum: meta.max } : {}),
      ...(meta.step === 1 ? { integer: true } : {}), applies: namespace.applies,
    }))
  }
  visit(root, [])
}
