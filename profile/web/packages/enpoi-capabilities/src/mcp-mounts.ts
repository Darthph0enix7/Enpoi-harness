/**
 * dsh-enpoi-capabilities — MCP on-demand mounting model.
 *
 * Persistent config says what a server IS (configured + mode); the
 * Capabilities switch sets the DEFAULT world (master-on always-on servers),
 * and the agent's mounts are SESSION-scoped and durable through the session
 * log: the `mcp/mounts` event carries the complete post-change set and the
 * `mcpMounts` projection folds it, so a resumed session comes back with
 * exactly the servers it had mounted. A session's world is
 * `(session mounts ∪ default-world always-on ∪ session override true) −
 * session override false`; a switched-off server is invisible by default, but
 * a skill's `mcp:` hint, an explicit mount, or the session switch pulls it in
 * for that session.
 *
 * @module dsh-enpoi-capabilities/mcp-mounts
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable session-scoped MCP mount change. Carries the complete
     * post-change set; `ignorable` so a build that predates this event can
     * still read the log.
     */
    'mcp/mounts': { mounted: string[] }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Mounted-server state for one session. */
    mcpMounts: McpMountsProjectionState
  }
  interface SessionProjectionMap {
    /** Client-visible mounted-server set (the session header chip reads it). */
    mcpMounts: McpMountsProjectionState
  }
}

/** Host fold state of the `mcpMounts` unit. */
export interface McpMountsProjectionState {
  /** Mounted server ids (catalog keys). */
  readonly mounted: readonly string[]
}

const mcpMountsStateSchema: z.ZodType<McpMountsProjectionState> = z.object({
  mounted: z.array(z.string().min(1)),
})

/**
 * Fold one committed session event into the mounted-set state.
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state (same reference when the event is not ours).
 */
export function applyMcpMountsProjection(
  state: McpMountsProjectionState,
  event: SessionEvent,
): McpMountsProjectionState {
  if (event.type !== 'mcp/mounts') return state
  return { mounted: [...new Set(event.data.mounted)] }
}

/** The `mcpMounts` projection unit registered by the plugin. */
export const mcpMountsProjection: ProjectionDefinition<'mcpMounts', McpMountsProjectionState> = {
  key: 'mcpMounts',
  // The profile's zod instance differs from the harness's; the projection
  // registry validates with its own copy, so the schema crosses as-is.
  stateSchema: mcpMountsStateSchema as never,
  init: () => ({ mounted: [] }),
  apply: applyMcpMountsProjection,
  // Client-visible: the session header chip renders the mounted set.
  wire: { viewSchema: mcpMountsStateSchema, view: state => state },
  stateVersion: 1,
}

/** Session-event name appended when the mounted set changes. */
export const MCP_MOUNTS_EVENT = 'mcp/mounts'

/** How a configured server participates in mounting. */
export type McpServerMode = 'always-on' | 'on-demand'

/** One catalog entry as this module reads it. */
export interface McpServerRecord {
  serverName?: string
  url?: string
  mode?: string
}

/** The mode of one catalog entry; absent means always-on (pre-existing behavior). */
export function serverModeOf(record: McpServerRecord | undefined): McpServerMode {
  return record?.mode === 'on-demand' ? 'on-demand' : 'always-on'
}

/** Whether one catalog entry is on-demand (never auto-mounted). */
export function isOnDemand(record: McpServerRecord | undefined): boolean {
  return serverModeOf(record) === 'on-demand'
}

/** The mounted namespace of one catalog entry (`serverName ?? id minus '-mcp'`). */
export function serverNameOf(id: string, record: McpServerRecord | undefined): string {
  return record?.serverName ?? id.replace(/-mcp$/, '')
}

/** The server segment of one `mcp__<server>__<tool>` name, or undefined. */
export function mcpServerOfToolName(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice('mcp__'.length)
  const separator = rest.indexOf('__')
  return separator <= 0 ? undefined : rest.slice(0, separator)
}

