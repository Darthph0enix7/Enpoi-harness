/**
 * The `enpoiCapabilities` Remote namespace owner over the shared Typert
 * Gateway.
 *
 * Kept out of the test import graph: the `@Remote` method decorator is
 * metadata the unit-test transform would have to parse, so the pure
 * projection lives in `mcp-tools.ts` and only the bundle imports this file
 * (dynamically, like the mcp-client mount above it).
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  mcpToolNames, registeredToolNames, removeMcpServerFenced,
  type McpCatalogSettings, type McpToolsView, type RegisteredToolsView,
} from './mcp-tools'

/** The live tool registry as this RPC reads it. */
interface ToolSchemaSource {
  schemas?: () => Array<{ name: string }>
}

/**
 * The live-capabilities remote namespace: `enpoiCapabilities.mcpTools()` and
 * `enpoiCapabilities.registeredTools()` over the shared Typert Gateway. Every
 * method reads fresh per call — the client never caches a mount state.
 */
export class EnpoiCapabilitiesService extends TypertRemoteService {
  /**
   * @param ctx - owning Host Context (the Typert binding is installed by the base).
   */
  constructor(ctx: Context) {
    super(ctx, 'enpoiCapabilities')
  }

  /**
   * Every MCP tool the runtime currently registers, read from the tool
   * registry on each call (`ctx.tools.schemas()`), so mounting or unmounting
   * a server changes the answer immediately. Failure posture is fail-open:
   * an unavailable registry or settings service answers an empty list.
   * @returns the sorted `mcp__<server>__<tool>` public names.
   */
  @Remote
  async mcpTools(): Promise<McpToolsView> {
    try {
      const tools = this.ctx.get('tools') as ToolSchemaSource | undefined
      const schemas = tools?.schemas?.() ?? []
      return { tools: mcpToolNames(schemas.map(schema => schema.name)) }
    } catch {
      // Advisory read: an unavailable registry must not fail the settings page.
      return { tools: [] }
    }
  }

  /**
   * Every tool the runtime currently registers (native, profile plugins, and
   * `mcp__<server>__<tool>` names alike), read fresh from the tool registry on
   * each call (`ctx.tools.schemas()`). The Permissions matrix and the Dynamic
   * → Roles tool grid build their rows from this projection, so any future
   * tool appears automatically. Failure posture is fail-open: an unavailable
   * registry answers an empty list.
   * @returns the sorted unique public tool names.
   */
  @Remote
  async registeredTools(): Promise<RegisteredToolsView> {
    try {
      const tools = this.ctx.get('tools') as ToolSchemaSource | undefined
      const schemas = tools?.schemas?.() ?? []
      return { tools: registeredToolNames(schemas.map(schema => schema.name)) }
    } catch {
      // Advisory read: an unavailable registry must not fail the settings page.
      return { tools: [] }
    }
  }

  /**
   * One session's capability overrides (skills/tools), read from the
   * session-scoped override service. Failure posture is fail-open: an
   * unavailable service answers an empty record.
   * @param sessionId - the session whose overrides are read.
   * @returns the override record.
   */
  @Remote
  async capabilityOverrides(sessionId: string): Promise<{ overrides: { skills: Record<string, boolean>; tools: Record<string, boolean>; mcp: Record<string, boolean> } }> {
    try {
      const sessions = this.ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
      const session = sessions?.get?.(sessionId)
      const service = this.ctx.get('capabilityOverrides') as
        | { read?: (session: unknown) => { skills: Record<string, boolean>; tools: Record<string, boolean>; mcp: Record<string, boolean> } }
        | undefined
      if (session === undefined || service?.read === undefined) return { overrides: { skills: {}, tools: {}, mcp: {} } }
      return { overrides: service.read(session) }
    } catch {
      return { overrides: { skills: {}, tools: {}, mcp: {} } }
    }
  }

