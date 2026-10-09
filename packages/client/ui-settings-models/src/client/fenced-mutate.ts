/**
 * Revision-fenced settings writes for the Models surfaces.
 *
 * The settings document carries a monotonic revision per namespace; a write
 * planned from a stale read is refused with `settings/conflict`, and replaying
 * the same operations repeats the refusal. The one correct pattern is
 * `describe` → plan against the fresh namespace → `mutate` with the read
 * revision, replanning from a new read after each conflict, bounded by
 * {@link MAX_GROUP_WRITE_RETRIES}. A write racing a never-settling gateway is
 * bounded by {@link withWriteTimeout}.
 *
 * @module ui-settings-models/fenced-mutate
 */
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { GroupWriteFailure } from './model-groups.ts'
import { MAX_GROUP_WRITE_RETRIES } from './model-groups.ts'
import type { ModelsWire } from './store.ts'
import type { en } from './locales.ts'
import { withWriteTimeout } from './write-timeout.ts'

/** One namespace's freshly planned write. */
export interface FencedPlan {
  /** Path operations against the namespace document. */
  ops: readonly SettingsPathOpView[]
  /** Human labels of the committed work (diagnostics/tests); defaults to none. */
  labels?: readonly string[]
}

/** One fenced namespace outcome: the failure, and the labels of the committed plan. */
export interface FencedOutcome {
  /** The refusing cause, or null once the plan committed (or was empty). */
  error: GroupWriteFailure | null
  /** Labels of the plan that committed; empty for an empty plan or a failure. */
  labels: readonly string[]
}

/**
 * Run one namespace's plan against the live document with revision fencing and
 * a bounded conflict retry that re-reads and replans each attempt. The plan
 * callback receives the freshly described namespace view, so a draft is always
 * re-applied onto the current document and leaf operations never overwrite a
 * concurrent writer's unrelated fields. A namespace with no operations is a
 * no-op and never mutates.
 * @param api - the settings Remote face (describe + mutate).
 * @param ns - the namespace to rewrite.
 * @param plan - builds the operations from one fresh namespace view.
 * @returns the failure, or the labels of the plan that committed.
 */
export async function applyFenced(
  api: Pick<ModelsWire, 'settings'>,
  ns: string,
  plan: (view: SettingsNamespaceView | undefined) => FencedPlan,
): Promise<FencedOutcome> {
  const timeout: FencedOutcome = { error: { code: 'timeout' }, labels: [] }
  return withWriteTimeout((async (): Promise<FencedOutcome> => {
    for (let attempt = 0; attempt <= MAX_GROUP_WRITE_RETRIES; attempt++) {
      const described = await api.settings.describe()
      if (!described.ok) return { error: { code: 'unavailable', ...messageOf(described.error.message) }, labels: [] }
      const view = described.value.namespaces.find(candidate => candidate.ns === ns)
      const planned = plan(view)
      if (planned.ops.length === 0) return { error: null, labels: [] }
      const written = await api.settings.mutate(ns, [...planned.ops], view?.revision)
      if (written.ok) return { error: null, labels: planned.labels ?? [] }
      if (written.error.code !== 'settings/conflict') {
        return { error: { code: 'rejected', ...messageOf(written.error.message) }, labels: [] }
      }
    }
    return { error: { code: 'conflict' }, labels: [] }
  })(), timeout)
}

/** Attach a host message only when it carries text. */
function messageOf(message: string): { message?: string } {
  return message === '' ? {} : { message }
}

/**
 * Localize why a fenced write did not commit. The host's own diagnostic is
 * shown verbatim when present; otherwise the cause code maps to dictionary
 * copy. A caller without a translate seat falls back to the machine code.
 * @param t - the Models section translate, when bound.
 * @param failure - the fenced write failure.
 * @returns the text the surface shows.
 */
export function fencedFailureText(
  t: ((key: keyof typeof en) => string) | undefined,
  failure: GroupWriteFailure,
): string {
  if (failure.message !== undefined && failure.message !== '') return failure.message
  if (t === undefined) return failure.code
  switch (failure.code) {
    case 'unavailable': return t('cleanupUnavailable')
    case 'conflict': return t('cleanupConflict')
    case 'timeout': return t('cleanupTimeout')
    case 'rejected': return t('cleanupRejected')
  }
}
