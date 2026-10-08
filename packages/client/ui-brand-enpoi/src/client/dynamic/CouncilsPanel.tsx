/**
 * CouncilsPanel — the council registry editor on the Dynamic settings page.
 *
 * The live roster comes from the host's `enpoiCouncil.list` RPC (including a
 * per-council validation `error`); the stored override records come from
 * `enpoi-orchestration.councils` in settings.describe. Add writes the whole
 * declarative spec at `councils.<id>` (defaults: one `claim` ledger kind,
 * `PROPOSE`/`ATTACK` actions, `blind` opening), enable/disable writes
 * `disabled` (true retires the tool), delete unsets the override so built-ins
 * fall back to their code default, and prompt editing rewrites the `seats`
 * array and `chairTemplate` object. Every write is optimistic at 0ms, fenced
 * by the namespace revision, retried on `settings/conflict`, and rolled back
 * behind a compact inline error when it does not persist.
 */
import { useEffect, useState } from 'react'
import css from './CouncilsPanel.module.css'
import type { BrandT } from '../locales.ts'
import { setStatus } from './status.ts'
import { withWriteTimeout } from './write-timeout.ts'

/** One council seat as stored in a declarative council spec. */
interface CouncilSeat {
  id: string
  label: string
  persona?: string
  family?: string
}

/** The prompt-bearing subset of a stored declarative council spec. */
interface CouncilSpec {
  label?: string
  seats?: CouncilSeat[]
  chairTemplate?: { systemPrompt?: string; userPromptTemplate?: string }
  disabled?: boolean
}

/** One row of the host council registry (`enpoiCouncil.list`). */
interface CouncilSummary {
  id: string
  label?: string
  seatCount?: number
  enabled?: boolean
  error?: string
}

/** One merged registry row: host summary plus the stored override spec. */
interface CouncilRow {
  id: string
  label: string
  seatCount: number
  enabled: boolean
  error?: string
  spec?: CouncilSpec
}

/** One path op inside the enpoi-orchestration namespace. */
interface SettingsPathOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/** The settings.describe view of the enpoi-orchestration namespace (council subset). */
interface OrchestrationView {
  revision?: number
  value?: { councils?: Record<string, unknown> }
}

/** Ledger kind of an added council (the minimal working default). */
interface LedgerKind {
  kind: string
  idPrefix: string
  terminalStatuses: string[]
}

/** Stopping policy of an added council. */
interface StoppingPolicy {
  type: 'ledger_convergence' | 'topological_saturation' | 'fixed_epochs'
  maxEpochs?: number
}

/** One complete declarative council spec as submitted by the add form. */
interface CouncilSpecInput {
  id: string
  label: string
  seats: CouncilSeat[]
  ledgerKinds: LedgerKind[]
  actions: string[]
  opening: 'blind' | 'open'
  steelman?: boolean
  deliverableSections: string[]
  stoppingPolicy: StoppingPolicy
  chairTemplate: { systemPrompt: string; userPromptTemplate: string }
}

/** How many times a fenced write re-reads and retries on conflict. */
const MAX_WRITE_RETRIES = 3

let rpcSeq = 0

