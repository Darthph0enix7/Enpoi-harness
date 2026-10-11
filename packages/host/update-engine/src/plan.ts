/**
 * Classification and plan construction (§3.2): the total decision matrix over
 * (previous manifest, new manifest, local tree scan, tombstones, pins).
 *
 * Every path in the union of the three inputs receives exactly one action.
 * Merge resolutions are computed here (3-way merge from the pristine base,
 * local, and shipped bytes) so the plan is complete before apply: content
 * conflicts on runtime-code paths mark the plan `switchDecision: 'abort'`,
 * config/data conflicts keep the local file with a `.new-<version>` sidecar.
 */

import { readTreeBytes } from './manifest.ts'
import { hashText, hashBytes } from './manifest.ts'
import { merge3 } from './diff3.ts'
import { matchesAnyGlob } from './glob.ts'
import type {
  ConflictSeverity,
  Manifest,
  ManifestEntry,
  MergeOutcome,
  PlanAction,
  PlanActionKind,
  PlanConflict,
  PlanCounts,
  PlanReason,
  PlannedOutcome,
  UpdatePlan,
} from './types.ts'

/** Extensions classified as runtime code for the conflict severity split. */
export const RUNTIME_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.wasm', '.node',
])

/** Options for {@link buildPlan}. */
export interface BuildPlanOptions {
  /** Installed version the plan is computed against; null for a cold start. */
  fromVersion: string | null
  /** Version being installed; used in sidecar names. */
  toVersion: string
  /** Previous release manifest (baseline, hash-only). */
  previous: Manifest
  /** New release manifest. */
  next: Manifest
  /** Local tree scan. */
  local: Manifest
  /** Current installed tree root (local bytes). */
  localRoot: string
  /** Previous version directory (pristine base bytes). */
  baseRoot: string
  /** New release tree (shipped bytes). */
  releaseRoot: string
  /** Explicit `--forget` paths/globs; respected absences. */
  tombstones?: readonly string[]
  /** Pin paths/globs excluded from replacement, merge, and deletion. */
  pins?: readonly string[]
}

/**
 * Test whether a path is runtime code under the §3.2 severity split.
 * @param path - Relative path.
 * @returns True for JS/TS/module-output extensions.
 */
export function isRuntimeCodePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return RUNTIME_CODE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/**
 * Build the complete deterministic update plan.
 * @param options - Manifests, tree roots, tombstones, and pins.
 * @returns Plan with actions, conflicts, counts, switch decision, and fingerprint.
 */
export async function buildPlan(options: BuildPlanOptions): Promise<UpdatePlan> {
  const pins = options.pins ?? []
  const tombstones = options.tombstones ?? []
  const actions: PlanAction[] = []
  const conflicts: PlanConflict[] = []

  const pathSet = new Set<string>([
    ...Object.keys(options.previous),
    ...Object.keys(options.next),
    ...Object.keys(options.local),
  ])
  const paths = [...pathSet].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

  for (const path of paths) {
    const classified = await classify(path, options.previous[path] ?? null, options.next[path] ?? null, options.local[path] ?? null, {
      ...options,
      pins,
      tombstones,
    })
    actions.push(classified.action)
    if (classified.conflict !== null) conflicts.push(classified.conflict)
  }

  actions.sort((left, right) => {
    const leftLate = left.kind === 'delete' || left.kind === 'tombstone'
    const rightLate = right.kind === 'delete' || right.kind === 'tombstone'
    if (leftLate !== rightLate) return leftLate ? 1 : -1
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })

  const counts: PlanCounts = {
    skip: 0, replace: 0, add: 0, merge: 0, 'keep-local': 0, 'keep-local-sidecar': 0,
    'keep-untracked': 0, restore: 0, delete: 0, tombstone: 0, 'pin-skip': 0,
  }
  for (const action of actions) counts[action.kind]++

  const switchDecision: 'proceed' | 'abort' = conflicts.some(conflict => conflict.abort) ? 'abort' : 'proceed'
  const withoutFingerprint = {
    schema: 1 as const,
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    actions,
    counts,
    conflicts,
    switchDecision,
  }
  return { ...withoutFingerprint, fingerprint: planFingerprint(withoutFingerprint) }
}

/** Plan fields that the canonical fingerprint covers. */
export type PlanFingerprintInput = Omit<UpdatePlan, 'fingerprint'>

/**
 * Recompute the canonical plan fingerprint (plan identity for journals).
 * @param plan - Plan or plan payload without its fingerprint.
 * @returns Hex SHA-256 over the canonical JSON.
 */