/**
 * The default world: the servers every session gets without a pull — the
 * master-on (`capabilities.mcp[id] === true`) always-on servers. A server the
 * operator switched OFF is in NO session's default world (the agent does not
 * even see it), but an explicit pull can still bring it into one session's
 * world for the work at hand.
 * @param catalog - the configured servers.
 * @param masterEnabled - ids whose `capabilities.mcp[id]` is true.
 * @returns a fresh set.
 */
export function mcpDefaultWorldIds(
  catalog: Record<string, McpServerRecord>,
  masterEnabled: ReadonlySet<string>,
): Set<string> {
  const set = new Set<string>()
  for (const [id, def] of Object.entries(catalog)) {
    if (!isOnDemand(def) && masterEnabled.has(id)) set.add(id)
  }
  return set
}

/**
 * The session's world:
 * `(session mounts ∪ default-world always-on ∪ session override true) − session override false`.
 * The master switch sets the DEFAULT world; a pull (a durable mount or the
 * center's "This session" switch) brings a switched-off server in anyway, and
 * a session-off override removes a default-world server for this session only.
 * @param catalog - the configured servers.
 * @param masterEnabled - ids whose `capabilities.mcp[id]` is true.
 * @param sessionMounts - the session's durable mounts (explicit pulls).
 * @param sessionOverrides - the session's explicit `capabilities.mcp` overrides.
 * @returns a fresh world set.
 */
export function mcpWorldOf(
  catalog: Record<string, McpServerRecord>,
  masterEnabled: ReadonlySet<string>,
  sessionMounts: ReadonlySet<string>,
  sessionOverrides: Readonly<Record<string, boolean>>,
): Set<string> {
  const world = new Set<string>()
  for (const id of sessionMounts) {
    if (catalog[id] !== undefined) world.add(id)
  }
  for (const id of mcpDefaultWorldIds(catalog, masterEnabled)) world.add(id)
  for (const [id, on] of Object.entries(sessionOverrides)) {
    if (on === true && catalog[id] !== undefined) world.add(id)
  }
  for (const [id, on] of Object.entries(sessionOverrides)) {
    if (on === false) world.delete(id)
  }
  return world
}

/**
 * The agent-visible ids of one session: all configured servers in catalog
 * are visible to `mcp list`, displaying their truthful state:
 * - mounted (connected in this session)
 * - available (always-on, ready to use)
 * - disabled (on-demand / default-off, mountable via `mcp mount <id>` or skill hint)
 * - unavailable (error / no url)
 */
export function mcpVisibleIds(
  catalog: Record<string, McpServerRecord>,
  _masterEnabled?: ReadonlySet<string>,
  _world?: ReadonlySet<string>,
  _sessionOverrides?: Readonly<Record<string, boolean>>,
): Set<string> {
  return new Set(Object.keys(catalog))
}

/**
 * The operator-facing reason for a switched-off server that was not pulled in:
 * the Capabilities center switch is off by default, so the server is absent
 * from every session's default world until a skill, an explicit mount, or the
 * session switch pulls it in.
 */
export function mcpDisabledReason(id: string): string {
  return `server "${id}" is disabled by the operator (capabilities.mcp.${id} is not true); it is absent by default and returns when a skill's mcp: hint, an explicit mcp mount, or the session switch pulls it in`
}

/**
 * The pre-execute deny reason for one `mcp__<server>__<tool>` name, or `''`
 * when the call is allowed. A switched-off server that is NOT in the session's
 * world is denied with the disabled reason (never "unknown"); an on-demand
 * server the session has not mounted is denied until mounted; a default-world
 * server switched off for this session is denied as session-scoped.
 * @param catalog - the configured servers.
 * @param masterEnabled - ids whose `capabilities.mcp[id]` is true.
 * @param world - the session's world (`mcpWorldOf`).
 * @param toolName - the public tool name.
 * @returns the denial sentence, or an empty string when callable.
 */
