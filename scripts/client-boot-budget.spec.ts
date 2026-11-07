/**
 * Boot-budget ratchet for `ui-brand-enpoi`: the heavy tab bodies and the
 * xterm emulator must stay reachable only through package-local dynamic
 * imports. The spec walks the real static import graph of the client entry
 * with the TypeScript parser, so a new eager import fails without waiting for
 * a browser or a production build. Byte readings are informational only; no
 * threshold depends on a build artifact being present.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGE = 'packages/client/ui-brand-enpoi'
const CLIENT_ENTRY = `${PACKAGE}/src/client/index.ts`
const TERMINAL_VIEW = `${PACKAGE}/src/client/terminal/TerminalView.tsx`
const TERMINAL_LAZY = `${PACKAGE}/src/client/terminal/lazy-terminal-view.tsx`
const TERMINAL_REGISTRY = `${PACKAGE}/src/client/terminal/registry.ts`
const LAZY_BODIES = `${PACKAGE}/src/client/lazy-bodies.tsx`

/** Bodies that must ship as package-local chunks, never in the eager entry. */
const DEFERRED_BODIES = [
  `${PACKAGE}/src/client/WatchtowerView.tsx`,
  `${PACKAGE}/src/client/AgentModelsBody.tsx`,
  `${PACKAGE}/src/client/SubagentSessionsBody.tsx`,
  `${PACKAGE}/src/client/GitBody.tsx`,
  `${PACKAGE}/src/client/OrchestrationSettings.tsx`,
  `${PACKAGE}/src/client/PermissionsSettings.tsx`,
  `${PACKAGE}/src/client/dynamic/DynamicSettings.tsx`,
] as const

/** Heavy client rows whose emitted bytes the informational snapshot records. */
const HEAVY_ROWS = [
  'ui-brand-enpoi',
  'ui-settings-models',
  'ui-conversation',
  'ui-chat',
  'ui-trajectory',
  'ui-sidebar-right',
] as const

/** One recorded dynamic import edge. */
interface DynamicEdge {
  readonly from: string
  readonly to: string
}

/** The static module graph reachable from one source entry. */
interface StaticGraph {
  readonly files: readonly string[]
  readonly specifiers: ReadonlySet<string>
  readonly dynamicEdges: readonly DynamicEdge[]
}

const SOURCE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs']
const INDEX_SUFFIXES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx']

/** Read and parse one repository-relative source file. */
function parseSource(file: string): ts.SourceFile {
  const text = readFileSync(resolve(ROOT, file), 'utf8')
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

/** Whether an import declaration is erased at compile time. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (clause === undefined) return false
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true
  const bindings = clause.namedBindings
  // A default import is a runtime binding; only the named half may be type-only.
  if (clause.name !== undefined) return false
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return false
  return bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)
}

/** Static (runtime) module specifiers of one source file. */
function staticSpecifiers(source: ts.SourceFile): readonly string[] {
  const specifiers: string[] = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && !isTypeOnlyImport(statement)) {
      specifiers.push(statement.moduleSpecifier.text)
      continue
    }
    if (ts.isExportDeclaration(statement)
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
      && !statement.isTypeOnly) {
      specifiers.push(statement.moduleSpecifier.text)
    }
  }
  return specifiers
}