export function planFingerprint(plan: PlanFingerprintInput): string {
  return hashBytes(canonicalJson({
    schema: plan.schema,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    actions: plan.actions,
    counts: plan.counts,
    conflicts: plan.conflicts,
    switchDecision: plan.switchDecision,
  }))
}

interface ClassifyContext extends BuildPlanOptions {
  pins: readonly string[]
  tombstones: readonly string[]
}

interface Classified {
  action: PlanAction
  conflict: PlanConflict | null
}

async function classify(
  path: string,
  baseline: ManifestEntry | null,
  shipped: ManifestEntry | null,
  local: ManifestEntry | null,
  context: ClassifyContext,
): Promise<Classified> {
  const pinned = matchesAnyGlob(context.pins, path)
  const tombstoned = matchesAnyGlob(context.tombstones, path)
  const base = { path, pinned, tombstoned, baseline, shipped, local }

  // --- Tombstones (§3.2 last row): explicit --forget wins over restore/delete.
  if (tombstoned && (baseline !== null || shipped !== null)) {
    const respect = local === null
      || (baseline !== null && entryMatches(local, baseline))
      || (baseline === null && shipped !== null && entryMatches(local, shipped))
    if (respect) {
      return action(base, {
        kind: 'tombstone',
        reason: 'tombstoned',
        outcome: absentOutcome(),
        merge: null,
      })
    }
    // Local diverged from the forgotten path: keep the user bytes and report.
    return action(base, { kind: 'keep-local', reason: 'tombstoned', outcome: preserved(local), merge: null })
  }

  // --- Previously shipped and still shipped.
  if (baseline !== null && shipped !== null) {
    const newState = entryMatches(shipped, baseline) ? 'unchanged' : 'changed'
    if (local === null) {
      return action(base, {
        kind: 'restore',
        reason: newState === 'unchanged' ? 'missing/unchanged' : 'missing/changed',
        outcome: { disposition: 'shipped', sha256: shipped.sha256, sidecars: {} },
        merge: null,
      })
    }
    const localState = entryMatches(local, baseline) ? 'unchanged' : 'modified'
    if (pinned && newState === 'changed') {
      return action(base, { kind: 'pin-skip', reason: 'pinned', outcome: preserved(local), merge: null })
    }
    if (localState === 'unchanged') {
      if (newState === 'unchanged') {
        return action(base, { kind: 'skip', reason: 'unchanged/unchanged', outcome: shippedOutcome(shipped), merge: null })
      }
      return action(base, { kind: 'replace', reason: 'unchanged/changed', outcome: shippedOutcome(shipped), merge: null })
    }
    if (newState === 'unchanged') {
      return action(base, { kind: 'keep-local', reason: 'modified/unchanged', outcome: preserved(local), merge: null })
    }
    return await resolveBothChanged(path, baseline, shipped, local, context)
  }

  // --- Previously shipped, removed from the new release (§3.4).
  if (baseline !== null && shipped === null) {
    if (local === null) {
      return action(base, { kind: 'skip', reason: 'missing/removed', outcome: { disposition: 'absent', sha256: null, sidecars: {} }, merge: null })
    }
    if (pinned) {
      return action(base, { kind: 'pin-skip', reason: 'pinned', outcome: preserved(local), merge: null })
    }
    if (entryMatches(local, baseline)) {
      return action(base, { kind: 'delete', reason: 'removed/unmodified', outcome: { disposition: 'absent', sha256: null, sidecars: {} }, merge: null })
    }
    return action(base, { kind: 'keep-local', reason: 'modified/removed', outcome: preserved(local), merge: null })
  }

  // --- Newly shipped.
  if (shipped !== null) {
    if (local === null) {
      return action(base, { kind: 'add', reason: 'added', outcome: shippedOutcome(shipped), merge: null })
    }
    if (pinned) {
      return action(base, { kind: 'pin-skip', reason: 'pinned', outcome: preserved(local), merge: null })
    }
    if (entryMatches(local, shipped)) {
      return action(base, { kind: 'skip', reason: 'untracked/identical', outcome: shippedOutcome(shipped), merge: null })
    }
    return await resolveCollision(path, shipped, local, context)
  }

  // --- Untracked local-only path: always preserved.
  return action(base, { kind: 'keep-untracked', reason: 'untracked/absent', outcome: preserved(local), merge: null })
}

