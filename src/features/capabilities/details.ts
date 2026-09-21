import { selectedSkill } from './skills-machine.ts'
import type { CapabilitiesFeatureState } from './machine.ts'
import {
  describeSkillResource,
  projectMcpBrowser,
  projectToolsBrowser,
} from './projectors.ts'

export interface CapabilitiesDetailField {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly description?: string
}

export interface CapabilitiesDetailsView {
  readonly title: string
  readonly fields: readonly CapabilitiesDetailField[]
}

function field(
  id: string,
  label: string,
  value: string,
  description?: string,
): CapabilitiesDetailField {
  return Object.freeze({
    id,
    label,
    value,
    ...(description === undefined ? {} : { description }),
  })
}

function skillsDetails(state: CapabilitiesFeatureState): CapabilitiesDetailsView | undefined {
  const selected = selectedSkill(state.skills)
  if (selected === undefined) return undefined
  const resource = describeSkillResource(selected)
  return Object.freeze({
    title: selected.name,
    fields: Object.freeze([
      field('name', 'Name', selected.name),
      field('description', 'Description', selected.description),
      ...(selected.whenToUse === undefined ? [] : [field('whenToUse', 'When to use', selected.whenToUse)]),
      field('source', 'Source', selected.source),
      field('provider', 'Provider', selected.provider),
      ...(resource === undefined ? [] : [field('resource', 'Resource', resource)]),
      field('usage', 'Usage', `Use /${selected.name} in Chat`),
      ...(selected.modelInvocable ? [field('agent', 'Agent', 'The agent can also choose this skill')] : []),
    ]),
  })
}

function parametersFields(
  parameterNames: readonly string[],
  requiredParameterNames: readonly string[],
): readonly CapabilitiesDetailField[] {
  return Object.freeze([
    field('parameters', 'Parameters', parameterNames.join(', ') || 'none'),
    field('required', 'Required', requiredParameterNames.join(', ') || 'none'),
  ])
}

function toolsDetails(state: CapabilitiesFeatureState): CapabilitiesDetailsView | undefined {
  const selected = projectToolsBrowser(state.tools)?.selected
  if (selected === undefined) return undefined
  return Object.freeze({
    title: selected.name,
    fields: Object.freeze([
      field('name', 'Name', selected.name),
      field('description', 'Description', selected.description),
      field('group', 'Group', selected.group),
      ...parametersFields(selected.parameterNames, selected.requiredParameterNames),
    ]),
  })
}

function mcpDetails(state: CapabilitiesFeatureState): CapabilitiesDetailsView | undefined {
  const selected = projectMcpBrowser(state.mcp)?.selected
  if (selected === undefined) return undefined
  return Object.freeze({
    title: `${selected.serverName} / ${selected.toolName}`,
    fields: Object.freeze([
      field('name', 'Name', `${selected.serverName} / ${selected.toolName}`),
      field('description', 'Description', selected.description),
      field('qualified', 'Qualified', selected.name),
      ...parametersFields(selected.parameterNames, selected.requiredParameterNames),
    ]),
  })
}

/** Read-only inspector content for the active tab selection, as plain display data. */
export function projectCapabilitiesDetails(
  state: CapabilitiesFeatureState,
): CapabilitiesDetailsView | undefined {
  switch (state.tab) {
    case 'skills': return skillsDetails(state)
    case 'tools': return toolsDetails(state)
    case 'mcp': return mcpDetails(state)
  }
}
