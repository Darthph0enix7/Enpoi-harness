/**
 * Capability scoping — the client half of the defaults ⊕ session-overrides
 * model. The Capabilities Control Center renders the effective surface for its
 * bound session: on the blank/new-session page (or with no bound session) edits
 * write the profile DEFAULTS; inside a live session they write SESSION
 * OVERRIDES (durable, logged, default untouched). MCP mounts are session
 * overrides too — an on-demand server is "enabled" exactly when this session
 * has mounted it, and reset unmounts.
 */

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Session capability overrides (skills/tools/mcp). */
    capabilityOverrides: CapabilityOverrideRecord
  }
}

/** One session's explicit overrides; an absent key inherits the default. */
export interface CapabilityOverrideRecord {
  skills: Record<string, boolean>
  tools: Record<string, boolean>
  mcp: Record<string, boolean>
}

/** Which layer an edit targets. */
export type ScopingMode = 'defaults' | 'session'

/** The empty record (everything inherits). */
export const EMPTY_OVERRIDES: CapabilityOverrideRecord = { skills: {}, tools: {}, mcp: {} }

/**
 * Which layer the center edits.
 * @param sessionId - the tab's bound session, when any.
 * @param blank - the session store's blank flag (undefined until the summary loads).
 * @returns `session` only for a live (non-blank) bound session.
 */
export function scopingModeOf(sessionId: string | undefined, blank: boolean | undefined): ScopingMode {
  return sessionId !== undefined && sessionId !== '' && blank === false ? 'session' : 'defaults'
}

/** The explicit override for one capability, or undefined when it inherits. */
export function overrideValueOf(
  record: CapabilityOverrideRecord | undefined,
  kind: 'skills' | 'tools' | 'mcp',
  id: string,
): boolean | undefined {
  return record?.[kind]?.[id]
}

/**
 * The effective value of one row.
 * @param kind - capability family.
 * @param id - capability id.
 * @param defaults - the profile default value (undefined = unset).
 * @param record - the session's override record.
 * @param mounted - the session's mounted MCP server ids.
 * @param onDemand - whether the MCP server is on-demand (mounts decide).
 * @returns the effective enabled state.
 */
export function effectiveValueOf(
  kind: 'skills' | 'tools' | 'mcp',
  id: string,
  defaults: boolean | undefined,
  record: CapabilityOverrideRecord | undefined,
  mounted: readonly string[] | undefined,
  onDemand: boolean,
): boolean {
  if (kind === 'mcp' && onDemand) return (mounted ?? []).includes(id)
  const override = overrideValueOf(record, kind, id)
  if (override !== undefined) return override
  return defaults !== false
}

/** Whether one row is overridden in this session (marker + reset affordance). */
export function isOverridden(
  kind: 'skills' | 'tools' | 'mcp',
  id: string,
  record: CapabilityOverrideRecord | undefined,
  mounted: readonly string[] | undefined,
  onDemand: boolean,
): boolean {
  if (kind === 'mcp' && onDemand) return (mounted ?? []).includes(id)
  return overrideValueOf(record, kind, id) !== undefined
}

let rpcSeq = 0

/** Unique wire rpcId per request (the gateway echoes it; duplicates race). */
function nextRpcId(prefix: string): string {
  rpcSeq += 1
  return `${prefix}-${rpcSeq}`
}

/** One capabilities remote call. */
async function callRemote(method: string, args: Record<string, unknown>): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch(`/api/enpoiCapabilities.${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: `enpoiCapabilities.${method}`,
        rpcId: nextRpcId(method),
        payload: { args },
      }),
    })
    if (!res.ok) return { ok: false, reason: `gateway responded ${res.status}` }
    const json = await res.json() as { result?: { ok?: boolean; value?: { ok?: boolean; reason?: string } } }
    if (json.result?.ok !== true) return { ok: false, reason: 'the request was rejected' }
    return { ok: json.result.value?.ok === true, reason: typeof json.result.value?.reason === 'string' ? json.result.value.reason : '' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Write one session capability override (null resets to the default). */
export function setCapabilityOverride(
  sessionId: string,
  kind: 'skills' | 'tools' | 'mcp',
  id: string,
  value: boolean | null,
): Promise<{ ok: boolean; reason: string }> {
  return callRemote('setCapabilityOverride', { sessionId, kind, id, value })
}

/** Mount one MCP server for this session (the session-mode enable). */
export function mountServerForSession(sessionId: string, server: string): Promise<{ ok: boolean; reason: string }> {
  return callRemote('mcpMount', { sessionId, server })
}

/** Unmount one MCP server from this session (the reset-to-default). */
export function unmountServerForSession(sessionId: string, server: string): Promise<{ ok: boolean; reason: string }> {
  return callRemote('mcpUnmount', { sessionId, server })
}
