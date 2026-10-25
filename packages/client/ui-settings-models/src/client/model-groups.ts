/**
 * Model groups (`enpoi-orchestration.chains`) for the Providers page: the
 * resolved projection every surface reads, and the leaf writes the Model
 * groups row issues.
 *
 * The settings document stays authoritative. This module never parses the raw
 * `chains` map: it reads the host's resolved-group artifact
 * (`modelChains.resolved`) through the shared ui-model-selection registry, so
 * the editor and the picker cannot drift on what a group contains. Writes are
 * PATCHES of the fields the operator actually changed — a rename writes
 * `chains.<id>.label` alone — so `selectors`, `adopt`, `attempts`, `onCut`,
 * `disabled`, and any field a later lane adds survive an edit untouched.
 *
 * Writes follow the Dynamic panels' pattern — one `settings.describe` for the
 * current revision, `settings.mutate` with `expectedRevision`, conflict retry
 * bounded by {@link MAX_GROUP_WRITE_RETRIES}, and a bounded race against a
 * never-settling gateway. The row applies the change optimistically and rolls
 * back behind an inline error when the write does not persist.
 *
 * The stored parse and the `ModelGroup`/`ModelGroupLink` types live in the
 * shared `@deepseek-ai/dsh-client-ui-primitives` owner, re-exported here for
 * this package's consumers.
 */
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelGroup, ModelGroupLink } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ModelsWire } from './store.ts'
import { withWriteTimeout } from './write-timeout.ts'

export { parseModelGroup, parseModelGroups, parseModelGroupList, parseResolvedModelGroup } from '@deepseek-ai/dsh-client-ui-primitives'
export { getModelGroups, refreshModelGroups, subscribeModelGroups, getModelGroupsSnapshot } from '@deepseek-ai/dsh-client-ui-model-selection/client'
export type { ModelGroup, ModelGroupLink, ModelGroupSelector, ModelGroupSelectorMatch } from '@deepseek-ai/dsh-client-ui-model-selection/client'

/** The namespace carrying the operator registries. */
export const ORCHESTRATION_NS = 'enpoi-orchestration'

/** How many times a fenced write re-reads and retries on conflict. */
export const MAX_GROUP_WRITE_RETRIES = 3

/** Whether two links carry the same editable route/effort. */
function sameLink(left: ModelGroupLink, right: ModelGroupLink): boolean {
  return left.provider === right.provider && left.model === right.model && left.effort === right.effort
}

/** Whether two lists of links carry the same ordered routes. */
export function sameLinks(left: readonly ModelGroupLink[], right: readonly ModelGroupLink[]): boolean {
  return left.length === right.length && left.every((link, index) => {
    const other = right[index]
    return other !== undefined && sameLink(link, other)
  })
}

/**
 * Whether two parsed group lists carry the same STORED values. The resolved
 * projection (members, warnings, candidate trivia) is deliberately excluded: a
 * catalogue change moving a selector's matches must not look like a settings
 * edit and drop an optimistic overlay.
 */
export function sameModelGroups(left: readonly ModelGroup[], right: readonly ModelGroup[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((group, index) => {
    const other = right[index]
    if (other === undefined || group.id !== other.id || group.label !== other.label
      || group.attempts !== other.attempts || group.onCut !== other.onCut
      || group.disabled !== other.disabled) return false
    if (JSON.stringify(group.selectors) !== JSON.stringify(other.selectors)) return false
    return sameLinks(group.links, other.links)
  })
}

/** The stored JSON value of one link. */
export type GroupSpecLink = { provider: string; model: string; effort?: string }

/**
 * The stored JSON value of a NEW group spec (`chains.<id>`). Selectors are
 * never written from the UI: creation starts with explicit links, and every
 * later edit patches a leaf so stored selectors cannot be dropped.
 */
export type GroupSpec = {
  label: string
  links: GroupSpecLink[]
  attempts: number
  onCut: 'failover' | 'continue'
  disabled: boolean
}

/** The stored spec value of one new group (the whole object, as `chains.<id>` holds it). */
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

/** Write one whole group spec at `chains.<id>` (creation only). */
export function groupWriteOps(group: ModelGroup): SettingsPathOpView[] {
  return [{ op: 'set', path: ['chains', group.id], value: groupSpec(group) }]
}

/**
 * Patch only the fields an edit actually changed. Every untouched key —
 * `selectors` and their `adopt` flags, `attempts`/`onCut`, `disabled`, the
 * label — stays exactly as stored, because this function never writes them.
 * @param next - the edited group (from the editor draft).
 * @param previous - the same group as the host last projected.
 * @returns the leaf operations; empty when nothing changed.
 */
export function groupEditOps(next: ModelGroup, previous: ModelGroup): SettingsPathOpView[] {
  const ops: SettingsPathOpView[] = []
  if (next.label !== previous.label) {
    ops.push({ op: 'set', path: ['chains', next.id, 'label'], value: next.label })
  }
  if (!sameLinks(next.links, previous.links)) {
    ops.push({
      op: 'set',
      path: ['chains', next.id, 'links'],
      value: groupSpec(next).links,
    })
  }
  if (next.attempts !== previous.attempts) {
    ops.push({ op: 'set', path: ['chains', next.id, 'attempts'], value: next.attempts })
  }
  if (next.onCut !== previous.onCut) {
    ops.push({ op: 'set', path: ['chains', next.id, 'onCut'], value: next.onCut })
  }
  return ops
}

/**
 * Order preview of a group's resolved members, e.g. `antigravity → opencode-go`.
 * A selector-only group previews what its selectors matched.
 */
export function linkProviderPreview(group: ModelGroup): string {
  const links = group.members.length > 0 ? group.members : group.links
  return links.map(link => link.provider).join(' → ')
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
