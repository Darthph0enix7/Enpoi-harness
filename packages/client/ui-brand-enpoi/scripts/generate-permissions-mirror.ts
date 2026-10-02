/**
 * Permissions-mirror generator — the client's shipped-default + role-surface
 * mirror of HOST-OWNED policy data.
 *
 * Sources (all read-only):
 *   - host policy defaults + seat guard: `$DSH_HOST_POLICY_FILE` or
 *     `~/.dsh/profiles/web/packages/enpoi-capabilities/src/policy.ts`
 *     (`SHIPPED_TOOL_DEFAULTS`, `SHIPPED_TOOL_DEFAULT_EXEMPTIONS`,
 *     `SHIPPED_SEAT_TOOL_DENY`);
 *   - tool-group catalog: `$DSH_TOOL_GROUPS_FILE` or
 *     `~/.dsh/profiles/web/packages/enpoi-tool-groups/src/catalog.ts`
 *     (`SHIPPED_TOOL_GROUPS`) — the Permissions page derives its family rows
 *     from this list so the two systems cannot drift;
 *   - child role tables: `packages/subagent/tool-subagent/src/index.ts`
 *     (`SHARED_CHILD_KEEP`, `SHARED_CHILD_DENY`, `ROLE_CHILD_DENY`);
 *   - main-agent advertised surface: `$DSH_TOOL_INVENTORY_DIR` or
 *     `scripts/tool-inventory/expected-orchestrator.json`.
 *
 * Output: `packages/client/ui-brand-enpoi/src/client/permissions-defaults.generated.ts`.
 *
 * Usage:
 *   pnpm exec tsx packages/client/ui-brand-enpoi/scripts/generate-permissions-mirror.ts --write
 *   pnpm exec tsx packages/client/ui-brand-enpoi/scripts/generate-permissions-mirror.ts --check
 *
 * `--check` exits 1 and prints the first differing lines when the committed
 * mirror drifts from the sources. A missing host policy file is reported and
 * treated as a skip (exit 0): machines without the deployment profile can
 * still run the client suite, and the host repo's own completeness spec
 * verifies the digest from the other side.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')

/** Filesystem locations the mirror is built from and written to. */
export interface MirrorPaths {
  hostPolicy: string
  toolGroups: string
  roleSource: string
  operatorFixture: string
  output: string
}

/** One shipped tool group, mirrored from the profile catalog. */
export interface MirrorToolGroup {
  id: string
  label: string
  purpose: string
  mode: string
  members: string[]
  preAttach: string[]
  seats?: string[]
  enabled: boolean
}

/** The canonical payload embedded in the generated module. */
export interface MirrorData {
  shippedToolDefaults: Record<string, string>
  shippedToolDefaultExemptions: Array<{ prefix: string; reason: string }>
  toolGroups: MirrorToolGroup[]
  seatToolDeny: Record<string, string[]>
  sharedChildKeep: string[]
  sharedChildDeny: string[]
  roleChildDeny: Record<string, string[]>
  operatorSurface: string[]
}

/** Resolve the default source/output locations (environment overridable). */
export function mirrorPaths(): MirrorPaths {
  return {
    hostPolicy: process.env.DSH_HOST_POLICY_FILE
      ?? join(homedir(), '.dsh', 'profiles', 'web', 'packages', 'enpoi-capabilities', 'src', 'policy.ts'),
    toolGroups: process.env.DSH_TOOL_GROUPS_FILE
      ?? join(homedir(), '.dsh', 'profiles', 'web', 'packages', 'enpoi-tool-groups', 'src', 'catalog.ts'),
    roleSource: join(REPO_ROOT, 'packages', 'subagent', 'tool-subagent', 'src', 'index.ts'),
    operatorFixture: join(
      process.env.DSH_TOOL_INVENTORY_DIR ?? join(REPO_ROOT, 'scripts', 'tool-inventory'),
      'expected-orchestrator.json',
    ),
    output: join(HERE, '..', 'src', 'client', 'permissions-defaults.generated.ts'),
  }
}

/** Parse one TS source file (comments preserved; the AST ignores them). */
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

/** The initializer of a top-level `const`/`let` declaration by name. */
function initializerOf(source: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined) {
          found = declaration.initializer
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Unwrap `Object.freeze(x)` / `x as T`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression
  if (ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === 'freeze'
    && current.arguments.length === 1) {
    current = current.arguments[0] as ts.Expression
  }
  return current
}

