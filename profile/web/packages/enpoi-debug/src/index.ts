/**
 * dsh-enpoi-debug — the agent-facing debug/transparency read surface
 * (doc 69 §9.1, P3).
 *
 * Owns exactly one thing: the read-only `session_debug` tool. The plugin is
 * mounted inside the agent-plane `enpoi-orchestration` group of the
 * `orchestrator` and `sysadmin` presets only (see the preset
 * `agent.cordis.yml` rows), so the tool lands in those agents' own tools
 * layer and stays invisible elsewhere — deliberately NOT listed in the
 * profile's host-plane bundles.
 *
 * It reads through the services the host RPCs wrap (`ctx.sessionController`
 * or a client-shaped `ctx.remote.session`, plus `ctx.diagnostics` for the
 * incident tail). No new host code, no session-log writes, bounded output,
 * and request bodies only behind the explicit `includeBodies` opt-in plus a
 * local `allowed-once` approval (agent `allow` alone never reaches them).
 *
 * @module dsh-enpoi-debug
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { registerSessionDebugTool } from './tools.js'

/** Cordis plugin name. */
export const name = 'enpoi-debug'

/** The tools registry is the only hard dependency; everything else degrades. */
export const inject = ['tools']

/**
 * Mount the plugin: register the `session_debug` tool in this scope.
 * @param ctx - agent-plane mount context.
 */
export function apply(ctx: Context): void {
  if (typeof ctx.tools?.register !== 'function') {
    ctx.logger?.warn('enpoi-debug: tools service unavailable; session_debug not registered')
    return
  }
  registerSessionDebugTool(ctx)
  process.stderr.write('[enpoi-debug] mounted (session_debug registered in this agent scope)\n')
}

export { registerSessionDebugTool, SESSION_DEBUG_TOOL_NAME, INCLUDE_BODIES_REASON, parseSessionDebugArgs, renderSessionDebug } from './tools.js'
export { resolveSessionSources, incidentReader } from './source.js'
export { clampRecentTools, foldDigest, foldFailure, foldSnapshot, foldIncidents, CAPS, PREVIEW_CHARS } from './fold.js'
export type * from './types.js'
