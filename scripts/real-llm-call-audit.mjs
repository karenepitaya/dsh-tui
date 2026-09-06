import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

export const name = 'real-llm-call-audit'
export const inject = ['llm', 'tools']

/** Acceptance-only observation and fixture boundary; never grants tool permission. */
export function apply(ctx, config) {
  let calls = 0
  const record = value => appendFileSync(config.path, JSON.stringify(value) + '\n')
  const fixture = realpathSync(config.workspace)
  const readable = new Set(['AGENTS.md', 'README.md', 'calc.mjs', 'calc.test.mjs', 'unrelated.txt', 'denied.txt', 'definitely-missing-acceptance.txt'].map(name => join(fixture, name).toLowerCase()))
  const writable = new Set(['calc.mjs', 'denied.txt'].map(name => join(fixture, name).toLowerCase()))
  ctx.tools.guard(exec => {
    const args = exec.arguments ?? {}
    let safe = false
    if (['read', 'write', 'edit'].includes(exec.name) && typeof args.file_path === 'string') {
      const target = resolve(fixture, args.file_path)
      const allowed = exec.name === 'read' ? readable : writable
      safe = allowed.has(target.toLowerCase()) && (!existsSync(target)
        || (!lstatSync(target).isSymbolicLink() && realpathSync(target).toLowerCase() === target.toLowerCase()))
    } else if (exec.name === 'glob') {
      safe = resolve(fixture, args.path ?? '.').toLowerCase() === fixture.toLowerCase()
        && typeof args.pattern === 'string'
        && !args.pattern.includes('..') && !args.pattern.includes(':')
        && !/^[\\/]/u.test(args.pattern)
    } else if (exec.name === 'pwsh') {
      safe = /^node\s+(?:\.\/|\.\\)?calc\.test\.mjs\s*;?$/u.test(String(args.command).trim())
        && resolve(fixture, args.workdir ?? '.').toLowerCase() === fixture.toLowerCase()
        && args.run_in_background !== true
        && readFileSync(join(fixture, 'calc.mjs'), 'utf8').replace(/[\s;]/gu, '') === 'exportfunctionadd(a,b){returna+b}'
        && createHash('sha256').update(readFileSync(join(fixture, 'calc.test.mjs'))).digest('hex') === config.verificationSha256
    }
    if (safe) return undefined
    record({ event: 'scope-denied', tool: exec.name })
    return 'Acceptance scope permits only the named fixture files, glob within the fixture root, and node calc.test.mjs after the minimal addition fix.'
  })
  ctx.on('llm/stream', async function* (options, next) {
    const call = ++calls
    record({ event: 'start', call, provider: options.provider, model: options.model, purpose: options.purpose ?? 'conversation' })
    let completed = false
    try {
      yield* next()
      completed = true
    } finally {
      record({ event: 'end', call, completed })
    }
  }, { global: true, prepend: true })
}
