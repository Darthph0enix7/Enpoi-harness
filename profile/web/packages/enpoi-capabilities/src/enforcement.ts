/**
 * enpoi-capabilities — Execution boundary enforcement.
 *
 * Implements:
 * - Invariant B1: Pre-dispatch waterfall denial for disabled tools, subagents, and skills.
 */

import type { CapabilitiesState } from './types'
import { PROTECTED_CAPABILITIES } from './types'
import { mcpServerNameOf, mcpServerSegment } from './policy'

export interface PreDispatchDecision {
  allowed: boolean
  syntheticResult?: string
}

/** The live MCP catalog subset the toggle lookup needs (catalog id → descriptor). */
export type McpCatalogDefs = Record<string, { serverName?: string } | undefined>

/** Mounted server names of a catalog (`serverName ?? id minus '-mcp'`). */
function mountedServerNames(catalog: McpCatalogDefs | undefined): string[] {
  return Object.entries(catalog ?? {}).map(([id, def]) => mcpServerNameOf(id, def))
}

/** The catalog id whose mounted name is `segment` (undefined for an unknown server). */
function catalogIdOf(segment: string, catalog: McpCatalogDefs | undefined): string | undefined {
  for (const [id, def] of Object.entries(catalog ?? {})) {
    if (mcpServerNameOf(id, def) === segment) return id
  }
  return undefined
}

/**
 * Evaluates whether a tool call is permitted by the active capability state.
 * Enforces denial at the execution boundary (Invariant B1).
 * @param toolName - public tool name (native or `mcp__<server>__<tool>`).
 * @param args - call arguments (subagent_type / skill name dispatches).
 * @param state - resolved capability state (the session's effective state).
 * @param mcpCatalog - live `mcpServers` catalog; resolves a tool-name server
 *   segment back to the catalog id `capabilities.mcp[...]` is keyed by.
 * @param mcpWorld - the session's MCP world (`mcpWorldOf`); a server pulled in
 *   for this session is callable even when the master switch is off.
 */
export function evaluateToolCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
  state: CapabilitiesState,
  mcpCatalog?: McpCatalogDefs,
  mcpWorld?: ReadonlySet<string>,
): PreDispatchDecision {
  // Invariant I15: Protected infrastructure always allowed
  if (PROTECTED_CAPABILITIES.has(toolName)) {
    return { allowed: true }
  }

  // 1. Check direct tool / subagent name (e.g. oracle_review, roundtable, chorus, edit, bash)
  if (state.tools[toolName] === false) {
    return {
      allowed: false,
      syntheticResult: `[CAPABILITY_DISABLED] Tool '${toolName}' is currently disabled by operator preference for this query. Do not attempt to invoke it in this turn.`,
    }
  }

  // 2. Check specialist worker dispatch via dispatch_task({ subagent_type })
  if (toolName === 'dispatch_task' && args && typeof args.subagent_type === 'string') {
    const worker = args.subagent_type.toLowerCase().trim()
    if (state.tools[worker] === false) {
      return {
        allowed: false,
        syntheticResult: `[CAPABILITY_DISABLED] Subagent worker '${worker}' is currently disabled by operator preference for this query. Do not attempt to invoke it in this turn.`,
      }
    }
  }

  // 3. Check skill loader tool dispatch via skill({ name })
  if (toolName === 'skill' && args && typeof args.name === 'string') {
    const skillName = args.name.toLowerCase().trim()
    if (state.skills[skillName] === false) {
      return {
        allowed: false,
        syntheticResult: `[SKILL_DISABLED] Skill '${skillName}' is currently disabled by operator preference for this query. Do not attempt to load it in this turn.`,
      }
    }
  }

  // 4. Check MCP tool suite dispatch (e.g. mcp__plane__*). The server segment
  // mirrors the policy ladder: a known catalog server whose mounted name
  // prefixes the tool name wins (longest first, so an id containing `__`
  // resolves whole), then the mounted name maps back to its catalog id — the
  // key `capabilities.mcp[...]` is written under. An unknown server keeps the
  // historical `__`-split / `-mcp` fallback.
  //
  // The master switch OFF is the DEFAULT world, not a refusal: a server pulled
  // into this session (skill `mcp:` hint, explicit mount, session switch) is
  // callable even when its toggle is not true; a switched-off server that was
  // NOT pulled in is denied with the disabled reason (never "unknown").
  if (toolName.startsWith('mcp__')) {
    const segment = mcpServerSegment(toolName, mountedServerNames(mcpCatalog))
    if (segment !== undefined) {
      const catalogId = catalogIdOf(segment, mcpCatalog)
      const toggleKeys = [...new Set(
        [catalogId, `${segment}-mcp`, segment].filter((key): key is string => key !== undefined && key !== ''),
      )]
      const pulled = catalogId !== undefined && mcpWorld?.has(catalogId) === true
      if (!pulled && !toggleKeys.some(key => state.mcp[key] === true)) {
        const suite = catalogId ?? `${segment}-mcp`
        return {
          allowed: false,
          syntheticResult: `[CAPABILITY_DISABLED] MCP Tool suite '${suite}' is disabled by the operator (capabilities.mcp.${suite} is not true). Pull it in for this session with a skill's mcp: hint, an explicit mcp mount, or the session switch. Do not attempt to invoke it in this turn otherwise.`,
        }
      }
    }
  }

  return { allowed: true }
}
