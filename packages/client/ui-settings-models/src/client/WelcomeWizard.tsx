/**
 * First-run welcome overlay: the approved seven-step flow rendered over the
 * real application. Steps read real state (the provider directory, the
 * analysis run) and write real settings through the Models operations; any
 * step can be skipped and the harness stays usable. The overlay shows once,
 * gated by `onboardingCompleted`, and the Setup settings section reopens it.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsSettingsState, ModelsSettingsStore, ModelsWire } from './store.ts'
import { protocolChoices } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { AddProviderModal } from './AddProviderModal.tsx'
import {
  WIZARD_STEPS, intelligenceWrites, sandboxWrite, skippedSteps,
  type IntelligenceChoice, type SandboxMode, type WizardStepId, type WizardWrite,
} from './welcome-wizard.ts'
import type { WelcomeWizardState, WelcomeWizardStore } from './welcome-wizard.ts'
import type { en } from './locales.ts'
import styles from './WelcomeWizard.module.css'

/** Registration-side dependencies of {@link WelcomeWizard}. */
export interface WelcomeWizardInjected {
  hooks: {
    /** Wizard state machine, gating, and analysis progress. */
    wizard: SnapshotStore<WelcomeWizardState>
    /** Shared Models-page join state (the real provider catalogue). */
    models: SnapshotStore<ModelsSettingsState>
  }
  /** Wizard controller. */
  store: WelcomeWizardStore
  /** Shared Models-page join controller. */
  modelsController: ModelsSettingsStore
  /** Real settings and discovery operations. */
  operations: ModelsOperations
  /** The Models wire faces the embedded Add Provider modal calls. */
  api: ModelsWire
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Feature copy. */
  t: (key: keyof typeof en) => string
}

/** Overlay owner props plus this feature's injected dependencies. */
export type WelcomeWizardProps = PropsRuntime<'settings.onboarding'> & InjectFace<WelcomeWizardInjected>

/** The five tour stops: label key, body key, and the real surface selector. */
const TOUR_STOPS = [
  { title: 'wizTourStopSidebar', body: 'wizTourStopSidebarBody', target: '[data-dsh-tour="rightbar"]' },
  { title: 'wizTourStopSettings', body: 'wizTourStopSettingsBody', target: '[data-dsh-tour="settings"]' },
  { title: 'wizTourStopPlugins', body: 'wizTourStopPluginsBody', target: '[data-dsh-tour="plugins"]' },
  { title: 'wizTourStopComposer', body: 'wizTourStopComposerBody', target: '[data-dsh-tour="composer"]' },
  { title: 'wizTourStopContext', body: 'wizTourStopContextBody', target: '[data-dsh-tour="context"]' },
] as const

const SANDBOX_OPTIONS: ReadonlyArray<{ mode: SandboxMode; title: keyof typeof en; body: keyof typeof en }> = [
  { mode: 'read-only', title: 'wizSandboxReadOnly', body: 'wizSandboxReadOnlyBody' },
  { mode: 'workspace-write', title: 'wizSandboxWrite', body: 'wizSandboxWriteBody' },
  { mode: 'danger-full-access', title: 'wizSandboxFull', body: 'wizSandboxFullBody' },
]

/** Run one step's writes and report whether every write was accepted. */
async function applyWrites(operations: ModelsOperations, writes: readonly WizardWrite[]): Promise<boolean> {
  for (const write of writes) {
    const outcome = await operations.writeSettings(write.ns, write.ops, undefined)
    if (outcome.kind !== 'written') return false
  }
  return true
}

