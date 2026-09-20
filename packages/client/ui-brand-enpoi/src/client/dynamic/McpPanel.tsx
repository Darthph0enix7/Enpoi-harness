/**
 * McpPanel — the MCP catalog editor on the Dynamic settings page.
 *
 * Rows come from `enpoi-orchestration.mcpServers` in settings.describe plus the
 * host heartbeat in `mcpStatus` (state dot and mount-failure text). Enable
 * toggles reuse the shared `toggleCapability` writer (`capabilities.mcp.<id>`),
 * add and remove reuse the shared catalog writers `addMcpServer` /
 * `removeMcpServer`, and inline edits write the whole `mcpServers.<id>` record
 * through a revision-fenced write with conflict retry. Every gesture lands
 * optimistically at 0ms and rolls back behind a compact error line when the
 * host rejects the write.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  KNOWN_CAPABILITIES,
  addMcpServer,
  removeMcpServer,
  refreshMcpStatus,
  toggleCapability,
  type McpServerEntry,
  type McpStatusEntry,
} from '../CapabilitiesBody.tsx'
import css from './McpPanel.module.css'

/** One path op inside the enpoi-orchestration namespace. */
interface SettingsPathOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/** The settings.describe view of the enpoi-orchestration namespace (MCP subset). */
interface OrchestrationView {
  revision?: number
  value?: {
    capabilities?: { mcp?: Record<string, boolean> }
    mcpStatus?: Record<string, McpStatusEntry>
    mcpServers?: Record<string, McpServerEntry>
  }
}

/** How many times a fenced write re-reads and retries on conflict. */
const MAX_WRITE_RETRIES = 3

let rpcSeq = 0

/** Unique wire rpcId per request (the gateway echoes it; duplicates race). */
function nextRpcId(prefix: string): string {
  rpcSeq += 1
  return `${prefix}-${rpcSeq}`
}

/** Whether a value is a plain JSON record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a string is an http(s) URL the mount machinery can dial. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Read the enpoi-orchestration namespace through the live gateway. */
async function describeOrchestration(): Promise<OrchestrationView | undefined> {
  try {
    const res = await fetch('/api/settings.describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.describe',
        rpcId: nextRpcId('mcp-describe'),
        payload: { args: {} },
      }),
    })
    if (!res.ok) return undefined
    const json = await res.json() as { result?: { ok?: boolean; value?: { namespaces?: OrchestrationView[] } } }
    const namespaces = json?.result?.value?.namespaces
    return Array.isArray(namespaces) ? namespaces.find(n => (n as { ns?: string }).ns === 'enpoi-orchestration') : undefined
  } catch {
    return undefined
  }
}

/** Outcome of one fenced settings write. */
interface MutationOutcome {
  ok: boolean
  conflict: boolean
  reason?: string
}

/** Post one catalog write fenced by the revision read from describe. */
async function postSettingsMutation(ops: SettingsPathOp[], expectedRevision: number | undefined): Promise<MutationOutcome> {
  const args: Record<string, unknown> = { ns: 'enpoi-orchestration', ops }
  if (expectedRevision !== undefined) args.expectedRevision = expectedRevision
  try {
    const res = await fetch('/api/settings.mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.mutate',
        rpcId: nextRpcId('mcp-write'),
        payload: { args },
      }),
    })
    if (!res.ok) return { ok: false, conflict: false, reason: `gateway responded ${res.status}` }
    const json = await res.json() as { result?: { ok?: boolean; error?: { code?: string; message?: unknown } } }
    if (json?.result?.ok === true) return { ok: true, conflict: false }
    const message = json?.result?.error?.message
    return {
      ok: false,
      conflict: json?.result?.error?.code === 'settings/conflict',
      ...(typeof message === 'string' && message !== '' ? { reason: message } : {}),
    }
  } catch (err: unknown) {
    return { ok: false, conflict: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Parse the optional headers textarea into a flat string map (undefined when blank). */
function parseHeadersField(text: string): Record<string, string> | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const parsed = JSON.parse(trimmed) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('headers must be a JSON object')
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`header "${key}" must be a string`)
    headers[key] = value
  }
  return headers
}

/** One catalog display row: a known capability id or a stored server. */
interface McpRow {
  id: string
  name: string
  description: string
  known: boolean
}

/** MCP connection state shown by one row's dot. */
interface StatusFace {
  color: string
  glow: string
  title: string
  error?: string
}

