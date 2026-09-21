import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))

function sourceFiles(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return extname(entry.name) === '.ts' ? [path] : []
  })
}

function relativeSource(path: string): string {
  return relative(sourceRoot, path).replaceAll('\\', '/')
}

function offenders(
  files: readonly string[],
  pattern: RegExp,
): readonly string[] {
  return files
    .filter(path => pattern.test(readFileSync(path, 'utf8')))
    .map(relativeSource)
    .sort()
}

const allSourceFiles = sourceFiles(sourceRoot)
const allSourceFileSet = new Set(allSourceFiles)

function reachableSourceFiles(entry: string): readonly string[] {
  const queue = [entry]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const path = queue.pop()!
    if (visited.has(path)) continue
    visited.add(path)
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/gu,
    )) {
      const target = join(path, '..', match[1]!)
      const resolved = target.endsWith('.ts') ? target : `${target}.ts`
      if (allSourceFileSet.has(resolved)) queue.push(resolved)
    }
  }
  return [...visited]
}

function declarationPath(sourcePath: string): string {
  return sourcePath.replace(/\.ts$/u, '.d.ts')
}

function emittedDeclaration(path: string): string {
  return ts.transpileDeclaration(readFileSync(path, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2024,
    },
    fileName: path,
  }).outputText
}

function resolveDeclaration(
  declarations: ReadonlyMap<string, string>,
  parent: string,
  specifier: string,
): string | undefined {
  const target = resolve(dirname(parent), specifier)
  const candidates = specifier.endsWith('.ts') || specifier.endsWith('.js')
    ? [`${target.slice(0, -3)}.d.ts`]
    : [`${target}.d.ts`, join(target, 'index.d.ts')]
  return candidates.find(candidate => declarations.has(candidate))
}

function publicDeclarationGraphOffenders(entries: readonly string[]): readonly string[] {
  const declarations = new Map(allSourceFiles.map(path => (
    [declarationPath(path), path] as const
  )))
  const queue = entries.map(entry => declarationPath(join(sourceRoot, entry)))
  const visited = new Set<string>()
  const found: string[] = []
  while (queue.length > 0) {
    const path = queue.pop()!
    if (visited.has(path)) continue
    visited.add(path)
    const sourcePath = declarations.get(path)
    if (sourcePath === undefined) throw new Error(`Missing declaration for ${path}`)
    const source = emittedDeclaration(sourcePath)
    const officialImports = [...source.matchAll(
      /(?:from\s+|import\s*\()\s*['"](@deepseek-ai\/dsh-[^'"]+)['"]/gu,
    )].map(match => match[1]!)
    if (officialImports.length > 0) {
      found.push(
        `${relative(sourceRoot, path).replaceAll('\\', '/')}: ${officialImports.join(', ')}`,
      )
    }
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/gu,
    )) {
      const target = resolveDeclaration(declarations, path, match[1]!)
      if (target !== undefined) queue.push(target)
    }
  }
  return found.sort()
}