/** The seven-step overlay. */
export function WelcomeWizard(props: WelcomeWizardProps): ReactNode {
  const { complete, useWizard, useModels, store, modelsController, operations, api, schema, t } = props
  const state = useWizard(snapshot => snapshot)
  const models = useModels(snapshot => snapshot)
  const [sandbox, setSandbox] = useState<SandboxMode>('workspace-write')
  const [choice, setChoice] = useState<IntelligenceChoice>({ compaction: true, keeper: true, whiteboard: true })
  const [compactionLlm, setCompactionLlm] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [stop, setStop] = useState(0)

  useEffect(() => {
    if (state.status === 'idle') void store.load()
  }, [store, state.status])

  useEffect(() => {
    if (models.status === 'idle') void modelsController.load()
  }, [modelsController, models.status])

  // A completed installation releases the coordinator's slot immediately; a
  // step still deciding renders nothing and blocks nothing.
  useEffect(() => {
    if (state.status === 'ready' && !state.visible) complete()
  }, [complete, state.status, state.visible])

  const kilo = useMemo(
    () => models.rows.find(row => row.entry.provider === 'kilo'),
    [models.rows],
  )
  const taken = useMemo(() => models.rows.map(row => row.entry.provider), [models.rows])
  const protocols = useMemo(() => protocolChoices(models.namespaces.get('llm-pi-ai'), schema), [models.namespaces, schema])

  if (!state.visible) return null

  const wizard = state.wizard
  const step = wizard.step
  const stepIndex = WIZARD_STEPS.indexOf(step)
  const canGoBack = stepIndex > 0 && step !== 'done'

  const finish = (): void => {
    void store.finish().then(() => { store.close() })
  }
  const continueStep = (): void => { store.dispatch({ type: 'continue' }) }

  const securityContinue = (): void => {
    void applyWrites(operations, [sandboxWrite(sandbox)]).then((written) => {
      if (written) store.dispatch({ type: 'configured' })
      continueStep()
    })
  }
  const intelligenceContinue = (): void => {
    const effective: IntelligenceChoice = { ...choice, compaction: choice.compaction && compactionLlm }
    void applyWrites(operations, intelligenceWrites(effective)).then((written) => {
      if (written) store.dispatch({ type: 'configured' })
      continueStep()
    })
  }
  const agentsAnalyse = (): void => {
    store.dispatch({ type: 'configured' })
    void store.startAnalysis()
    continueStep()
  }

  return (
    <div className={styles.backdrop} role="presentation">
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('wizTitle')}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (step === 'done') finish()
            else if (step === 'tour') store.dispatch({ type: 'skip-tour' })
            else store.dispatch({ type: 'skip' })
          }
          if (event.key === 'ArrowRight' && step !== 'done') continueStep()
          if (event.key === 'ArrowLeft' && canGoBack) store.dispatch({ type: 'goto', step: WIZARD_STEPS[stepIndex - 1] ?? 'welcome' })
        }}
      >
        <nav className={styles.rail} aria-label={t('wizSteps')}>
          {WIZARD_STEPS.map((id, index) => {
            const stepState = wizard.states[id]
            return (
              <button
                key={id}
                type="button"
                className={styles.railItem}
                data-state={stepState}
                data-active={id === step}
                aria-label={t(stepNameKey(id))}
                onClick={() => { store.dispatch({ type: 'goto', step: id }) }}
              >
                <span className={styles.railIndex}>{index + 1}</span>
                <span className={styles.railLabel}>{t(stepNameKey(id))}</span>
              </button>
            )
          })}
        </nav>

        <div className={styles.panel}>
          <p className={styles.eyebrow}>{t('wizEyebrow').replace('{n}', String(stepIndex + 1)).replace('{name}', t(stepNameKey(step)))}</p>
          {step === 'welcome' && (
            <WelcomeStep t={t} onContinue={continueStep} onSkipAll={() => { store.skipWholeTour() }} />
          )}
          {step === 'security' && (
            <SecurityStep t={t} mode={sandbox} onMode={setSandbox} onContinue={securityContinue} onBack={() => { store.dispatch({ type: 'goto', step: 'welcome' }) }} />
          )}
          {step === 'provider' && (
            <ProviderStep
              t={t}
              installed={kilo !== undefined}
              configured={kilo?.configured === true}
              onAdd={() => { setAddOpen(true) }}
              onContinue={continueStep}
              onBack={() => { store.dispatch({ type: 'goto', step: 'security' }) }}
            />
          )}
          {step === 'intelligence' && (
            <IntelligenceStep
              t={t}
              choice={choice}
              onChoice={setChoice}
              compactionLlm={compactionLlm}
              onCompactionLlm={setCompactionLlm}
              onContinue={intelligenceContinue}
              onBack={() => { store.dispatch({ type: 'goto', step: 'provider' }) }}
            />
          )}
          {step === 'tour' && (
            <TourStep
              t={t}
              stop={stop}
              onStop={setStop}
              onStart={() => { setStop(0) }}
              onFinish={() => { store.dispatch({ type: 'configured' }); store.dispatch({ type: 'continue' }) }}
              onSkip={() => { store.dispatch({ type: 'skip-tour' }) }}
            />
          )}
          {step === 'agents' && (
            <AgentsStep t={t} analysis={state.analysis} onAnalyse={agentsAnalyse} onSkip={() => { store.dispatch({ type: 'skip' }) }} />
          )}
          {step === 'done' && (
            <DoneStep
              t={t}
              skipped={skippedSteps(wizard)}
              analysis={state.analysis}
              error={state.error}
              saving={state.status === 'saving'}
              onFinish={finish}
              onReplay={() => { store.dispatch({ type: 'restart' }) }}
            />
          )}

          {state.analysis !== null && state.analysis !== undefined && step !== 'done' && (
            <AnalysisDock t={t} analysis={state.analysis} />
          )}
        </div>

        <AddProviderModal
          open={addOpen}
          taken={taken}
          protocols={protocols}
          api={api}
          t={t}
          readOnly={false}
          onClose={(created) => {
            setAddOpen(false)
            void modelsController.load()
            if (created === true) store.dispatch({ type: 'configured' })
          }}
        />
      </section>
    </div>
  )
}

