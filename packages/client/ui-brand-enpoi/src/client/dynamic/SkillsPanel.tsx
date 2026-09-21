/**
 * SkillsPanel — skills and tool capability toggles on the Dynamic settings page.
 *
 * Skills are the live catalog of `/api/skills.list`, addressed by the newest
 * visible session (the catalog is session-scoped, so the panel asks
 * `/api/session/list` for candidate ids and walks them newest-first). Each row
 * shows the skill's instruction-file path and toggles
 * `capabilities.skills.<name>`; tool rows cover the known core/system tools
 * plus any keys already stored under `capabilities.tools.<id>`. Every toggle
 * is optimistic at 0ms, fenced by the namespace revision with conflict retry,
 * rolled back behind a compact error line, and followed by a capability
 * re-read so the Capabilities tab stays in step. Tool policy (ask/allow/deny)
 * is owned by the Permissions settings page.
 */
import { useEffect, useState } from 'react'
import {
  KNOWN_CAPABILITIES,
  PROTECTED_CAPABILITIES,
  refreshCapabilities,
} from '../CapabilitiesBody.tsx'
import css from './SkillsPanel.module.css'
import { setStatus } from './status.ts'
import { withWriteTimeout } from './write-timeout.ts'

/** One live skill catalog row (skills.list superset with the file path). */
interface SkillRow {
  name: string
  description: string
  path?: string
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
  value?: { capabilities?: { tools?: Record<string, boolean>; skills?: Record<string, boolean> } }
}

/** How many sessions the skill-catalog walk tries before giving up. */
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