/** Read one string literal property/element. */
function stringValue(node: ts.Expression | undefined, context: string): string {
  if (node === undefined || !ts.isStringLiteralLike(node)) throw new Error(`${context}: expected a string literal`)
  return node.text
}

/** Read an array literal of string literals. */
function stringArray(node: ts.Expression, context: string): string[] {
  const array = unwrap(node)
  if (!ts.isArrayLiteralExpression(array)) throw new Error(`${context}: expected an array literal`)
  return array.elements.map(element => stringValue(element, context))
}

/** The property name of an object literal member, when it is a plain key. */
function propertyName(member: ts.ObjectLiteralElementLike, context: string): string {
  if (!ts.isPropertyAssignment(member)) throw new Error(`${context}: expected a property assignment`)
  const name = member.name
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  throw new Error(`${context}: unsupported property name`)
}

/** Read a `Record<string, string>` object literal. */
function stringRecord(node: ts.Expression, context: string): Record<string, string> {
  const record = unwrap(node)
  if (!ts.isObjectLiteralExpression(record)) throw new Error(`${context}: expected an object literal`)
  const out: Record<string, string> = {}
  for (const member of record.properties) {
    out[propertyName(member, context)] = stringValue((member as ts.PropertyAssignment).initializer, context)
  }
  return out
}

/** Read a `Record<string, readonly string[]>` object literal. */
function stringArrayRecord(node: ts.Expression, context: string): Record<string, string[]> {
  const record = unwrap(node)
  if (!ts.isObjectLiteralExpression(record)) throw new Error(`${context}: expected an object literal`)
  const out: Record<string, string[]> = {}
  for (const member of record.properties) {
    out[propertyName(member, context)] = stringArray((member as ts.PropertyAssignment).initializer, context)
  }
  return out
}

/** Read one boolean literal. */
function booleanValue(node: ts.Expression | undefined, context: string): boolean {
  if (node === undefined || (node.kind !== ts.SyntaxKind.TrueKeyword && node.kind !== ts.SyntaxKind.FalseKeyword)) {
    throw new Error(`${context}: expected a boolean literal`)
  }
  return node.kind === ts.SyntaxKind.TrueKeyword
}

/** Read an array literal of tool-group definitions (`SHIPPED_TOOL_GROUPS`). */
function toolGroupArray(node: ts.Expression, context: string): MirrorToolGroup[] {
  const array = unwrap(node)
  if (!ts.isArrayLiteralExpression(array)) throw new Error(`${context}: expected an array literal`)
  return array.elements.map((element, index) => {
    const entry = unwrap(element)
    if (!ts.isObjectLiteralExpression(entry)) throw new Error(`${context}[${index}]: expected an object literal`)
    const fields: Record<string, ts.Expression> = {}
    for (const member of entry.properties) {
      fields[propertyName(member, context)] = (member as ts.PropertyAssignment).initializer
    }
    const field = (name: string): ts.Expression => fields[name] ?? fail(`${context}[${index}].${name}`)
    const seats = fields['seats']
    return {
      id: stringValue(field('id'), `${context}[${index}].id`),
      label: stringValue(field('label'), `${context}[${index}].label`),
      purpose: stringValue(field('purpose'), `${context}[${index}].purpose`),
      mode: stringValue(field('mode'), `${context}[${index}].mode`),
      members: stringArray(field('members'), `${context}[${index}].members`),
      preAttach: stringArray(field('preAttach'), `${context}[${index}].preAttach`),
      ...(seats === undefined ? {} : { seats: stringArray(seats, `${context}[${index}].seats`) }),
      enabled: booleanValue(fields['enabled'], `${context}[${index}].enabled`),
    }
  })
}

/** Read an array literal of `{ prefix, reason }` objects. */
function exemptionArray(node: ts.Expression, context: string): Array<{ prefix: string; reason: string }> {
  const array = unwrap(node)
  if (!ts.isArrayLiteralExpression(array)) throw new Error(`${context}: expected an array literal`)
  return array.elements.map((element, index) => {
    const entry = unwrap(element)
    if (!ts.isObjectLiteralExpression(entry)) throw new Error(`${context}[${index}]: expected an object literal`)
    const fields: Record<string, string> = {}
    for (const member of entry.properties) {
      fields[propertyName(member, context)] = stringValue((member as ts.PropertyAssignment).initializer, context)
    }
    if (fields.prefix === undefined || fields.reason === undefined) {
      throw new Error(`${context}[${index}]: needs both prefix and reason`)
    }
    return { prefix: fields.prefix, reason: fields.reason }
  })
}

