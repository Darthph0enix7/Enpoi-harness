/**
 * enpoi-fs-ops — file-system operations for the sidebar explorer.
 *
 * Fenced `/sidebar/fsops` JSON routes (same trust fence as the sidebar API:
 * loopback host or a configured trusted authority). Operations:
 * - fs.rename  — move a file/dir; refuses overwriting an existing target
 * - fs.delete  — move to ~/.dsh/trash/sidebar/<ms>-<basename> (never rm)
 * - fs.mkdir   — create a directory (recursive)
 * - fs.create  — create an empty file (refuses existing)
 * - fs.stat    — mtimeMs + size for the editor's external-change watcher
 * - fs.read    — text content + full-file sha256 + mtimeMs/size; refuses
 *                binary (NUL / invalid UTF-8), caps the returned content at
 *                4 MiB and flags `truncated` (never saveable, sha stays full)
 * - fs.list    — direct children of one directory inside the settings
 *                document's own directory; the one listing the sidebar may
 *                take outside a session workspace (operator preview grant)
 * - settings.document — absolute settings document path and its containing
 *                directory, when a settings provider is mounted
 * - fs.write   — atomic optimistic save (expectedSha conflict / explicit force
 *                overwrite / create-only), content-addressed pre-overwrite
 *                backup in ~/.dsh/file-history/editor/<sha256>, .dsh-tmp
 *                staging + fsync; containment is the session workspace plus
 *                the settings document directory (operator preview grant)
 * - skills.list   — on-disk skill bundles under `$DSH_HOME/skills` plus,
 *                   when a session address resolves, read-only registry rows
 *                   (the shipped tiers come from the profile's own root)
 * - skills.read   — one SKILL.md: frontmatter name/description/mcp + body + raw
 * - skills.create — write <name>/SKILL.md (slug validation, no clobber)
 * - skills.update — rewrite description + body + mcp, preserving other frontmatter
 * - skills.delete — trash-stage the bundle; the shipped tier skills refuse
 *                   every create/update/delete
 *
 * Path safety mirrors dsh-better-sidebar's fs-tree: absolute paths only,
 * name validation (no '/', '..', empty), and the cwd root is never
 * deletable. The trash staging is standalone (Oracle: no coupling to
 * enpoi-file-revert's session-keyed trash). Skills CRUD never accepts a
 * caller path: every operation derives <skillsDir>/<slug> from a validated
 * kebab-case name and re-checks containment.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join, dirname, basename, resolve, isAbsolute, relative } from 'node:path'
import { mkdir, rename, stat, writeFile, rm, open, readFile, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { IncomingHttpHeaders } from 'node:http'

export const name = 'enpoi-fs-ops'
export const inject = ['webServer', 'webRuntime', 'sessions']

const TRASH_ROOT = join(homedir(), '.dsh', 'trash', 'sidebar')

/** Editor pre-overwrite backups are content-addressed under the user's home. */
function editorBackupPath(sha256: string): string {
  return join(homedir(), '.dsh', 'file-history', 'editor', sha256)
}

/** fs.read returns at most this many content bytes (sha/size stay full-file). */
const MAX_READ_BYTES = 4 * 1024 * 1024

