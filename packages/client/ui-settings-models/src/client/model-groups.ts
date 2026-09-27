/**
 * Model groups (`enpoi-orchestration.chains`) for the Providers page: the
 * registry parse and the fenced write the Model groups row uses.
 *
 * Writes follow the Dynamic panels' pattern — one `settings.describe` for the
 * current revision, `settings.mutate` with `expectedRevision`, conflict retry
 * bounded by {@link MAX_GROUP_WRITE_RETRIES}, and a bounded race against a
 * never-settling gateway. The row applies the change optimistically and rolls
 * back behind an inline error when the write does not persist.
 */
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsWire } from './store.ts'
import { withWriteTimeout } from './write-timeout.ts'

/** The namespace carrying the operator registries. */
export const ORCHESTRATION_NS = 'enpoi-orchestration'

/** One ordered link of a group: a route plus the model it serves. */
export interface ModelGroupLink {
  provider: string
  model: string
  effort?: string
}

/** One model group as this surface edits it (`chains.<id>`). */
export interface ModelGroup {
  id: string
  label: string
  links: ModelGroupLink[]
  attempts: number
  onCut: 'failover' | 'continue'
  disabled: boolean
}

/** How many times a fenced write re-reads and retries on conflict. */
export const MAX_GROUP_WRITE_RETRIES = 3

/** Parse one stored link; a link without a route/model is dropped. */
function parseLink(raw: unknown): ModelGroupLink | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.provider !== 'string' || rec.provider === '') return undefined
  if (typeof rec.model !== 'string' || rec.model === '') return undefined
  // The effort is adapter-owned: a non-string or blank value is absent, so the
  // link keeps inheriting exactly as a link that never declared one.
  const effort = typeof rec.effort === 'string' ? rec.effort.trim() : ''
  return {
    provider: rec.provider,
    model: rec.model,
    ...effort === '' ? {} : { effort },
  }
}

/** Parse the stored `chains` map into editable groups, dropping malformed entries. */
export function parseModelGroups(value: unknown): ModelGroup[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const groups: ModelGroup[] = []
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (id === '' || raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const rec = raw as Record<string, unknown>
    groups.push({
      id,
      label: typeof rec.label === 'string' && rec.label !== '' ? rec.label : id,
      links: Array.isArray(rec.links)
        ? rec.links.map(parseLink).filter((link): link is ModelGroupLink => link !== undefined)
        : [],
      attempts: typeof rec.attempts === 'number' && Number.isInteger(rec.attempts) && rec.attempts >= 1
        ? rec.attempts
        : 2,
      onCut: rec.onCut === 'continue' ? 'continue' : 'failover',
      disabled: rec.disabled === true,
    })
  }
  return groups
}

/** Read the groups out of the mirrored namespace view. */
export function readModelGroups(namespace: SettingsNamespaceView | undefined): ModelGroup[] {
  if (namespace === undefined) return []
  const value = namespace.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return parseModelGroups((value as Record<string, unknown>)['chains'])
}

/** The stored JSON value of one link. */
export type GroupSpecLink = { provider: string; model: string; effort?: string }

/** The stored JSON value of one group spec (`chains.<id>`). */
export type GroupSpec = {
  label: string
  links: GroupSpecLink[]
  attempts: number
  onCut: 'failover' | 'continue'
  disabled: boolean
}

/** The stored spec value of one group (the whole object, as `chains.<id>` holds it). */
export function groupSpec(group: ModelGroup): GroupSpec {
  return {
    label: group.label,
    links: group.links.map(link => ({
      provider: link.provider,
      model: link.model,
      ...link.effort === undefined ? {} : { effort: link.effort },
    })),
    attempts: group.attempts,
    onCut: group.onCut,
    disabled: group.disabled,
  }
}

/** Write one whole group spec at `chains.<id>`. */
export function groupWriteOps(group: ModelGroup): SettingsPathOpView[] {
  return [{ op: 'set', path: ['chains', group.id], value: groupSpec(group) }]
}

/** Order preview of a group's links, e.g. `antigravity → opencode-go`. */
export function linkProviderPreview(group: ModelGroup): string {
  return group.links.map(link => link.provider).join(' → ')
}

/** One link as an operator reads it, e.g. `antigravity/gemini-3.8-flash-tiered`. */
export function linkLabel(link: ModelGroupLink): string {
  return `${link.provider}/${link.model}`
}

/** One group id accepted by the registry (mirrors the council-id rule). */
export function isValidGroupId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
}

/** Why a fenced write did not persist. */
export interface GroupWriteFailure {
  /** Machine cause the row localizes when the host supplied no message. */
  code: 'unavailable' | 'conflict' | 'timeout' | 'rejected'
  /** The host's own diagnostic, shown verbatim when present. */
  message?: string
}

/**
 * Apply operations to `enpoi-orchestration` with revision fencing and bounded
 * conflict retry.
 * @param api - the settings Remote face (describe + mutate).
 * @param ops - path operations against the stored section.
 * @returns null once committed, otherwise why the write did not persist.
 */
export async function writeGroupOps(
  api: Pick<ModelsWire, 'settings'>,
  ops: SettingsPathOpView[],
): Promise<GroupWriteFailure | null> {
  return withWriteTimeout((async (): Promise<GroupWriteFailure | null> => {
    for (let attempt = 0; attempt <= MAX_GROUP_WRITE_RETRIES; attempt++) {
      const described = await api.settings.describe()
      if (!described.ok) return { code: 'unavailable', ...messageOf(described.error.message) }
      const namespace = described.value.namespaces.find(view => view.ns === ORCHESTRATION_NS)
      const written = await api.settings.mutate(ORCHESTRATION_NS, ops, namespace?.revision)
      if (written.ok) return null
      if (written.error.code !== 'settings/conflict') {
        return { code: 'rejected', ...messageOf(written.error.message) }
      }
    }
    return { code: 'conflict' }
  })(), { code: 'timeout' })
}

/** Attach a host message only when it carries text. */
function messageOf(message: string): { message?: string } {
  return message === '' ? {} : { message }
}