/** Locale key for one step name. */
function stepNameKey(id: WizardStepId): keyof typeof en {
  switch (id) {
    case 'welcome': return 'wizNameWelcome'
    case 'security': return 'wizNameSecurity'
    case 'provider': return 'wizNameProvider'
    case 'intelligence': return 'wizNameIntelligence'
    case 'tour': return 'wizNameTour'
    case 'agents': return 'wizNameAgents'
    case 'done': return 'wizNameDone'
    /* v8 ignore next -- closed union; every step id is handled above */
    default: return 'wizNameWelcome'
  }
}

type T = (key: keyof typeof en) => string

function WelcomeStep({ t, onContinue, onSkipAll }: { t: T; onContinue: () => void; onSkipAll: () => void }): ReactNode {
  return (
    <div className={styles.step}>
      <h2 className={styles.heading}>{t('wizTitle')}</h2>
      <p className={styles.lead}>{t('wizWelcomeLead')}</p>
      <div className={styles.cards}>
        <div className={styles.card}><h3>{t('wizCardOneTitle')}</h3><p>{t('wizCardOneBody')}</p></div>
        <div className={styles.card}><h3>{t('wizCardTwoTitle')}</h3><p>{t('wizCardTwoBody')}</p></div>
        <div className={styles.card}><h3>{t('wizCardThreeTitle')}</h3><p>{t('wizCardThreeBody')}</p></div>
      </div>
      <p className={styles.fineprint}>{t('wizWelcomeFineprint')}</p>
      <div className={styles.actions}>
        <Button variant="primary" onClick={onContinue}>{t('wizStart')}</Button>
        <Button onClick={onSkipAll}>{t('wizSkipTour')}</Button>
      </div>
    </div>
  )
}