/** Largest file the download route serves, in bytes (base64-inflated on the wire). */
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Read up to `length` bytes from position 0 of an open handle, short-read safe. */
async function readAtMost(handle: FileHandle, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

/**
 * Atomic replace: write a sibling `.dsh-tmp-<pid>-<rand>` file, fsync it, then
 * rename over the target (same filesystem). `mode` is applied to the temp file
 * so an existing target's permissions survive the rename; 0o644 for new files.
 * The temp file is removed on any failure — never left behind.
 */
async function writeFileAtomic(target: string, bytes: Buffer, mode: number): Promise<void> {
  const dir = dirname(target)
  const tmp = join(dir, `${basename(target)}.dsh-tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
  await mkdir(dir, { recursive: true })
  let handle: FileHandle | undefined
  try {
    handle = await open(tmp, 'w', mode)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmp, target)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await rm(tmp, { force: true }).catch(() => {})
    throw new FsOpsError('fs-error', `cannot write "${target}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
}

/** Store pre-overwrite bytes under their digest; idempotent (wx + EEXIST skip). */
async function backupBytes(bytes: Buffer): Promise<string> {
  const dest = editorBackupPath(sha256Of(bytes))
  try {
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return dest
    throw new FsOpsError('fs-error', `cannot back up existing file: ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  return dest
}

export const Config = Schema.object({
  /** Skills directory the `skills.*` routes manage. Defaults to `$DSH_HOME/skills`. */
  skillsDir: Schema.string(),
})

export interface FsOpsConfig {
  /** Skills directory the `skills.*` routes manage; defaults to `$DSH_HOME/skills`. */
  skillsDir?: string
}

/**
 * Skills shipped with the profile. Delete is refused: the shipped tier
 * workflows are the deployment's defaults, and removing one leaves no copy
 * anywhere else.
 */
const PROTECTED_SKILL_NAMES: ReadonlySet<string> = new Set([
  'tier1-workflow',
  'tier2-workflow',
  'tier3-workflow',
])

/** Largest SKILL.md this API reads or writes, in bytes. */
const MAX_SKILL_BYTES = 1024 * 1024

/** Frontmatter-bearing skill file name inside a directory bundle. */
const SKILL_FILE_NAME = 'SKILL.md'

/** One on-disk skill entry under the skills root. */
interface SkillEntry {
  /** On-disk name: the directory name, or the file stem of a flat `<name>.md`. */
  entry: string
  /** Skill identity: the frontmatter name (discovery addresses skills by this). */
  name: string
  description: string
  /** `mcp:` frontmatter hint: MCP servers loaded with this skill (empty when absent). */
  mcp: string[]
  /** Absolute instruction-file path. */
  path: string
  /** Absolute path of the bundle directory or flat file, for delete staging. */
  rootPath: string
  format: 'directory' | 'file'
}

/** Parsed SKILL.md: frontmatter lines (delimiters removed), name/description/mcp, body. */
interface ParsedSkillMarkdown {
  frontmatter: string[] | undefined
  name: string | undefined
  description: string | undefined
  mcp: string[] | undefined
  body: string
}

/**
 * Resolve the managed skills directory: explicit config first, else the user
 * root `$DSH_HOME/skills` — the root every preset reads. Never the profile's
 * own skills dir: user-created skills belong to the user's home, not to the
 * versioned profile.
 */
function resolveSkillsRoot(config: FsOpsConfig): string {
  if (typeof config.skillsDir === 'string' && config.skillsDir !== '') return resolve(config.skillsDir)
  return dshHomePath('skills')
}

/** Validate the payload's `name` as a kebab-case skill name. */
function requireSkillName(payload: unknown): string {
  const name = requireString(payload, 'name')
  if (!isSkillName(name)) {
    throw new FsOpsError('bad-request', `invalid skill name "${name}": expected kebab-case ([a-z0-9]+(-[a-z0-9]+)*)`, 400)
  }
  return name
}

/** Read a required string field; `allowEmpty` admits "". */
function requireField(payload: unknown, key: string, allowEmpty = false): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new FsOpsError('bad-request', `missing or invalid "${key}"`, 400)
  }
  return value
}

/** Keep a derived skills path inside the managed root. */
function requireContained(root: string, target: string): string {
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new FsOpsError('fs-error', `skill path "${target}" escapes the skills directory`, 400)
  }
  return target
}

/** Whether one entry is a shipped default (by frontmatter name or on-disk name). */
function isProtectedSkill(entry: Pick<SkillEntry, 'name' | 'entry'>): boolean {
  return PROTECTED_SKILL_NAMES.has(entry.name) || PROTECTED_SKILL_NAMES.has(entry.entry)
}

/**
 * Refuse a create/update/delete whose target name is a shipped default: the
 * profile's skills dir owns the canonical tier files, and the user root must
 * never grow a second writable copy.
 */
function requireUnprotectedSkill(name: string, action: 'created' | 'edited' | 'deleted'): void {
  if (!PROTECTED_SKILL_NAMES.has(name)) return
  throw new FsOpsError(
    'protected',
    `skill "${name}" is a shipped default of this profile and cannot be ${action}; it lives in the profile's skills dir`,
    400,
  )
}

/**
 * Split a raw file into frontmatter lines and body.
 * @returns undefined when the file has no complete `---` block.
 */
function splitFrontmatter(raw: string): { lines: string[]; body: string } | undefined {
  const lines = raw.split('\n')
  if ((lines[0] ?? '').replace(/\r$/, '') !== '---') return undefined
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.replace(/\r$/, '') === '---') {
      return { lines: lines.slice(1, index).map(line => line.replace(/\r$/, '')), body: lines.slice(index + 1).join('\n') }
    }
  }
  return undefined
}

/** Decode one YAML scalar for `key` from frontmatter lines, block scalars included. */
function frontmatterValue(lines: readonly string[], key: string): string | undefined {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (/^\s/.test(line) || line === '') continue
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]?(.*)$/.exec(line)
    if (match === null || match[1] !== key) continue
    return decodeScalar(lines, index, match[2] ?? '')
  }
  return undefined
}

/** Decode the value that starts on the `key:` line, consuming indented block continuation. */
function decodeScalar(lines: readonly string[], index: number, rest: string): string {
  if (/^[|>][+-]?[ \t]*$/.test(rest)) {
    const block: string[] = []
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const line = lines[cursor] ?? ''
      if (line.trim() !== '' && !/^\s/.test(line)) break
      block.push(line)
    }
    while (block.length > 0 && (block[block.length - 1] ?? '').trim() === '') block.pop()
    const indents = block.filter(line => line.trim() !== '').map(line => line.length - line.trimStart().length)
    const indent = indents.length === 0 ? 0 : Math.min(...indents)
    const parts = block.map(line => line.slice(Math.min(indent, line.length - line.trimStart().length)))
    return (rest.startsWith('>') ? parts.join(' ') : parts.join('\n')).trim()
  }
  if (rest.startsWith('"')) {
    let escaped = false
    for (let cursor = 1; cursor < rest.length; cursor++) {
      const char = rest[cursor]
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') return decodeDoubleQuoted(rest.slice(1, cursor))
    }
    return rest.slice(1)
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1)
    if (end >= 0) return rest.slice(1, end).replace(/''/g, "'")
    return rest.slice(1)
  }
  const comment = rest.search(/\s#/)
  return (comment >= 0 ? rest.slice(0, comment) : rest).trim()
}

/** Decode the YAML escapes admitted inside a double-quoted scalar. */
function decodeDoubleQuoted(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index] ?? ''
    if (char !== '\\') { result += char; continue }
    const next = value[++index] ?? ''
    switch (next) {
      case 'n': result += '\n'; break
      case 'r': result += '\r'; break
      case 't': result += '\t'; break
      case '"': result += '"'; break
      case '\\': result += '\\'; break
      case '/': result += '/'; break
      case '0': result += '\0'; break
      case 'u': {
        const hex = value.slice(index + 1, index + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { result += String.fromCharCode(Number.parseInt(hex, 16)); index += 4 } else { result += 'u' }
        break
      }
      default: result += next
    }
  }
  return result
}

