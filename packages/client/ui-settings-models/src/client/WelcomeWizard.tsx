/**
 * First-run welcome overlay: the approved seven-step flow rendered over the
 * real application. Steps read real state (the provider directory, the
 * analysis run) and write real settings through the Models operations; any
 * step can be skipped and the harness stays usable. The overlay shows once,
 * gated by `onboardingCompleted`, and the Setup settings section reopens it.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

/**
 * The five tour stops: label key, body key, the real surface selector, and
 * where the tip reads relative to the spotlighted surface.
 */
const TOUR_STOPS = [
  { title: 'wizTourStopSidebar', body: 'wizTourStopSidebarBody', target: '[data-dsh-tour="rightbar"]', place: 'left' },
  { title: 'wizTourStopSettings', body: 'wizTourStopSettingsBody', target: '[data-dsh-tour="settings"]', place: 'right' },
  { title: 'wizTourStopPlugins', body: 'wizTourStopPluginsBody', target: '[data-dsh-tour="plugins"]', place: 'right' },
  { title: 'wizTourStopComposer', body: 'wizTourStopComposerBody', target: '[data-dsh-tour="composer"]', place: 'top' },
  { title: 'wizTourStopContext', body: 'wizTourStopContextBody', target: '[data-dsh-tour="context"]', place: 'right' },
] as const

/** One viewport rectangle the spotlight and tip position from. */
interface TourRect {
  left: number
  top: number
  width: number
  height: number
}

/** Padding the spotlight leaves around the real target. */
const TOUR_PAD = 8

/** Distance between the spotlight edge and the tip card. */
const TIP_MARGIN = 14

const SANDBOX_OPTIONS: ReadonlyArray<{ mode: SandboxMode; title: keyof typeof en; body: keyof typeof en }> = [
  { mode: 'read-only', title: 'wizSandboxReadOnly', body: 'wizSandboxReadOnlyBody' },
  { mode: 'workspace-write', title: 'wizSandboxWrite', body: 'wizSandboxWriteBody' },
  { mode: 'danger-full-access', title: 'wizSandboxFull', body: 'wizSandboxFullBody' },
]