/** Dynamic `import()` specifiers anywhere in one source file. */
function dynamicSpecifiers(source: ts.SourceFile): readonly string[] {
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments
      if (first !== undefined && ts.isStringLiteral(first)) specifiers.push(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

/** Resolve a relative source specifier against the repository tree. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier))
  for (const suffix of SOURCE_SUFFIXES) {
    const candidate = `${base}${suffix}`
    if (existsSync(resolve(ROOT, candidate)) && statSync(resolve(ROOT, candidate)).isFile()) return candidate
  }
  for (const suffix of INDEX_SUFFIXES) {
    const candidate = posix.join(base, suffix)
    if (existsSync(resolve(ROOT, candidate)) && statSync(resolve(ROOT, candidate)).isFile()) return candidate
  }
  return undefined
}

/** Walk static imports from one entry; record dynamic edges without following them. */
function collectStaticGraph(entry: string): StaticGraph {
  const files: string[] = []
  const seen = new Set<string>()
  const specifiers = new Set<string>()
  const dynamicEdges: DynamicEdge[] = []
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    files.push(file)
    const source = parseSource(file)
    for (const specifier of staticSpecifiers(source)) {
      specifiers.add(specifier)
      if (!specifier.startsWith('.')) continue
      const target = resolveRelative(file, specifier)
      if (target !== undefined) queue.push(target)
    }
    for (const specifier of dynamicSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue
      const target = resolveRelative(file, specifier)
      if (target !== undefined) dynamicEdges.push({ from: file, to: target })
    }
  }
  return { files: files.sort(), specifiers, dynamicEdges }
}

/** Emitted client-bundle bytes for one workspace package, or null when not built here. */
function clientBundleBytes(name: string): number | null {
  const path = resolve(ROOT, `packages/client/${name}/lib/client.js`)
  return existsSync(path) ? statSync(path).size : null
}

describe('ui-brand-enpoi boot budget', () => {
  const graph = collectStaticGraph(CLIENT_ENTRY)
  const externalSpecifiers = [...graph.specifiers].filter(specifier => !specifier.startsWith('.'))

  it('keeps xterm and its stylesheet out of the eager client graph', () => {
    expect(externalSpecifiers.filter(specifier => specifier === '@xterm/xterm'
      || specifier === '@xterm/addon-fit'
      || specifier === '@xterm/xterm/css/xterm.css')).toEqual([])
    expect(externalSpecifiers.filter(specifier => specifier.startsWith('@xterm/'))).toEqual([])
  })

  it('keeps the emulator and every deferred body behind a dynamic import', () => {
    expect(graph.files).not.toContain(TERMINAL_VIEW)
    for (const body of DEFERRED_BODIES) expect(graph.files).not.toContain(body)
    expect(graph.dynamicEdges).toEqual(expect.arrayContaining([
      { from: TERMINAL_LAZY, to: TERMINAL_VIEW },
      ...DEFERRED_BODIES.map(body => ({ from: LAZY_BODIES, to: body })),
    ]))
  })

  it('proves the deferred module still owns the xterm imports', () => {
    const view = readFileSync(resolve(ROOT, TERMINAL_VIEW), 'utf8')
    expect(view).toContain("from '@xterm/xterm'")
    expect(view).toContain("from '@xterm/addon-fit'")
    expect(view).toContain("import '@xterm/xterm/css/xterm.css'")
    expect(existsSync(resolve(ROOT, `${PACKAGE}/src/client/terminal/styles.ts`))).toBe(false)
  })

  it('keeps terminal transport independent from the emulator module', () => {
    expect(graph.files).toContain(TERMINAL_REGISTRY)
    const registry = readFileSync(resolve(ROOT, TERMINAL_REGISTRY), 'utf8')
    expect(registry).not.toMatch(/@xterm\//u)
    expect(registry).toContain('WebSocket')
  })

  it('keeps the deferred chunk glob published', () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, `${PACKAGE}/package.json`), 'utf8')) as { files?: readonly string[] }
    expect(manifest.files).toContain('lib/client.*.js')
  })

  it('records heavy row sizes as an informational snapshot', () => {
    const snapshot: Record<string, number | null> = {}
    for (const row of HEAVY_ROWS) snapshot[row] = clientBundleBytes(row)
    const eagerSourceBytes = graph.files.reduce((sum, file) => sum + statSync(resolve(ROOT, file)).size, 0)
    console.info('[client-boot-budget] heavy client.js bytes:', JSON.stringify(snapshot))
    console.info('[client-boot-budget] eager ui-brand-enpoi source bytes:', eagerSourceBytes)
    expect(Object.keys(snapshot)).toEqual([...HEAVY_ROWS])
    for (const bytes of Object.values(snapshot)) {
      expect(bytes === null || (Number.isInteger(bytes) && bytes > 0)).toBe(true)
    }
    expect(eagerSourceBytes).toBeGreaterThan(0)
  })
})