/** Quote one string as a YAML double-quoted scalar (JSON escapes plus line separators). */
function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `"${escaped}"`
}

/** Split one YAML flow sequence's inner text on top-level commas. */
function splitFlowSequence(inner: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const char of inner) {
    if (quote !== undefined) {
      current += char
      if (quote === '"') {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quote = undefined
      } else if (char === "'") {
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue }
    if (char === ',') { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/** Decode one flow-sequence item or block-sequence scalar (quotes, trailing comment). */
function decodeInlineScalar(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"')) {
    let escaped = false
    for (let cursor = 1; cursor < value.length; cursor++) {
      const char = value[cursor]
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') return decodeDoubleQuoted(value.slice(1, cursor))
    }
    return value.slice(1)
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1)
    if (end >= 0) return value.slice(1, end).replace(/''/g, "'")
    return value.slice(1)
  }
  const comment = value.search(/\s#/)
  return (comment >= 0 ? value.slice(0, comment) : value).trim()
}

/**
 * Parse an optional string-array frontmatter field: the one-line flow form
 * (`mcp: [server]`) the UI writes, or an indented `- server` block.
 * @returns the decoded entries, or undefined when the key is absent.
 */
function frontmatterStringArray(lines: readonly string[], key: string): string[] | undefined {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (/^\s/.test(line) || line === '') continue
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]?(.*)$/.exec(line)
    if (match === null || match[1] !== key) continue
    const rest = (match[2] ?? '').trim()
    if (rest.startsWith('[')) {
      const end = rest.lastIndexOf(']')
      if (end < 0) return []
      return splitFlowSequence(rest.slice(1, end)).map(decodeInlineScalar).filter(entry => entry !== '')
    }
    const entries: string[] = []
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const item = lines[cursor] ?? ''
      if (item.trim() === '') continue
      if (!/^\s/.test(item)) break
      const bullet = /^\s*-[ \t]*(.*)$/.exec(item)
      if (bullet === null) continue
      const value = decodeInlineScalar(bullet[1] ?? '')
      if (value !== '') entries.push(value)
    }
    return entries
  }
  return undefined
}

/** Whether one string is safe as a bare YAML flow-sequence scalar. */
function isBareYamlScalar(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)
    && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(value)
}

/** Serialize the `mcp:` hint as one flow sequence (unsafe entries quoted). */
function yamlArray(values: readonly string[]): string {
  return `[${values.map(value => isBareYamlScalar(value) ? value : yamlQuote(value)).join(', ')}]`
}

/** Parse a SKILL.md without loading any YAML library. */
function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const frontmatter = splitFrontmatter(raw)
  if (frontmatter === undefined) return { frontmatter: undefined, name: undefined, description: undefined, mcp: undefined, body: raw.trim() }
  return {
    frontmatter: frontmatter.lines,
    name: frontmatterValue(frontmatter.lines, 'name'),
    description: frontmatterValue(frontmatter.lines, 'description'),
    mcp: frontmatterStringArray(frontmatter.lines, 'mcp'),
    body: frontmatter.body.trim(),
  }
}

/** Normalize a submitted body: LF line endings, no trailing whitespace, one trailing newline. */
function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '')
}

/**
 * Compose the SKILL.md text for a create or update.
 *
 * With existing frontmatter, every other line is preserved verbatim (unknown
 * fields such as `whenToUse`, invocation flags, comments) and the
 * `description:` and `mcp:` entries are replaced; without frontmatter the file
 * is written fresh. `mcp` undefined leaves an existing hint untouched, an
 * empty list removes the entry, a non-empty list replaces it.
 */
function skillFileText(
  existing: ParsedSkillMarkdown | undefined,
  name: string,
  description: string,
  body: string,
  mcp?: readonly string[],
): string {
  const bodyText = normalizeBody(body)
  const mcpLine = mcp === undefined || mcp.length === 0 ? undefined : `mcp: ${yamlArray(mcp)}`
  if (existing?.frontmatter === undefined || existing.name === undefined) {
    const fresh = [`name: ${name}`, `description: ${yamlQuote(description)}`]
    if (mcpLine !== undefined) fresh.push(mcpLine)
    return `---\n${fresh.join('\n')}\n---\n${bodyText === '' ? '' : `\n${bodyText}\n`}`
  }
  const lines = [...existing.frontmatter]
  const index = lines.findIndex(line => /^description[ \t]*:/.test(line))
  if (index >= 0) {
    let end = index + 1
    while (end < lines.length && /^\s/.test(lines[end] ?? '')) end++
    lines.splice(index, end - index, `description: ${yamlQuote(description)}`)
  } else {
    lines.push(`description: ${yamlQuote(description)}`)
  }
  if (mcp !== undefined) {
    const mcpIndex = lines.findIndex(line => /^mcp[ \t]*:/.test(line))
    if (mcpIndex >= 0) {
      let end = mcpIndex + 1
      while (end < lines.length && /^\s/.test(lines[end] ?? '')) end++
      if (mcpLine === undefined) lines.splice(mcpIndex, end - mcpIndex)
      else lines.splice(mcpIndex, end - mcpIndex, mcpLine)
    } else if (mcpLine !== undefined) {
      lines.push(mcpLine)
    }
  }
  return `---\n${lines.join('\n')}\n---\n${bodyText === '' ? '' : `\n${bodyText}\n`}`
}

