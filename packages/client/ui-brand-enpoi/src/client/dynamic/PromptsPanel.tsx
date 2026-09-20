/**
 * Prompts tab of the Dynamic settings page (doc 59).
 *
 * One place to edit every role persona: rows are the role label plus a persona
 * textarea that writes `enpoi-orchestration.roles.<id>.persona` through the
 * same 0ms optimistic / revision-fenced writer as the Roles tab — a built-in
 * role with no settings entry gets an override entry on first save. Below it,
 * where council prompts live is shown read-only: each registered council's
 * seats and chair template. Council prompts are Edited in Councils; this tab
 * never writes them.
 */
import { useMemo, useState, useSyncExternalStore } from 'react'
import { titleCaseRoleId } from '../role-registry.ts'
import {
  DraftTextarea,
  buildRoleRows,
  editRole,
  getRoleSettings,
  subscribeRoleSettings,
  withoutRoleKey,
} from './RolesPanel.tsx'
import css from './RolesPanel.module.css'

/** CSS-module reads are `string | undefined` under noUncheckedIndexedAccess; keys are static. */
function c(name: string): string {
  return css[name] ?? ''
}

/** One read-only council row: label, seat names, and the chair template text when present. */
interface CouncilRow {
  id: string
  label: string
  seats: string[]
  systemPrompt?: string
  userPromptTemplate?: string
}

/** Read one seat's display name from a seat entry (string, or an object with a name-ish field). */
function seatName(seat: unknown): string | undefined {
  if (typeof seat === 'string') return seat.trim() === '' ? undefined : seat
  if (seat !== null && typeof seat === 'object' && !Array.isArray(seat)) {
    const record = seat as Record<string, unknown>
    for (const key of ['label', 'id', 'role', 'name']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  return undefined
}

/** Read one optional string field from a plain record. */
function recordText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Read the councils registry tolerantly: the writer is the councils lane, so
 * unknown fields are ignored and a malformed entry is skipped.
 * @param raw - the raw `enpoi-orchestration.councils` value.
 * @returns the read-only council rows.
 */
function buildCouncilRows(raw: unknown): CouncilRow[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const rows: CouncilRow[] = []
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const seatList = Array.isArray(entry.seats) ? entry.seats : Array.isArray(entry.members) ? entry.members : []
    const seats = seatList.map(seatName).filter((seat): seat is string => seat !== undefined)
    const label = typeof entry.label === 'string' && entry.label !== '' ? entry.label : titleCaseRoleId(id)
    const chair = entry.chairTemplate !== null && typeof entry.chairTemplate === 'object' && !Array.isArray(entry.chairTemplate)
      ? entry.chairTemplate as Record<string, unknown>
      : (entry.chair !== null && typeof entry.chair === 'object' && !Array.isArray(entry.chair)
        ? entry.chair as Record<string, unknown>
        : undefined)
    const systemPrompt = chair === undefined ? undefined : recordText(chair, 'systemPrompt') ?? recordText(chair, 'template')
    const userPromptTemplate = chair === undefined ? undefined : recordText(chair, 'userPromptTemplate') ?? recordText(chair, 'prompt')
    const row: CouncilRow = { id, label, seats }
    if (systemPrompt !== undefined) row.systemPrompt = systemPrompt
    if (userPromptTemplate !== undefined) row.userPromptTemplate = userPromptTemplate
    rows.push(row)
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id))
}

/** Prompts tab: role personas (writable) over read-only council prompt locations. */
export function PromptsPanel() {
  const snapshot = useSyncExternalStore(subscribeRoleSettings, getRoleSettings)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => buildRoleRows(snapshot.roles).filter(row => !row.retired), [snapshot.roles])
  const councils = useMemo(() => buildCouncilRows(snapshot.councils), [snapshot.councils])

  /** Write one role persona through the shared optimistic/fenced writer. */
  const commitPersona = (id: string, next: string): void => {
    setError(null)
    editRole(id, fresh => next.trim() === ''
      ? withoutRoleKey(fresh, 'persona')
      : { ...fresh, persona: next }, setError)
  }

  return (
    <div className={c('wrap')}>
      <p className={c('hint')}>
        Role personas write <code>enpoi-orchestration.roles.&lt;id&gt;.persona</code>; a built-in role gets an
        override entry on first save. Seat models are assigned in Agent Models.
      </p>
      {error !== null && <p className={c('error')} role="alert">{error}</p>}
      <section className={c('group')}>
        <header className={c('groupHead')}>ROLE PERSONAS</header>
        <div className={c('rows')}>
          {rows.map((row) => {
            const label = row.entry.label !== undefined && row.entry.label !== ''
              ? row.entry.label
              : titleCaseRoleId(row.id)
            return (
              <div key={row.id} className={c('promptRow')}>
                <div className={c('promptHead')}>
                  <span className={c('rowName')}>{label}</span>
                  <span className={c('rowId')}>{row.id}</span>
                  {row.builtIn && <span className={c('tag')}>built-in</span>}
                </div>
                <DraftTextarea
                  value={row.entry.persona ?? ''}
                  label={`Persona for ${label}`}
                  placeholder="Code default"
                  onCommit={(next) => { commitPersona(row.id, next) }}
                />
              </div>
            )
          })}
        </div>
      </section>
      <section className={c('group')}>
        <header className={c('groupHead')}>
          COUNCIL PROMPTS
          <span className={c('tag')}>Edited in Councils</span>
        </header>
        <div className={c('rows')}>
          {councils.length === 0 && <p className={c('empty')}>No councils registered.</p>}
          {councils.map(council => (
            <div key={council.id} className={c('promptRow')}>
              <div className={c('promptHead')}>
                <span className={c('rowName')}>{council.label}</span>
                <span className={c('rowId')}>{council.id}</span>
              </div>
              <p className={c('councilMeta')}>
                Seats: {council.seats.length > 0 ? council.seats.join(', ') : 'none registered'}
              </p>
              <p className={c('templateText')}>
                Chair system prompt: {council.systemPrompt ?? 'none'}
              </p>
              <p className={c('templateText')}>
                Chair user template: {council.userPromptTemplate ?? 'none'}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
