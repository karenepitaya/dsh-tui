const direct = await import('../lib/index.js')
const self = await import('dsh-tui')

const expectedKeys = ['Config', 'apply', 'inject', 'name']
for (const [label, module] of [['direct', direct], ['self', self]]) {
  const keys = Object.keys(module).sort()
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${label} built DSH-TUI exports ${keys.join(', ')}, expected ${expectedKeys.join(', ')}`,
    )
  }
  if ('default' in module) {
    throw new Error(`${label} function plugin must not export default`)
  }
}
