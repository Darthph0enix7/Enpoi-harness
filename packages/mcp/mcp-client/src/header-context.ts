/**
 * Per-call session propagation and host-side dynamic HTTP header provider seam.
 *
 * @module @deepseek-ai/dsh-mcp-client/header-context
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { SecretRedactor } from './redact.ts'

/**
 * Optional host-side service that resolves per-request HTTP headers for an MCP
 * server keyed by the calling session id. Secrets resolved here stay out of
 * plugin Config, tool schemas, system prompts, session logs, and error text.
 */
export interface McpHeaderProvider {
  /**
   * Resolve dynamic HTTP headers for one outbound MCP HTTP request.
   * @param sessionId - calling session id, or `undefined` outside a session call.
   * @param serverId - configured MCP `serverName`.
   * @returns headers to attach to the request, or `undefined` for none.
   */
  headersFor(sessionId: string | undefined, serverId: string): Promise<Record<string, string> | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpHeaderProvider?: McpHeaderProvider
  }
}

const mcpSessionStorage = new AsyncLocalStorage<{ sessionId: string | undefined; redactor?: SecretRedactor }>()

/**
 * Bind `sessionId` across one asynchronous MCP tool or resource call so the
 * Streamable HTTP transport can resolve per-session headers at request time.
 * @param sessionId - calling session id, or `undefined` when unassociated.
 * @param fn - async MCP SDK operation.
 * @param redactor - call-local tracker for the credentials sent by the transport.
 * @returns the result of `fn`.
 */
export function runWithMcpSession<T>(sessionId: string | undefined, fn: () => Promise<T>, redactor?: SecretRedactor): Promise<T> {
  return mcpSessionStorage.run({ sessionId, ...(redactor === undefined ? {} : { redactor }) }, fn)
}

/**
 * Read the calling session id bound to the active async execution context, if any.
 * @returns the active session id, or `undefined`.
 */
export function currentMcpSessionId(): string | undefined {
  return mcpSessionStorage.getStore()?.sessionId
}

/**
 * Read the redactor bound to the active MCP call.
 * @returns the active MCP call's redactor, when the caller carries one.
 */
export function currentMcpRedactor(): SecretRedactor | undefined {
  return mcpSessionStorage.getStore()?.redactor
}
