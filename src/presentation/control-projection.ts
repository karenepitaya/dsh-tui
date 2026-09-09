import { projectButton, projectChoiceRow, type ButtonModel, type ControlRole, type SelectionListItem } from 'pi-tui-orbs'

const tones = {
  text: 'primary', muted: 'muted', focus: 'accent', selected: 'accent',
  disabled: 'muted', button: 'primary', primary: 'accent', error: 'error',
  accent: 'accent', success: 'success',
} as const satisfies Record<ControlRole, string>

/** Adapt the shared control to renderer-neutral Frame / conversation segments. */
export function buttonSegment(model: ButtonModel) {
  const span = projectButton({ appearance: 'action', ...model })
  return { text: span.text, tone: tones[span.role], bold: span.role === 'focus' || span.role === 'primary' || span.role === 'error' }
}

/** Catalogs retain their domain labels; Orbs owns focus and check indicators. */
export function choiceText(label: string, selected: boolean, attributes: Omit<SelectionListItem, 'id' | 'label'> = {}): string {
  return projectChoiceRow({ id: label, label, ...attributes }, { selected })
    .map(span => span.text).join('')
}
