import type { DshTuiTheme } from './theme.ts'

/** Stable, app-local style reference; retained nodes never own a frozen old theme. */
export class ThemeBinding {
  readonly value: DshTuiTheme

  constructor(private current: DshTuiTheme) {
    const self = this
    this.value = Object.freeze({
      get preset() { return self.current.preset },
      get colorEnabled() { return self.current.colorEnabled },
      get styleEnabled() { return self.current.styleEnabled },
      get colorLevel() { return self.current.colorLevel },
      get semantic() { return self.current.semantic },
      get colors() { return self.current.colors },
      paint: (role, text) => this.current.paint(role, text),
      paintBackground: (role, text) => this.current.paintBackground(role, text),
      background: (color, text) => this.current.background(color, text),
      bold: text => this.current.bold(text),
      dim: text => this.current.dim(text),
      inverse: text => this.current.inverse(text),
      italic: text => this.current.italic(text),
      underline: text => this.current.underline(text),
    } satisfies DshTuiTheme)
  }

  update(theme: DshTuiTheme): void { this.current = theme }
}
