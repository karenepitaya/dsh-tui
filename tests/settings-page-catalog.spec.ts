import { describe, expect, it } from 'vitest'
import { buildSettingsFields } from '../src/settings/page-catalog.ts'
import type { SettingsCatalogSnapshot, SettingsNamespaceSnapshot } from '../src/settings/port.ts'

function catalog(namespace: Partial<SettingsNamespaceSnapshot> = {}): SettingsCatalogSnapshot {
  return { available: true, writable: true, documentBacked: true, generation: 1, namespaces: [{
    namespace: 'dsh-tui', schema: {}, value: {}, revision: 3, applies: 'live', secrets: [], ...namespace,
  }] }
}
const preferences = {
  uid: 1, refs: {
    1: { type: 'object', dict: { version: 2, theme: 3, density: 7, navigationKeys: 11, reducedMotion: 15, layoutMode: 16, defaultTranscriptMode: 20 } },
    2: { type: 'const', value: 1 },
    3: { type: 'object', meta: { default: { preset: 'auto' } }, dict: { preset: 4, palette: 24 } },
    4: { type: 'union', list: [5, 6, 23] },
    5: { type: 'const', value: 'auto' }, 6: { type: 'const', value: 'cordis' }, 23: { type: 'const', value: 'mono' },
    7: { type: 'union', meta: { default: 'compact' }, list: [8, 9] },
    8: { type: 'const', value: 'compact' }, 9: { type: 'const', value: 'comfortable' },
    11: { type: 'union', list: [12, 13, 14] },
    12: { type: 'const', value: 'arrows' }, 13: { type: 'const', value: 'vim' }, 14: { type: 'const', value: 'both' },
    15: { type: 'boolean', meta: { default: false } },
    16: { type: 'union', list: [5, 17, 18] },
    17: { type: 'const', value: 'single' }, 18: { type: 'const', value: 'split' },
    20: { type: 'union', list: [8, 21] }, 21: { type: 'const', value: 'verbose' },
    24: { type: 'dict', inner: { type: 'string' }, meta: { default: {} } },
  },
}

