/**
 * Orchestration settings section (doc 38) — every tunable orchestration
 * parameter as a Settings-page control. Glass theme, minimalistic monochrome
 * icons, 0ms optimistic updates, hot-swapped by the backend resolvers.
 */
import { useEffect, useSyncExternalStore, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  getOrchestrationParams,
  subscribeOrchestrationParams,
  setOrchestrationParam,
  resetOrchestrationGroup,
  type OrchestrationParams,
} from './params-store.ts'
import type { CompactionPolicyReadout } from './compaction-policy.ts'
import type { BrandEnpoiKey, BrandT } from './locales.ts'
import css from './OrchestrationSettings.module.css'

/** Injected business face of the Orchestration settings section. */
export interface OrchestrationSettingsInjected {
  /** Effective compaction policy for the selected summariser route. */
  hooks: { compactionPolicy: HostObservable<CompactionPolicyReadout> }
  /** Ensure the model catalog backing the readout is loaded. */
  loadPolicyModels: () => void
}

export type OrchestrationSettingsProps =
  & { close: () => void }
  & PropsLocale<'brandEnpoi'>
  & InjectFace<OrchestrationSettingsInjected>

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
  compaction: 'M3 3h10v10H3zM3 6h10M3 10h4m2 2v3m0 0l-1.5-1.5M9 15l1.5-1.5',
  memory: 'M3 3h10v10H3zM6 6h4M6 9h4',
  oracle: 'M8 3a5 5 0 100 10A5 5 0 008 3z',
  reset: 'M13 8a5 5 0 11-1.5-3.5M13 2v3h-3',
}

interface ParamRow {
  key: string
  labelKey: BrandEnpoiKey
  hintKey: BrandEnpoiKey
  /** Boolean toggle row (no min/max). */
  bool?: boolean
  min?: number
  max?: number
  step?: number
  format?: (v: number) => string
}

const COUNCIL_ROWS: ParamRow[] = [
  { key: 'maxDebateTokens', labelKey: 'orchLabelMaxDebateTokens', hintKey: 'orchHintMaxDebateTokens', min: 20_000, max: 500_000, step: 10_000, format: v => `${(v / 1000).toLocaleString()}k` },
  { key: 'defaultMaxRounds', labelKey: 'orchLabelMaxRounds', hintKey: 'orchHintMaxRounds', min: 1, max: 12 },
  { key: 'defaultHideLimit', labelKey: 'orchLabelHideRoundLimits', hintKey: 'orchHintHideRoundLimits', bool: true },
  { key: 'quorumFraction', labelKey: 'orchLabelQuorum', hintKey: 'orchHintQuorum', min: 0.5, max: 1, step: 0.05, format: v => `${Math.round(v * 100)}%` },
  { key: 'debaterTimeoutMs', labelKey: 'orchLabelDebaterTimeout', hintKey: 'orchHintDebaterTimeout', min: 10_000, max: 180_000, step: 5_000, format: v => `${Math.round(v / 1000)}s` },
  { key: 'debaterRetryCount', labelKey: 'orchLabelRetries', hintKey: 'orchHintRetries', min: 0, max: 3 },
  { key: 'consensusThreshold', labelKey: 'orchLabelConsensus', hintKey: 'orchHintConsensus', min: 0.5, max: 1, step: 0.05, format: v => v.toFixed(2) },
  { key: 'plateauDeltaThreshold', labelKey: 'orchLabelPlateauDelta', hintKey: 'orchHintPlateauDelta', min: 0.01, max: 0.2, step: 0.01, format: v => v.toFixed(2) },
]