describe('architecture import boundaries', () => {
  const files = allSourceFiles

  it('keeps mutable coordinators and caches out of module scope', () => {
    const mutableConstructors = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])
    const violations: string[] = []
    for (const path of files) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue
        const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
        for (const declaration of statement.declarationList.declarations) {
          const name = declaration.name.getText(source)
          if (!isConst) {
            violations.push(`${relativeSource(path)}: module-level ${name} is not const`)
            continue
          }
          const initializer = declaration.initializer
          if (initializer !== undefined
            && ts.isNewExpression(initializer)
            && ts.isIdentifier(initializer.expression)
            && mutableConstructors.has(initializer.expression.text)) {
            violations.push(
              `${relativeSource(path)}: module-level ${name} constructs ${initializer.expression.text}`,
            )
          }
        }
      }
    }
    expect(violations).toEqual([])
  }, 30_000)

  it('keeps official DSH packages inside anti-corruption adapters', () => {
    const outsideAdapters = files.filter((path) => {
      const name = relativeSource(path)
      return !name.startsWith('dsh/')
        && !name.startsWith('compat/dsh-rc2/')
        && name !== 'plugin.ts'
    })
    expect(offenders(outsideAdapters, /from\s+['"]@deepseek-ai\/dsh/u)).toEqual([])
  })

  it('keeps reverse imports of DSH adapters out of product layers', () => {
    const productFiles = files.filter((path) => {
      const name = relativeSource(path)
      return !name.startsWith('dsh/')
        && !name.startsWith('adapters/')
        && !name.startsWith('compat/dsh-rc2/')
        && name !== 'index.ts'
        && name !== 'internal.ts'
        && name !== 'plugin.ts'
    })
    expect(offenders(productFiles, /from\s+['"][^'"]*\/dsh\//u)).toEqual([])
  })

  it('keeps Presentation independent from the retained UI toolkit', () => {
    const presentation = files.filter(path => relativeSource(path).startsWith('presentation/'))
    expect(offenders(presentation, /from\s+['"]@earendil-works\/pi-tui/u)).toEqual([])
  })

  it('keeps extension contracts and pure engines independent from Cordis', () => {
    const pureRoots = ['features/', 'kernel/', 'layout/', 'navigation/', 'preferences/', 'resource/']
    const pureFiles = files.filter(path => (
      pureRoots.some(root => relativeSource(path).startsWith(root))
      || relativeSource(path) === 'runtime/service.ts'
    ))
    expect(offenders(pureFiles, /from\s+['"]@deepseek-ai\/cordis/u)).toEqual([])
  })

  it.each([
    ['experimental', 'experimental.ts'],
    ['kernel', 'kernel-entry.ts'],
    ['Cordis adapter', 'adapters/cordis.ts'],
    ['legacy Chat feature', 'features/legacy-chat-entry.ts'],
    ['Sessions feature', 'features/sessions-entry.ts'],
    ['Activity feature', 'features/activity-entry.ts'],
    ['Diff feature', 'features/diff-entry.ts'],
    ['Models feature', 'features/models-entry.ts'],
    ['Modes feature', 'features/modes-entry.ts'],
    ['Capabilities feature', 'features/capabilities-entry.ts'],
    ['product', 'product.ts'],
    ['runtime service contract', 'runtime/service.ts'],
    ['runtime session contract', 'runtime/runtime-session.ts'],
    ['composition ownership contract', 'composition/ownership.ts'],
  ])('keeps the %s public source graph free of official DSH imports', (_label, entry) => {
    expect(offenders(
      reachableSourceFiles(join(sourceRoot, entry)),
      /(?:from\s+|import\s*\()\s*['"]@deepseek-ai\/dsh-/u,
    )).toEqual([])
  })

  it('keeps every non-DSH public declaration graph free of official DSH types', () => {
    expect(publicDeclarationGraphOffenders([
      'index.ts',
      'experimental.ts',
      'kernel-entry.ts',
      'adapters/cordis.ts',
      'features/legacy-chat-entry.ts',
      'features/sessions-entry.ts',
      'features/activity-entry.ts',
      'features/diff-entry.ts',
      'features/models-entry.ts',
      'features/modes-entry.ts',
      'features/capabilities-entry.ts',
      'product.ts',
      'runtime/service.ts',
      'runtime/runtime-session.ts',
      'composition/ownership.ts',
    ])).toEqual([])
  }, 30_000)

  it('keeps composition ownership context-scoped and launcher dependencies declared', () => {
    const ownership = readFileSync(join(sourceRoot, 'composition/ownership.ts'), 'utf8')
    const splitAdapter = readFileSync(join(sourceRoot, 'adapters/cordis.ts'), 'utf8')
    const rootPlugin = readFileSync(join(sourceRoot, 'plugin.ts'), 'utf8')

    expect(ownership).not.toMatch(/new (?:Map|WeakMap|Set|WeakSet)\s*[<(]/u)
    expect(ownership).not.toMatch(/^\s*let\s+/mu)
    expect(splitAdapter.indexOf('claimDshTuiComposition(')).toBeLessThan(
      splitAdapter.indexOf('provideDshTuiFeatures(ctx)'),
    )
    expect(rootPlugin.indexOf('claimDshTuiComposition(')).toBeLessThan(
      rootPlugin.indexOf('mountRootComposition('),
    )
    expect(rootPlugin).toContain("ctx.inject(['cmdlineArgs', 'appExit']")
    expect(rootPlugin).not.toContain("ctx.get('cmdlineArgs')")
    expect(rootPlugin).not.toContain("ctx.get('appExit')")
  })

  it('keeps the runtime session lease narrow and the legacy facade explicit', () => {
    const declaration = emittedDeclaration(join(sourceRoot, 'runtime/runtime-session.ts'))
    expect(declaration).toMatch(/export interface RuntimeSessionLease \{/u)
    expect(declaration).toMatch(/readonly core: RuntimeSessionCorePort/u)
    expect(declaration).toMatch(/readonly capabilities: RuntimeSessionCapabilityResolver/u)
    expect(declaration).toMatch(/asLegacyPort\(\): Promise<DshTuiSessionPort>/u)
    expect(declaration).toMatch(/release\(reason\?: unknown\): Promise<void>/u)
    expect(declaration).not.toMatch(/RuntimeSessionLease extends/u)
    expect(declaration).not.toMatch(/@deepseek-ai\/(?:cordis|dsh-)/u)
  })

  it('keeps the product runtime contract setup-free behind a compatible adapter export', () => {
    const runtimeService = join(sourceRoot, 'runtime/service.ts')
    const dshAdapter = readFileSync(join(sourceRoot, 'dsh/runtime-service.ts'), 'utf8')
    const declaration = emittedDeclaration(runtimeService)
    const dto = declaration.match(
      /export interface OpenDshTuiSessionOptions \{[\s\S]*?\n\}/u,
    )?.[0]

    expect(dto).toBeDefined()
    expect(dto).not.toMatch(/\bsetup\??\s*:/u)
    expect(readFileSync(runtimeService, 'utf8')).not.toMatch(
      /OpenDshTuiRuntimeOptions\s*=\s*Extract<OpenDshRuntimeOptions/u,
    )
    expect(dshAdapter).toMatch(
      /export type \{[\s\S]*?OpenDshTuiSessionOptions,[\s\S]*?\} from '\.\.\/runtime\/service\.ts'/u,
    )
  })
})
