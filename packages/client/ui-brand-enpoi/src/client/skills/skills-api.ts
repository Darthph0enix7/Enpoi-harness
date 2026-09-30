/**
 * Skills settings API client — the fenced `/sidebar/fsops` `skills.*` routes
 * plus the newest-session address the host uses to merge the read-only
 * registry catalog. Mirrors the sidebar's gateway envelope handling; every
 * failure is a {@link SkillsApiError} carrying the host's code and message.
 */

/** Skill identity as the host reports it: `default`/`profile` rows are editable, `registry` rows are not. */
export type SkillSource = 'default' | 'profile' | 'registry'

/** One skills list row. */
export interface SkillRow {
  /** Skill identity (frontmatter name). */
  name: string
  /** On-disk entry name; equals `name` for entries created here. */
  entry: string
  description: string
  path?: string
  format: 'directory' | 'file'
  source: SkillSource
  protected: boolean
  editable: boolean
}

/** `skills.list` value. */
export interface SkillsListValue {
  root: string
  skills: SkillRow[]
  registry: { ok: true } | { ok: false; error: string }
}

/** One loaded skill definition. */
export interface SkillDetailValue {
  name: string
  entry: string
  description: string
  body: string
  content: string
  path: string
  format: 'directory' | 'file'
  source: SkillSource
  protected: boolean
}

/** Create/update payload shared by both write routes. */
export interface SkillWriteInput {
  name: string
  description: string
  body: string
}

/** One rejected fenced call. */
export class SkillsApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'SkillsApiError'
  }
}

/** Kebab-case skill name, mirroring the host's `isSkillName` (instant local feedback; the host re-checks). */
export function isSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

let rpcSeq = 0

/** Unique wire rpcId per request (the gateway echoes it; duplicates race). */
function nextRpcId(prefix: string): string {
  rpcSeq += 1
  return `${prefix}-${rpcSeq}`
}

/** One skills.* call against the fenced fsops route. */
async function callSkills(method: string, payload: Record<string, unknown>): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`/sidebar/fsops/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new SkillsApiError('network', error instanceof Error ? error.message : String(error), 0)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new SkillsApiError('malformed', `“${method}” returned a non-JSON response`, response.status)
  }
  const envelope = parsed as { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } } | null
  if (envelope?.ok === true) return envelope.value
  // A missing/blank wire message falls back to the route name: a diagnostic
  // token, while every user-facing wrapper copy is localized by the section.
  const reason: string = typeof envelope?.error?.message === 'string' && envelope.error.message !== ''
    ? envelope.error.message
    : method
  const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : 'error'
  throw new SkillsApiError(code, reason, response.status)
}

/** One list row from an untrusted wire value; undefined when unusable. */
function parseRow(value: unknown): SkillRow | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name === '') return undefined
  const source = record.source === 'default' || record.source === 'profile' || record.source === 'registry'
    ? record.source
    : 'profile'
  return {
    name: record.name,
    entry: typeof record.entry === 'string' && record.entry !== '' ? record.entry : record.name,
    description: typeof record.description === 'string' ? record.description : '',
    ...typeof record.path === 'string' && record.path !== '' ? { path: record.path } : {},
    format: record.format === 'file' ? 'file' : 'directory',
    source,
    protected: record.protected === true,
    editable: record.editable === true,
  }
}

/** List the profile skills directory; `sessionId` adds read-only registry rows. */
export async function listSkills(sessionId: string | undefined): Promise<SkillsListValue> {
  const value = await callSkills('skills.list', sessionId === undefined ? {} : { sessionId })
  const record = value as { root?: unknown; skills?: unknown; registry?: unknown } | null
  if (record === null || typeof record !== 'object' || !Array.isArray(record.skills)) {
    throw new SkillsApiError('malformed', '“skills.list” returned a malformed response', 200)
  }
  const registry = record.registry as { ok?: unknown; error?: unknown } | null
  return {
    root: typeof record.root === 'string' ? record.root : '',
    skills: record.skills.map(parseRow).filter((row): row is SkillRow => row !== undefined),
    registry: registry?.ok === true
      ? { ok: true }
      : { ok: false, error: typeof registry?.error === 'string' ? registry.error : 'unavailable' },
  }
}

/** Load one SKILL.md. */
export async function readSkill(name: string): Promise<SkillDetailValue> {
  const value = await callSkills('skills.read', { name })
  const record = value as Record<string, unknown> | null
  if (record === null || typeof record !== 'object' || typeof record.body !== 'string') {
    throw new SkillsApiError('malformed', '“skills.read” returned a malformed response', 200)
  }
  return {
    name: typeof record.name === 'string' ? record.name : name,
    entry: typeof record.entry === 'string' ? record.entry : name,
    description: typeof record.description === 'string' ? record.description : '',
    body: record.body,
    content: typeof record.content === 'string' ? record.content : record.body,
    path: typeof record.path === 'string' ? record.path : '',
    format: record.format === 'file' ? 'file' : 'directory',
    source: record.source === 'default' ? 'default' : record.source === 'registry' ? 'registry' : 'profile',
    protected: record.protected === true,
  }
}

/** Create a new directory-bundle skill. */
export async function createSkill(input: SkillWriteInput): Promise<void> {
  await callSkills('skills.create', { ...input })
}

/** Rewrite one skill's description and body. */
export async function updateSkill(input: SkillWriteInput): Promise<void> {
  await callSkills('skills.update', { ...input })
}

/** Trash-stage one skill. */
export async function deleteSkill(name: string): Promise<void> {
  await callSkills('skills.delete', { name })
}

/** The newest visible session id, for the host's registry merge; undefined when none resolves. */
export async function newestSessionId(): Promise<string | undefined> {
  try {
    const response = await fetch('/api/session/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'session.list',
        rpcId: nextRpcId('skills-sessions'),
        payload: { args: { request: {} } },
      }),
    })
    if (!response.ok) return undefined
    const json = await response.json() as { result?: { ok?: boolean; value?: { items?: unknown } } }
    const items = json?.result?.value?.items
    if (!Array.isArray(items)) return undefined
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      const id = (item as Record<string, unknown>).sessionId
      if (typeof id === 'string' && id !== '') return id
    }
  } catch {
    // No session address: the section degrades to the on-disk profile skills.
  }
  return undefined
}