function SecurityStep({ t, mode, onMode, onContinue, onBack }: {
  t: T
  mode: SandboxMode
  onMode: (mode: SandboxMode) => void
  onContinue: () => void
  onBack: () => void
}): ReactNode {
  return (
    <div className={styles.step}>
      <h2 className={styles.heading}>{t('wizSecurityHeading')}</h2>
      <div className={styles.cards}>
        <div className={styles.card}><h3>{t('wizLoopbackTitle')}</h3><p>{t('wizLoopbackBody')}</p></div>
        <div className={styles.card}><h3>{t('wizTrustedTitle')}</h3><p>{t('wizTrustedBody')}</p></div>
      </div>
      <h3 className={styles.subhead}>{t('wizSandboxSubhead')}</h3>
      <div className={styles.radios} role="radiogroup" aria-label={t('wizSandboxSubhead')}>
        {SANDBOX_OPTIONS.map(option => (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={mode === option.mode}
            className={styles.radio}
            data-active={mode === option.mode}
            onClick={() => { onMode(option.mode) }}
          >
            <strong>{t(option.title)}</strong>
            <span>{t(option.body)}</span>
          </button>
        ))}
      </div>
      <p className={styles.fineprint}>{t('wizSandboxFineprint')}</p>
      <div className={styles.actions}>
        <Button onClick={onBack}>{t('wizBack')}</Button>
        <Button variant="primary" onClick={onContinue}>{t('wizContinue')}</Button>
      </div>
    </div>
  )
}

function ProviderStep({ t, installed, configured, onAdd, onContinue, onBack }: {
  t: T
  installed: boolean
  configured: boolean
  onAdd: () => void
  onContinue: () => void
  onBack: () => void
}): ReactNode {
  return (
    <div className={styles.step}>
      <h2 className={styles.heading}>{t('wizProviderHeading')}</h2>
      <p className={styles.lead}>{t('wizProviderLead')}</p>
      <div className={styles.route} data-state={configured ? 'configured' : installed ? 'installed' : 'missing'}>
        <strong>{configured ? t('wizProviderConfigured') : installed ? t('wizProviderInstalled') : t('wizProviderMissing')}</strong>
        <span>{t('wizProviderRoute')}</span>
        <span>{t('wizProviderFree')}</span>
      </div>
      <p className={styles.fineprint}>{t('wizProviderFineprint')}</p>
      <div className={styles.actions}>
        <Button onClick={onBack}>{t('wizBack')}</Button>
        <Button variant="primary" onClick={onAdd}>{t('wizProviderAdd')}</Button>
        <Button onClick={onContinue}>{t('wizContinue')}</Button>
      </div>
    </div>
  )
}

function IntelligenceStep({ t, choice, onChoice, compactionLlm, onCompactionLlm, onContinue, onBack }: {
  t: T
  choice: IntelligenceChoice
  onChoice: (choice: IntelligenceChoice) => void
  compactionLlm: boolean
  onCompactionLlm: (value: boolean) => void
  onContinue: () => void
  onBack: () => void
}): ReactNode {
  const allOff = !choice.compaction && !choice.keeper && !choice.whiteboard
  return (
    <div className={styles.step}>
      <h2 className={styles.heading}>{t('wizIntelligenceHeading')}</h2>
      <p className={styles.lead}>{t('wizIntelligenceLead')}</p>
      <div className={styles.toggles}>
        <Toggle
          title={t('wizCompactionTitle')}
          sub={t('wizCompactionSub')}
          on={choice.compaction}
          onToggle={() => { onChoice({ ...choice, compaction: !choice.compaction }) }}
          chip={compactionLlm ? t('wizCompactionChipLlm') : t('wizCompactionChipMechanical')}
        >
          <div className={styles.segments} role="radiogroup" aria-label={t('wizCompactionTitle')}>
            <button type="button" role="radio" aria-checked={compactionLlm} data-active={compactionLlm} onClick={() => { onCompactionLlm(true) }}>{t('wizCompactionLlm')}</button>
            <button type="button" role="radio" aria-checked={!compactionLlm} data-active={!compactionLlm} onClick={() => { onCompactionLlm(false) }}>{t('wizCompactionMechanical')}</button>
          </div>
        </Toggle>
        <Toggle
          title={t('wizKeeperTitle')}
          sub={t('wizKeeperSub')}
          on={choice.keeper}
          onToggle={() => { onChoice({ ...choice, keeper: !choice.keeper }) }}
          chip={t('wizKeeperChip')}
        />
        <Toggle
          title={t('wizWhiteboardTitle')}
          sub={t('wizWhiteboardSub')}
          on={choice.whiteboard}
          onToggle={() => { onChoice({ ...choice, whiteboard: !choice.whiteboard }) }}
          chip={t('wizWhiteboardChip')}
        />
      </div>
      <p className={styles.fineprint}>{t('wizIntelligenceFineprint')}</p>
      <div className={styles.actions}>
        <Button onClick={onBack}>{t('wizBack')}</Button>
        <Button variant="primary" onClick={onContinue}>{allOff ? t('wizContinueOff') : t('wizContinue')}</Button>
      </div>
    </div>
  )
}