/** Unique wire rpcId per request (the gateway echoes it; duplicates race). */
function nextRpcId(prefix: string): string {
  rpcSeq += 1
  return `${prefix}-${rpcSeq}`
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
        rpcId: nextRpcId('councils-describe'),
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
        rpcId: nextRpcId('councils-write'),
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

/** One council-list attempt; success carries the roster, failure the reason to show. */
async function fetchCouncilList(): Promise<{ ok: true; councils: CouncilSummary[] } | { ok: false; reason: string }> {
  try {
    const res = await fetch('/api/enpoiCouncil.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'enpoiCouncil.list',
        rpcId: nextRpcId('councils-list'),
        payload: { args: {} },
      }),
    })
    if (!res.ok) return { ok: false, reason: `gateway responded ${res.status}` }
    const json = await res.json() as {
      result?: {
        ok?: boolean
        value?: { councils?: unknown }
        error?: { message?: unknown }
      }
    }
    const result = json?.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, reason: typeof message === 'string' && message !== '' ? message : 'council registry request was rejected' }
    }
    const rows = result.value?.councils
    if (!Array.isArray(rows)) return { ok: false, reason: 'council registry response was malformed' }
    const councils: CouncilSummary[] = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const rec = row as Record<string, unknown>
      if (typeof rec.id !== 'string' || rec.id === '') continue
      const summary: CouncilSummary = { id: rec.id }
      if (typeof rec.label === 'string' && rec.label !== '') summary.label = rec.label
      if (Array.isArray(rec.seats)) summary.seatCount = rec.seats.length
      if (rec.enabled === false) summary.enabled = false
      if (rec.error !== undefined && rec.error !== null) summary.error = String(rec.error)
      councils.push(summary)
    }
    return { ok: true, councils }
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Parse one seat out of a stored spec, dropping rows without an id. */
function parseSeat(raw: unknown): CouncilSeat | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== 'string' || rec.id === '') return undefined
  const seat: CouncilSeat = { id: rec.id, label: typeof rec.label === 'string' && rec.label !== '' ? rec.label : rec.id }
  if (typeof rec.persona === 'string' && rec.persona !== '') seat.persona = rec.persona
  if (typeof rec.family === 'string' && rec.family !== '') seat.family = rec.family
  return seat
}

/** Parse the prompt-bearing subset of one stored council override. */
function parseSpec(raw: unknown): CouncilSpec {
  const spec: CouncilSpec = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return spec
  const rec = raw as Record<string, unknown>
  if (typeof rec.label === 'string') spec.label = rec.label
  if (Array.isArray(rec.seats)) {
    spec.seats = rec.seats.map(parseSeat).filter((seat): seat is CouncilSeat => seat !== undefined)
  }
  const chair = rec.chairTemplate
  if (chair !== null && typeof chair === 'object' && !Array.isArray(chair)) {
    const fields = chair as Record<string, unknown>
    spec.chairTemplate = {
      ...(typeof fields.systemPrompt === 'string' ? { systemPrompt: fields.systemPrompt } : {}),
      ...(typeof fields.userPromptTemplate === 'string' ? { userPromptTemplate: fields.userPromptTemplate } : {}),
    }
  }
  if (rec.disabled === true) spec.disabled = true
  return spec
}