/** Sort record keys so the payload is byte-stable; arrays keep source order. */
function canonical<T>(value: T): T {
  if (Array.isArray(value)) return (value as unknown[]).map(canonical) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key])
    }
    return out as T
  }
  return value
}

/**
 * Read the harness-owned sources (child role tables + the preset inventory).
 * @param paths - source locations.
 * @returns the role and operator-surface slices of the mirror payload.
 */
export function buildRepoMirrorData(paths: MirrorPaths = mirrorPaths()): Pick<
  MirrorData,
  'sharedChildKeep' | 'sharedChildDeny' | 'roleChildDeny' | 'operatorSurface'
> {
  const roles = parse(paths.roleSource)
  const sharedChildKeep = canonical(stringArray(
    initializerOf(roles, 'SHARED_CHILD_KEEP') ?? fail('SHARED_CHILD_KEEP'), 'SHARED_CHILD_KEEP',
  ))
  const sharedChildDeny = canonical(stringArray(
    initializerOf(roles, 'SHARED_CHILD_DENY') ?? fail('SHARED_CHILD_DENY'), 'SHARED_CHILD_DENY',
  ))
  const roleChildDeny = canonical(stringArrayRecord(
    initializerOf(roles, 'ROLE_CHILD_DENY') ?? fail('ROLE_CHILD_DENY'), 'ROLE_CHILD_DENY',
  ))

  const fixture = JSON.parse(readFileSync(paths.operatorFixture, 'utf8')) as { preset?: unknown; tools?: unknown }
  if (fixture.preset !== 'orchestrator' || !Array.isArray(fixture.tools)) {
    throw new Error(`${paths.operatorFixture}: expected the orchestrator preset inventory`)
  }
  const operatorSurface = canonical((fixture.tools as unknown[]).map((tool) => {
    if (typeof tool !== 'string') throw new Error(`${paths.operatorFixture}: non-string tool name`)
    return tool
  }))
  return { sharedChildKeep, sharedChildDeny, roleChildDeny, operatorSurface }
}

/**
 * Read every source and build the canonical mirror payload.
 * @param paths - source/output locations.
 * @returns the payload plus the two digests the generated module carries.
 */
export function buildMirrorData(paths: MirrorPaths = mirrorPaths()): {
  data: MirrorData
  hostDefaultsDigest: string
  mirrorSourceDigest: string
} {
  const policy = parse(paths.hostPolicy)
  const shippedToolDefaults = canonical(stringRecord(
    initializerOf(policy, 'SHIPPED_TOOL_DEFAULTS') ?? fail('SHIPPED_TOOL_DEFAULTS'), 'SHIPPED_TOOL_DEFAULTS',
  ))
  const shippedToolDefaultExemptions = exemptionArray(
    initializerOf(policy, 'SHIPPED_TOOL_DEFAULT_EXEMPTIONS') ?? fail('SHIPPED_TOOL_DEFAULT_EXEMPTIONS'),
    'SHIPPED_TOOL_DEFAULT_EXEMPTIONS',
  )
  const seatToolDeny = canonical(stringArrayRecord(
    initializerOf(policy, 'SHIPPED_SEAT_TOOL_DENY') ?? fail('SHIPPED_SEAT_TOOL_DENY'), 'SHIPPED_SEAT_TOOL_DENY',
  ))

  const catalog = parse(paths.toolGroups)
  const toolGroups = canonical(toolGroupArray(
    initializerOf(catalog, 'SHIPPED_TOOL_GROUPS') ?? fail('SHIPPED_TOOL_GROUPS'), 'SHIPPED_TOOL_GROUPS',
  ))

  const data: MirrorData = {
    shippedToolDefaults, shippedToolDefaultExemptions, toolGroups, seatToolDeny, ...buildRepoMirrorData(paths),
  }
  const hostDefaultsDigest = digest({ shippedToolDefaults, shippedToolDefaultExemptions })
  const mirrorSourceDigest = digest(data)
  return { data, hostDefaultsDigest, mirrorSourceDigest }
}

/** Throw on a missing source declaration. */
function fail(name: string): never {
  throw new Error(`source declaration ${name} not found`)
}