  /**
   * Write one session capability override (or reset it with a null value).
   * The change is durable in the session log and hot-applied to that session's
   * surface; the profile default is untouched.
   * @param sessionId - the session to override.
   * @param kind - `skills` or `tools`.
   * @param id - the capability id.
   * @param value - the override value, or null to reset to the default.
   * @returns whether the write succeeded, with the reason on failure.
   */
  @Remote
  async setCapabilityOverride(sessionId: string, kind: string, id: string, value: boolean | null): Promise<{ ok: boolean; reason: string }> {
    try {
      if (kind !== 'skills' && kind !== 'tools' && kind !== 'mcp') return { ok: false, reason: `unknown capability kind "${kind}"` }
      if (id === '') return { ok: false, reason: 'missing capability id' }
      const sessions = this.ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
      const session = sessions?.get?.(sessionId)
      if (session === undefined) return { ok: false, reason: `session "${sessionId}" is not live` }
      const service = this.ctx.get('capabilityOverrides') as
        | { set?: (session: unknown, kind: 'skills' | 'tools' | 'mcp', id: string, value: boolean | null) => unknown }
        | undefined
      if (service?.set === undefined) return { ok: false, reason: 'the override service is unavailable' }
      service.set(session, kind, id, value)
      return { ok: true, reason: '' }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * The OPERATOR view of one session's MCP rows: every configured server,
   * switched-off (master-toggle) servers included and marked `enabled:false`,
   * with the honest mount state. The session header chip filters it to
   * `mounted`. Failure posture is fail-open: an unavailable service answers an
   * empty list.
   * @param sessionId - the session whose rows are read.
   * @returns the rows with tool counts.
   */
  @Remote
  async mcpMounts(sessionId: string): Promise<{ mounts: Array<{ id: string; serverName: string; toolCount: number }> }> {
    try {
      const service = this.ctx.get('mcpMounts') as
        | { list?: (session: { id: string }) => Array<{ id: string; serverName: string; state: string; toolCount: number }> }
        | undefined
      const rows = service?.list?.({ id: sessionId }) ?? []
      return { mounts: rows.filter(row => row.state === 'mounted').map(row => ({ id: row.id, serverName: row.serverName, toolCount: row.toolCount })) }
    } catch {
      return { mounts: [] }
    }
  }

  /**
   * Pull one server into one session (the session-scope enable on the session
   * surface). Any configured server may be pulled, including one the operator
   * switched OFF by default — the master switch sets the default world, not a
   * refusal. On-demand and pulled switched-off servers connect on first use;
   * default-world always-on servers are already connected.
   * @param sessionId - the session to mount for.
   * @param server - the catalog server id.
   * @returns whether the mount succeeded, with the reason on failure.
   */
  @Remote
  async mcpMount(sessionId: string, server: string): Promise<{ ok: boolean; reason: string }> {
    try {
      const sessions = this.ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
      const session = sessions?.get?.(sessionId)
      if (session === undefined) return { ok: false, reason: `session "${sessionId}" is not live` }
      const service = this.ctx.get('mcpMounts') as
        | { mount?: (session: unknown, id: string) => Promise<{ ok: boolean; reason: string }> }
        | undefined
      if (service?.mount === undefined) return { ok: false, reason: 'the mount service is unavailable' }
      return await service.mount(session, server)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Release one server from one session (the operator's close control on the
   * session surface). The shared connection is disposed when no session holds
   * it and the server is not in the default world (on-demand or switched off
   * by default); a default-world always-on server keeps its connection.
   * @param sessionId - the session to unmount from.
   * @param server - the catalog server id.
   * @returns whether the unmount succeeded, with the reason on failure.
   */
  @Remote
  async mcpUnmount(sessionId: string, server: string): Promise<{ ok: boolean; reason: string }> {
    try {
      const sessions = this.ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
      const session = sessions?.get?.(sessionId)
      if (session === undefined) return { ok: false, reason: `session "${sessionId}" is not live` }
      const service = this.ctx.get('mcpMounts') as
        | { unmount?: (session: unknown, id: string) => Promise<{ ok: boolean; reason: string }> }
        | undefined
      if (service?.unmount === undefined) return { ok: false, reason: 'the mount service is unavailable' }
      return await service.unmount(session, server)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Remove one catalog MCP server AND every policy row it owned
   * (`mcp__<server>__*` + exact `mcp__<server>__<tool>` rows, global and per
   * agent) in a single revision-fenced settings write, so the Permissions page
   * never accumulates rows for a server that no longer exists.
   * @param id - the `enpoi-orchestration.mcpServers` catalog key.
   * @returns whether the entry was removed and how many policy rows went with it.
   */
  @Remote
  async removeMcpServer(id: string): Promise<{ removed: boolean; rows: number }> {
    const settings = this.ctx.get('settings') as McpCatalogSettings | undefined
    return await removeMcpServerFenced(settings, id)
  }
}

/**
 * Mount the `enpoiCapabilities` remote namespace on the owning context.
 * @param ctx - owning plugin context.
 */
export function mountCapabilitiesRemote(ctx: Context): void {
  ctx.plugin(EnpoiCapabilitiesService)
}