/** Read the optional `mcp` write field: undefined when absent, else validated unique strings. */
function readMcpField(payload: unknown): string[] | undefined {
  const record = payload as Record<string, unknown> | null
  if (record === null || record.mcp === undefined) return undefined
  if (!Array.isArray(record.mcp)) {
    throw new FsOpsError('bad-request', '"mcp" must be an array of server ids', 400)
  }
  const values: string[] = []
  for (const entry of record.mcp) {
    if (typeof entry !== 'string') {
      throw new FsOpsError('bad-request', '"mcp" entries must be strings', 400)
    }
    const value = entry.trim()
    if (value === '') {
      throw new FsOpsError('bad-request', '"mcp" entries must be non-empty server ids', 400)
    }
    if (!values.includes(value)) values.push(value)
  }
  return values
}

/** Read one SKILL.md as UTF-8, refusing oversized files. */
async function readSkillText(path: string): Promise<string> {
  const info = await stat(path)
  if (info.size > MAX_SKILL_BYTES) {
    throw new FsOpsError('too-large', `"${path}" is larger than ${MAX_SKILL_BYTES} bytes`, 413)
  }
  return await readFile(path, 'utf8')
}

/** Reject a composed SKILL.md past the size cap. */
function requireSkillSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) {
    throw new FsOpsError('too-large', `skill file would exceed ${MAX_SKILL_BYTES} bytes`, 413)
  }
}