/** The MCP catalog editor. */
export function McpPanel() {
  const [servers, setServers] = useState<Record<string, McpServerEntry> | null>(null)
  const [status, setStatus] = useState<Record<string, McpStatusEntry>>({})
  const [caps, setCaps] = useState<Record<string, boolean>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addUrl, setAddUrl] = useState('')
  const [addApiKeyEnv, setAddApiKeyEnv] = useState('')
  const [addHeaders, setAddHeaders] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [addBusy, setAddBusy] = useState(false)

  const [editId, setEditId] = useState<string | null>(null)
  const [editUrl, setEditUrl] = useState('')
  const [editApiKeyEnv, setEditApiKeyEnv] = useState('')
  const [editHeaders, setEditHeaders] = useState('')
  const [editBusy, setEditBusy] = useState(false)

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  /** Re-read catalog, heartbeat, and enable flags in one pass. */
  const refresh = async (): Promise<void> => {
    const view = await describeOrchestration()
    if (view === undefined) {
      setLoadError('settings service is unavailable')
      return
    }
    setLoadError(null)
    const value = view.value ?? {}
    setServers(isRecord(value.mcpServers) ? value.mcpServers as Record<string, McpServerEntry> : {})
    setStatus(isRecord(value.mcpStatus) ? value.mcpStatus as Record<string, McpStatusEntry> : {})
    setCaps(isRecord(value.capabilities?.mcp) ? value.capabilities.mcp as Record<string, boolean> : {})
  }

  useEffect(() => {
    void refresh()
    // Prime the shared capability catalog too: the shared remove writer only
    // unsets ids its own cache has seen.
    void refreshMcpStatus()
    const interval = window.setInterval(() => { void refresh() }, 15_000)
    return () => { window.clearInterval(interval) }
  }, [])

  /** Apply a write with conflict retry; returns the reason, or null when persisted. */
  const writeFenced = async (ops: SettingsPathOp[]): Promise<string | null> => {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const view = await describeOrchestration()
      if (view === undefined) return 'settings service is unavailable'
      const outcome = await postSettingsMutation(ops, view.revision)
      if (outcome.ok) return null
      if (!outcome.conflict) return outcome.reason ?? 'settings write was rejected'
    }
    return 'settings write conflicted repeatedly'
  }

  /** Flip one server's capability flag through the shared writer. */
  const onToggle = (id: string, next: boolean): void => {
    setActionError(null)
    const previous = caps
    setCaps(current => ({ ...current, [id]: next }))
    void toggleCapability('mcp', id, next).then((accepted) => {
      if (!accepted) {
        setCaps(previous)
        setActionError(`could not ${next ? 'enable' : 'disable'} "${id}"`)
      }
    })
  }

  /** Open the inline editor with the stored record's values. */
  const startEdit = (id: string, entry: McpServerEntry | undefined): void => {
    setActionError(null)
    setConfirmRemove(null)
    setEditId(id)
    setEditUrl(entry?.url ?? '')
    setEditApiKeyEnv(entry?.apiKeyEnv ?? '')
    setEditHeaders(entry?.headers !== undefined ? JSON.stringify(entry.headers) : '')
  }

  /** Persist one inline edit as a whole-record fenced write. */
  const saveEdit = async (id: string): Promise<void> => {
    setActionError(null)
    const url = editUrl.trim()
    if (!isHttpUrl(url)) { setActionError('url must be an http(s) address'); return }
    let headers: Record<string, string> | undefined
    try {
      headers = parseHeadersField(editHeaders)
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err))
      return
    }
    const existing = servers?.[id]
    const entry: McpServerEntry = {
      serverName: id,
      transport: existing?.transport ?? 'streamable-http',
      url,
      ...(editApiKeyEnv.trim() !== '' ? { apiKeyEnv: editApiKeyEnv.trim() } : {}),
      ...(headers !== undefined ? { headers } : {}),
    }
    const previous = servers
    setServers(current => ({ ...(current ?? {}), [id]: entry }))
    setEditBusy(true)
    const reason = await writeFenced([{ op: 'set', path: ['mcpServers', id], value: entry }])
    setEditBusy(false)
    if (reason !== null) {
      setServers(previous)
      setActionError(reason)
      return
    }
    setEditId(null)
    void refreshMcpStatus()
  }

  /** Submit the add form through the shared catalog writer. */
  const submitAdd = async (): Promise<void> => {
    setAddError(null)
    const id = addName.trim()
    const url = addUrl.trim()
    if (id === '') { setAddError('server id is required'); return }
    if (!isHttpUrl(url)) { setAddError('url must be an http(s) address'); return }
    if (servers !== null && servers[id] !== undefined) { setAddError(`server id "${id}" already exists`); return }
    let headers: Record<string, string> | undefined
    try {
      headers = parseHeadersField(addHeaders)
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : String(err))
      return
    }
    const entry: McpServerEntry = {
      serverName: id,
      transport: 'streamable-http',
      url,
      ...(addApiKeyEnv.trim() !== '' ? { apiKeyEnv: addApiKeyEnv.trim() } : {}),
      ...(headers !== undefined ? { headers } : {}),
    }
    const previous = servers
    setServers(current => ({ ...(current ?? {}), [id]: entry }))
    setAddBusy(true)
    const result = await addMcpServer({
      serverName: id,
      url,
      apiKeyEnv: addApiKeyEnv,
      ...(headers !== undefined ? { headers } : {}),
    })
    setAddBusy(false)
    if (!result.ok) {
      setServers(previous)
      setAddError(result.reason)
      return
    }
    setAddName('')
    setAddUrl('')
    setAddApiKeyEnv('')
    setAddHeaders('')
    setAddOpen(false)
    void refreshMcpStatus()
  }

  /** Confirm-and-remove one catalog server through the shared writer. */
  const submitRemove = async (id: string): Promise<void> => {
    setActionError(null)
    setConfirmRemove(null)
    const previous = servers
    setServers(current => Object.fromEntries(
      Object.entries(current ?? {}).filter(([candidate]) => candidate !== id),
    ))
    // The shared writer skips ids its own catalog cache has not seen: sync it first.
    await refreshMcpStatus()
    const result = await removeMcpServer(id)
    if (!result.ok) {
      setServers(previous)
      setActionError(result.reason)
      return
    }
    // A no-op (cache miss) still answers ok; confirm the key actually left the document.
    const after = await describeOrchestration()
    if (after === undefined || after.value?.mcpServers?.[id] !== undefined) {
      setServers(previous)
      setActionError(after === undefined ? 'settings service is unavailable' : `mcpServers.${id} was not removed`)
      return
    }
    void refreshMcpStatus()
  }

  /** Connection dot of one row from the host heartbeat. */
  const statusFace = (id: string): StatusFace => {
    const entry = status[id]
    if (entry === undefined) return { color: '#475569', glow: 'none', title: 'No heartbeat yet' }
    if (Date.now() - entry.checkedAt > 45_000) return { color: '#475569', glow: 'none', title: 'Checking availability…' }
    if (entry.error !== undefined) {
      return { color: '#e5716f', glow: '0 0 4px rgba(229, 113, 111, 0.35)', title: `Mount failed — ${entry.error}`, error: entry.error }
    }
    if (entry.state === 'down') return { color: '#e5716f', glow: '0 0 4px rgba(229, 113, 111, 0.35)', title: 'Not reachable — server not running' }
    if (entry.mounted) return { color: '#34d399', glow: '0 0 5px rgba(52, 211, 153, 0.6)', title: 'Connected & mounted — tools active' }
    return {
      color: '#67dce7',
      glow: '0 0 5px rgba(103, 220, 231, 0.45)',
      title: entry.authError === true ? 'Server running · auth rejected' : 'Server running · toggled off',
    }
  }

  const rows = useMemo<McpRow[]>(() => {
    const list = new Map<string, McpRow>()
    for (const cap of KNOWN_CAPABILITIES) {
      if (cap.kind === 'mcp') list.set(cap.id, { id: cap.id, name: cap.name, description: cap.description, known: true })
    }
    for (const [id, entry] of Object.entries(servers ?? {})) {
      if (list.has(id)) continue
      let host = 'MCP server'
      try { host = new URL(entry.url ?? '').host } catch { /* keep the default label */ }
      list.set(id, { id, name: id, description: host, known: false })
    }
    return [...list.values()]
  }, [servers])

  return (
    <div className={css.container}>
      <p className={css.hint}>
        Catalog lives in <code>enpoi-orchestration.mcpServers</code>; the host heartbeat reports mount state.
      </p>
      {loadError !== null && (
        <div className={css.errorRow}>
          <span className={css.errorLine} title={loadError}>{loadError}</span>
          <button type="button" className={css.retryBtn} onClick={() => { void refresh() }}>Retry</button>
        </div>
      )}
      {actionError !== null && <div className={css.actionError}>{actionError}</div>}
      <div className={css.list}>
        {servers === null && <div className={css.empty}>Loading MCP catalog…</div>}
        {servers !== null && rows.map((row) => {
          const entry = servers[row.id]
          const face = statusFace(row.id)
          const enabled = caps[row.id] === true
          const editing = editId === row.id
          return (
            <div className={css.card} key={row.id}>
              <div className={css.row}>
                <span className={css.dot} title={face.title} style={{ background: face.color, boxShadow: face.glow }} />
                <div className={css.rowInfo}>
                  <div className={css.rowName}>
                    <span>{row.name}</span>
                    {!row.known && <span className={css.rowId}>{row.id}</span>}
                  </div>
                  <div className={css.rowDesc} title={entry?.url ?? row.description}>{entry?.url ?? row.description}</div>
                  {face.error !== undefined && <div className={css.rowError} title={face.error}>mount failed: {face.error}</div>}
                </div>
                <div className={css.rowActions}>
                  <label className={css.switch} title={enabled ? 'Disable server' : 'Enable server'}>
                    <input
                      className={css.switchInput}
                      type="checkbox"
                      aria-label={`Enable ${row.name}`}
                      checked={enabled}
                      onChange={(e) => { onToggle(row.id, e.target.checked) }}
                    />
                    <span className={`${css.switchTrack}${enabled ? ` ${css.switchOn}` : ''}`}>
                      <span className={`${css.switchKnob}${enabled ? ` ${css.switchKnobOn}` : ''}`} />
                    </span>
                  </label>
                  <button
                    type="button"
                    className={css.btn}
                    aria-label={`Edit ${row.name}`}
                    onClick={() => {
                      if (editing) setEditId(null)
                      else startEdit(row.id, entry)
                    }}
                  >
                    {editing ? 'Close' : 'Edit'}
                  </button>
                  {confirmRemove === row.id ? (
                    <>
                      <span className={css.confirmText}>Remove?</span>
                      <button type="button" className={css.confirmBtn} aria-label={`Confirm remove ${row.name}`} onClick={() => { void submitRemove(row.id) }}>
                        Remove
                      </button>
                      <button type="button" className={css.btn} onClick={() => { setConfirmRemove(null) }}>Cancel</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={css.removeBtn}
                      aria-label={`Remove ${row.name}`}
                      title={`Unset mcpServers.${row.id}`}
                      onClick={() => { setActionError(null); setConfirmRemove(row.id) }}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
              {editing && (
                <div className={css.editor}>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>URL</span>
                    <input className={css.addInput} aria-label={`${row.name} url`} placeholder="https://host/mcp" value={editUrl} onChange={(e) => { setEditUrl(e.target.value) }} />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>API key env (optional)</span>
                    <input className={css.addInput} aria-label={`${row.name} API key env`} placeholder="MCP_API_KEY" value={editApiKeyEnv} onChange={(e) => { setEditApiKeyEnv(e.target.value) }} />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>Headers JSON (optional)</span>
                    <textarea className={css.addInput} rows={2} aria-label={`${row.name} headers JSON`} placeholder='{"x-workspace-slug":"main"}' value={editHeaders} onChange={(e) => { setEditHeaders(e.target.value) }} />
                  </label>
                  <div className={css.addActions}>
                    <button type="button" className={css.addBtn} disabled={editBusy} onClick={() => { void saveEdit(row.id) }}>
                      {editBusy ? 'Saving…' : 'Save server'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className={css.addWrap}>
        {addOpen ? (
          <div className={css.addForm}>
            <input className={css.addInput} aria-label="MCP server id" placeholder="server-id" value={addName} onChange={(e) => { setAddName(e.target.value) }} />
            <input className={css.addInput} aria-label="MCP server URL" placeholder="https://host/mcp" value={addUrl} onChange={(e) => { setAddUrl(e.target.value) }} />
            <input className={css.addInput} aria-label="MCP server API key env" placeholder="API key env (optional)" value={addApiKeyEnv} onChange={(e) => { setAddApiKeyEnv(e.target.value) }} />
            <textarea className={css.addInput} rows={2} aria-label="MCP server headers JSON" placeholder='Headers JSON (optional), e.g. {"x-workspace-slug":"main"}' value={addHeaders} onChange={(e) => { setAddHeaders(e.target.value) }} />
            {addError !== null && <div className={css.actionError}>{addError}</div>}
            <div className={css.addActions}>
              <button type="button" className={css.addBtn} disabled={addBusy} onClick={() => { void submitAdd() }}>
                {addBusy ? 'Adding…' : 'Add server'}
              </button>
              <button type="button" className={css.btn} onClick={() => { setAddOpen(false); setAddError(null) }}>Cancel</button>
            </div>
          </div>
        ) : (
          <button type="button" className={css.addBtn} onClick={() => { setAddOpen(true); setAddError(null) }}>
            + Add MCP server
          </button>
        )}
      </div>
    </div>
  )
}
