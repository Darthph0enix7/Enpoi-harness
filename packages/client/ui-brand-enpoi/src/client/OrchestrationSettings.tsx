/**
 * Orchestration settings section (doc 38) — every tunable orchestration
 * parameter as a Settings-page control. Glass theme, minimalistic monochrome
 * icons, 0ms optimistic updates, hot-swapped by the backend resolvers.
 */
import { useSyncExternalStore, useState } from 'react'
import {
  getOrchestrationParams,
  subscribeOrchestrationParams,
  setOrchestrationParam,
  resetOrchestrationGroup,
  type OrchestrationParams,
} from './params-store.ts'
import css from './OrchestrationSettings.module.css'

/** Minimalistic monochrome stroke icons (currentColor, 1.2-1.3 stroke). */
function Icon({ d, size = 13 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  council: 'M3 13V8m3 5V5m3 8V3m3 10V7',
  keeper: 'M8 2l1.5 4.5H14l-3.5 2.8L11.8 14 8 11.2 4.2 14l1.3-4.7L2 6.5h4.5z',
  memory: 'M3 3h10v10H3zM6 6h4M6 9h4',
  oracle: 'M8 3a5 5 0 100 10A5 5 0 008 3z',
  reset: 'M13 8a5 5 0 11-1.5-3.5M13 2v3h-3',
}

interface ParamRow {
  key: string
  label: string
  hint: string
  /** Boolean toggle row (no min/max). */
  bool?: boolean
  min?: number
  max?: number
  step?: number
  format?: (v: number) => string
}

const COUNCIL_ROWS: ParamRow[] = [
  { key: 'maxDebateTokens', label: 'Token ceiling', hint: 'Cumulative debate safety cap', min: 20_000, max: 500_000, step: 10_000, format: v => `${(v / 1000).toLocaleString()}k` },
  { key: 'defaultMaxRounds', label: 'Max rounds', hint: 'Default safety round cap', min: 1, max: 12 },
  { key: 'defaultHideLimit', label: 'Hide round limits', hint: 'Anti-pacing: models never see the cap', bool: true },
  { key: 'quorumFraction', label: 'Quorum', hint: 'Min fraction of debaters online', min: 0.5, max: 1, step: 0.05, format: v => `${Math.round(v * 100)}%` },
  { key: 'debaterTimeoutMs', label: 'Debater timeout', hint: 'Per-turn timeout', min: 10_000, max: 180_000, step: 5_000, format: v => `${Math.round(v / 1000)}s` },
  { key: 'debaterRetryCount', label: 'Retries', hint: 'Immediate retries per debater', min: 0, max: 3 },
  { key: 'consensusThreshold', label: 'Consensus', hint: 'Ratio that stops the debate', min: 0.5, max: 1, step: 0.05, format: v => v.toFixed(2) },
  { key: 'plateauDeltaThreshold', label: 'Plateau delta', hint: 'Claim delta that stops the debate', min: 0.01, max: 0.2, step: 0.01, format: v => v.toFixed(2) },
]

const KEEPER_ROWS: ParamRow[] = [
  { key: 'leaseMs', label: 'Lease', hint: 'Single-flight lock timeout', min: 15_000, max: 120_000, step: 5_000, format: v => `${Math.round(v / 1000)}s` },
  { key: 'maxInputEvents', label: 'Input events', hint: 'Sliding window of events', min: 20, max: 200 },
  { key: 'maxOutputTokens', label: 'Output tokens', hint: 'Brief length budget', min: 512, max: 4096, step: 128 },
  { key: 'structuralDistanceK', label: 'Freshness K', hint: 'Structural events before re-distill', min: 4, max: 200 },
  { key: 'minRefreshMs', label: 'Min refresh', hint: 'Anti-thrash floor', min: 5_000, max: 300_000, step: 5_000, format: v => `${Math.round(v / 1000)}s` },
  { key: 'negativeCacheMs', label: 'Failure cache', hint: 'Negative-cache window', min: 5_000, max: 600_000, step: 5_000, format: v => `${Math.round(v / 1000)}s` },
  { key: 'claimsBatchSize', label: 'Claims batch', hint: 'Turns per extraction pass', min: 1, max: 50 },
  { key: 'claimsBatchMinutes', label: 'Claims timer', hint: 'Max minutes between passes', min: 1, max: 60 },
]

const MEMORY_ROWS: ParamRow[] = [
  { key: 'retrieverTopK', label: 'Retriever top-K', hint: 'Max facts per search', min: 1, max: 20 },
  { key: 'retrieverCharBudget', label: 'Char budget', hint: 'Max chars per injection', min: 200, max: 4000, step: 100 },
]

const ORACLE_ROWS: ParamRow[] = [
  { key: 'timeoutMs', label: 'Consultation timeout', hint: 'Max wait for a verdict', min: 30_000, max: 300_000, step: 10_000, format: v => `${Math.round(v / 1000)}s` },
]

function Group({
  id,
  title,
  icon,
  rows,
  params,
  onReset,
}: {
  id: keyof OrchestrationParams
  title: string
  icon: string
  rows: ParamRow[]
  params: OrchestrationParams
  onReset: () => void
}) {
  const group = params[id] as Record<string, number | boolean>
  return (
    <section className={css.group}>
      <div className={css.groupHead}>
        <span className={css.groupIcon}><Icon d={icon} /></span>
        <span className={css.groupTitle}>{title}</span>
        <button type="button" className={css.resetBtn} onClick={onReset} title="Reset to defaults">
          <Icon d={ICONS.reset} size={11} />
        </button>
      </div>
      <div className={css.rows}>
        {rows.map(row => {
          const value = group[row.key]
          const isBool = row.bool === true || typeof value === 'boolean'
          return (
            <div className={css.row} key={row.key}>
              <div className={css.rowLabel}>
                <span className={css.rowName}>{row.label}</span>
                <span className={css.rowHint}>{row.hint}</span>
              </div>
              {isBool ? (
                <button
                  type="button"
                  className={`${css.toggle} ${value ? css.toggleOn : ''}`}
                  onClick={() => setOrchestrationParam(id, row.key, !value)}
                  aria-pressed={value === true}
                  title={value === true ? 'On' : 'Off'}
                >
                  <span className={css.toggleKnob} />
                </button>
              ) : (
                <NumberRow id={id} row={row} value={typeof value === 'number' ? value : 0} />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Number row with local draft — persists on blur/Enter (no per-keystroke writes). */
function NumberRow({ id, row, value }: { id: keyof OrchestrationParams; row: ParamRow; value: number }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const raw = Number(draft)
    setDraft(null)
    if (Number.isNaN(raw)) return
    const clamped = Math.min(row.max ?? raw, Math.max(row.min ?? raw, raw))
    setOrchestrationParam(id, row.key, clamped)
  }
  return (
    <div className={css.numWrap}>
      <input
        type="number"
        className={css.numInput}
        value={draft ?? value}
        min={row.min}
        max={row.max}
        step={row.step ?? 1}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
      />
      {row.format !== undefined && (
        <span className={css.numFmt}>{row.format(value)}</span>
      )}
    </div>
  )
}

/** The Orchestration settings section — registered as `settings.section` id 'orchestration'. */
export function OrchestrationSettings(_props: { close: () => void }): React.ReactNode {
  const params = useSyncExternalStore(subscribeOrchestrationParams, getOrchestrationParams)
  return (
    <div className={css.container}>
      <div className={css.intro}>
        <span className={css.introIcon}><Icon d="M8 2l1.5 4.5H14l-3.5 2.8L11.8 14 8 11.2 4.2 14l1.3-4.7L2 6.5h4.5z" size={14} /></span>
        <span>Orchestration parameters — hot-swapped on the next use, no restart needed.</span>
      </div>
      <Group id="council" title="High Council" icon={ICONS.council} rows={COUNCIL_ROWS} params={params}
        onReset={() => resetOrchestrationGroup('council')} />
      <Group id="keeper" title="Context Keeper" icon={ICONS.keeper} rows={KEEPER_ROWS} params={params}
        onReset={() => resetOrchestrationGroup('keeper')} />
      <Group id="memory" title="Memory" icon={ICONS.memory} rows={MEMORY_ROWS} params={params}
        onReset={() => resetOrchestrationGroup('memory')} />
      <Group id="oracle" title="Oracle" icon={ICONS.oracle} rows={ORACLE_ROWS} params={params}
        onReset={() => resetOrchestrationGroup('oracle')} />
    </div>
  )
}