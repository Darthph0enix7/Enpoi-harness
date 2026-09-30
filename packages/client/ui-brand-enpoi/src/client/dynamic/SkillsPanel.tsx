/**
 * SkillsPanel — skills management and tool capability toggles on the Dynamic settings page.
 *
 * Skills are the host's live catalog: `/sidebar/fsops` `skills.list` (the user
 * root `$DSH_HOME/skills` plus, when a session address resolves, the read-only
 * registry rows the host merges), enriched with `modelInvocable` from the
 * session-addressed `/api/skills.list`. Each editable row offers Edit and
 * Delete; the shipped tier rows arrive `protected`/`editable:false` and stay
 * read-only. Every row toggles `capabilities.skills.<name>`; tool rows cover
 * the known core/system tools plus any keys already stored under
 * `capabilities.tools.<id>`. Every toggle is optimistic at 0ms, fenced by the
 * namespace revision with conflict retry, rolled back behind a compact error
 * line, and followed by a capability re-read so the Capabilities tab stays in
 * step. CRUD writes go through the same fenced fsops routes and reload the
 * catalog; tool policy (ask/allow/deny) is owned by the Permissions settings
 * page.
 */
import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { KNOWN_CAPABILITIES, PROTECTED_CAPABILITIES } from '../capability-catalog.ts'
import { refreshCapabilities } from '../CapabilitiesBody.tsx'
import css from './SkillsPanel.module.css'
import { setStatus } from './status.ts'
import { withWriteTimeout } from './write-timeout.ts'
import {
  createSkill,
  deleteSkill,
  isSkillName,
  listSkills,
  readSkill,
  SkillsApiError,
  updateSkill,
  type SkillRow,
} from './skills-api.ts'
import {
  customToolNameOf,
  emptyParam,
  isCustomToolId,
  parseCustomTools,
  type CustomToolParam,
  type CustomToolRecord,
} from './custom-tools-model.ts'

/** Props of {@link SkillsPanel}: the Dynamic section's locale share (CRUD copy). */
export type SkillsPanelProps = PropsLocale<'settings.dynamicSkills'>

/** One catalog row enriched with the registry's invocation flag. */
interface PanelSkillRow extends SkillRow {
  modelInvocable: boolean
}

/** One tool capability row of the panel. */
interface ToolRow {
  id: string
  name: string
  description: string
  category: string
  protected: boolean
}

/** One path op inside the enpoi-orchestration namespace. */
interface SettingsPathOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/** The settings.describe view of the enpoi-orchestration namespace (capability subset). */
interface OrchestrationView {
  revision?: number
  value?: {
    capabilities?: { tools?: Record<string, boolean>; skills?: Record<string, boolean> }
    customTools?: unknown
  }
}

/** One open skill form (create or edit). */
interface SkillFormState {
  mode: 'create' | 'edit'
  name: string
  description: string
  body: string
  /** Read/write/validation failure shown inside the dialog. */
  error: string | null
  /** Edit loads the body before the fields are usable. */
  loading: boolean
}

/** One open custom-tool form (create or edit). */
interface ToolFormState {
  mode: 'create' | 'edit'
  id: string
  name: string
  description: string
  command: string
  params: CustomToolParam[]
  error: string | null
}

/** How many sessions the catalog walk tries before giving up. */
const MAX_SESSION_CANDIDATES = 5

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