/** Run one step's writes and return the first refusal message, or null. */
async function applyWrites(operations: ModelsOperations, writes: readonly WizardWrite[]): Promise<string | null> {
  for (const write of writes) {
    const outcome = await operations.writeSettings(write.ns, write.ops, undefined)
    if (outcome.kind !== 'written') return outcome.message
  }
  return null
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
  // The tour is its own overlay layer: while it runs the wizard dialog is not
  // rendered at all, so exactly one layer owns the screen.
  const [tourStarted, setTourStarted] = useState(false)

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
  // Rows the provider step renders: a route the add just wrote appears here as
  // soon as the awaited refresh lands, without a page reload.
  const configuredProviders = useMemo(
    () => models.rows
      .filter(row => row.configured || row.entry.active)
      .map(row => ({ id: row.entry.provider, name: row.entry.displayName, configured: row.configured })),
    [models.rows],
  )
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

  /** Persist one step's writes without holding the step transition; a refusal
   * surfaces as a non-blocking alert while the wizard keeps its new step. */
  const persistWrites = (writes: readonly WizardWrite[]): void => {
    void applyWrites(operations, writes).then((failure) => {
      if (failure !== null) store.noteWriteFailure(failure)
    })
  }
  const securityContinue = (): void => {
    store.dispatch({ type: 'configured' })
    continueStep()
    persistWrites([sandboxWrite(sandbox)])
  }
  const intelligenceContinue = (): void => {
    const effective: IntelligenceChoice = { ...choice, compaction: choice.compaction && compactionLlm }
    store.dispatch({ type: 'configured' })
    continueStep()
    persistWrites(intelligenceWrites(effective))
  }
  const agentsAnalyse = (): void => {
    store.dispatch({ type: 'configured' })
    void store.startAnalysis()
    continueStep()
  }

  // The tour layer replaces the wizard dialog for as long as it runs.
  if (step === 'tour' && tourStarted) {
    return (
      <TourOverlay
        t={t}
        stop={stop}
        stepNumber={WIZARD_STEPS.indexOf('tour') + 1}
        stepCount={WIZARD_STEPS.length}
        onStop={setStop}
        onBack={() => { setTourStarted(false) }}
        onFinish={() => {
          setTourStarted(false)
          store.dispatch({ type: 'configured' })
          store.dispatch({ type: 'continue' })
        }}
        onSkip={() => {
          setTourStarted(false)
          store.dispatch({ type: 'skip-tour' })
        }}
      />
    )
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
              providers={configuredProviders}
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
              onStart={() => { setStop(0); setTourStarted(true) }}
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

          {state.error !== null && step !== 'done' && (
            <p className={styles.error} role="alert" data-wiz-write-error>{state.error}</p>
          )}

          {state.analysis !== null && state.analysis !== undefined && (
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
          onClose={async (created) => {
            // The modal stays up until the provider panel behind it carries
            // the new route, so the result is visible when the form closes.
            try {
              if (created) await modelsController.load()
            } finally {
              setAddOpen(false)
            }
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

function ProviderStep({ t, providers, installed, configured, onAdd, onContinue, onBack }: {
  t: T
  /** Live routes the panel lists; the step's own add refreshes this list. */
  providers: readonly { id: string; name: string; configured: boolean }[]
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
      <div className={styles.providerPanel} data-wiz-providers>
        {providers.map(provider => (
          <div
            key={provider.id}
            className={styles.providerRow}
            data-state={provider.configured ? 'configured' : 'installed'}
          >
            <strong>{provider.name}</strong>
            <span>{provider.id}</span>
          </div>
        ))}
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
          tone={compactionLlm ? 'llm' : 'off'}
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
          tone="llm"
        />
        <Toggle
          title={t('wizWhiteboardTitle')}
          sub={t('wizWhiteboardSub')}
          on={choice.whiteboard}
          onToggle={() => { onChoice({ ...choice, whiteboard: !choice.whiteboard }) }}
          chip={t('wizWhiteboardChip')}
          tone="off"
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

function Toggle({ title, sub, on, onToggle, chip, tone, children }: {
  title: string
  sub: string
  on: boolean
  onToggle: () => void
  chip: string
  /** Chip emphasis: 'llm' is the amber model-call note, 'off' the green no-call note. */
  tone: 'llm' | 'off'
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
      <span className={styles.chip} data-tone={tone}>{chip}</span>
      {on && children !== undefined ? children : null}
    </div>
  )
}

/** The tour intro panel inside the wizard; starting hands over to {@link TourOverlay}. */
function TourStep({ t, onStart, onSkip }: {
  t: T
  onStart: () => void
  onSkip: () => void
}): ReactNode {
  return (
    <div className={styles.step}>
      <h2 className={styles.heading}>{t('wizTourHeading')}</h2>
      <p className={styles.lead}>{t('wizTourLead')}</p>
      <p className={styles.fineprint}>{t('wizTourFineprint')}</p>
      <div className={styles.actions}>
        <Button variant="primary" onClick={onStart}>{t('wizTourStart')}</Button>
        <Button onClick={onSkip}>{t('wizSkipTour')}</Button>
      </div>
    </div>
  )
}

/** Measure one element's viewport rectangle. */
function rectOf(element: Element): TourRect {
  const box = element.getBoundingClientRect()
  return { left: box.left, top: box.top, width: box.width, height: box.height }
}

/** Whether two measurements name the same box (sub-pixel jitter is not a move). */
function sameRect(left: TourRect | null, right: TourRect | null): boolean {
  if (left === null || right === null) return left === right
  return Math.abs(left.left - right.left) < 0.5
    && Math.abs(left.top - right.top) < 0.5
    && Math.abs(left.width - right.width) < 0.5
    && Math.abs(left.height - right.height) < 0.5
}

/**
 * Place the tip beside the spotlight for one stop, clamped to the viewport; a
 * target that is not on screen centers the tip and leaves the scrim intact.
 */
function tipAt(rect: TourRect | null, place: typeof TOUR_STOPS[number]['place'], size: { width: number; height: number }): { left: number; top: number } {
  const width = window.innerWidth || 1024
  const height = window.innerHeight || 768
  if (rect === null) {
    return { left: Math.max(16, (width - size.width) / 2), top: 72 }
  }
  const hole = {
    left: rect.left - TOUR_PAD,
    top: rect.top - TOUR_PAD,
    width: rect.width + TOUR_PAD * 2,
    height: rect.height + TOUR_PAD * 2,
  }
  let left: number
  let top: number
  switch (place) {
    case 'right':
      left = hole.left + hole.width + TIP_MARGIN
      top = hole.top + hole.height / 2 - size.height / 2
      break
    case 'left':
      left = hole.left - size.width - TIP_MARGIN
      top = hole.top + hole.height / 2 - size.height / 2
      break
    case 'top':
      left = hole.left + hole.width / 2 - size.width / 2
      top = hole.top - size.height - TIP_MARGIN
      break
    default:
      left = hole.left + hole.width / 2 - size.width / 2
      top = hole.top + hole.height + TIP_MARGIN
      break
  }
  return {
    left: Math.max(16, Math.min(left, width - size.width - 16)),
    top: Math.max(64, Math.min(top, height - size.height - 16)),
  }
}

/**
 * The tour layer: a full-viewport scrim that owns every pointer event, a
 * spotlight hole that follows the real target, and the tip card. The wizard
 * dialog is not rendered while this layer is, so exactly one layer is on
 * screen; Back leaves the layer at the first stop instead of dead-ending.
 */
function TourOverlay({ t, stop, stepNumber, stepCount, onStop, onBack, onFinish, onSkip }: {
  t: T
  stop: number
  stepNumber: number
  stepCount: number
  onStop: (stop: number) => void
  onBack: () => void
  onFinish: () => void
  onSkip: () => void
}): ReactNode {
  const current = TOUR_STOPS[stop] ?? TOUR_STOPS[0]
  const [rect, setRect] = useState<TourRect | null>(null)
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)

  const measure = useCallback(() => {
    const target = document.querySelector(current.target)
    const next = target === null ? null : rectOf(target)
    setRect(previous => sameRect(previous, next) ? previous : next)
  }, [current.target])

  useLayoutEffect(() => { measure() }, [measure])

  // The real interface can move under the layer (a resize, a scrolling rail, a
  // late layout settle): one animation-frame loop re-measures the target and
  // publishes only real moves, so the spotlight follows the surface instead of
  // freezing at the first frame.
  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      measure()
      frame = requestAnimationFrame(tick)
    })
    return () => { cancelAnimationFrame(frame) }
  }, [measure])

  // The tip is measured after its content changes, then placed beside the hole.
  useLayoutEffect(() => {
    const element = tipRef.current
    if (element === null) return
    const box = element.getBoundingClientRect()
    setTip(tipAt(rect, current.place, { width: box.width, height: box.height }))
  }, [rect, stop, current.place])

  useEffect(() => { layerRef.current?.focus({ preventScroll: true }) }, [stop])

  const back = (): void => { if (stop > 0) onStop(stop - 1); else onBack() }
  const forward = (): void => { if (stop < TOUR_STOPS.length - 1) onStop(stop + 1); else onFinish() }

  return (
    <div
      ref={layerRef}
      className={styles.tourLayer}
      data-dsh-tour-overlay
      role="dialog"
      aria-modal="true"
      aria-label={t('wizNameTour')}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onSkip()
        else if (event.key === 'ArrowRight') forward()
        else if (event.key === 'ArrowLeft') back()
      }}
    >
      {rect !== null && (
        <div
          className={styles.tourHole}
          data-dsh-tour-hole
          style={{
            left: rect.left - TOUR_PAD,
            top: rect.top - TOUR_PAD,
            width: rect.width + TOUR_PAD * 2,
            height: rect.height + TOUR_PAD * 2,
          }}
        >
          <span className={styles.tourRing} />
        </div>
      )}
      <div
        ref={tipRef}
        className={styles.tourTip}
        data-dsh-tour-tip
        style={{
          visibility: tip === null ? 'hidden' : 'visible',
          left: tip?.left ?? 0,
          top: tip?.top ?? 0,
        }}
      >
        <p className={styles.eyebrow}>
          {t('wizEyebrow').replace('{n}', `${stepNumber} of ${stepCount}`).replace('{name}', t('wizNameTour'))}
        </p>
        <p className={styles.tourCount} data-dsh-tour-count>
          {t('wizTourStop').replace('{n}', String(stop + 1)).replace('{total}', String(TOUR_STOPS.length))}
        </p>
        <h2 className={styles.heading}>{t(current.title)}</h2>
        <p className={styles.tourBody}>{t(current.body)}</p>
        <div className={styles.tourDots} aria-hidden="true">
          {TOUR_STOPS.map((entry, index) => (
            <i key={entry.target} data-on={index === stop || undefined} />
          ))}
        </div>
        <div className={styles.actions}>
          <Button onClick={back}>{t('wizBack')}</Button>
          {stop < TOUR_STOPS.length - 1
            ? <Button variant="primary" onClick={forward}>{t('wizNext')}</Button>
            : <Button variant="primary" onClick={forward}>{t('wizTourFinish')}</Button>}
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

/** Display order of the host analysis stages; index maps to `stageIndex`. */
const ANALYSIS_PHASE_KEYS = [
  'wizPhaseHardware', 'wizPhaseOs', 'wizPhaseServices', 'wizPhaseDisk', 'wizPhaseGpu', 'wizPhaseWriting',
] as const

/** One phase's render state from the live job position. */
function phaseState(analysis: NonNullable<WelcomeWizardState['analysis']>, index: number): 'done' | 'active' | 'pending' {
  if (analysis.state === 'succeeded') return 'done'
  if (analysis.state === 'failed') return index < analysis.stageIndex ? 'done' : 'pending'
  if (index < analysis.stageIndex) return 'done'
  return index === analysis.stageIndex ? 'active' : 'pending'
}

/**
 * Live system-analysis progress: the determinate bar and phase rail render the
 * polled host job (`pct`, `stageIndex`), so the indicator moves with the real
 * run instead of a decorative animation.
 */
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
  const phases = ANALYSIS_PHASE_KEYS.slice(0, Math.max(0, Math.min(analysis.stageCount, ANALYSIS_PHASE_KEYS.length)))
  return (
    <div className={styles.dock} data-state={analysis.state} data-dsh-analysis-dock role="status">
      <div className={styles.dockHead}>
        <strong>{t('wizAnalysisDock')}</strong>
        {analysis.state === 'running' && <span className={styles.spinner} data-dsh-analysis-spinner aria-hidden="true" />}
        <span className={styles.dockPct} data-dsh-analysis-pct>{analysis.pct}%</span>
      </div>
      <div className={styles.dockTrack} data-dsh-analysis-track>
        <div className={styles.dockFill} data-dsh-analysis-fill style={{ width: `${analysis.pct}%` }} />
      </div>
      {phases.length > 0 && (
        <ol className={styles.dockPhases} data-dsh-analysis-phases>
          {phases.map((key, index) => (
            <li key={key} data-phase={key} data-state={phaseState(analysis, index)}>
              {t(key)}
            </li>
          ))}
        </ol>
      )}
      <span className={styles.dockLabel} data-dsh-analysis-stage>{label}</span>
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