/** Merge the host roster over the stored overrides into display rows. */
function buildRows(councils: readonly CouncilSummary[], specs: Record<string, CouncilSpec>): CouncilRow[] {
  const rows = new Map<string, CouncilRow>()
  for (const [id, spec] of Object.entries(specs)) {
    rows.set(id, {
      id,
      label: spec.label !== undefined && spec.label !== '' ? spec.label : id,
      seatCount: spec.seats?.length ?? 0,
      enabled: spec.disabled !== true,
      spec,
    })
  }
  for (const summary of councils) {
    const existing = rows.get(summary.id)
    rows.set(summary.id, {
      id: summary.id,
      label: summary.label ?? existing?.label ?? summary.id,
      seatCount: summary.seatCount ?? existing?.seatCount ?? 0,
      enabled: summary.enabled ?? existing?.enabled ?? true,
      ...(summary.error !== undefined ? { error: summary.error } : {}),
      ...(existing?.spec !== undefined ? { spec: existing.spec } : {}),
    })
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Split a comma-separated field into trimmed non-empty entries. */
function parseCommaList(text: string): string[] {
  return text.split(',').map(part => part.trim()).filter(part => part !== '')
}

/** Trim seat fields and drop seats without an id. */
function sanitizeSeats(seats: readonly CouncilSeat[]): CouncilSeat[] {
  const out: CouncilSeat[] = []
  for (const seat of seats) {
    const id = seat.id.trim()
    if (id === '') continue
    const next: CouncilSeat = { id, label: seat.label.trim() !== '' ? seat.label.trim() : id }
    if (seat.persona !== undefined && seat.persona.trim() !== '') next.persona = seat.persona.trim()
    if (seat.family !== undefined && seat.family.trim() !== '') next.family = seat.family.trim()
    out.push(next)
  }
  return out
}

/** Seat + chair prompt draft of one expanded council row. */
interface PromptDraft {
  seats: CouncilSeat[]
  systemPrompt: string
  userPromptTemplate: string
}

/** Seed a prompt draft from the stored spec (empty fields for a code default). */
function draftFromSpec(spec: CouncilSpec | undefined): PromptDraft {
  return {
    seats: (spec?.seats ?? []).map(seat => ({ ...seat })),
    systemPrompt: spec?.chairTemplate?.systemPrompt ?? '',
    userPromptTemplate: spec?.chairTemplate?.userPromptTemplate ?? '',
  }
}

/** The council registry editor. */
export function CouncilsPanel({ t }: { t: BrandT }) {
  const [rows, setRows] = useState<CouncilRow[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, PromptDraft>>({})
  const [editBusyId, setEditBusyId] = useState<string | null>(null)

  // Add-council form.
  const [addOpen, setAddOpen] = useState(false)
  const [addId, setAddId] = useState('')
  const [addLabel, setAddLabel] = useState('')
  const [addSeats, setAddSeats] = useState<CouncilSeat[]>([{ id: 'seat-1', label: t('councilDefaultSeatLabel', { index: 1 }), persona: t('councilDefaultSeatPersona') }])
  const [addActions, setAddActions] = useState('PROPOSE, ATTACK')
  const [addSections, setAddSections] = useState('FINDINGS, OPEN QUESTIONS')
  const [addStopping, setAddStopping] = useState<StoppingPolicy['type']>('ledger_convergence')
  const [addMaxEpochs, setAddMaxEpochs] = useState('4')
  const [addSystemPrompt, setAddSystemPrompt] = useState('')
  const [addUserTemplate, setAddUserTemplate] = useState('')
  const [addBusy, setAddBusy] = useState(false)

  /** Re-read the host roster and the stored overrides in one pass. */
  const refresh = async (): Promise<void> => {
    const [view, list] = await Promise.all([describeOrchestration(), fetchCouncilList()])
    const specs: Record<string, CouncilSpec> = {}
    const stored = view?.value?.councils
    if (stored !== null && stored !== undefined && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [id, raw] of Object.entries(stored)) specs[id] = parseSpec(raw)
    }
    setRows(buildRows(list.ok ? list.councils : [], specs))
    setListError(list.ok
      ? (view === undefined ? 'settings service is unavailable' : null)
      : list.reason)
  }

  useEffect(() => {
    void refresh()
  }, [])

  /** Apply a write with conflict retry; returns the reason, or null when persisted. */
  const writeFenced = (ops: SettingsPathOp[]): Promise<string | null> => withWriteTimeout((async () => {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const view = await describeOrchestration()
      if (view === undefined) return 'settings service is unavailable'
      const outcome = await postSettingsMutation(ops, view.revision)
      if (outcome.ok) return null
      if (!outcome.conflict) return outcome.reason ?? 'settings write was rejected'
    }
    return 'settings write conflicted repeatedly'
  })(), 'settings write timed out')

  /** Retire or re-enable one council by writing its `disabled` flag. */
  const toggleEnabled = async (row: CouncilRow): Promise<void> => {
    setStatus(null)
    const previous = rows
    setRows(current => current?.map(item => item.id === row.id ? { ...item, enabled: !row.enabled } : item) ?? current)
    const reason = await writeFenced([{ op: 'set', path: ['councils', row.id, 'disabled'], value: row.enabled }])
    if (reason !== null) {
      setRows(previous)
      setStatus(reason)
    }
  }

  /** Unset one council override; a built-in reappears from its code default. */
  const removeCouncil = async (row: CouncilRow): Promise<void> => {
    setStatus(null)
    setConfirmRemove(null)
    const previous = rows
    setRows(current => current?.filter(item => item.id !== row.id) ?? current)
    const reason = await writeFenced([{ op: 'unset', path: ['councils', row.id] }])
    if (reason !== null) {
      setRows(previous)
      setStatus(reason)
      return
    }
    // Built-ins are re-seeded from code after the unset; re-read to show them.
    void refresh()
  }

  /** Expand one row (or collapse it) and seed its prompt draft from the stored spec. */
  const toggleExpand = (row: CouncilRow): void => {
    setStatus(null)
    const next = expandedId === row.id ? null : row.id
    if (next !== null && drafts[row.id] === undefined) {
      setDrafts(prev => ({ ...prev, [row.id]: draftFromSpec(row.spec) }))
    }
    setExpandedId(next)
  }

  /** Update one seat persona in an expanded row's draft. */
  const updateSeatPersona = (councilId: string, seatId: string, persona: string): void => {
    setDrafts((prev) => {
      const draft = prev[councilId]
      if (draft === undefined) return prev
      return {
        ...prev,
        [councilId]: { ...draft, seats: draft.seats.map(seat => seat.id === seatId ? { ...seat, persona } : seat) },
      }
    })
  }

  /** Persist one expanded row's seat personas and chair prompts. */
  const savePrompts = async (row: CouncilRow): Promise<void> => {
    const draft = drafts[row.id]
    if (draft === undefined) return
    setStatus(null)
    setEditBusyId(row.id)
    const previous = rows
    const seats = sanitizeSeats(draft.seats)
    const chairTemplate = { systemPrompt: draft.systemPrompt, userPromptTemplate: draft.userPromptTemplate }
    setRows(current => current?.map(item => item.id === row.id
      ? { ...item, spec: { ...(item.spec ?? {}), seats, chairTemplate } }
      : item) ?? current)
    const reason = await writeFenced([
      { op: 'set', path: ['councils', row.id, 'seats'], value: seats },
      { op: 'set', path: ['councils', row.id, 'chairTemplate'], value: chairTemplate },
    ])
    setEditBusyId(null)
    if (reason !== null) {
      setRows(previous)
      setStatus(reason)
    }
  }

  /** Submit the add-council form; validation failures render in the section status line. */
  const submitAdd = async (): Promise<void> => {
    setStatus(null)
    const id = addId.trim()
    const label = addLabel.trim()
    if (id === '') { setStatus('council id is required'); return }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      setStatus('council id must start alphanumeric and use only letters, digits, ".", "_", "-"')
      return
    }
    if (label === '') { setStatus('council label is required'); return }
    const seats = sanitizeSeats(addSeats)
    if (seats.length === 0) { setStatus('at least one named seat is required'); return }
    if (new Set(seats.map(seat => seat.id)).size !== seats.length) { setStatus('seat ids must be unique'); return }
    const actions = parseCommaList(addActions)
    if (actions.length === 0) { setStatus('at least one action is required'); return }
    let stoppingPolicy: StoppingPolicy
    if (addStopping === 'fixed_epochs') {
      const maxEpochs = Number(addMaxEpochs)
      if (!Number.isInteger(maxEpochs) || maxEpochs < 1) { setStatus('maxEpochs must be a positive integer'); return }
      stoppingPolicy = { type: 'fixed_epochs', maxEpochs }
    } else {
      stoppingPolicy = { type: addStopping }
    }
    const spec: CouncilSpecInput = {
      id,
      label,
      seats,
      ledgerKinds: [{ kind: 'claim', idPrefix: 'C', terminalStatuses: ['invariant', 'falsified'] }],
      actions,
      opening: 'blind',
      deliverableSections: parseCommaList(addSections),
      stoppingPolicy,
      chairTemplate: { systemPrompt: addSystemPrompt, userPromptTemplate: addUserTemplate },
    }
    const previous = rows
    const optimistic: CouncilRow = { id, label, seatCount: seats.length, enabled: true, spec }
    setRows(current => [...(current ?? []).filter(row => row.id !== id), optimistic].sort((a, b) => a.id.localeCompare(b.id)))
    setAddBusy(true)
    const reason = await withWriteTimeout((async (): Promise<string | null> => {
      let result: string | null = null
      for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
        const view = await describeOrchestration()
        if (view === undefined) { result = 'settings service is unavailable'; break }
        const stored = view.value?.councils
        if (stored !== null && stored !== undefined && typeof stored === 'object' && !Array.isArray(stored)
          && (stored as Record<string, unknown>)[id] !== undefined) {
          result = `council id "${id}" already exists`
          break
        }
        const outcome = await postSettingsMutation([{ op: 'set', path: ['councils', id], value: spec }], view.revision)
        if (outcome.ok) { result = null; break }
        if (!outcome.conflict) { result = outcome.reason ?? 'settings write was rejected'; break }
        result = 'settings write conflicted repeatedly'
      }
      return result
    })(), 'settings write timed out')
    setAddBusy(false)
    if (reason !== null) {
      setRows(previous)
      setStatus(reason)
      return
    }
    setAddId('')
    setAddLabel('')
    setAddOpen(false)
  }

  /** Patch one add-form seat row. */
  const updateAddSeat = (index: number, patch: Partial<CouncilSeat>): void => {
    setAddSeats(list => list.map((seat, i) => i === index ? { ...seat, ...patch } : seat))
  }

  return (
    <div className={css.container}>
      <p className={css.hint}>
        {t('councilHintLead')} <code>enpoi-orchestration.councils</code>{t('councilHintTail')}
      </p>
      {listError !== null && (
        <div className={css.errorRow}>
          <span className={css.errorLine} title={listError}>{t('councilUnavailable', { reason: listError })}</span>
          <button type="button" className={css.retryBtn} onClick={() => { void refresh() }}>{t('commonRetry')}</button>
        </div>
      )}
      <div className={css.list}>
        {rows === null && <div className={css.empty}>{t('councilLoading')}</div>}
        {rows !== null && rows.length === 0 && <div className={css.empty}>{t('councilEmpty')}</div>}
        {rows?.map((row) => {
          const expanded = expandedId === row.id
          const draft = drafts[row.id]
          return (
            <div className={css.card} key={row.id}>
              <div className={css.row}>
                <span
                  className={css.dot}
                  title={row.enabled ? t('councilEnabledTitle') : t('councilDisabledTitle')}
                  style={{
                    background: row.enabled ? '#34d399' : '#64748b',
                    boxShadow: row.enabled ? '0 0 5px rgba(52, 211, 153, 0.6)' : 'none',
                  }}
                />
                <div className={css.rowInfo}>
                  <div className={css.rowName}>
                    <span>{row.label}</span>
                    <span className={css.rowId}>{row.id}</span>
                  </div>
                  <div className={css.rowDesc}>
                    {row.seatCount === 1 ? t('councilSeatOne', { count: row.seatCount }) : t('councilSeatMany', { count: row.seatCount })}{row.enabled ? '' : t('councilDisabledSuffix')}
                  </div>
                  {row.error !== undefined && <div className={css.rowError} title={row.error}>{t('councilInvalid', { reason: row.error })}</div>}
                </div>
                <div className={css.rowActions}>
                  <button
                    type="button"
                    className={css.btn}
                    aria-label={row.enabled ? t('councilDisableAria', { label: row.label }) : t('councilEnableAria', { label: row.label })}
                    onClick={() => { void toggleEnabled(row) }}
                  >
                    {row.enabled ? t('commonDisable') : t('commonEnable')}
                  </button>
                  {confirmRemove === row.id ? (
                    <>
                      <span className={css.confirmText}>{t('councilConfirmText')}</span>
                      <button type="button" className={css.confirmBtn} aria-label={t('councilConfirmDeleteAria', { label: row.label })} onClick={() => { void removeCouncil(row) }}>
                        {t('commonDelete')}
                      </button>
                      <button type="button" className={css.btn} onClick={() => { setConfirmRemove(null) }}>{t('commonCancel')}</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={css.removeBtn}
                      aria-label={t('councilDeleteAria', { label: row.label })}
                      title={t('councilUnsetTitle', { id: row.id })}
                      onClick={() => { setStatus(null); setConfirmRemove(row.id) }}
                    >
                      ×
                    </button>
                  )}
                  <button
                    type="button"
                    className={css.expandBtn}
                    aria-label={expanded ? t('councilCollapseAria', { label: row.label }) : t('councilExpandAria', { label: row.label })}
                    aria-expanded={expanded}
                    onClick={() => { toggleExpand(row) }}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                </div>
              </div>
              {expanded && (
                row.spec === undefined || draft === undefined ? (
                  <div className={css.editHint}>
                    {t('councilNoStoredSpec')}
                  </div>
                ) : (
                  <div className={css.editor}>
                    <div className={css.editorLabel}>{t('councilSeatPersonas')}</div>
                    {draft.seats.map(seat => (
                      <label key={seat.id} className={css.field}>
                        <span className={css.fieldLabel}>{seat.label} <span className={css.rowId}>{seat.id}</span></span>
                        <textarea
                          className={css.textarea}
                          rows={2}
                          aria-label={t('councilSeatPersonaAria', { council: row.label, seat: seat.id })}
                          value={seat.persona ?? ''}
                          onChange={(e) => { updateSeatPersona(row.id, seat.id, e.target.value) }}
                        />
                      </label>
                    ))}
                    {draft.seats.length === 0 && <div className={css.editHint}>{t('councilNoSeats')}</div>}
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('councilChairSystem')}</span>
                      <textarea
                        className={css.textarea}
                        rows={3}
                        aria-label={t('councilChairSystemAria', { council: row.label })}
                        value={draft.systemPrompt}
                        onChange={(e) => { setDrafts(prev => ({ ...prev, [row.id]: { ...draft, systemPrompt: e.target.value } })) }}
                      />
                    </label>
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('councilChairUser')}</span>
                      <textarea
                        className={css.textarea}
                        rows={3}
                        aria-label={t('councilChairUserAria', { council: row.label })}
                        value={draft.userPromptTemplate}
                        onChange={(e) => { setDrafts(prev => ({ ...prev, [row.id]: { ...draft, userPromptTemplate: e.target.value } })) }}
                      />
                    </label>
                    <div className={css.addActions}>
                      <button type="button" className={css.addBtn} disabled={editBusyId === row.id} onClick={() => { void savePrompts(row) }}>
                        {editBusyId === row.id ? t('commonSaving') : t('councilSavePrompts')}
                      </button>
                      <button type="button" className={css.btn} onClick={() => { setExpandedId(null) }}>{t('commonClose')}</button>
                    </div>
                  </div>
                )
              )}
            </div>
          )
        })}
      </div>
      <div className={css.addWrap}>
        {addOpen ? (
          <div className={css.addForm}>
            <div className={css.formGrid}>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('councilId')}</span>
                <input className={css.addInput} aria-label={t('councilId')} placeholder="my-council" value={addId} onChange={(e) => { setAddId(e.target.value) }} />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('councilLabel')}</span>
                <input className={css.addInput} aria-label={t('councilLabelAria')} placeholder={t('councilLabelPlaceholder')} value={addLabel} onChange={(e) => { setAddLabel(e.target.value) }} />
              </label>
            </div>
            <div className={css.editorLabel}>{t('councilSeats')}</div>
            {addSeats.map((seat, index) => (
              <div className={css.seatRow} key={index}>
                <input className={css.addInput} aria-label={t('councilSeatIdAria', { index: index + 1 })} placeholder="seat-id" value={seat.id} onChange={(e) => { updateAddSeat(index, { id: e.target.value }) }} />
                <input className={css.addInput} aria-label={t('councilSeatLabelAria', { index: index + 1 })} placeholder={t('councilSeatLabelPlaceholder')} value={seat.label} onChange={(e) => { updateAddSeat(index, { label: e.target.value }) }} />
                <textarea className={css.addInput} rows={2} aria-label={t('councilNewSeatPersonaAria', { index: index + 1 })} placeholder={t('councilSeatPersonaPlaceholder')} value={seat.persona ?? ''} onChange={(e) => { updateAddSeat(index, { persona: e.target.value }) }} />
                {addSeats.length > 1 && (
                  <button type="button" className={css.removeBtn} aria-label={t('councilRemoveSeatAria', { index: index + 1 })} onClick={() => { setAddSeats(list => list.filter((_, i) => i !== index)) }}>×</button>
                )}
              </div>
            ))}
            <button
              type="button"
              className={css.btn}
              onClick={() => { setAddSeats(list => [...list, { id: `seat-${list.length + 1}`, label: t('councilDefaultSeatLabel', { index: list.length + 1 }), persona: '' }]) }}
            >
              {t('councilAddSeat')}
            </button>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('councilActions')}</span>
              <input className={css.addInput} aria-label={t('councilActionsAria')} placeholder={t('councilActionsPlaceholder')} value={addActions} onChange={(e) => { setAddActions(e.target.value) }} />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('councilSections')}</span>
              <input className={css.addInput} aria-label={t('councilSectionsAria')} placeholder={t('councilSectionsPlaceholder')} value={addSections} onChange={(e) => { setAddSections(e.target.value) }} />
            </label>
            <div className={css.formGrid}>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('councilStopping')}</span>
                <select
                  className={css.addInput}
                  aria-label={t('councilStoppingAria')}
                  value={addStopping}
                  onChange={(e) => { setAddStopping(e.target.value as StoppingPolicy['type']) }}
                >
                  <option value="ledger_convergence">ledger_convergence</option>
                  <option value="topological_saturation">topological_saturation</option>
                  <option value="fixed_epochs">fixed_epochs</option>
                </select>
              </label>
              {addStopping === 'fixed_epochs' && (
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('councilMaxEpochs')}</span>
                  <input className={css.addInput} aria-label={t('councilMaxEpochsAria')} inputMode="numeric" value={addMaxEpochs} onChange={(e) => { setAddMaxEpochs(e.target.value) }} />
                </label>
              )}
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('councilChairSystem')}</span>
              <textarea className={css.addInput} rows={2} aria-label={t('councilNewChairSystemAria')} value={addSystemPrompt} onChange={(e) => { setAddSystemPrompt(e.target.value) }} />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('councilChairUser')}</span>
              <textarea className={css.addInput} rows={2} aria-label={t('councilNewChairUserAria')} value={addUserTemplate} onChange={(e) => { setAddUserTemplate(e.target.value) }} />
            </label>
            <div className={css.addActions}>
              <button type="button" className={css.addBtn} disabled={addBusy} onClick={() => { void submitAdd() }}>
                {addBusy ? t('commonAdding') : t('councilAdd')}
              </button>
              <button type="button" className={css.btn} onClick={() => { setAddOpen(false); setStatus(null) }}>{t('commonCancel')}</button>
            </div>
          </div>
        ) : (
          <button type="button" className={css.addBtn} onClick={() => { setAddOpen(true); setStatus(null) }}>
            {t('councilAddCta')}
          </button>
        )}
      </div>
    </div>
  )
}