async function resolveBothChanged(
  path: string,
  baseline: ManifestEntry,
  shipped: ManifestEntry,
  local: ManifestEntry,
  context: ClassifyContext,
): Promise<Classified> {
  const severity = severityFor(path)
  const abort = severity === 'runtime-code'
  const sidecarPath = sidecarName(path, 'new', context.toVersion)

  if (local.type !== shipped.type || baseline.type !== shipped.type) {
    const sidecar = await shippedSidecar(context.releaseRoot, path, shipped, 'new', context.toVersion)
    return action({ path, pinned: false, tombstoned: false, baseline, shipped, local }, {
      kind: 'keep-local-sidecar',
      reason: 'modified/changed',
      outcome: { disposition: 'local', sha256: local.sha256, sidecars: sidecar.record },
      merge: { status: 'type-mismatch', severity, conflicts: 0 },
      conflict: {
        path,
        kind: 'type-mismatch',
        severity,
        abort,
        detail: `local kind '${local.type}' differs from shipped kind '${shipped.type}'; local kept`,
        sidecar: sidecar.path,
      },
    })
  }

  if (local.type === 'dir') {
    return action({ path, pinned: false, tombstoned: false, baseline, shipped, local }, {
      kind: 'keep-local-sidecar',
      reason: 'modified/changed',
      outcome: { disposition: 'local', sha256: null, sidecars: {} },
      merge: { status: 'type-mismatch', severity: 'config-data', conflicts: 0 },
      conflict: {
        path,
        kind: 'type-mismatch',
        severity: 'config-data',
        abort: false,
        detail: 'directory metadata changed on both sides; local kept',
        sidecar: null,
      },
    })
  }

  if (local.type === 'symlink') {
    const sidecar = await shippedSidecar(context.releaseRoot, path, shipped, 'new', context.toVersion)
    return action({ path, pinned: false, tombstoned: false, baseline, shipped, local }, {
      kind: 'keep-local-sidecar',
      reason: 'modified/changed',
      outcome: { disposition: 'local', sha256: local.sha256, sidecars: sidecar.record },
      merge: { status: 'binary', severity: 'config-data', conflicts: 0 },
      conflict: {
        path,
        kind: 'binary',
        severity: 'config-data',
        abort: false,
        detail: `symlink target changed on both sides ('${local.target ?? ''}' kept, shipped '${shipped.target ?? ''}'); local kept`,
        sidecar: sidecar.path,
      },
    })
  }

  const [baseBytes, localBytes, shippedBytes] = await Promise.all([
    readTreeBytes(context.baseRoot, path).catch(() => null),
    readTreeBytes(context.localRoot, path).catch(() => null),
    readTreeBytes(context.releaseRoot, path),
  ])
  if (baseBytes === null || localBytes === null) {
    const sidecar = await shippedSidecar(context.releaseRoot, path, shipped, 'new', context.toVersion)
    return action({ path, pinned: false, tombstoned: false, baseline, shipped, local }, {
      kind: 'keep-local-sidecar',
      reason: 'modified/changed',
      outcome: { disposition: 'local', sha256: local.sha256, sidecars: sidecar.record },
      merge: { status: 'type-mismatch', severity, conflicts: 0 },
      conflict: {
        path,
        kind: 'type-mismatch',
        severity,
        abort,
        detail: 'merge base or local bytes unavailable; local kept',
        sidecar: sidecar.path,
      },
    })
  }

  const binary = baseline.binary || local.binary || shipped.binary
    || baseBytes.includes(0) || localBytes.includes(0) || shippedBytes.includes(0)
  if (binary) {
    const sidecar = await shippedSidecar(context.releaseRoot, path, shipped, 'new', context.toVersion)
    return action({ path, pinned: false, tombstoned: false, baseline, shipped, local }, {
      kind: 'keep-local-sidecar',
      reason: 'modified/changed',
      outcome: { disposition: 'local', sha256: local.sha256, sidecars: sidecar.record },
      merge: { status: 'binary', severity, conflicts: 0 },
      conflict: {
        path,
        kind: 'binary',
        severity,
        abort,
        detail: 'binary file changed on both sides; local kept',
        sidecar: sidecar.path,
      },
    })
  }

  const merged = merge3(baseBytes.toString('utf8'), localBytes.toString('utf8'), shippedBytes.toString('utf8'))
  if (merged.clean) {
    return action({ path, pinned: false, tombstoned: false, baseline, shipped, local }, {
      kind: 'merge',
      reason: 'modified/changed',
      outcome: { disposition: 'merged', sha256: hashText(merged.text), sidecars: {} },
      merge: { status: 'clean', severity: null, conflicts: 0 },
    })
  }
  return action({ path, pinned: false, tombstoned: false, baseline, shipped, local }, {
    kind: 'keep-local-sidecar',
    reason: 'modified/changed',
    outcome: { disposition: 'local', sha256: local.sha256, sidecars: { [sidecarPath]: hashText(merged.text) } },
    merge: { status: 'conflict', severity, conflicts: merged.conflicts },
    conflict: {
      path,
      kind: 'merge',
      severity,
      abort,
      detail: `merge conflict in ${merged.conflicts} region(s); local kept`,
      sidecar: sidecarPath,
    },
  })
}