const KEEPER_ROWS: ParamRow[] = [
  { key: 'leaseMs', labelKey: 'orchLabelLease', hintKey: 'orchHintLease', min: 15_000, max: 120_000, step: 5_000, format: v => `${Math.round(v / 1000)}s` },
  { key: 'maxInputEvents', labelKey: 'orchLabelInputEvents', hintKey: 'orchHintInputEvents', min: 20, max: 200 },
  { key: 'maxOutputTokens', labelKey: 'orchLabelOutputTokens', hintKey: 'orchHintOutputTokens', min: 512, max: 4096, step: 128 },
  { key: 'structuralDistanceK', labelKey: 'orchLabelFreshnessK', hintKey: 'orchHintFreshnessK', min: 4, max: 200 },
  { key: 'minRefreshMs', labelKey: 'orchLabelMinRefresh', hintKey: 'orchHintMinRefresh', min: 5_000, max: 300_000, step: 5_000, format: v => `${Math.round(v / 1000)}s` },
  { key: 'negativeCacheMs', labelKey: 'orchLabelFailureCache', hintKey: 'orchHintFailureCache', min: 5_000, max: 600_000, step: 5_000, format: v => `${Math.round(v / 1000)}s` },
  { key: 'claimsBatchSize', labelKey: 'orchLabelClaimsBatch', hintKey: 'orchHintClaimsBatch', min: 1, max: 50 },
  { key: 'claimsBatchMinutes', labelKey: 'orchLabelClaimsTimer', hintKey: 'orchHintClaimsTimer', min: 1, max: 60 },
]

const COMPACTION_ROWS: ParamRow[] = [
  { key: 'thresholdRatio', labelKey: 'orchLabelFireAt', hintKey: 'orchHintFireAt', min: 0.05, max: 1, step: 0.01, format: v => `${Math.round(v * 100)}%` },
  { key: 'retainRatio', labelKey: 'orchLabelKeepTail', hintKey: 'orchHintKeepTail', min: 0.01, max: 0.99, step: 0.01, format: v => `${Math.round(v * 100)}%` },
  { key: 'headroomTokens', labelKey: 'orchLabelHeadroom', hintKey: 'orchHintHeadroom', min: 1024, max: 500_000, step: 1024, format: v => `${v.toLocaleString()} tok` },
  { key: 'retainTokens', labelKey: 'orchLabelTailFloor', hintKey: 'orchHintTailFloor', min: 0, max: 500_000, step: 512, format: v => v === 0 ? 'off' : `${v.toLocaleString()} tok` },
  { key: 'pruneThresholdChars', labelKey: 'orchLabelPruneAbove', hintKey: 'orchHintPruneAbove', min: 100, max: 200_000, step: 256, format: v => `${v.toLocaleString()} ch` },
  { key: 'pruneHeadChars', labelKey: 'orchLabelPruneHead', hintKey: 'orchHintPruneHead', min: 0, max: 100_000, step: 128, format: v => `${v.toLocaleString()} ch` },
  { key: 'pruneTailChars', labelKey: 'orchLabelPruneTail', hintKey: 'orchHintPruneTail', min: 0, max: 100_000, step: 128, format: v => `${v.toLocaleString()} ch` },
]

const MEMORY_ROWS: ParamRow[] = [
  { key: 'retrieverTopK', labelKey: 'orchLabelRetrieverTopK', hintKey: 'orchHintRetrieverTopK', min: 1, max: 20 },
  { key: 'retrieverCharBudget', labelKey: 'orchLabelCharBudget', hintKey: 'orchHintCharBudget', min: 200, max: 4000, step: 100 },
]

const ORACLE_ROWS: ParamRow[] = [
  { key: 'timeoutMs', labelKey: 'orchLabelConsultationTimeout', hintKey: 'orchHintConsultationTimeout', min: 30_000, max: 300_000, step: 10_000, format: v => `${Math.round(v / 1000)}s` },
]