describe('Settings page catalog', () => {
  it('projects real Schemastery references into named TUI controls and preserves inheritance', () => {
    const source = catalog({ schema: preferences, value: {
      version: 1, theme: { preset: 'mono', palette: {} }, density: 'comfortable', navigationKeys: 'both',
      reducedMotion: true, layoutMode: 'auto', defaultTranscriptMode: 'verbose',
    }, base: { density: 'comfortable' }, user: { theme: { preset: 'mono' }, reducedMotion: true } })
    const before = JSON.stringify(source)
    const fields = buildSettingsFields(source)
    expect(fields).toHaveLength(6)
    expect(fields.map(field => field.label)).toEqual(['主题', '显示密度', '页面布局', '导航键', '减少动画', '对话显示'])
    expect(fields.map(field => field.group)).toEqual(['外观', '外观', '外观', '交互', '交互', '交互'])
    expect(fields[0]).toMatchObject({ section: 'general', path: ['theme', 'preset'], control: 'select', value: 'mono', inheritedValue: 'auto', overridden: true })
    expect(fields[0]?.options).toEqual([{ label: '自动', value: 'auto' }, { label: 'Cordis', value: 'cordis' }, { label: '单色', value: 'mono' }])
    expect(fields[1]).toMatchObject({ inheritedValue: 'comfortable', overridden: false })
    expect(fields.find(field => field.path[0] === 'reducedMotion')).toMatchObject({ control: 'boolean', inheritedValue: false, overridden: true })
    expect(new Set(fields.map(field => field.id)).size).toBe(6)
    expect(JSON.stringify(source)).toBe(before)
    const permission = catalog({ namespace: 'permission', schema: { type: 'object', dict: { defaultPreset: { type: 'string' } } }, value: { defaultPreset: 'workspace' } }).namespaces[0]!
    const reverse = buildSettingsFields({ ...source, namespaces: [permission, ...source.namespaces] })
    expect(reverse[0]?.label).toBe('主题')
    expect(reverse.at(-1)).toMatchObject({ label: '默认权限', group: '权限' })
  })

  it('keeps supported plugin scalar constraints while summarizing collections without JSON', () => {
    const fields = buildSettingsFields(catalog({ namespace: 'shell', applies: 'restart', schema: { type: 'object', dict: {
      timeoutMs: { type: 'number', meta: { min: 1, max: 2000, step: 1, default: 1000 } },
      cwd: { type: 'string', meta: { description: { zh: '命令运行目录', en: 'Working directory' } } },
      enabled: { type: 'boolean' }, models: { type: 'array' }, headers: { type: 'dict' },
      disabled: { type: 'string', meta: { disabled: true } },
      empty: { type: 'object', dict: {} }, $internal: { type: 'string' }, revision: { type: 'number' },
      hidden: { type: 'string', meta: { hidden: true } },
    } }, value: { timeoutMs: 500, cwd: 'D:/work', enabled: false, models: [{ apiKey: 'DO_NOT_LEAK' }], headers: { Authorization: 'DO_NOT_LEAK' }, disabled: 'locked', hidden: 'invisible' } }))
    expect(fields[0]).toMatchObject({ label: '命令超时（毫秒）', section: 'plugins', control: 'number', minimum: 1, maximum: 2000, integer: true, inheritedValue: 1000, applies: 'restart' })
    expect(fields.find(field => field.path[0] === 'cwd')).toMatchObject({ control: 'text', description: '命令运行目录' })
    expect(fields.find(field => field.path[0] === 'models')).toMatchObject({ control: 'readonly', value: '1 项' })
    expect(fields.find(field => field.path[0] === 'disabled')?.control).toBe('readonly')
    expect(JSON.stringify(fields)).not.toContain('DO_NOT_LEAK')
    expect(fields.map(field => field.path[0])).not.toEqual(expect.arrayContaining(['empty', '$internal', 'revision', 'hidden']))
  })

  it('projects real provider dict paths and never exposes secrets or credential references as editors', () => {
    const source = catalog({ namespace: 'llm-pi-ai', schema: { type: 'object', dict: { providers: { type: 'dict', inner: { type: 'object', dict: {
      baseURL: { type: 'string' }, api: { type: 'union', list: [{ type: 'const', value: 'openai-completions', meta: { description: 'OpenAI Compatible' } }] },
      apiKey: { type: 'string', meta: { default: 'DEFAULT_SECRET' } },
      apiKeyEnv: { type: 'string', meta: { role: 'credential-ref' } }, models: { type: 'array' },
    } } } } }, value: { providers: { custom: { baseURL: 'https://example.test', api: 'openai-completions', apiKey: 'SECRET', apiKeyEnv: 'CREDENTIAL_NAME', models: [] } } }, base: { providers: { custom: { apiKey: 'BASE_SECRET' } } },
    user: { providers: { custom: { apiKey: 'USER_SECRET' } } }, secrets: [{ path: ['providers', 'custom', 'apiKey'], set: true }] })
    const fields = buildSettingsFields(source)
    expect(fields.find(field => field.path.at(-1) === 'baseURL')).toMatchObject({ section: 'models', path: ['providers', 'custom', 'baseURL'], control: 'text', group: '模型提供方 · custom' })
    expect(fields.find(field => field.path.at(-1) === 'apiKey')).toMatchObject({ control: 'secret', value: undefined, secretSet: true, overridden: true })
    expect(fields.find(field => field.path.at(-1) === 'apiKey')?.inheritedValue).toBeUndefined()
    expect(fields.find(field => field.path.at(-1) === 'apiKeyEnv')).toMatchObject({ control: 'readonly', value: '由凭据服务管理' })
    expect(JSON.stringify(fields)).not.toMatch(/SECRET|CREDENTIAL_NAME/u)
  })

  it('retains official default scopes and hides browser-only preferences', () => {
    const namespaces = ['permission', 'agent-presets', 'locale', 'ui-theme', 'ui-conversation'].map(namespace => ({ ...catalog().namespaces[0]!, namespace,
      schema: { type: 'object', dict: { [namespace === 'permission' ? 'defaultPreset' : 'default']: { type: 'string' } } },
      value: { defaultPreset: 'workspace', default: 'standard' },
    }))
    const fields = buildSettingsFields({ ...catalog(), namespaces })
    expect(fields).toHaveLength(2)
    expect(fields[0]).toMatchObject({ namespace: 'permission', section: 'general', label: '默认权限' })
    expect(fields[0]?.description).toContain('新建的会话')
    expect(fields[1]).toMatchObject({ namespace: 'agent-presets', section: 'presets', control: 'readonly' })
    expect(fields[1]?.description).toContain('预设')
  })

  it('uses advertised preset choices only and keeps missing scalar values editable without placeholder writes', () => {
    const source = catalog({ namespace: 'agent-presets', schema: { type: 'object', dict: { default: { type: 'string' } } }, value: { default: 'custom' } })
    expect(buildSettingsFields({ ...source, presetChoices: [{ id: 'custom', name: '我的助手' }] })[0]).toMatchObject({
      control: 'select', value: 'custom', options: [{ label: '我的助手', value: 'custom' }],
    })
    expect(buildSettingsFields({ ...source, presetChoices: [] })[0]?.control).toBe('readonly')
    const unknown = buildSettingsFields(catalog({ namespace: 'custom-plugin', schema: { type: 'object', dict: {
      title: { type: 'string', meta: { description: '用途说明' } },
      mode: { type: 'union', list: [{ type: 'const', value: 'quick' }, { type: 'const', value: null }] },
      password: { type: 'string', meta: { role: 'secret' } },
      key: { type: 'string', meta: { role: 'secret', disabled: true } },
    } }, value: { mode: null, key: 'DO_NOT_EXPOSE' } }))
    expect(unknown[0]).toMatchObject({ group: 'custom-plugin', label: 'title', control: 'text', value: undefined, description: '用途说明' })
    expect(unknown[1]?.options).toEqual([{ label: 'quick', value: 'quick' }, { label: 'null', value: null }])
    expect(unknown[2]).toMatchObject({ value: undefined, secretSet: false })
    expect(unknown[3]).toMatchObject({ control: 'readonly', value: undefined, secretSet: true })
    expect(JSON.stringify(unknown)).not.toContain('DO_NOT_EXPOSE')
  })

  it('handles absent schemas, future TUI fields and provider defaults without a user layer', () => {
    expect(buildSettingsFields({ ...catalog(), namespaces: [] })).toEqual([])
    expect(buildSettingsFields(catalog({ schema: undefined }))).toEqual([])
    expect(buildSettingsFields(catalog({ schema: { type: 'object', dict: { extra: { type: 'text' }, density: { type: 'string' } } }, value: { extra: 'future', density: 'compact' } })).find(field => field.path[0] === 'extra'))
      .toMatchObject({ description: '终端界面设置。', control: 'readonly' })
    const model = buildSettingsFields(catalog({ namespace: 'llm-pi-ai', schema: { type: 'object', dict: {
      providers: { type: 'dict', inner: { type: 'object', dict: { baseURL: { type: 'string' } } } },
    } }, value: { providers: { first: { baseURL: 'https://example.test' } } } }))
    expect(model[0]).toMatchObject({ section: 'models', group: '模型提供方 · first', overridden: false })
    expect(buildSettingsFields(catalog({ namespace: 'llm-pi-ai', schema: { type: 'object', dict: {
      providers: { type: 'dict', inner: { type: 'object', dict: { baseURL: { type: 'string' } } } },
    } }, value: { providers: { first: { baseURL: 'https://example.test' } } }, user: { providers: null } }))[0]?.value)
      .toBe('https://example.test')
    const defaultModel = buildSettingsFields(catalog({ namespace: 'agent-default-model', schema: { type: 'object', dict: { model: { type: 'string' } } }, value: { model: 'route/model' } }))
    expect(defaultModel[0]?.section).toBe('models')
  })
})
