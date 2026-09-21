/**
 * Effective role registry reader (`enpoiRoles.list`).
 *
 * The Dynamic → Roles panel edits only the settings override layer
 * (`enpoi-orchestration.roles`); the built-in personas live in the fork's role
 * tables (`tool-subagent`), so an untouched built-in would render empty
 * fields. This store serves the host's effective registry (persona included)
 * through the profile RPC that owns the role tables — the client never
 * duplicates persona text.
 *
 * Failure posture is FAIL-OPEN: a missing service, a failed read, or a
 * malformed answer keeps the map empty, and the panel falls back to the
 * today's display (settings key plus client code-default label/group).
 */

/** One host-resolved role row; structural subset of the host's `ResolvedRole`. */
export interface EffectiveRole {
  id: string
  label?: string
  persona?: string
  group?: string
  seat?: boolean
  builtin?: boolean
  available?: string[]
}

/** Role id → host-resolved role. */
export type EffectiveRoleMap = Record<string, EffectiveRole>

let current: EffectiveRoleMap = {}
let primed = false
let failed = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Synchronous snapshot reader for the panels (0ms latency). */
export function getEffectiveRoles(): EffectiveRoleMap {
  return current
}

/**
 * Subscribe to effective-registry changes (boot priming and pushed refreshes).
 * @param listener - called after each snapshot change.
 * @returns unsubscribe function.
 */
export function subscribeEffectiveRoles(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether the last read failed (the panel shows the settings-layer fallback). */
export function effectiveRolesUnavailable(): boolean {
  return failed
}

/** Monotonic rpcIds: the gateway echoes the id and duplicates race. */
let rpcSeq = 0

/** Parse one raw host row, dropping rows without an id. */
function parseRole(raw: unknown): EffectiveRole | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== 'string' || rec.id === '') return undefined
  const role: EffectiveRole = { id: rec.id }
  if (typeof rec.label === 'string' && rec.label !== '') role.label = rec.label
  if (typeof rec.persona === 'string' && rec.persona !== '') role.persona = rec.persona
  if (typeof rec.group === 'string' && rec.group !== '') role.group = rec.group
  if (typeof rec.seat === 'boolean') role.seat = rec.seat
  if (typeof rec.builtin === 'boolean') role.builtin = rec.builtin
  if (Array.isArray(rec.available)) role.available = rec.available.map(String)
  return role
}

/** Read the effective registry through the profile RPC. */
async function fetchEffectiveRoles(): Promise<EffectiveRoleMap | undefined> {
  rpcSeq += 1
  const res = await fetch('/api/enpoiRoles.list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'enpoiRoles.list',
      rpcId: `roles-effective-${rpcSeq}`,
      payload: { args: {} },
    }),
  })
  if (!res.ok) return undefined
  const json = await res.json() as {
    result?: { ok?: boolean; value?: { roles?: unknown } }
  }
  const result = json.result
  if (result?.ok !== true) return undefined
  const rows = result.value?.roles
  if (!Array.isArray(rows)) return undefined
  const map: EffectiveRoleMap = {}
  for (const row of rows) {
    const role = parseRole(row)
    if (role !== undefined) map[role.id] = role
  }
  return map
}

/** Re-read the effective registry; a failed read keeps the last snapshot. */
export async function refreshEffectiveRoles(): Promise<void> {
  try {
    const map = await fetchEffectiveRoles()
    if (map === undefined) {
      failed = true
      notify()
      return
    }
    current = map
    failed = false
    notify()
  } catch {
    // Offline or malformed answer: the panel keeps the settings-layer display.
    failed = true
    notify()
  }
}

/** Eagerly prime the effective registry on boot. */
export function primeEffectiveRoles(): void {
  if (primed) return
  primed = true
  void refreshEffectiveRoles()
}

// Auto-prime on module import so the roles tab renders populated baselines.
if (typeof window !== 'undefined') {
  primeEffectiveRoles()
}