/** The message one failed request or CRUD call shows. */
function errorMessage(error: unknown): string {
  if (error instanceof SkillsApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/** Read the enpoi-orchestration namespace through the live gateway. */
async function describeOrchestration(): Promise<OrchestrationView | undefined> {
  try {
    const shared = (globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe
    if (typeof shared === 'function') {
      const namespaces = (await (shared as () => Promise<{ namespaces?: readonly unknown[] } | undefined>)())?.namespaces
      return Array.isArray(namespaces)
        ? (namespaces as OrchestrationView[]).find(n => (n as { ns?: string }).ns === 'enpoi-orchestration')
        : undefined
    }
    const res = await fetch('/api/settings.describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.describe',
        rpcId: nextRpcId('skills-describe'),
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

/** Post one capability write fenced by the revision read from describe. */
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
        rpcId: nextRpcId('skills-write'),
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

/** Read the newest visible session ids (the catalog is session-addressed). */
async function fetchSessionIds(): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
  try {
    const res = await fetch('/api/session/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'session.list',
        rpcId: nextRpcId('skills-sessions'),
        payload: { args: { request: {} } },
      }),
    })
    if (!res.ok) return { ok: false, reason: `gateway responded ${res.status}` }
    const json = await res.json() as {
      result?: { ok?: boolean; value?: { items?: unknown }; error?: { message?: unknown } }
    }
    const result = json?.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, reason: typeof message === 'string' && message !== '' ? message : 'session list request was rejected' }
    }
    const items = result.value?.items
    if (!Array.isArray(items)) return { ok: false, reason: 'session list response was malformed' }
    const ids: string[] = []
    for (const item of items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const id = (item as Record<string, unknown>).sessionId
      if (typeof id !== 'string' || id === '' || ids.includes(id)) continue
      ids.push(id)
      if (ids.length >= MAX_SESSION_CANDIDATES) break
    }
    return { ok: true, ids }
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Invocation flags by skill name from the session-addressed registry catalog; undefined when none answers. */
async function fetchInvocableMap(sessionIds: readonly string[]): Promise<Map<string, boolean> | undefined> {
  for (const sessionId of sessionIds) {
    try {
      const res = await fetch('/api/skills.list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          method: 'skills.list',
          rpcId: nextRpcId('skills-list'),
          payload: { args: { request: { sessionId } } },
        }),
      })
      if (!res.ok) continue
      const json = await res.json() as {
        result?: { ok?: boolean; value?: { skills?: Array<{ name?: unknown; modelInvocable?: unknown }> } }
      }
      const rows = json?.result?.ok === true ? json.result.value?.skills : undefined
      if (!Array.isArray(rows)) continue
      const map = new Map<string, boolean>()
      for (const row of rows) {
        if (typeof row.name === 'string' && row.name !== '') map.set(row.name, row.modelInvocable === true)
      }
      return map
    } catch {
      // The next candidate session owns the catalog; a total failure keeps the default flag.
    }
  }
  return undefined
}

