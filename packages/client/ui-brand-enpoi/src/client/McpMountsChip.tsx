/**
 * Session header chip: the MCP servers THIS session has mounted, with a
 * popover that lists them (tool counts) and closes each one. The mounted set
 * is the durable `mcpMounts` session projection; the popover reads the live
 * rows and unmounts through the `enpoiCapabilities` remote.
 */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './McpMountsChip.module.css'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** MCP servers this session has mounted (on-demand mounting). */
    mcpMounts: { readonly mounted: readonly string[] }
  }
}

/** Props assembled by the conversation header renderer. */
export type McpMountsChipProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'mcpMounts'>

/** One mounted server row. */
interface MountRow {
  id: string
  serverName: string
  toolCount: number
}

let rpcSeq = 0

/** Unique wire rpcId per request (the gateway echoes it; duplicates race). */
function nextRpcId(prefix: string): string {
  rpcSeq += 1
  return `${prefix}-${rpcSeq}`
}

/** Read the session's mounted rows through the capabilities remote. */
async function fetchMounts(sessionId: string): Promise<MountRow[] | undefined> {
  try {
    const res = await fetch('/api/enpoiCapabilities.mcpMounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'enpoiCapabilities.mcpMounts',
        rpcId: nextRpcId('mcp-mounts'),
        payload: { args: { sessionId } },
      }),
    })
    if (!res.ok) return undefined
    const json = await res.json() as { result?: { ok?: boolean; value?: { mounts?: unknown } } }
    if (json.result?.ok !== true) return undefined
    const mounts = json.result.value?.mounts
    if (!Array.isArray(mounts)) return undefined
    return mounts
      .filter((row): row is MountRow => row !== null && typeof row === 'object'
        && typeof (row as MountRow).id === 'string' && typeof (row as MountRow).serverName === 'string')
      .map(row => ({ id: row.id, serverName: row.serverName, toolCount: typeof row.toolCount === 'number' ? row.toolCount : 0 }))
  } catch {
    return undefined
  }
}

/** Unmount one server from this session. */
async function unmountServer(sessionId: string, server: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch('/api/enpoiCapabilities.mcpUnmount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'enpoiCapabilities.mcpUnmount',
        rpcId: nextRpcId('mcp-unmount'),
        payload: { args: { sessionId, server } },
      }),
    })
    if (!res.ok) return { ok: false, reason: `gateway responded ${res.status}` }
    const json = await res.json() as { result?: { ok?: boolean; value?: { ok?: boolean; reason?: string } } }
    if (json.result?.ok !== true) return { ok: false, reason: 'the unmount request was rejected' }
    return { ok: json.result.value?.ok === true, reason: typeof json.result.value?.reason === 'string' ? json.result.value.reason : '' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Render the mounted-server chip, or nothing when the session has no mounts.
 * @param props - session identity, the sessions snapshot hook, and localized copy.
 * @returns the chip with its popover.
 */
export function McpMountsChip({ sessionId, useSessions, t }: McpMountsChipProps) {
  const mounted = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.mcpMounts as { mounted?: unknown } | undefined
    return Array.isArray(value?.mounted) ? value.mounted.filter((id): id is string => typeof id === 'string') : []
  })
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<MountRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mountedKey = mounted.join(',')
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setRows(null)
    void fetchMounts(sessionId).then((value) => {
      if (cancelled) return
      if (value === undefined) setError(t('loadFailed'))
      else { setRows(value); setError(null) }
    })
    return () => { cancelled = true }
  }, [open, sessionId, mountedKey, t])
  if (mounted.length === 0) return null
  const close = async (server: string): Promise<void> => {
    const outcome = await unmountServer(sessionId, server)
    if (!outcome.ok) {
      setError(t('unmountFailed', { reason: outcome.reason }))
      return
    }
    setError(null)
    const value = await fetchMounts(sessionId)
    if (value !== undefined) setRows(value)
  }
  return (
    <div className={css.wrap} data-mcp-mounts-chip="">
      <button
        type="button"
        className={css.chip}
        aria-expanded={open}
        aria-label={t('chipLabel', { count: mounted.length })}
        onClick={() => { setOpen(value => !value) }}
      >
        {t('chipLabel', { count: mounted.length })}
      </button>
      {open && (
        <div className={css.popover} role="dialog" aria-label={t('title')} data-mcp-mounts-popover="">
          <div className={css.head}>{t('title')}</div>
          {rows === null && error === null && <div className={css.dim}>{t('loading')}</div>}
          {rows?.map(row => (
            <div key={row.id} className={css.row} data-mcp-mount={row.id}>
              <span className={css.name}>{row.serverName}</span>
              <span className={css.count}>{t('toolCount', { count: row.toolCount })}</span>
              <button
                type="button"
                className={css.close}
                data-mcp-unmount={row.id}
                aria-label={`${t('unmount')}: ${row.serverName}`}
                onClick={() => { void close(row.id) }}
              >
                {t('unmount')}
              </button>
            </div>
          ))}
          {error !== null && <div className={css.error} role="alert" data-mcp-mounts-error="">{error}</div>}
        </div>
      )}
    </div>
  )
}
