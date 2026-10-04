/**
 * dsh-enpoi-debug — resolve the in-process read surface.
 *
 * The plugin runs inside the host process (a preset-plane mount), so it reads
 * the same services the wire RPCs wrap:
 * 1. `ctx.sessionController` — the host Session API (`session.digest`,
 *    `session.requestSnapshot`, `session.executionState`).
 * 2. `ctx.remote.session` — the Client Remote face, when this assembly is a
 *    client-shaped one that exposes it in-process.
 * 3. `ctx.diagnostics` (or `ctx.remote.diagnostics`) — the incident store for
 *    the `incidents` section.
 *
 * No new host code, no session-log writes: every call is a read.
 *
 * @module dsh-enpoi-debug/source
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  DebugSources,
  DigestValue,
  ExecutionStateValue,
  IncidentListValue,
  SnapshotValue,
} from './types.js'

/** Bound one read so a hung host call cannot hold the tool open forever. */
const READ_TIMEOUT_MS = 20_000

type AsyncMethod = (...args: unknown[]) => unknown

function method(target: unknown, name: string): AsyncMethod | undefined {
  if (target === null || target === undefined) return undefined
  const value = (target as Record<string, unknown>)[name]
  return typeof value === 'function' ? value as AsyncMethod : undefined
}

/**
 * Build a source bundle over one service-like object.
 * @param target - the service (host controller or generated Remote face).
 * @returns the bundle, or undefined when it cannot answer digest + snapshot.
 */
function sourcesOver(target: unknown): DebugSources | undefined {
  const digest = method(target, 'digest')
  const requestSnapshot = method(target, 'requestSnapshot')
  if (digest === undefined || requestSnapshot === undefined) return undefined
  const executionState = method(target, 'executionState')
  return {
    digest: async request => await digest.call(target, request) as DigestValue,
    requestSnapshot: async request => await requestSnapshot.call(
      target,
      request,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    ) as SnapshotValue,
    ...executionState === undefined
      ? {}
      : { executionState: async request => await executionState.call(target, request) as ExecutionStateValue },
  }
}

/**
 * Resolve the Session read surface for this process.
 * @param ctx - plugin context (agent-plane mount).
 * @returns the source bundle with its incident reader, or undefined when no
 *   Session API exists here.
 */
export function resolveSessionSources(ctx: Context): DebugSources | undefined {
  const controller = sourcesOver(ctx.get('sessionController'))
  if (controller !== undefined) return { ...controller, ...incidentReader(ctx) }
  const remote = ctx.get('remote') as { session?: unknown } | undefined
  const client = sourcesOver(remote?.session)
  if (client !== undefined) return { ...client, ...incidentReader(ctx) }
  return undefined
}

/**
 * The incident reader, when the diagnostics service is present in this scope.
 * A missing diagnostics service disables only the `incidents` section.
 * @param ctx - plugin context.
 * @returns the reader or an empty object when no diagnostics service exists.
 */
export function incidentReader(ctx: Context): { incidents?: (limit: number) => Promise<IncidentListValue | undefined> } {
  const local = ctx.get('diagnostics') as unknown
  const remote = (ctx.get('remote') as { diagnostics?: unknown } | undefined)?.diagnostics
  const target = method(local, 'list') !== undefined ? local : method(remote, 'list') !== undefined ? remote : undefined
  const list = method(target, 'list')
  if (target === undefined || list === undefined) return {}
  return {
    incidents: async (limit: number) => await list.call(target, { limit }) as IncidentListValue,
  }
}