/** Skills management (CRUD + capability toggles) and tool capability toggles. */
export function SkillsPanel({ t }: SkillsPanelProps) {
  const [tools, setTools] = useState<Record<string, boolean> | null>(null)
  const [skillCaps, setSkillCaps] = useState<Record<string, boolean>>({})
  const [skills, setSkills] = useState<PanelSkillRow[] | null>(null)
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [skillsNote, setSkillsNote] = useState<string | null>(null)
  const [loadingSkills, setLoadingSkills] = useState(true)
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [form, setForm] = useState<SkillFormState | null>(null)
  const [deleting, setDeleting] = useState<PanelSkillRow | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [customTools, setCustomTools] = useState<CustomToolRecord[]>([])
  const [toolForm, setToolForm] = useState<ToolFormState | null>(null)
  const [deletingTool, setDeletingTool] = useState<CustomToolRecord | null>(null)
  const [toolDeleteError, setToolDeleteError] = useState<string | null>(null)

  /** Re-read capability flags and the skills catalog (on-disk + registry). */
  const load = async (): Promise<void> => {
    setSettingsError(null)
    setLoadingSkills(true)
    const view = await describeOrchestration()
    if (view === undefined) {
      setSettingsError(t('settingsUnavailable'))
    } else {
      setRevision(view.revision)
      const defaults: Record<string, boolean> = {}
      for (const cap of KNOWN_CAPABILITIES) {
        if (cap.kind === 'tool') defaults[cap.id] = cap.defaultEnabled
      }
      const storedTools = view.value?.capabilities?.tools
      if (isRecord(storedTools)) Object.assign(defaults, storedTools as Record<string, boolean>)
      for (const id of PROTECTED_CAPABILITIES) defaults[id] = true
      setTools(defaults)
      setSkillCaps(isRecord(view.value?.capabilities?.skills) ? view.value?.capabilities?.skills as Record<string, boolean> : {})
      setCustomTools(parseCustomTools(view.value?.customTools))
    }
    const sessions = await fetchSessionIds()
    const sessionId = sessions.ok ? sessions.ids[0] : undefined
    try {
      const list = await listSkills(sessionId)
      const invocable = sessions.ok && sessions.ids.length > 0 ? await fetchInvocableMap(sessions.ids) : undefined
      setSkills(list.skills.map(row => ({ ...row, modelInvocable: invocable?.get(row.name) ?? true })))
      setSkillsError(null)
      if (!sessions.ok || sessions.ids.length === 0) setSkillsNote(t('noSessionHint'))
      else if (!list.registry.ok) setSkillsNote(t('registryUnavailable', { reason: list.registry.error }))
      else setSkillsNote(null)
    } catch (error: unknown) {
      setSkills([])
      setSkillsError(errorMessage(error))
      setSkillsNote(sessions.ok ? null : `session list unavailable: ${sessions.reason}`)
    }
    setLoadingSkills(false)
  }

  useEffect(() => {
    void load()
    // Mount-time read: CRUD and toggles call load() explicitly afterwards.
  }, [])

  /** Apply one capability write with conflict retry; returns the reason on failure. */
  const writeCapability = (kind: 'skill' | 'tool', id: string, enabled: boolean): Promise<string | null> => withWriteTimeout((async () => {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const view = await describeOrchestration()
      if (view === undefined) return t('settingsUnavailable')
      setRevision(view.revision)
      const outcome = await postSettingsMutation(
        [{ op: 'set', path: ['capabilities', kind === 'tool' ? 'tools' : 'skills', id], value: enabled }],
        view.revision,
      )
      if (outcome.ok) return null
      if (!outcome.conflict) return outcome.reason ?? 'settings write was rejected'
    }
    return 'settings write conflicted repeatedly'
  })(), 'settings write timed out')

  /** Apply one fenced settings write with conflict retry; returns the reason on failure. */
  const writeOps = (ops: SettingsPathOp[]): Promise<string | null> => withWriteTimeout((async () => {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const view = await describeOrchestration()
      if (view === undefined) return t('settingsUnavailable')
      setRevision(view.revision)
      const outcome = await postSettingsMutation(ops, view.revision)
      if (outcome.ok) return null
      if (!outcome.conflict) return outcome.reason ?? 'settings write was rejected'
    }
    return 'settings write conflicted repeatedly'
  })(), 'settings write timed out')

  /** Flip one skill capability optimistically, rolling back on rejection. */
  const toggleSkill = (id: string, next: boolean): void => {
    setStatus(null)
    const previous = skillCaps
    setSkillCaps(current => ({ ...current, [id]: next }))
    setPending(current => ({ ...current, [id]: true }))
    void writeCapability('skill', id, next).then((reason) => {
      setPending(current => Object.fromEntries(
        Object.entries(current).filter(([candidate]) => candidate !== id),
      ))
      if (reason !== null) {
        setSkillCaps(previous)
        setStatus(reason)
        return
      }
      void refreshCapabilities()
    })
  }

  /** Flip one tool capability optimistically, rolling back on rejection. */
  const toggleTool = (id: string, next: boolean): void => {
    setStatus(null)
    const previous = tools
    setTools(current => current === null ? current : { ...current, [id]: next })
    setPending(current => ({ ...current, [id]: true }))
    void writeCapability('tool', id, next).then((reason) => {
      setPending(current => Object.fromEntries(
        Object.entries(current).filter(([candidate]) => candidate !== id),
      ))
      if (reason !== null) {
        setTools(previous)
        setStatus(reason)
        return
      }
      void refreshCapabilities()
    })
  }

  const patchForm = (patch: Partial<SkillFormState>): void => {
    setForm(current => current === null ? current : { ...current, ...patch })
  }

  const openCreate = (): void => {
    setForm({ mode: 'create', name: '', description: '', body: '', error: null, loading: false })
  }

  const openEdit = (row: PanelSkillRow): void => {
    setForm({ mode: 'edit', name: row.name, description: row.description, body: '', error: null, loading: true })
    void readSkill(row.name).then((detail) => {
      setForm(current => current === null || current.mode !== 'edit' || current.name !== row.name
        ? current
        : { ...current, description: detail.description, body: detail.body, loading: false })
    }).catch((error: unknown) => {
      setForm(current => current === null || current.mode !== 'edit' || current.name !== row.name
        ? current
        : { ...current, error: t('detailFailed', { reason: errorMessage(error) }), loading: false })
    })
  }

  const saveForm = async (): Promise<void> => {
    if (form === null || form.loading || busy) return
    const name = form.name.trim()
    const description = form.description.trim()
    if (!isSkillName(name)) { patchForm({ error: t('nameRequired') }); return }
    if (description === '') { patchForm({ error: t('descriptionRequired') }); return }
    setBusy(true)
    patchForm({ error: null })
    try {
      const input = { name, description, body: form.body }
      if (form.mode === 'create') await createSkill(input)
      else await updateSkill(input)
      setForm(null)
      await load()
    } catch (error: unknown) {
      patchForm({ error: t('saveFailed', { reason: errorMessage(error) }) })
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null || busy) return
    setBusy(true)
    setDeleteError(null)
    try {
      await deleteSkill(deleting.name)
      setDeleting(null)
      await load()
    } catch (error: unknown) {
      setDeleteError(t('deleteFailed', { reason: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const closeDelete = (): void => {
    setDeleting(null)
    setDeleteError(null)
  }

  const patchToolForm = (patch: Partial<ToolFormState>): void => {
    setToolForm(current => current === null ? current : { ...current, ...patch })
  }

  const openToolCreate = (): void => {
    setToolForm({ mode: 'create', id: '', name: '', description: '', command: '', params: [], error: null })
  }

  const openToolEdit = (tool: CustomToolRecord): void => {
    setToolForm({
      mode: 'edit', id: tool.id, name: tool.name, description: tool.description,
      command: tool.command, params: tool.params.map(param => ({ ...param })), error: null,
    })
  }

  const patchToolParam = (index: number, patch: Partial<CustomToolParam>): void => {
    setToolForm(current => current === null ? current : {
      ...current,
      params: current.params.map((param, at) => at === index ? { ...param, ...patch } : param),
    })
  }

  const saveToolForm = async (): Promise<void> => {
    if (toolForm === null || busy) return
    const id = toolForm.id.trim()
    const name = toolForm.name.trim()
    const description = toolForm.description.trim()
    const command = toolForm.command
    if (toolForm.mode === 'create' && !isCustomToolId(id)) { patchToolForm({ error: t('customToolErrorId') }); return }
    if (name === '') { patchToolForm({ error: t('customToolErrorName') }); return }
    if (description === '') { patchToolForm({ error: t('customToolErrorDescription') }); return }
    if (command.trim() === '') { patchToolForm({ error: t('customToolErrorCommand') }); return }
    const params = toolForm.params.map(param => ({ ...param, name: param.name.trim(), description: param.description.trim() }))
    const names = new Set<string>()
    for (const param of params) {
      if (!isCustomToolId(param.name) || names.has(param.name)) { patchToolForm({ error: t('customToolErrorParam') }); return }
      names.add(param.name)
    }
    const record: CustomToolRecord = { id, name, description, params, command }
    const next = toolForm.mode === 'create'
      ? [...customTools, record]
      : customTools.map(tool => tool.id === id ? record : tool)
    const ops: SettingsPathOp[] = [{ op: 'set', path: ['customTools'], value: next }]
    if (toolForm.mode === 'create') {
      // The tool's own permission row defaults to ask, so first use is operator-granted.
      ops.push({ op: 'set', path: ['permissions', 'tools', customToolNameOf(id)], value: 'ask' })
    }
    setBusy(true)
    patchToolForm({ error: null })
    const failure = await writeOps(ops)
    setBusy(false)
    if (failure !== null) {
      patchToolForm({ error: t(toolForm.mode === 'create' ? 'customToolCreateFailed' : 'customToolUpdateFailed', { reason: failure }) })
      return
    }
    setToolForm(null)
    await load()
  }

  const confirmDeleteTool = async (): Promise<void> => {
    if (deletingTool === null || busy) return
    setBusy(true)
    setToolDeleteError(null)
    const next = customTools.filter(tool => tool.id !== deletingTool.id)
    const failure = await writeOps([
      { op: 'set', path: ['customTools'], value: next },
      { op: 'unset', path: ['permissions', 'tools', customToolNameOf(deletingTool.id)] },
    ])
    setBusy(false)
    if (failure !== null) {
      setToolDeleteError(t('customToolDeleteFailed', { reason: failure }))
      return
    }
    setDeletingTool(null)
    await load()
  }

  const toolRows: ToolRow[] = (() => {
    const rows = new Map<string, ToolRow>()
    for (const cap of KNOWN_CAPABILITIES) {
      if (cap.kind !== 'tool') continue
      rows.set(cap.id, {
        id: cap.id,
        name: cap.name,
        description: cap.description,
        category: cap.category,
        protected: PROTECTED_CAPABILITIES.has(cap.id),
      })
    }
    for (const id of Object.keys(tools ?? {})) {
      if (rows.has(id)) continue
      rows.set(id, {
        id,
        name: id,
        description: t('storedToolDescription'),
        category: 'custom',
        protected: PROTECTED_CAPABILITIES.has(id),
      })
    }
    return [...rows.values()]
  })()

  const renderSwitch = (label: string, enabled: boolean, disabled: boolean, onChange: (next: boolean) => void) => (
    <label className={css.switch} style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      <input
        className={css.switchInput}
        type="checkbox"
        aria-label={t('enableLabel', { label })}
        checked={enabled}
        disabled={disabled}
        onChange={(e) => { onChange(e.target.checked) }}
      />
      <span className={`${css.switchTrack}${enabled ? ` ${css.switchOn}` : ''}`}>
        <span className={`${css.switchKnob}${enabled ? ` ${css.switchKnobOn}` : ''}`} />
      </span>
    </label>
  )

  return (
    <div className={css.container} data-skills-panel="">
      <div className={css.hint}>{t('panelHint')}</div>
      {settingsError !== null && (
        <div className={css.errorRow}>
          <span className={css.errorLine} title={settingsError}>{settingsError}</span>
          <button type="button" className={css.retryBtn} onClick={() => { void load() }}>{t('retry')}</button>
        </div>
      )}

      <section className={css.group}>
        <div className={css.groupHead}>
          <span className={css.groupTitle}>{t('skillsTitle')}</span>
          <div className={css.groupActions}>
            <span className={css.countBadge}>{skills === null ? '…' : t('liveCount', { count: skills.length })}</span>
            <button type="button" className={css.addBtn} data-skills-add="" onClick={openCreate}>{t('add')}</button>
          </div>
        </div>
        {skillsError !== null && (
          <div className={css.errorRow}>
            <span className={css.errorLine} title={skillsError}>{t('loadFailed')}: {skillsError}</span>
            <button type="button" className={css.retryBtn} onClick={() => { void load() }}>{t('retry')}</button>
          </div>
        )}
        {skillsNote !== null && <div className={css.note}>{skillsNote}</div>}
        {skills === null && loadingSkills && <div className={css.empty}>{t('loading')}</div>}
        {skills !== null && skills.length === 0 && skillsError === null && (
          <div className={css.empty} data-skills-empty="">{t('empty')}</div>
        )}
        <div className={css.rows}>
          {skills?.map((skill) => {
            const enabled = skillCaps[skill.name] !== false
            return (
              <div className={css.row} key={skill.name} data-skill-row={skill.name}>
                <div className={css.rowInfo}>
                  <div className={css.rowName}>
                    <span>{skill.name}</span>
                    {!skill.modelInvocable && <span className={css.badge}>{t('userOnly')}</span>}
                    {skill.protected && <span className={css.badge}>{t('protectedBadge')}</span>}
                  </div>
                  {skill.description !== '' && <div className={css.rowDesc}>{skill.description}</div>}
                  {skill.path !== undefined && (
                    <div className={css.rowPath} title={skill.path}>{skill.path}</div>
                  )}
                </div>
                {skill.editable && (
                  <div className={css.rowActions}>
                    <button
                      type="button"
                      className={css.actionBtn}
                      data-skill-edit={skill.name}
                      aria-label={`${t('edit')}: ${skill.name}`}
                      onClick={() => { openEdit(skill) }}
                    >
                      {t('edit')}
                    </button>
                    <button
                      type="button"
                      className={css.actionBtnDanger}
                      data-skill-delete={skill.name}
                      aria-label={`${t('delete')}: ${skill.name}`}
                      onClick={() => { setDeleteError(null); setDeleting(skill) }}
                    >
                      {t('delete')}
                    </button>
                  </div>
                )}
                {renderSwitch(skill.name, enabled, pending[skill.name] === true, (next) => { toggleSkill(skill.name, next) })}
              </div>
            )
          })}
        </div>
      </section>

      <section className={css.group}>
        <div className={css.groupHead}>
          <span className={css.groupTitle}>{t('toolsTitle')}</span>
          <div className={css.groupActions}>
            <span className={css.countBadge}>{toolRows.length + customTools.length}</span>
            <button type="button" className={css.addBtn} data-tools-add="" onClick={openToolCreate}>{t('customToolAdd')}</button>
          </div>
        </div>
        <div className={css.rows}>
          {tools === null && <div className={css.empty}>{t('loadingTools')}</div>}
          {tools !== null && toolRows.map((tool) => {
            const enabled = tools[tool.id] !== false
            return (
              <div className={css.row} key={tool.id}>
                <div className={css.rowInfo}>
                  <div className={css.rowName}>
                    <span>{tool.name}</span>
                    {tool.protected && <span className={css.badge}>{t('coreBadge')}</span>}
                    <span className={css.badge}>{tool.category}</span>
                  </div>
                  <div className={css.rowDesc}>{tool.description}</div>
                </div>
                {renderSwitch(tool.name, enabled, tool.protected || pending[tool.id] === true, (next) => { toggleTool(tool.id, next) })}
              </div>
            )
          })}
          {customTools.map((tool) => {
            const name = customToolNameOf(tool.id)
            const enabled = tools?.[name] !== false
            return (
              <div className={css.row} key={`custom:${tool.id}`} data-custom-tool={tool.id}>
                <div className={css.rowInfo}>
                  <div className={css.rowName}>
                    <span>{tool.name}</span>
                    <span className={css.badge}>{t('customToolBadge')}</span>
                    <span className={css.badge}>{name}</span>
                  </div>
                  {tool.description !== '' && <div className={css.rowDesc}>{tool.description}</div>}
                  <div className={css.rowPath} title={tool.command}>{tool.command}</div>
                </div>
                <div className={css.rowActions}>
                  <button
                    type="button"
                    className={css.actionBtn}
                    data-tool-edit={tool.id}
                    aria-label={`${t('edit')}: ${tool.name}`}
                    onClick={() => { openToolEdit(tool) }}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className={css.actionBtnDanger}
                    data-tool-delete={tool.id}
                    aria-label={`${t('delete')}: ${tool.name}`}
                    onClick={() => { setToolDeleteError(null); setDeletingTool(tool) }}
                  >
                    {t('delete')}
                  </button>
                </div>
                {renderSwitch(tool.name, enabled, pending[name] === true, (next) => { toggleTool(name, next) })}
              </div>
            )
          })}
        </div>
      </section>

      {revision !== undefined && <div className={css.foot}>{t('revisionLabel', { revision })}</div>}

      <Modal
        open={form !== null}
        onClose={() => { if (!busy) setForm(null) }}
        title={form?.mode === 'edit' ? t('editTitle') : t('newTitle')}
        closeLabel={t('cancel')}
        footer={<>
          <Button variant="outline" disabled={busy} onClick={() => { setForm(null) }}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || form?.loading === true} data-skill-save="" onClick={() => { void saveForm() }}>
            {form?.mode === 'edit' ? t('save') : t('create')}
          </Button>
        </>}
      >
        <div className={css.form} data-skills-form="">
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldName')}</span>
            <Input
              data-skill-name-input=""
              aria-label={t('fieldName')}
              value={form?.name ?? ''}
              disabled={form?.mode === 'edit'}
              placeholder={t('namePlaceholder')}
              onChange={(event) => { patchForm({ name: event.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldDescription')}</span>
            <Input
              data-skill-description-input=""
              aria-label={t('fieldDescription')}
              value={form?.description ?? ''}
              placeholder={t('descriptionPlaceholder')}
              onChange={(event) => { patchForm({ description: event.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldBody')}</span>
            <textarea
              className={css.textarea}
              data-skill-body-input=""
              aria-label={t('fieldBody')}
              rows={10}
              spellCheck={false}
              placeholder={t('bodyPlaceholder')}
              value={form?.body ?? ''}
              disabled={form?.loading === true}
              onChange={(event) => { patchForm({ body: event.target.value }) }}
            />
          </label>
          {form?.error != null && <p className={css.actionError} role="alert" data-skills-form-error="">{form.error}</p>}
        </div>
      </Modal>

      <Modal
        open={deleting !== null}
        onClose={closeDelete}
        title={t('deleteTitle')}
        closeLabel={t('cancel')}
        footer={<>
          <Button variant="outline" disabled={busy} onClick={closeDelete}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy} data-skill-delete-confirm="" onClick={() => { void confirmDelete() }}>
            {t('delete')}
          </Button>
        </>}
      >
        <p className={css.confirmText}>{t('deleteConfirm', { name: deleting?.name ?? '' })}</p>
        {deleteError !== null && <p className={css.actionError} role="alert" data-skills-delete-error="">{deleteError}</p>}
      </Modal>

      <Modal
        open={toolForm !== null}
        onClose={() => { if (!busy) setToolForm(null) }}
        title={toolForm?.mode === 'edit' ? t('customToolEditTitle') : t('customToolNewTitle')}
        closeLabel={t('cancel')}
        footer={<>
          <Button variant="outline" disabled={busy} onClick={() => { setToolForm(null) }}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy} data-tool-save="" onClick={() => { void saveToolForm() }}>
            {toolForm?.mode === 'edit' ? t('customToolSave') : t('customToolCreate')}
          </Button>
        </>}
      >
        <div className={css.form} data-tool-form="">
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('customToolId')}</span>
            <Input
              data-tool-id-input=""
              aria-label={t('customToolId')}
              value={toolForm?.id ?? ''}
              disabled={toolForm?.mode === 'edit'}
              placeholder="github-repo"
              onChange={(event) => { patchToolForm({ id: event.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('customToolName')}</span>
            <Input
              data-tool-name-input=""
              aria-label={t('customToolName')}
              value={toolForm?.name ?? ''}
              placeholder={t('customToolName')}
              onChange={(event) => { patchToolForm({ name: event.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('customToolDescription')}</span>
            <Input
              data-tool-description-input=""
              aria-label={t('customToolDescription')}
              value={toolForm?.description ?? ''}
              placeholder={t('customToolDescription')}
              onChange={(event) => { patchToolForm({ description: event.target.value }) }}
            />
          </label>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('customToolParams')}</span>
            {toolForm?.params.map((param, index) => (
              <div className={css.paramRow} key={index} data-tool-param={index}>
                <Input
                  className={css.paramName ?? ''}
                  aria-label={`${t('customToolParamName')} ${String(index + 1)}`}
                  value={param.name}
                  placeholder={t('customToolParamNamePlaceholder')}
                  onChange={(event) => { patchToolParam(index, { name: event.target.value }) }}
                />
                <select
                  className={css.paramType}
                  aria-label={`${t('customToolParamType')} ${String(index + 1)}`}
                  value={param.type}
                  onChange={(event) => { patchToolParam(index, { type: event.target.value as CustomToolParam['type'] }) }}
                >
                  {(['string', 'number', 'boolean'] as const).map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <label className={css.paramRequired}>
                  <input
                    type="checkbox"
                    checked={param.required}
                    aria-label={`${t('customToolParamRequired')} ${String(index + 1)}`}
                    onChange={(event) => { patchToolParam(index, { required: event.target.checked }) }}
                  />
                  {t('customToolParamRequired')}
                </label>
                <Input
                  className={css.paramDesc ?? ''}
                  aria-label={`${t('customToolParamDescription')} ${String(index + 1)}`}
                  value={param.description}
                  placeholder={t('customToolParamDescription')}
                  onChange={(event) => { patchToolParam(index, { description: event.target.value }) }}
                />
                <button
                  type="button"
                  className={css.actionBtnDanger}
                  data-tool-param-remove={index}
                  aria-label={`${t('customToolRemoveParam')} ${String(index + 1)}`}
                  onClick={() => { patchToolForm({ params: (toolForm?.params ?? []).filter((_param, at) => at !== index) }) }}
                >
                  {t('customToolRemoveParam')}
                </button>
              </div>
            ))}
            <button
              type="button"
              className={css.addBtn}
              data-tool-param-add=""
              onClick={() => { patchToolForm({ params: [...(toolForm?.params ?? []), emptyParam()] }) }}
            >
              {t('customToolAddParam')}
            </button>
          </div>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('customToolCommand')}</span>
            <textarea
              className={css.textarea}
              data-tool-command-input=""
              aria-label={t('customToolCommand')}
              rows={4}
              spellCheck={false}
              placeholder={t('customToolCommandPlaceholder')}
              value={toolForm?.command ?? ''}
              onChange={(event) => { patchToolForm({ command: event.target.value }) }}
            />
            <span className={css.fieldHint}>{t('customToolCommandHint')}</span>
          </label>
          {toolForm?.error != null && <p className={css.actionError} role="alert" data-tool-form-error="">{toolForm.error}</p>}
        </div>
      </Modal>

      <Modal
        open={deletingTool !== null}
        onClose={() => { setDeletingTool(null); setToolDeleteError(null) }}
        title={t('customToolDeleteTitle')}
        closeLabel={t('cancel')}
        footer={<>
          <Button variant="outline" disabled={busy} onClick={() => { setDeletingTool(null); setToolDeleteError(null) }}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy} data-tool-delete-confirm="" onClick={() => { void confirmDeleteTool() }}>
            {t('delete')}
          </Button>
        </>}
      >
        <p className={css.confirmText}>{t('customToolDeleteConfirm', { name: deletingTool?.name ?? '' })}</p>
        {toolDeleteError !== null && <p className={css.actionError} role="alert" data-tool-delete-error="">{toolDeleteError}</p>}
      </Modal>
    </div>
  )
}