export function mcpToolDenyReason(
  catalog: Record<string, McpServerRecord>,
  masterEnabled: ReadonlySet<string>,
  world: ReadonlySet<string>,
  toolName: string,
): string {
  const server = mcpServerOfToolName(toolName)
  if (server === undefined) return ''
  const entry = Object.entries(catalog).find(([id, def]) => serverNameOf(id, def) === server)
  if (entry === undefined) return ''
  const [id, def] = entry
  if (world.has(id)) return ''
  if (!masterEnabled.has(id)) {
    return `${toolName} is not available: its MCP server "${id}" is disabled by the operator (capabilities.mcp.${id} is not true). Pull it in for this session with a skill's mcp: hint, an explicit mcp mount, or the session switch.`
  }
  if (isOnDemand(def)) {
    return `${toolName} is not available: its MCP server "${id}" is on-demand and this session has not mounted it. Use the mcp tool (action "mount") first.`
  }
  return `${toolName} is not available: its MCP server "${id}" is switched off for this session (session scope).`
}

/** One row of the `mcp list` action. */
export interface McpMountRow {
  id: string
  serverName: string
  mode: McpServerMode
  /** The master switch: `capabilities.mcp[id] === true`. */
  enabled: boolean
  state: 'mounted' | 'available' | 'disabled' | 'unavailable'
  reason: string
  toolCount: number
}

/**
 * Build `mcp` rows. The state is honest end to end: `mounted` requires BOTH
 * the session's world and a live fiber; a failed/pending fiber is
 * `unavailable` with its reason and its real (usually 0) tool count; a
 * switched-off server that was not pulled in is `disabled` in the operator
 * view and is omitted from the agent view via `options.include`.
 * @param catalog - the configured servers.
 * @param masterEnabled - ids whose `capabilities.mcp[id]` is true.
 * @param world - the session's world (`mcpWorldOf`).
 * @param connected - ids with a live mcp-client fiber (globally connected).
 * @param errors - last mount failure per id.
 * @param toolNames - every registered tool name.
 * @param options - `include` keeps only those ids (the agent-visible set).
 * @returns one row per configured server (sorted by id), minus excluded ids.
 */
export function buildMountRows(
  catalog: Record<string, McpServerRecord>,
  masterEnabled: ReadonlySet<string>,
  world: ReadonlySet<string>,
  connected: ReadonlySet<string>,
  errors: ReadonlyMap<string, string>,
  toolNames: readonly string[],
  options?: { include?: ReadonlySet<string> },
): McpMountRow[] {
  const counts = new Map<string, number>()
  for (const name of toolNames) {
    const server = mcpServerOfToolName(name)
    if (server === undefined) continue
    counts.set(server, (counts.get(server) ?? 0) + 1)
  }
  return Object.entries(catalog)
    .filter(([id]) => options?.include === undefined || options.include.has(id))
    .map(([id, record]) => {
      const serverName = serverNameOf(id, record)
      const toolCount = counts.get(serverName) ?? 0
      const error = errors.get(id)
      const enabled = masterEnabled.has(id)
      const inWorld = world.has(id)
      const live = connected.has(id)
      let state: McpMountRow['state']
      let reason = ''
      if (!enabled && !inWorld) {
        state = 'disabled'
        reason = mcpDisabledReason(id)
      } else if (error !== undefined) {
        state = 'unavailable'
        reason = error
      } else if (record.url === undefined || record.url === '') {
        state = 'unavailable'
        reason = 'no url configured'
      } else if (inWorld && live) {
        state = 'mounted'
      } else if (!inWorld) {
        state = 'available'
      } else {
        state = 'unavailable'
        reason = 'not connected'
      }
      return { id, serverName, mode: serverModeOf(record), enabled, state, reason, toolCount }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}