/** sha256 of the canonical JSON payload. */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Render the generated TypeScript module. */
export function renderMirror(
  data: MirrorData,
  hostDefaultsDigest: string,
  mirrorSourceDigest: string,
  paths: MirrorPaths = mirrorPaths(),
): string {
  const lines: string[] = []
  lines.push('/**')
  lines.push(' * GENERATED FILE — do not edit by hand; regenerate instead.')
  lines.push(' *')
  lines.push(' * The client mirror of the host-owned shipped defaults and child role')
  lines.push(' * tables. The Permissions page resolves every row against this data, so a')
  lines.push(' * stale mirror would show a wrong decision/provenance.')
  lines.push(' *')
  lines.push(` * Sources: ${paths.hostPolicy}`)
  lines.push(` *          ${paths.toolGroups}`)
  lines.push(` *          ${paths.roleSource}`)
  lines.push(` *          ${paths.operatorFixture}`)
  lines.push(' *')
  lines.push(' * Regenerate:')
  lines.push(' *   pnpm exec tsx packages/client/ui-brand-enpoi/scripts/generate-permissions-mirror.ts --write')
  lines.push(' * Check:')
  lines.push(' *   pnpm exec tsx packages/client/ui-brand-enpoi/scripts/generate-permissions-mirror.ts --check')
  lines.push(' * `HOST_DEFAULTS_DIGEST` covers the host-owned payload; the host repository\'s')
  lines.push(' * tool-defaults completeness spec verifies it from the other side.')
  lines.push(' */')
  lines.push('')
  lines.push(`export const HOST_DEFAULTS_DIGEST = ${JSON.stringify(hostDefaultsDigest)}`)
  lines.push('')
  lines.push(`export const MIRROR_SOURCE_DIGEST = ${JSON.stringify(mirrorSourceDigest)}`)
  lines.push('')
  lines.push('/** Shipped per-tool defaults from the host policy resolver. */')
  lines.push("export const SHIPPED_TOOL_DEFAULTS: Readonly<Record<string, 'allow' | 'ask' | 'deny'>> = Object.freeze({")
  for (const key of Object.keys(data.shippedToolDefaults)) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(data.shippedToolDefaults[key])},`)
  }
  lines.push('})')
  lines.push('')
  lines.push('/** Host families deliberately left to `defaults.unknownTools` (shipped ask). */')
  lines.push('export const SHIPPED_TOOL_DEFAULT_EXEMPTIONS: readonly { prefix: string; reason: string }[] = Object.freeze([')
  for (const exemption of data.shippedToolDefaultExemptions) {
    lines.push(`  { prefix: ${JSON.stringify(exemption.prefix)}, reason: ${JSON.stringify(exemption.reason)} },`)
  }
  lines.push('])')
  lines.push('')
  lines.push('/** One shipped tool group (profile `enpoi-tool-groups` catalog). */')
  lines.push('export interface ShippedToolGroupMirror {')
  lines.push('  readonly id: string')
  lines.push('  readonly label: string')
  lines.push('  readonly purpose: string')
  lines.push("  readonly mode: 'static' | 'on-demand'")
  lines.push('  readonly members: readonly string[]')
  lines.push('  readonly preAttach: readonly string[]')
  lines.push('  readonly seats?: readonly string[]')
  lines.push('  readonly enabled: boolean')
  lines.push('}')
  lines.push('')
  lines.push('/** The shipped tool-group catalog: the Permissions family rows derive from this list. */')
  lines.push('export const SHIPPED_TOOL_GROUP_CATALOG: readonly ShippedToolGroupMirror[] = Object.freeze([')
  for (const group of data.toolGroups) {
    lines.push('  Object.freeze({')
    lines.push(`    id: ${JSON.stringify(group.id)},`)
    lines.push(`    label: ${JSON.stringify(group.label)},`)
    lines.push(`    purpose: ${JSON.stringify(group.purpose)},`)
    lines.push(`    mode: ${JSON.stringify(group.mode)},`)
    lines.push(`    members: Object.freeze(${jsonArray(group.members)}),`)
    lines.push(`    preAttach: Object.freeze(${jsonArray(group.preAttach)}),`)
    if (group.seats !== undefined) lines.push(`    seats: Object.freeze(${jsonArray(group.seats)}),`)
    lines.push(`    enabled: ${group.enabled ? 'true' : 'false'},`)
    lines.push('  }),')
  }
  lines.push('])')
  lines.push('')
  lines.push('/** Tools the shipped seat guard denies per seat (`SHIPPED_SEAT_TOOL_DENY`). */')
  lines.push('export const SHIPPED_SEAT_TOOL_DENY: Readonly<Record<string, readonly string[]>> = Object.freeze({')
  for (const seat of Object.keys(data.seatToolDeny)) {
    lines.push(`  ${JSON.stringify(seat)}: Object.freeze(${jsonArray(data.seatToolDeny[seat] ?? [])}),`)
  }
  lines.push('})')
  lines.push('')
  lines.push('/** Tools every child keeps regardless of role surface (host keep list). */')
  lines.push(`export const SHARED_CHILD_KEEP: readonly string[] = Object.freeze(${jsonArray(data.sharedChildKeep)})`)
  lines.push('')
  lines.push('/** Tools denied to every child (host anti-leak floor). */')
  lines.push(`export const SHARED_CHILD_DENY: readonly string[] = Object.freeze(${jsonArray(data.sharedChildDeny)})`)
  lines.push('')
  lines.push('/** Extra per-role child denials (host role table). */')
  lines.push('export const ROLE_CHILD_DENY: Readonly<Record<string, readonly string[]>> = Object.freeze({')
  for (const role of Object.keys(data.roleChildDeny)) {
    lines.push(`  ${JSON.stringify(role)}: Object.freeze(${jsonArray(data.roleChildDeny[role] ?? [])}),`)
  }
  lines.push('})')
  lines.push('')
  lines.push('/** The main-agent advertised surface (shipped preset inventory). */')
  lines.push(`export const OPERATOR_SURFACE: readonly string[] = Object.freeze(${jsonArray(data.operatorSurface)})`)
  lines.push('')
  return lines.join('\n')
}

/** One JSON array rendered on a single line. */
function jsonArray(values: readonly string[]): string {
  return `[${values.map(value => JSON.stringify(value)).join(', ')}]`
}

/** Build the mirror and report whether the committed file matches. */
export function checkMirror(paths: MirrorPaths = mirrorPaths()): {
  ok: boolean
  skipped: boolean
  reason: string
  data?: MirrorData
  rendered?: string
  committed?: string
} {
  if (!existsSync(paths.hostPolicy)) {
    return { ok: true, skipped: true, reason: `host policy missing at ${paths.hostPolicy}` }
  }
  if (!existsSync(paths.toolGroups)) {
    return { ok: true, skipped: true, reason: `tool-group catalog missing at ${paths.toolGroups}` }
  }
  if (!existsSync(paths.roleSource)) {
    return { ok: true, skipped: true, reason: `role source missing at ${paths.roleSource}` }
  }
  const { data, hostDefaultsDigest, mirrorSourceDigest } = buildMirrorData(paths)
  const rendered = renderMirror(data, hostDefaultsDigest, mirrorSourceDigest, paths)
  const committed = existsSync(paths.output) ? readFileSync(paths.output, 'utf8') : ''
  // The generated header names the absolute source paths this machine used;
  // that line is informational, so the check compares the payload body only —
  // a different checkout location must not read as drift.
  return { ok: bodyOf(committed) === bodyOf(rendered), skipped: false, reason: '', data, rendered, committed }
}

/** The generated module below its header comment. */
function bodyOf(moduleText: string): string {
  const end = moduleText.indexOf('*/')
  return end === -1 ? moduleText : moduleText.slice(end + 2)
}

/** First differing line pair, for a readable drift report. */
function firstDiff(rendered: string, committed: string): string {
  const left = rendered.split('\n')
  const right = committed.split('\n')
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] !== right[index]) {
      return `line ${index + 1}:\n  generated: ${left[index] ?? '<missing>'}\n  committed: ${right[index] ?? '<missing>'}`
    }
  }
  return 'no differing line (trailing bytes differ)'
}

/** CLI: `--write` regenerates, `--check` verifies. */
function main(): void {
  const write = process.argv.includes('--write')
  const paths = mirrorPaths()
  if (write) {
    const { data, hostDefaultsDigest, mirrorSourceDigest } = buildMirrorData(paths)
    writeFileSync(paths.output, renderMirror(data, hostDefaultsDigest, mirrorSourceDigest, paths))
    process.stdout.write(`wrote ${paths.output}\n`)
    return
  }
  const result = checkMirror(paths)
  if (result.skipped) {
    process.stdout.write(`SKIP: ${result.reason}\n`)
    return
  }
  if (!result.ok) {
    process.stderr.write(
      `DRIFT: ${paths.output}\n${firstDiff(bodyOf(result.rendered ?? ''), bodyOf(result.committed ?? ''))}\n`,
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(`OK: ${paths.output}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