function Group({
  id,
  title,
  icon,
  rows,
  params,
  onReset,
  note,
  footer,
  t,
}: {
  id: keyof OrchestrationParams
  title: string
  icon: string
  rows: ParamRow[]
  params: OrchestrationParams
  onReset: () => void
  /** Optional one-line explanation under the header. */
  note?: string
  /** Optional extra content under the rows. */
  footer?: React.ReactNode
  /** Package copy translate for row labels, hints, and the toggle title. */
  t: BrandT
}) {
  const group = params[id] as Record<string, number | boolean>
  return (
    <section className={css.group}>
      <div className={css.groupHead}>
        <span className={css.groupIcon}><Icon d={icon} /></span>
        <span className={css.groupTitle}>{title}</span>
        <button type="button" className={css.resetBtn} onClick={onReset} title={t('orchResetTitle')}>
          <Icon d={ICONS.reset} size={11} />
        </button>
      </div>
      {note !== undefined && <div className={css.groupNote}>{note}</div>}
      <div className={css.rows}>
        {rows.map((row) => {
          const value = group[row.key]
          const isBool = row.bool === true || typeof value === 'boolean'
          return (
            <div className={css.row} key={row.key}>
              <div className={css.rowLabel}>
                <span className={css.rowName}>{t(row.labelKey)}</span>
                <span className={css.rowHint}>{t(row.hintKey)}</span>
              </div>
              {isBool ? (
                <button
                  type="button"
                  className={`${css.toggle} ${value ? css.toggleOn : ''}`}
                  onClick={() => setOrchestrationParam(id, row.key, !value)}
                  aria-pressed={value === true}
                  title={value === true ? t('orchToggleOn') : t('orchToggleOff')}
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
      {footer}
    </section>
  )
}

/** Effective-policy readout: exactly when compaction fires for the selected route. */
function CompactionReadout({ readout, t }: { readout: CompactionPolicyReadout; t: BrandT }) {
  const thresholdTokens = readout.thresholdTokens
  const retainTokens = readout.retainTokens
  const numbers = thresholdTokens !== undefined && retainTokens !== undefined
  return (
    <div className={css.readout}>
      <div className={css.readoutRoute}>
        <span className={css.readoutLabel}>{t('orchEffectivePolicy')}</span>
        <span className={css.readoutValue}>{readout.route}</span>
      </div>
      {numbers ? (
        <div className={css.readoutLine}>
          {t('orchFiresAt', { tokens: thresholdTokens.toLocaleString() })}
          {' · '}{t('orchKeeps', { tokens: retainTokens.toLocaleString() })}
          {readout.contextWindow !== undefined && (
            <span className={css.readoutDim}>{t('orchWindow', { tokens: readout.contextWindow.toLocaleString() })}</span>
          )}
        </div>
      ) : (
        <div className={css.readoutLine}>{readout.problem ?? t('orchWindowUnknown')}</div>
      )}
      {numbers && readout.problem !== undefined && (
        <div className={css.readoutProblem}>{readout.problem}</div>
      )}
    </div>
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
        onKeyDown={(e) => {
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
export function OrchestrationSettings({
  useCompactionPolicy,
  loadPolicyModels,
  t,
}: OrchestrationSettingsProps): React.ReactNode {
  const params = useSyncExternalStore(subscribeOrchestrationParams, getOrchestrationParams)
  const policy = useCompactionPolicy(snapshot => snapshot)
  useEffect(() => { loadPolicyModels() }, [loadPolicyModels])
  return (
    <div className={css.container}>
      <div className={css.intro}>
        <span className={css.introIcon}><Icon d="M8 2l1.5 4.5H14l-3.5 2.8L11.8 14 8 11.2 4.2 14l1.3-4.7L2 6.5h4.5z" size={14} /></span>
        <span>{t('orchIntro')}</span>
      </div>
      <Group id="council" title={t('orchGroupCouncil')} icon={ICONS.council} rows={COUNCIL_ROWS} params={params} t={t}
        onReset={() => resetOrchestrationGroup('council')} />
      <Group id="keeper" title={t('orchGroupKeeper')} icon={ICONS.keeper} rows={KEEPER_ROWS} params={params} t={t}
        onReset={() => resetOrchestrationGroup('keeper')} />
      <Group
        id="compaction"
        title={t('orchGroupCompaction')}
        icon={ICONS.compaction}
        rows={COMPACTION_ROWS}
        params={params}
        t={t}
        onReset={() => resetOrchestrationGroup('compaction')}
        note={t('orchNoteCompaction')}
        footer={<CompactionReadout readout={policy} t={t} />}
      />
      <Group id="memory" title={t('orchGroupMemory')} icon={ICONS.memory} rows={MEMORY_ROWS} params={params} t={t}
        onReset={() => resetOrchestrationGroup('memory')} />
      <Group id="oracle" title={t('orchGroupOracle')} icon={ICONS.oracle} rows={ORACLE_ROWS} params={params} t={t}
        onReset={() => resetOrchestrationGroup('oracle')} />
    </div>
  )
}