function Toggle({ title, sub, on, onToggle, chip, children }: {
  title: string
  sub: string
  on: boolean
  onToggle: () => void
  chip: string
  children?: ReactNode
}): ReactNode {
  return (
    <div className={styles.toggle} data-on={on}>
      <div className={styles.toggleHead}>
        <strong>{title}</strong>
        <button type="button" role="switch" aria-checked={on} aria-label={title} className={styles.switch} onClick={onToggle}>
          <span className={styles.knob} />
        </button>
      </div>
      <p>{sub}</p>
      <span className={styles.chip}>{chip}</span>
      {on && children !== undefined ? children : null}
    </div>
  )
}

function TourStep({ t, stop, onStop, onStart, onFinish, onSkip }: {
  t: T
  stop: number
  onStop: (stop: number) => void
  onStart: () => void
  onFinish: () => void
  onSkip: () => void
}): ReactNode {
  const [started, setStarted] = useState(false)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const current = TOUR_STOPS[stop] ?? TOUR_STOPS[0]
  useEffect(() => {
    if (!started) return
    const target = document.querySelector(current.target)
    if (target === null) {
      setRect(null)
      return
    }
    const box = target.getBoundingClientRect()
    setRect({ left: box.left, top: box.top, width: box.width, height: box.height })
  }, [started, stop, current])
  if (!started) {
    return (
      <div className={styles.step}>
        <h2 className={styles.heading}>{t('wizTourHeading')}</h2>
        <p className={styles.lead}>{t('wizTourLead')}</p>
        <p className={styles.fineprint}>{t('wizTourFineprint')}</p>
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => { onStart(); setStarted(true) }}>{t('wizTourStart')}</Button>
          <Button onClick={onSkip}>{t('wizSkipTour')}</Button>
        </div>
      </div>
    )
  }
  return (
    <div className={styles.step}>
      {rect === null ? null : (
        <div
          className={styles.spotlight}
          style={{ left: rect.left - 8, top: rect.top - 8, width: rect.width + 16, height: rect.height + 16 }}
        />
      )}
      <div className={styles.tip}>
        <p className={styles.eyebrow}>{t('wizTourStop').replace('{n}', String(stop + 1)).replace('{total}', String(TOUR_STOPS.length))}</p>
        <h2 className={styles.heading}>{t(current.title)}</h2>
        <p>{t(current.body)}</p>
        <div className={styles.actions}>
          <Button disabled={stop === 0} onClick={() => { onStop(Math.max(0, stop - 1)) }}>{t('wizBack')}</Button>
          {stop < TOUR_STOPS.length - 1
            ? <Button variant="primary" onClick={() => { onStop(stop + 1) }}>{t('wizNext')}</Button>
            : <Button variant="primary" onClick={onFinish}>{t('wizTourFinish')}</Button>}
          <Button onClick={onSkip}>{t('wizSkipTour')}</Button>
        </div>
      </div>
    </div>
  )
}

