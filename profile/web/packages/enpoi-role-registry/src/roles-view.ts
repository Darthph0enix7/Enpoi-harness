/**
 * The effective-role projection served by the `enpoiRoles` Remote namespace
 * (Dynamic → Roles baselines). Kept free of Remote/decorator machinery so the
 * projection is unit-testable on its own; the RPC wrapper lives in
 * `roles-remote.ts`.
 */
import { listRoleRegistry, type OrchestrationSettingsHandle, type ResolvedRole } from '@deepseek-ai/dsh-tool-subagent'

/** One role row served to the client; a JSON-safe projection of `ResolvedRole`. */
export interface EffectiveRoleRow {
  id: string
  label?: string
  persona?: string
  group?: string
  seat: boolean
  builtin: boolean
  /** Whether the generic delegation tool may spawn this role (false = tool-only). */
  spawnable: boolean
  available?: readonly string[]
}

/** The `enpoiRoles.list` payload. */
export interface EffectiveRoleList {
  roles: EffectiveRoleRow[]
}

/**
 * Project the host's effective registry into sorted, JSON-safe rows.
 * @param settings - the Settings service handle, when the service is up.
 * @returns the effective rows (host code defaults plus settings overrides).
 */
export function effectiveRoleRows(settings: OrchestrationSettingsHandle | undefined): EffectiveRoleList {
  const registry: Record<string, ResolvedRole> = listRoleRegistry(settings)
  const roles = Object.values(registry)
    .map((role): EffectiveRoleRow => ({
      id: role.id,
      ...(role.label !== undefined ? { label: role.label } : {}),
      ...(role.persona !== undefined ? { persona: role.persona } : {}),
      ...(role.group !== undefined ? { group: role.group } : {}),
      seat: role.seat,
      builtin: role.builtin,
      spawnable: role.spawnable,
      ...(role.available !== undefined ? { available: role.available } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return { roles }
}