/** Parse one candidate instruction file into an entry, or undefined when it is not a valid skill. */
async function readSkillEntry(path: string, entry: string, rootPath: string, format: 'directory' | 'file'): Promise<SkillEntry | undefined> {
  let raw: string
  try {
    raw = await readSkillText(path)
  } catch (error) {
    if (error instanceof FsOpsError) return undefined
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = parseSkillMarkdown(raw)
  if (parsed.name === undefined || !isSkillName(parsed.name) || parsed.description === undefined || parsed.description === '') return undefined
  return { entry, name: parsed.name, description: parsed.description, mcp: parsed.mcp ?? [], path, rootPath, format }
}

/** List the valid on-disk skill entries under the managed root, sorted by on-disk name. */
async function listSkillEntries(root: string): Promise<SkillEntry[]> {
  let dirents
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new FsOpsError('fs-error', `cannot list skills in "${root}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  const entries: SkillEntry[] = []
  const seen = new Set<string>()
  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (dirent.isDirectory()) {
      const entry = await readSkillEntry(join(root, dirent.name, SKILL_FILE_NAME), dirent.name, join(root, dirent.name), 'directory')
      if (entry !== undefined && !seen.has(entry.name)) { seen.add(entry.name); entries.push(entry) }
    } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
      const stem = dirent.name.slice(0, -'.md'.length)
      if (stem === '') continue
      const path = join(root, dirent.name)
      const entry = await readSkillEntry(path, stem, path, 'file')
      if (entry !== undefined && !seen.has(entry.name)) { seen.add(entry.name); entries.push(entry) }
    }
  }
  return entries
}

/**
 * Resolve one entry by skill name: the direct `<name>/SKILL.md` / `<name>.md`
 * hit first, then a scan matching the declared frontmatter name.
 */
async function findSkillEntry(root: string, name: string): Promise<SkillEntry | undefined> {
  const direct: Array<{ path: string; rootPath: string; format: 'directory' | 'file' }> = [
    { path: join(root, name, SKILL_FILE_NAME), rootPath: join(root, name), format: 'directory' },
    { path: join(root, `${name}.md`), rootPath: join(root, `${name}.md`), format: 'file' },
  ]
  for (const candidate of direct) {
    const entry = await readSkillEntry(candidate.path, name, candidate.rootPath, candidate.format)
    if (entry !== undefined) return entry
  }
  return (await listSkillEntries(root)).find(entry => entry.name === name)
}

/** Move one skill bundle into the DSH_HOME trash; never rm. */
async function trashSkill(entry: SkillEntry): Promise<string> {
  const dest = join(dshHomePath('trash', 'skills'), `${Date.now()}-${randomUUID()}-${basename(entry.rootPath)}`)
  try {
    await mkdir(dirname(dest), { recursive: true })
    await rename(entry.rootPath, dest)
  } catch (error) {
    throw new FsOpsError('fs-error', `cannot delete skill "${entry.name}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  return dest
}

/** One registry catalog row as the session skill catalog reports it. */
interface RegistrySkill {
  name: string
  description: string
  path?: string
}

/** Structural face of the session-addressed skill catalog service. */
interface SkillCatalogFace {
  list?: (request: { sessionId: string }, signal: AbortSignal) => Promise<{ skills?: readonly RegistrySkill[] }>
}

/** Read the registry catalog for one session; failures degrade to on-disk rows alone. */
async function readRegistrySkills(
  ctx: Context, sessionId: string | undefined,
): Promise<{ skills: RegistrySkill[]; error?: string }> {
  if (sessionId === undefined || sessionId === '') return { skills: [] }
  const catalog = ctx.get('sessionSkillCatalog') as SkillCatalogFace | undefined
  if (catalog?.list === undefined) return { skills: [], error: 'skill catalog service is unavailable' }
  try {
    const value = await catalog.list({ sessionId }, new AbortController().signal)
    const skills = Array.isArray(value.skills) ? value.skills : []
    return { skills: skills.filter(skill => isSkillName(skill.name)) }
  } catch (error) {
    return { skills: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** Structural subset of the node HTTP request the fence reads. */
interface TrustRequest {
  headers: IncomingHttpHeaders
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** DNS-rebinding / cross-site fence, behaviorally identical to the sidebar's. */
function isTrustedRequest(req: TrustRequest, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (isLoopbackHostname(hostname)) return true
  return trustedHosts.some((entry) => {
    try {
      return new URL(`http://${entry}`).hostname === hostname
    } catch {
      return false
    }
  })
}

/** One API failure with its wire code and HTTP status. */
class FsOpsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new FsOpsError('bad-request', `missing or invalid "${key}"`, 400)
  }
  return value
}

function requireAbsolute(path: string): string {
  if (!isAbsolute(path)) {
    throw new FsOpsError('fs-error', `"${path}" is not an absolute path`, 400)
  }
  return resolve(path)
}

/** Structural face of the settings service's document location. */
interface SettingsDocumentFace {
  /** Absolute path of the profile patch the settings provider edits. */
  readonly documentPath?: string
}

/**
 * The settings document the operator preview may open, and its directory.
 *
 * The grant is derived from the live settings provider at request time, never
 * from a caller path, so the routes below can only ever reach the one document
 * this deployment owns. `undefined` means the provider is absent or has no
 * path: every grant-dependent route then refuses as if no document existed.
 */
function settingsDocument(ctx: Context): { path: string; root: string } | undefined {
  const path = (ctx.get('settings') as SettingsDocumentFace | undefined)?.documentPath
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return undefined
  const resolved = resolve(path)
  return { path: resolved, root: dirname(resolved) }
}

/** Whether one path is the settings document's directory or below it. */
function insideSettingsRoot(document: { root: string }, path: string): boolean {
  const rel = relative(document.root, resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Cap on returned directory entries for `fs.list`; the rest is dropped and reported cut. */
const MAX_LIST_ENTRIES = 2000

/**
 * Resolve one payload path against the session workspace.
 *
 * The file tree and chat links address files relative to the workspace root
 * (`notes.txt`), while an explicit absolute path is taken as-is. A relative
 * path needs the session's cwd; an absolute one never does.
 * @param payload - request body carrying the path and optionally a cwd/session.
 * @param sessions - session lookup used to derive the cwd.
 * @param key - payload field holding the path.
 * @returns the absolute, normalised path.
 */
function requireWorkspacePath(
  payload: unknown,
  sessions: { get?: (id: string) => { header?: { cwd?: string } } | undefined } | undefined,
  key = 'path',
): string {
  const raw = requireString(payload, key)
  if (isAbsolute(raw)) return resolve(raw)
  return resolve(cwdOf(payload, sessions), raw)
}

/** Validate a new entry name: no separators, no '..', not empty, not dot. */
function requireValidName(name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new FsOpsError('bad-request', `invalid name "${name}"`, 400)
  }
  return name
}

/** Largest JSON request body accepted, in bytes: an editor save up to the read cap plus JSON escaping. */
const MAX_BODY_BYTES = 2 * MAX_READ_BYTES

async function readJsonBody(req: { on: (event: string, cb: (chunk: Buffer) => void) => unknown }): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new FsOpsError('bad-request', 'request body too large', 413)
    chunks.push(Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new FsOpsError('bad-request', 'malformed JSON body', 400)
  }
}

function writeJson(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function writeOk(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, error: unknown): void {
  const err = error instanceof FsOpsError ? error : new FsOpsError('internal', error instanceof Error ? error.message : String(error), 500)
  writeJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } })
}

/** Resolve the session cwd from the payload (mirror of the sidebar's cwdOf). */
function cwdOf(payload: unknown, sessions: { get?: (id: string) => { header?: { cwd?: string } } | undefined } | undefined): string {
  const record = payload as Record<string, unknown> | null
  const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : ''
  const explicit = typeof record?.cwd === 'string' && record.cwd !== '' ? record.cwd : undefined
  if (explicit !== undefined) return explicit
  const session = sessionId !== '' ? sessions?.get?.(sessionId) : undefined
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new FsOpsError('fs-error', 'no working directory for this session', 400)
  }
  return cwd
}

export function apply(ctx: Context, config: FsOpsConfig): void {
  const sessions = ctx.get('sessions') as { get?: (id: string) => { cwd?: string } | undefined } | undefined
  const trustedHosts = (ctx.get('webRuntime') as { trustedHosts?: readonly string[] } | undefined)?.trustedHosts ?? []

  const api: Record<string, (payload: unknown) => Promise<unknown>> = {
    'settings.document': async () => {
      const document = settingsDocument(ctx)
      if (document === undefined) {
        throw new FsOpsError('not-found', 'no settings document is available', 404)
      }
      return document
    },

    'fs.rename': async (payload) => {
      const cwd = cwdOf(payload, sessions)
      const from = requireAbsolute(requireString(payload, 'from'))
      const to = requireAbsolute(requireString(payload, 'to'))
      if (from === cwd || relative(cwd, from) === '') {
        throw new FsOpsError('fs-error', 'cannot rename the workspace root', 400)
      }
      // Refuse overwriting an existing target (no silent clobber).
      try {
        await stat(to)
        throw new FsOpsError('fs-error', `"${to}" already exists`, 409)
      } catch (error) {
        if (error instanceof FsOpsError) throw error
        // ENOENT — target free, proceed.
      }
      try {
        await mkdir(dirname(to), { recursive: true })
        await rename(from, to)
      } catch (error) {
        throw new FsOpsError('fs-error', `cannot rename "${from}" → "${to}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      return { ok: true, from, to }
    },

    'fs.delete': async (payload) => {
      const cwd = cwdOf(payload, sessions)
      const path = requireAbsolute(requireString(payload, 'path'))
      if (path === cwd || relative(cwd, path) === '') {
        throw new FsOpsError('fs-error', 'cannot delete the workspace root', 400)
      }
      // Trash staging: never rm — recoverable by hand from ~/.dsh/trash/sidebar.
      // UUID suffix prevents same-millisecond same-basename collisions
      // (Oracle fix-soon #4).
      const destDir = join(TRASH_ROOT, `${Date.now()}-${randomUUID()}-${basename(path)}`)
      try {
        await mkdir(dirname(destDir), { recursive: true })
        await rename(path, destDir)
      } catch (error) {
        throw new FsOpsError('fs-error', `cannot delete "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      return { ok: true, dest: destDir }
    },

    'fs.mkdir': async (payload) => {
      const cwd = cwdOf(payload, sessions)
      const parent = requireAbsolute(requireString(payload, 'parent'))
      const name = requireValidName(requireString(payload, 'name'))
      const target = join(parent, name)
      if (relative(cwd, target) === '' || relative(cwd, target).startsWith('..')) {
        throw new FsOpsError('fs-error', 'new directory must stay inside the workspace', 400)
      }
      try {
        await mkdir(target, { recursive: false })
      } catch (error) {
        throw new FsOpsError('fs-error', `cannot create directory "${target}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      return { ok: true, path: target }
    },

    'fs.create': async (payload) => {
      const cwd = cwdOf(payload, sessions)
      const parent = requireAbsolute(requireString(payload, 'parent'))
      const name = requireValidName(requireString(payload, 'name'))
      const target = join(parent, name)
      if (relative(cwd, target) === '' || relative(cwd, target).startsWith('..')) {
        throw new FsOpsError('fs-error', 'new file must stay inside the workspace', 400)
      }
      try {
        // 'wx' = fail if the file exists (atomic no-clobber — closes the
        // stat-then-write TOCTOU truncation window, Oracle fix-soon #1).
        await mkdir(parent, { recursive: true })
        await writeFile(target, '', { flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FsOpsError('fs-error', `"${target}" already exists`, 409)
        }
        throw new FsOpsError('fs-error', `cannot create "${target}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      return { ok: true, path: target }
    },

    'fs.list': async (payload) => {
      // The operator tree always addresses the listing by absolute path; a
      // relative one has no workspace to resolve against here.
      const path = requireAbsolute(requireString(payload, 'path'))
      const document = settingsDocument(ctx)
      if (document === undefined || !insideSettingsRoot(document, path)) {
        throw new FsOpsError('fs-error', `"${path}" is outside the settings document directory`, 400)
      }
      let dirents
      try {
        dirents = await readdir(path, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new FsOpsError('not-found', `"${path}" does not exist`, 404)
        }
        throw new FsOpsError('fs-error', `cannot list "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      const entries = dirents.slice(0, MAX_LIST_ENTRIES).map((dirent) => {
        if (dirent.isDirectory()) return { name: dirent.name, type: 'directory' as const }
        if (dirent.isFile()) return { name: dirent.name, type: 'file' as const }
        // A symlink or device reports `other`, matching the workspace listing's
        // vocabulary without following the link out of the granted directory.
        return { name: dirent.name, type: 'other' as const }
      })
      return { path, entries, truncated: dirents.length > MAX_LIST_ENTRIES }
    },

    'fs.stat': async (payload) => {
      const path = requireWorkspacePath(payload, sessions)
      try {
        const info = await stat(path)
        return { ok: true, path, mtimeMs: info.mtimeMs, size: info.size, isDir: info.isDirectory() }
      } catch (error) {
        // A missing file is a state the editor renders ("File not found"), not a
        // failure: report it as 404 so the watcher can tell it apart from a read
        // error it should retry.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new FsOpsError('not-found', `"${path}" does not exist`, 404)
        }
        throw new FsOpsError('fs-error', `cannot stat "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
    },

    'fs.download': async (payload) => {
      const path = requireWorkspacePath(payload, sessions)
      let handle: FileHandle
      try {
        handle = await open(path, 'r')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new FsOpsError('not-found', `"${path}" does not exist`, 404)
        }
        throw new FsOpsError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      try {
        const info = await handle.stat()
        if (info.isDirectory()) {
          throw new FsOpsError('fs-error', `"${path}" is a directory`, 400)
        }
        if (info.size > MAX_DOWNLOAD_BYTES) {
          throw new FsOpsError('too-large', `"${path}" is larger than ${MAX_DOWNLOAD_BYTES} bytes`, 413)
        }
        const bytes = await handle.readFile()
        return { base64: bytes.toString('base64'), size: bytes.length, name: basename(path) }
      } finally {
        await handle.close()
      }
    },

    'fs.read': async (payload) => {
      const path = requireWorkspacePath(payload, sessions)
      let handle: FileHandle
      try {
        handle = await open(path, 'r')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new FsOpsError('not-found', `"${path}" does not exist`, 404)
        }
        throw new FsOpsError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      try {
        const info = await handle.stat()
        if (info.isDirectory()) {
          throw new FsOpsError('fs-error', `"${path}" is a directory`, 400)
        }
        const size = info.size
        const truncated = size > MAX_READ_BYTES
        const head = await readAtMost(handle, truncated ? MAX_READ_BYTES : size)
        if (head.includes(0)) {
          throw new FsOpsError('not-text', `"${path}" is binary (NUL byte)`, 400)
        }
        let content: string
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(head)
        } catch {
          throw new FsOpsError('not-text', `"${path}" is not valid UTF-8 text`, 400)
        }
        // The sha always covers the FULL file, so a truncated buffer can never
        // be mistaken for an up-to-date save candidate by change detection.
        let sha256: string
        if (!truncated) {
          sha256 = sha256Of(head)
        } else {
          const hash = createHash('sha256')
          const stream = handle.createReadStream({ start: 0, autoClose: false })
          for await (const chunk of stream) hash.update(chunk as Buffer)
          sha256 = hash.digest('hex')
        }
        return { content, sha256, mtimeMs: info.mtimeMs, size, truncated }
      } finally {
        await handle.close().catch(() => {})
      }
    },

    'fs.write': async (payload) => {
      const cwd = cwdOf(payload, sessions)
      const path = requireWorkspacePath(payload, sessions)
      const record = payload as Record<string, unknown> | null
      const content = record?.content
      if (typeof content !== 'string') {
        throw new FsOpsError('bad-request', 'missing or invalid "content"', 400)
      }
      const rawExpected = record?.expectedSha
      if (rawExpected !== undefined && rawExpected !== null && typeof rawExpected !== 'string') {
        throw new FsOpsError('bad-request', 'invalid "expectedSha"', 400)
      }
      const expectedSha = typeof rawExpected === 'string' ? rawExpected : null
      // `expectedSha: null` is an explicit create-only request; absent means force.
      const createOnly = rawExpected === null
      // `force: true` is the conflict resolution's explicit Overwrite: the write
      // skips the digest check, and the backup below (never skipped) preserves
      // the on-disk version the overwrite replaces.
      const force = record?.force === true

      // Containment: the session workspace — never its root, never anything
      // outside it (`relative` resolves dot-segments for us) — plus the
      // operator preview grant: the settings document's own directory is the
      // one place outside a workspace the sidebar may save into. The grant
      // covers every write form below (save, force overwrite, create-beside).
      const root = resolve(cwd)
      const rel = relative(root, path)
      const inWorkspace = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      if (!inWorkspace) {
        const document = settingsDocument(ctx)
        if (document === undefined || !insideSettingsRoot(document, path)) {
          throw new FsOpsError('fs-error', 'file must stay inside the workspace', 400)
        }
      }

      const bytes = Buffer.from(content, 'utf8')
      const newSha = sha256Of(bytes)

      let existing: Buffer | null = null
      let mode = 0o644
      try {
        const info = await stat(path)
        if (info.isDirectory()) {
          throw new FsOpsError('fs-error', `"${path}" is a directory`, 400)
        }
        existing = await readFile(path)
        mode = info.mode & 0o777
      } catch (error) {
        if (error instanceof FsOpsError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new FsOpsError('fs-error', `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
        }
      }

      let backup: string | null = null
      if (existing !== null) {
        if (createOnly) {
          throw new FsOpsError('exists', `"${path}" already exists`, 409)
        }
        if (!force && expectedSha !== null && sha256Of(existing) !== expectedSha) {
          throw new FsOpsError('conflict', 'file changed on disk since it was read', 409)
        }
        // Zero data loss: every overwrite/truncate keeps the old bytes — the
        // forced Overwrite included, so the replaced version stays recoverable.
        backup = await backupBytes(existing)
      } else if (expectedSha !== null && !force) {
        // The read source vanished — never silently recreate under an expectedSha.
        throw new FsOpsError('conflict', 'file changed on disk since it was read', 409)
      }

      await writeFileAtomic(path, bytes, mode)
      const info = await stat(path)
      return { sha256: newSha, mtimeMs: info.mtimeMs, size: bytes.length, backup }
    },

    'skills.list': async (payload) => {
      const root = resolveSkillsRoot(config)
      const entries = await listSkillEntries(root)
      const rows = entries.map(entry => ({
        name: entry.name,
        entry: entry.entry,
        description: entry.description,
        mcp: entry.mcp,
        path: entry.path,
        format: entry.format,
        source: isProtectedSkill(entry) ? 'default' as const : 'profile' as const,
        protected: isProtectedSkill(entry),
        editable: !isProtectedSkill(entry),
      }))
      const record = payload as Record<string, unknown> | null
      const sessionId = typeof record?.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
      const registry = await readRegistrySkills(ctx, sessionId)
      const known = new Set(rows.flatMap(row => [row.name, row.entry]))
      const registryRows = registry.skills
        .filter(skill => !known.has(skill.name))
        .map(skill => ({
          name: skill.name,
          entry: skill.name,
          description: skill.description,
          mcp: [],
          ...skill.path === undefined ? {} : { path: skill.path },
          format: 'file' as const,
          source: PROTECTED_SKILL_NAMES.has(skill.name) ? 'default' as const : 'registry' as const,
          protected: PROTECTED_SKILL_NAMES.has(skill.name),
          editable: false,
        }))
      return {
        root,
        skills: [...rows, ...registryRows].sort((left, right) => left.name.localeCompare(right.name)),
        registry: registry.error === undefined ? { ok: true } : { ok: false, error: registry.error },
      }
    },

    'skills.read': async (payload) => {
      const name = requireSkillName(payload)
      const root = resolveSkillsRoot(config)
      const entry = await findSkillEntry(root, name)
      if (entry === undefined) {
        throw new FsOpsError('not-found', `skill "${name}" does not exist`, 404)
      }
      const content = await readSkillText(entry.path)
      const parsed = parseSkillMarkdown(content)
      return {
        name: entry.name,
        entry: entry.entry,
        description: parsed.description ?? entry.description,
        mcp: parsed.mcp ?? entry.mcp,
        body: parsed.body,
        content,
        path: entry.path,
        format: entry.format,
        source: isProtectedSkill(entry) ? 'default' as const : 'profile' as const,
        protected: isProtectedSkill(entry),
      }
    },

    'skills.create': async (payload) => {
      const name = requireSkillName(payload)
      requireUnprotectedSkill(name, 'created')
      const description = requireField(payload, 'description').trim()
      const body = requireField(payload, 'body', true)
      const mcp = readMcpField(payload)
      const root = resolveSkillsRoot(config)
      const existing = await findSkillEntry(root, name)
      if (existing !== undefined) {
        throw new FsOpsError('exists', `skill "${name}" already exists`, 409)
      }
      const targetDir = requireContained(root, join(root, name))
      const targetFile = requireContained(root, join(targetDir, SKILL_FILE_NAME))
      const text = skillFileText(undefined, name, description, body, mcp)
      requireSkillSize(text)
      try {
        await mkdir(root, { recursive: true })
        // Non-recursive mkdir is the atomic no-clobber: a racing create fails EEXIST.
        await mkdir(targetDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FsOpsError('exists', `skill "${name}" already exists`, 409)
        }
        throw new FsOpsError('fs-error', `cannot create skill "${name}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      try {
        await writeFileAtomic(targetFile, Buffer.from(text, 'utf8'), 0o644)
      } catch (error) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      return { name, path: targetFile }
    },

    'skills.update': async (payload) => {
      const name = requireSkillName(payload)
      requireUnprotectedSkill(name, 'edited')
      const description = requireField(payload, 'description').trim()
      const body = requireField(payload, 'body', true)
      const mcp = readMcpField(payload)
      const root = resolveSkillsRoot(config)
      const entry = await findSkillEntry(root, name)
      if (entry === undefined) {
        throw new FsOpsError('not-found', `skill "${name}" does not exist`, 404)
      }
      if (isProtectedSkill(entry)) {
        throw new FsOpsError('protected', `skill "${entry.name}" is a shipped default of this profile and cannot be edited`, 400)
      }
      const raw = await readSkillText(entry.path)
      const parsed = parseSkillMarkdown(raw)
      const base = parsed.frontmatter !== undefined && parsed.name !== undefined ? parsed : undefined
      const text = skillFileText(base, entry.name, description, body, mcp)
      requireSkillSize(text)
      const info = await stat(entry.path)
      await writeFileAtomic(entry.path, Buffer.from(text, 'utf8'), info.mode & 0o777)
      return { name: base?.name ?? entry.name, path: entry.path }
    },

    'skills.delete': async (payload) => {
      const name = requireSkillName(payload)
      requireUnprotectedSkill(name, 'deleted')
      const root = resolveSkillsRoot(config)
      const entry = await findSkillEntry(root, name)
      if (entry === undefined) {
        throw new FsOpsError('not-found', `skill "${name}" does not exist`, 404)
      }
      if (isProtectedSkill(entry)) {
        throw new FsOpsError('protected', `skill "${entry.name}" is a shipped default of this profile and cannot be deleted`, 400)
      }
      const dest = await trashSkill(entry)
      return { name: entry.name, dest }
    },
  }

  ctx.effect(() => {
    const webServer = ctx.get('webServer') as {
      register?: (spec: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) => unknown
    } | undefined
    if (webServer?.register === undefined) return () => {}
    return webServer.register({
      kind: 'prefix',
      path: '/sidebar/fsops',
      handler: async (req, res) => {
        const httpReq = req as {
          headers: IncomingHttpHeaders
          method?: string
          url?: string
          on: (event: string, cb: (chunk: Buffer) => void) => unknown
        }
        const httpRes = res as {
          writeHead: (status: number, headers: Record<string, string>) => void
          end: (body: string) => void
        }
        if (!isTrustedRequest(httpReq, trustedHosts)) {
          writeJson(httpRes, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        // Cross-site simple-request CSRF (Oracle B1): a text/plain POST from
        // a malicious page is a CORS simple request — no preflight — and the
        // fence (Host-only) would let it through. Requiring application/json
        // forces a preflight for cross-site JSON, which our 405 on OPTIONS
        // blocks. Also reject any explicit untrusted Origin outright.
        const contentType = header(httpReq.headers, 'content-type') ?? ''
        if (!contentType.toLowerCase().includes('application/json')) {
          writeJson(httpRes, 415, { ok: false, error: { code: 'bad-request', message: 'content-type must be application/json' } })
          return
        }
        const origin = header(httpReq.headers, 'origin')
        if (origin !== undefined && origin !== 'null') {
          let originHost: string
          try {
            originHost = new URL(origin).hostname
          } catch {
            writeJson(httpRes, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (!isLoopbackHostname(originHost) && !trustedHosts.some((entry) => {
            try { return new URL(`http://${entry}`).hostname === originHost } catch { return false }
          })) {
            writeJson(httpRes, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
        }
        if (httpReq.method !== 'POST') {
          writeJson(httpRes, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const pathname = new URL(httpReq.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith('/sidebar/fsops/') ? pathname.slice('/sidebar/fsops/'.length) : undefined
        if (method === undefined || method.includes('/')) {
          writeError(httpRes, new FsOpsError('not-found', 'unknown fsops method', 404))
          return
        }
        try {
          const payload = await readJsonBody(httpReq)
          const handler = api[method]
          if (handler === undefined) {
            throw new FsOpsError('not-found', `unknown fsops method "${method}"`, 404)
          }
          writeOk(httpRes, await handler(payload))
        } catch (error) {
          writeError(httpRes, error)
        }
      },
    })
  }, 'dsh-enpoi-fs-ops: /sidebar/fsops routes')
}