function AgentsStep({ t, analysis, onAnalyse, onSkip }: {
  t: T
  analysis: WelcomeWizardState['analysis']
  onAnalyse: () => void
  onSkip: () => void
}): ReactNode {
  return (
    <div className={styles.step}>
      <h2 className={styles.heading}>{t('wizAgentsHeading')}</h2>
      <p className={styles.lead}>{t('wizAgentsLead')}</p>
      <div className={styles.cards}>
        <div className={styles.card} data-agent="orchestrator"><h3>{t('wizAgentOrchestrator')}</h3><p>{t('wizAgentOrchestratorBody')}</p></div>
        <div className={styles.card} data-agent="sysadmin"><h3>{t('wizAgentSysadmin')}</h3><p>{t('wizAgentSysadminBody')}</p></div>
        <div className={styles.card} data-agent="creator"><h3>{t('wizAgentCreator')}</h3><p>{t('wizAgentCreatorBody')}</p></div>
      </div>
      <div className={styles.offer}>
        <h3>{t('wizAnalyseTitle')}</h3>
        <p>{t('wizAnalyseBody')}</p>
        {analysis !== null && analysis !== undefined
          ? <p className={styles.fineprint}>{t('wizAnalyseRunning')}</p>
          : (
            <div className={styles.actions}>
              <Button variant="primary" onClick={onAnalyse}>{t('wizAnalyseStart')}</Button>
              <Button onClick={onSkip}>{t('wizAnalyseSkip')}</Button>
            </div>
          )}
      </div>
    </div>
  )
}

function AnalysisDock({ t, analysis }: { t: T; analysis: NonNullable<WelcomeWizardState['analysis']> }): ReactNode {
  const label = analysis.state === 'running'
    ? t('wizAnalysisRunning')
    : analysis.state === 'succeeded'
      ? t('wizAnalysisReady')
        .replace('{threads}', String(analysis.summary?.threads ?? 0))
        .replace('{memory}', String(analysis.summary?.memoryGiB ?? 0))
        .replace('{services}', String(analysis.summary?.services ?? 0))
      : analysis.state === 'failed'
        ? `${t('wizAnalysisFailed')}: ${analysis.error ?? ''}`
        : ''
  return (
    <div className={styles.dock} data-state={analysis.state} role="status">
      <strong>{t('wizAnalysisDock')}</strong>
      <span>{label}</span>
      <progress max={100} value={analysis.pct} />
    </div>
  )
}

function DoneStep({ t, skipped, analysis, error, saving, onFinish, onReplay }: {
  t: T
  skipped: readonly WizardStepId[]
  analysis: WelcomeWizardState['analysis']
  error: string | null
  saving: boolean
  onFinish: () => void
  onReplay: () => void
}): ReactNode {
  const skippedLine = (id: WizardStepId): keyof typeof en => {
    switch (id) {
      case 'security': return 'wizSkippedSecurity'
      case 'provider': return 'wizSkippedProvider'
      case 'intelligence': return 'wizSkippedIntelligence'
      case 'tour': return 'wizSkippedTour'
      case 'agents': return 'wizSkippedAgents'
      /* v8 ignore next 2 -- welcome and done never reach the Done page's skip list */
      default: return 'wizSkippedSecurity'
    }
  }
  return (
    <div className={styles.step}>
      <h2 className={styles.heading}>{t('wizDoneHeading')}</h2>
      <p className={styles.lead}>{skipped.length === 0 ? t('wizDoneLeadNoSkips') : t('wizDoneLeadSkips')}</p>
      {skipped.length > 0 && (
        <div className={styles.card}>
          <h3>{t('wizDoneSkippedCard').replace('{n}', String(skipped.length))}</h3>
          <ul>{skipped.map(id => <li key={id}>{t(skippedLine(id))}</li>)}</ul>
        </div>
      )}
      <div className={styles.card}>
        <h3>{t('wizDoneCreatorTitle')}</h3>
        <p>{t('wizDoneCreatorBody')}</p>
      </div>
      {analysis?.state === 'running' ? <p className={styles.fineprint}>{t('wizAnalyseRunning')}</p> : null}
      {error === null ? null : <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <Button variant="primary" disabled={saving} onClick={onFinish}>{t('wizFinish')}</Button>
        <Button onClick={onReplay}>{t('wizReplay')}</Button>
      </div>
    </div>
  )
}