async function resolveCollision(
  path: string,
  shipped: ManifestEntry,
  local: ManifestEntry,
  context: ClassifyContext,
): Promise<Classified> {
  const sidecar = await shippedSidecar(context.releaseRoot, path, shipped, 'shipped', context.toVersion)
  return action({ path, pinned: false, tombstoned: false, baseline: null, shipped, local }, {
    kind: 'keep-local-sidecar',
    reason: 'untracked/added',
    outcome: { disposition: 'local', sha256: local.sha256, sidecars: sidecar.record },
    merge: null,
    conflict: {
      path,
      kind: 'untracked-collision',
      severity: 'config-data',
      abort: false,
      detail: 'newly shipped path collides with an untracked local path; user file kept',
      sidecar: sidecar.path,
    },
  })
}

interface SidecarResult {
  /** Sidecar path when one is written; null for directories. */
  path: string | null
  /** Outcome record: sidecar path → content hash. */
  record: Record<string, string>
}

async function shippedSidecar(
  releaseRoot: string,
  path: string,
  shipped: ManifestEntry,
  tag: 'new' | 'shipped',
  version: string,
): Promise<SidecarResult> {
  if (shipped.type === 'dir') return { path: null, record: {} }
  const sidecarPath = sidecarName(path, tag, version)
  if (shipped.type === 'symlink') {
    const content = Buffer.from(`${shipped.target ?? ''}\n`, 'utf8')
    return { path: sidecarPath, record: { [sidecarPath]: hashBytes(content) } }
  }
  const bytes = await readTreeBytes(releaseRoot, path)
  return { path: sidecarPath, record: { [sidecarPath]: hashBytes(bytes) } }
}

function sidecarName(path: string, tag: 'new' | 'shipped', version: string): string {
  const safeVersion = version.replace(/[/\\]/gu, '-')
  return safeVersion === '' ? `${path}.${tag}` : `${path}.${tag}-${safeVersion}`
}

function severityFor(path: string): ConflictSeverity {
  return isRuntimeCodePath(path) ? 'runtime-code' : 'config-data'
}

function entryMatches(local: ManifestEntry, reference: ManifestEntry): boolean {
  return local.type === reference.type
    && local.mode === reference.mode
    && local.sha256 === reference.sha256
    && local.target === reference.target
}

function shippedOutcome(shipped: ManifestEntry): PlannedOutcome {
  return { disposition: 'shipped', sha256: shipped.sha256, sidecars: {} }
}

function preserved(local: ManifestEntry | null): PlannedOutcome {
  return { disposition: 'local', sha256: local?.sha256 ?? null, sidecars: {} }
}

function absentOutcome(): PlannedOutcome {
  return { disposition: 'absent', sha256: null, sidecars: {} }
}

function action(
  base: {
    path: string
    pinned: boolean
    tombstoned: boolean
    baseline: ManifestEntry | null
    shipped: ManifestEntry | null
    local: ManifestEntry | null
  },
  add: { kind: PlanActionKind; reason: PlanReason; outcome: PlannedOutcome; merge: MergeOutcome | null; conflict?: PlanConflict },
): Classified {
  return {
    action: {
      kind: add.kind,
      path: base.path,
      reason: add.reason,
      pinned: base.pinned,
      tombstoned: base.tombstoned,
      baseline: base.baseline,
      shipped: base.shipped,
      local: base.local,
      outcome: add.outcome,
      merge: add.merge,
    },
    conflict: add.conflict ?? null,
  }
}

/**
 * Serialize a plan deterministically (2-space JSON, trailing newline).
 * @param plan - Plan to serialize.
 * @returns JSON text.
 */
export function serializePlan(plan: UpdatePlan): string {
  return JSON.stringify(plan, null, 2) + '\n'
}

/**
 * Parse and validate a plan document, rejecting any fingerprint mismatch.
 * @param text - JSON plan text.
 * @returns Parsed plan.
 */
export function parsePlan(text: string): UpdatePlan {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || (parsed as { schema?: unknown }).schema !== 1 || !Array.isArray((parsed as { actions?: unknown }).actions)) {
    throw new Error('invalid update plan document')
  }
  const plan = parsed as UpdatePlan
  const expected = planFingerprint(plan)
  if (expected !== plan.fingerprint) {
    throw new Error(`update plan fingerprint mismatch: expected ${plan.fingerprint}, computed ${expected}`)
  }
  return plan
}

function canonicalJson(value: unknown): string {
  return stableStringify(value)
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
