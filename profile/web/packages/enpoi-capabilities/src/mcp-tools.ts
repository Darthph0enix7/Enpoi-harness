/**
 * enpoi-capabilities — MCP tool projection + catalog removal for the
 * Permissions matrix.
 *
 * The Permissions matrix lists the REAL model-facing tools: the host projects
 * every currently registered `mcp__<server>__<tool>` name on each
 * `enpoiCapabilities.mcpTools()` call, so mounting or unmounting a server
 * changes the client's row list with no code change and no rebuilt UI.
 *
 * Removing a server must also remove the policy rows it owned
 * (`permissions.tools['mcp__<server>__*']` and exact `mcp__<server>__<tool>`
 * rows, plus the same keys under `permissions.agents[*]`) in the SAME
 * revision-fenced settings write as the catalog `unset`, so a removal leaves
 * no inert rows behind.
 *
 * Pure module: no Cordis imports, unit-testable on its own (the Remote
 * wrapper lives in `rpc.ts`, which only the bundle imports).
 */

import { mcpPolicyRemovalOps, mcpServerNameOf, type PermissionPolicyConfig } from './policy'

/** Prefix every MCP-client registration carries (`publicToolName`). */
export const MCP_TOOL_PREFIX = 'mcp__'

/** The namespace the MCP catalog, status, and permission policy live in. */
export const ORCHESTRATION_NS = 'enpoi-orchestration'

/** One MCP public tool name (`mcp__<server>__<tool>`). */
export interface McpToolName {
  name: string
}

/** The `enpoiCapabilities.mcpTools` payload: the live registered tool names. */
export interface McpToolsView {
  tools: string[]
}

/** The `enpoiCapabilities.registeredTools` payload: EVERY live tool name. */
export interface RegisteredToolsView {
  tools: string[]
}

/** One path op inside the orchestration settings namespace. */
export interface SettingsPathOp {
  op: string
  path: string[]
  value?: unknown
}

/**
 * The settings-service slice catalog removal fences against. The descriptor
 * `value` is the resolved document on both the pre-0.1.7 storage service and
 * the merged form service (which projects the owning entry's volatile fields),
 * so one read path serves both engines.
 */
export interface McpCatalogSettings {
  describe?: () => Array<{ ns: string; revision?: number; value?: unknown }>
  mutate?: (ns: string, ops: SettingsPathOp[], expectedRevision?: number) => Promise<unknown>
}

/** How many times a fenced write re-reads and retries on a revision conflict. */
const MAX_WRITE_ATTEMPTS = 3

/** Whether an error is the settings service's stale-revision refusal. */
function isConflict(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code
  return code === 'SETTINGS_CONFLICT' || code === 'settings/conflict'
}

/**
 * Whether a settings-service object can perform a fenced write.
 * @param settings - candidate service.
 * @returns true when `mutate` is available.
 */
export function canFenceMcpWrites(settings: McpCatalogSettings | undefined): settings is McpCatalogSettings & { mutate: NonNullable<McpCatalogSettings['mutate']> } {
  return settings?.mutate !== undefined
}

/**
 * Keep only registered MCP public names, sorted for a stable answer.
 * @param names - every tool name the runtime currently registers.
 * @returns sorted `mcp__<server>__<tool>` names.
 */
export function mcpToolNames(names: readonly string[]): string[] {
  return names
    .filter(name => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Every name the live tool registry currently holds, deduped and sorted for a
 * stable answer. The Permissions matrix derives its rows from this projection,
 * so a tool added by any plugin (whiteboard, upstream, a future MCP server)
 * appears with no client code change; the curated client overlay only orders
 * and labels rows.
 * @param names - every tool name the runtime currently registers.
 * @returns sorted unique non-empty names.
 */
export function registeredToolNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(name => typeof name === 'string' && name !== ''))]
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Remove one catalog server AND every policy row it owned in a single
 * revision-fenced write: `mcpServers.<id>` plus the `mcp__<mounted>__*` /
 * `mcp__<mounted>__<tool>` rows at the global tier and under every agent
 * override. The state is re-read before each attempt, so a concurrent edit
 * (or a conflict) is folded in rather than clobbered, and an entry that is
 * already gone is a no-op.
 * @param settings - settings-service slice; a no-op result when unavailable.
 * @param id - the `mcpServers` catalog key to remove.
 * @param ns - owning namespace (defaults to `enpoi-orchestration`).
 * @returns whether the catalog entry was removed and how many rows went with it.
 */
export async function removeMcpServerFenced(
  settings: McpCatalogSettings | undefined,
  id: string,
  ns: string = ORCHESTRATION_NS,
): Promise<{ removed: boolean; rows: number }> {
  if (!canFenceMcpWrites(settings)) return { removed: false, rows: 0 }
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const descriptor = settings.describe?.().find(entry => entry.ns === ns)
    const value = descriptor?.value as { mcpServers?: Record<string, { serverName?: string }>; permissions?: PermissionPolicyConfig } | undefined
    const def = (value?.mcpServers ?? {})[id]
    if (def === undefined) return { removed: false, rows: 0 }
    const server = mcpServerNameOf(id, def)
    const ops: SettingsPathOp[] = [
      { op: 'unset', path: ['mcpServers', id] },
      ...mcpPolicyRemovalOps(server, value?.permissions),
    ]
    const revision = descriptor?.revision
    try {
      await settings.mutate(ns, ops, revision)
      return { removed: true, rows: ops.length - 1 }
    } catch (error) {
      if (isConflict(error) && attempt < MAX_WRITE_ATTEMPTS - 1) continue
      throw error
    }
  }
  return { removed: false, rows: 0 }
}