/** Read the enpoi-orchestration namespace through the live gateway. */
async function describeOrchestration(): Promise<OrchestrationView | undefined> {
  try {
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

/** Read the newest visible session ids (the skill catalog is session-addressed). */
async function fetchSessionIds(): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
  try {
    const res = await fetch('/api/session/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'session.list',
        rpcId: nextRpcId('skills-sessions'),
        payload: { args: { _request: {} } },
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

/** One skills.list attempt; success carries the catalog, failure the reason to show. */
async function fetchSkillCatalog(sessionId: string): Promise<
  { ok: true; skills: SkillRow[] } | { ok: false; reason: string }
> {
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
    if (!res.ok) return { ok: false, reason: `gateway responded ${res.status}` }
    const json = await res.json() as {
      result?: {
        ok?: boolean
        value?: { skills?: Array<{ name?: unknown; description?: unknown; path?: unknown; modelInvocable?: unknown }> }
        error?: { message?: unknown }
      }
    }
    const result = json?.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, reason: typeof message === 'string' && message !== '' ? message : 'skill catalog request was rejected' }
    }
    const rows = result.value?.skills
    if (!Array.isArray(rows)) return { ok: false, reason: 'skill catalog response was malformed' }
    const skills: SkillRow[] = []
    for (const row of rows) {
      if (typeof row.name !== 'string' || row.name === '') continue
      skills.push({
        name: row.name,
        description: typeof row.description === 'string' ? row.description : '',
        ...(typeof row.path === 'string' && row.path !== '' ? { path: row.path } : {}),
        modelInvocable: row.modelInvocable === true,
      })
    }
    return { ok: true, skills }
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Skills & tools capability toggles. */
export function SkillsPanel() {
  const [tools, setTools] = useState<Record<string, boolean> | null>(null)
  const [skillCaps, setSkillCaps] = useState<Record<string, boolean>>({})
  const [skills, setSkills] = useState<SkillRow[] | null>(null)
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [loadingSkills, setLoadingSkills] = useState(true)
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, boolean>>({})

  /** Re-read capability flags and the session-addressed skill catalog. */
  const load = async (): Promise<void> => {
    setSettingsError(null)
    setLoadingSkills(true)
    const view = await describeOrchestration()
    if (view === undefined) {
      setSettingsError('settings service is unavailable')
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
    }
    const sessions = await fetchSessionIds()
    if (!sessions.ok) {
      setSkillsError(`session list unavailable: ${sessions.reason}`)
      setLoadingSkills(false)
      return
    }
    if (sessions.ids.length === 0) {
      setSkillsError('no session available to resolve the skill catalog')
      setLoadingSkills(false)
      return
    }
    let reason = 'skill catalog request failed'
    for (const sessionId of sessions.ids) {
      const attempt = await fetchSkillCatalog(sessionId)
      if (attempt.ok) {
        setSkills(attempt.skills)
        setSkillsError(null)
        setLoadingSkills(false)
        return
      }
      reason = attempt.reason
    }
    setSkills([])
    setSkillsError(reason)
    setLoadingSkills(false)
  }

  useEffect(() => {
    void load()
  }, [])

  /** Apply one capability write with conflict retry; returns the reason on failure. */
  const writeCapability = (kind: 'skill' | 'tool', id: string, enabled: boolean): Promise<string | null> => withWriteTimeout((async () => {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const view = await describeOrchestration()
      if (view === undefined) return 'settings service is unavailable'
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
        description: 'Stored tool capability',
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
        aria-label={`Enable ${label}`}
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
    <div className={css.container}>
      <div className={css.hint}>
        Skill and tool toggles write <code>capabilities.skills.*</code> / <code>capabilities.tools.*</code> in
        {' '}<code>enpoi-orchestration</code> and apply to the next query. Tool policy (ask/allow/deny) lives on the
        {' '}Permissions settings page.
      </div>
      {settingsError !== null && (
        <div className={css.errorRow}>
          <span className={css.errorLine} title={settingsError}>{settingsError}</span>
          <button type="button" className={css.retryBtn} onClick={() => { void load() }}>Retry</button>
        </div>
      )}

      <section className={css.group}>
        <div className={css.groupHead}>
          <span className={css.groupTitle}>Skills</span>
          <span className={css.countBadge}>{skills?.length ?? '…'} live</span>
        </div>
        {skillsError !== null && (
          <div className={css.errorRow}>
            <span className={css.errorLine} title={skillsError}>skill catalog unavailable: {skillsError}</span>
            <button type="button" className={css.retryBtn} onClick={() => { void load() }}>Retry</button>
          </div>
        )}
        {skills === null && loadingSkills && <div className={css.empty}>Loading skill catalog…</div>}
        {skills !== null && skills.length === 0 && skillsError === null && (
          <div className={css.empty}>No skills discovered. Add a folder with a SKILL.md, then reload.</div>
        )}
        <div className={css.rows}>
          {skills?.map((skill) => {
            const enabled = skillCaps[skill.name] !== false
            return (
              <div className={css.row} key={skill.name}>
                <div className={css.rowInfo}>
                  <div className={css.rowName}>
                    <span>{skill.name}</span>
                    {!skill.modelInvocable && <span className={css.badge}>user-only</span>}
                  </div>
                  {skill.description !== '' && <div className={css.rowDesc}>{skill.description}</div>}
                  {skill.path !== undefined && (
                    <div className={css.rowPath} title={skill.path}>{skill.path}</div>
                  )}
                </div>
                {renderSwitch(skill.name, enabled, pending[skill.name] === true, (next) => { toggleSkill(skill.name, next) })}
              </div>
            )
          })}
        </div>
      </section>

      <section className={css.group}>
        <div className={css.groupHead}>
          <span className={css.groupTitle}>Tools</span>
          <span className={css.countBadge}>{toolRows.length}</span>
        </div>
        <div className={css.rows}>
          {tools === null && <div className={css.empty}>Loading tools…</div>}
          {tools !== null && toolRows.map((tool) => {
            const enabled = tools[tool.id] !== false
            return (
              <div className={css.row} key={tool.id}>
                <div className={css.rowInfo}>
                  <div className={css.rowName}>
                    <span>{tool.name}</span>
                    {tool.protected && <span className={css.badge}>Core</span>}
                    <span className={css.badge}>{tool.category}</span>
                  </div>
                  <div className={css.rowDesc}>{tool.description}</div>
                </div>
                {renderSwitch(tool.name, enabled, tool.protected || pending[tool.id] === true, (next) => { toggleTool(tool.id, next) })}
              </div>
            )
          })}
        </div>
      </section>

      {revision !== undefined && <div className={css.foot}>namespace revision {revision}</div>}
    </div>
  )
}
