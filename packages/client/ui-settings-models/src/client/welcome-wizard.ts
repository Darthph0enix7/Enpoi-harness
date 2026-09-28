/**
 * First-run welcome wizard state: the seven steps of the approved flow, the
 * real settings writes each configured step offers, and the durable
 * `onboardingCompleted` marker that shows the wizard once. The state machine
 * is pure; the store adds the settings scope, the reopen entry, and the
 * background system-analysis poll.
 * @module ui-settings-models/welcome-wizard
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { WELCOME_NOTICE_SETTINGS_NAMESPACE } from '../onboarding-copy.ts'

/** One settings scope answer, as the wizard reads it. */
export interface WizardScopeSnapshot {
  mode: 'host' | 'memory'
  status: 'loading' | 'ready' | 'unavailable'
  value?: Record<string, unknown> | undefined
}

/** The settings scope the wizard follows; `ctx.configForms.get(...)` satisfies this. */
export interface WizardScope {
  getSnapshot: () => WizardScopeSnapshot
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: unknown) => Promise<boolean | void>
}

/** Bump only when the first-run flow changes materially; the marker is compared for exact equality. */
export const WIZARD_VERSION = '2026-09-28.1'

/** Settings namespace holding the completion marker. */
export const WIZARD_SETTINGS_NAMESPACE = WELCOME_NOTICE_SETTINGS_NAMESPACE

/** Field storing the version of the setup flow this installation completed. */
export const WIZARD_COMPLETED_FIELD = 'onboardingCompleted'

/** Route id and free model the background helpers use for their seats. */
export const WIZARD_FREE_PROVIDER = 'kilo'
export const WIZARD_FREE_MODEL = 'kilo-auto/free'

/** The seven steps, in order. */
export const WIZARD_STEPS = ['welcome', 'security', 'provider', 'intelligence', 'tour', 'agents', 'done'] as const

/** One step identity. */
export type WizardStepId = typeof WIZARD_STEPS[number]

/**
 * Per-step outcome: configured holds a real change, default is a forward pass
 * that kept the shipped default, skipped is an explicit skip (the only state
 * the Done page lists).
 */
export type WizardStepState = 'default' | 'configured' | 'skipped'

/** Sandbox presets the security step writes. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Background-helper choices the intelligence step writes. */
export interface IntelligenceChoice {
  compaction: boolean
  keeper: boolean
  whiteboard: boolean
}

/** One real settings write a step performs. */
export interface WizardWrite {
  ns: string
  ops: SettingsPathOpView[]
}

/** Wizard navigation and completion. */
export interface WizardState {
  step: WizardStepId
  states: Record<WizardStepId, WizardStepState>
}

/** Actions the wizard view dispatches. */
export type WizardAction =
  | { type: 'goto'; step: WizardStepId }
  | { type: 'continue' }
  | { type: 'skip' }
  | { type: 'skip-tour' }
  | { type: 'configured' }
  | { type: 'restart' }

/** The settings write the security step performs for one sandbox preset. */
export function sandboxWrite(mode: SandboxMode): WizardWrite {
  return { ns: 'permission-presets', ops: [{ op: 'set', path: ['defaultPreset'], value: mode }] }
}

/**
 * The settings writes the intelligence step performs. The compaction and
 * keeper seats point at the free Kilo route, never at the session's main
 * model; switching compaction off clears its seat so the documented inherit
 * default returns.
 * @param choice - which helpers stay on.
 * @returns the writes in application order.
 */
export function intelligenceWrites(choice: IntelligenceChoice): WizardWrite[] {
  const ns = 'enpoi-orchestration'
  const writes: WizardWrite[] = [
    { ns, ops: [{ op: 'set', path: ['capabilities', 'tools', 'keeper'], value: choice.keeper }] },
    { ns, ops: [{ op: 'set', path: ['toolGroups', 'groups', 'whiteboard', 'enabled'], value: choice.whiteboard }] },
  ]
  if (choice.compaction) {
    writes.push({
      ns,
      ops: [{ op: 'set', path: ['personas', 'compaction'], value: { provider: WIZARD_FREE_PROVIDER, model: WIZARD_FREE_MODEL } }],
    })
  } else {
    writes.push({ ns, ops: [{ op: 'unset', path: ['personas', 'compaction'] }] })
  }
  if (choice.keeper) {
    writes.push({
      ns,
      ops: [{ op: 'set', path: ['personas', 'keeper'], value: { provider: WIZARD_FREE_PROVIDER, model: WIZARD_FREE_MODEL } }],
    })
  }
  return writes
}

/** Fresh wizard state: the welcome step, every later step at its default. */
export function initialWizardState(): WizardState {
  return {
    step: 'welcome',
    states: Object.fromEntries(WIZARD_STEPS.map(id => [id, 'default'])) as Record<WizardStepId, WizardStepState>,
  }
}

/** The step after one identity, or the same step at the end. */
function nextStep(step: WizardStepId): WizardStepId {
  const index = WIZARD_STEPS.indexOf(step)
  return WIZARD_STEPS[Math.min(index + 1, WIZARD_STEPS.length - 1)] ?? 'done'
}

/**
 * Apply one navigation action.
 * @param state - current wizard state.
 * @param action - the dispatched action.
 * @returns the next state; inputs are never mutated.
 */
export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'goto':
      return { ...state, step: action.step }
    case 'continue':
      return {
        step: nextStep(state.step),
        states: { ...state.states, [state.step]: state.states[state.step] === 'configured' ? 'configured' : 'default' },
      }
    case 'skip':
      return {
        step: nextStep(state.step),
        states: { ...state.states, [state.step]: state.states[state.step] === 'configured' ? 'configured' : 'skipped' },
      }
    case 'skip-tour': {
      const states = { ...state.states, tour: 'skipped' as const }
      return { step: 'agents', states }
    }
    case 'configured':
      return { ...state, states: { ...state.states, [state.step]: 'configured' } }
    case 'restart':
      return initialWizardState()
    /* v8 ignore next -- closed union; every action is handled above */
    default:
      return state
  }
}

/** The steps an explicit skip marked, in order, for the Done page. */
export function skippedSteps(state: WizardState): WizardStepId[] {
  return WIZARD_STEPS.filter(id => state.states[id] === 'skipped' && id !== 'done')
}

/**
 * The whole-tour skip: steps 2 to 6 are skipped, nothing else changes.
 * @returns state at the Done step with the skipped range recorded.
 */
export function skipWholeTour(): WizardState {
  const state = initialWizardState()
  return {
    step: 'done',
    states: { ...state.states, security: 'skipped', provider: 'skipped', intelligence: 'skipped', tour: 'skipped', agents: 'skipped' },
  }
}

/** One analysis run as the wizard dock renders it. */
export interface WizardAnalysisView {
  state: 'idle' | 'running' | 'succeeded' | 'failed'
  stage: string
  stageIndex: number
  stageCount: number
  pct: number
  error?: string
  summary?: { threads: number; memoryGiB: number; services: number | null; gpu?: string }
}

/** One RPC outcome at the wizard's own wire boundary. */
export type WizardRpcResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** The host calls the wizard makes. */
export interface WizardAnalysisApi {
  start: () => Promise<WizardRpcResult<WizardAnalysisView>>
  status: () => Promise<WizardRpcResult<WizardAnalysisView>>
}

/** Snapshot rendered by the wizard overlay. */
export interface WelcomeWizardState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  error: string | null
  /** Durable or process-local completion of the setup flow. */
  completed: boolean
  /** Process-local reopen from the Setup entry; overrides completion. */
  reopened: boolean
  /** Whether the overlay is on screen. */
  visible: boolean
  /** Step machine state. */
  wizard: WizardState
  /** Background analysis run, when one was started. */
  analysis: WizardAnalysisView | null
}

/** How often the wizard polls a running analysis. The host scan can settle in
 * under a second, so the poll is fast enough to render its live stages. */
const ANALYSIS_POLL_MS = 300

/* v8 ignore next 3 -- closed-union default only defends future source widening */
function assertNever(_value: never): never {
  throw new Error('unexpected wizard settings status')
}

/** Coordinates the wizard's settings scope, navigation, and analysis poll. */
export class WelcomeWizardStore {
  /** uSES-safe state source the overlay and Setup section render from. */
  readonly store: SnapshotStore<WelcomeWizardState> = createSnapshotStore<WelcomeWizardState>({
    status: 'idle',
    error: null,
    completed: false,
    reopened: false,
    visible: false,
    wizard: initialWizardState(),
    analysis: null,
  })

  private localCompleted = false
  private saving = false
  private following: (() => void) | undefined
  private poll: ReturnType<typeof setInterval> | undefined

  /**
   * @param scope - the settings namespace carrying the completion marker.
   * @param analysis - the host analysis calls.
   */
  constructor(
    private readonly scope: WizardScope,
    private readonly analysis: WizardAnalysisApi,
  ) {}

  /**
   * Begin following the bound scope (idempotent) and publish its current answer.
   * @returns settlement after the current answer is published.
   */
  load(): Promise<void> {
    this.following ??= this.scope.subscribe(() => { this.derive() })
    this.derive()
    return Promise.resolve()
  }

  /**
   * Apply one navigation action.
   * @param action - the action to dispatch.
   */
  dispatch(action: WizardAction): void {
    this.store.update((state) => { state.wizard = wizardReducer(state.wizard, action) })
  }

  /** Skip the whole tour from the welcome step: steps 2 to 6 are marked skipped. */
  skipWholeTour(): void {
    this.store.update((state) => { state.wizard = skipWholeTour() })
  }

  /** Reopen the wizard from the Setup entry, whatever the marker says. */
  reopen(): void {
    this.store.update((state) => {
      state.reopened = true
      state.wizard = initialWizardState()
      state.visible = true
    })
  }

  /** Close the overlay without completing; the next first run shows it again. */
  close(): void {
    this.store.update((state) => {
      state.reopened = false
      state.visible = state.status === 'ready' && !state.completed
    })
  }

  /**
   * Persist completion, or advance only this process for a remote browser. The
   * overlay stays visible when the write did not stick, so the error is seen.
   * @returns true when the selected persistence mode holds the completion.
   */
  async finish(): Promise<boolean> {
    if (this.scope.getSnapshot().mode === 'memory') {
      this.localCompleted = true
      this.derive()
      return true
    }
    this.saving = true
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    try {
      await this.scope.set(WIZARD_COMPLETED_FIELD, WIZARD_VERSION)
    } finally {
      this.saving = false
    }
    this.derive()
    const { completed } = this.store.getSnapshot()
    if (!completed) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = 'the setup completion did not persist'
      })
    }
    return completed
  }

  /** Start the background system analysis, or adopt the run already in flight. */
  async startAnalysis(): Promise<void> {
    const started = await this.analysis.start()
    if (!started.ok) {
      this.store.update((state) => { state.analysis = { state: 'failed', stage: '', stageIndex: 0, stageCount: 0, pct: 0, error: started.message } })
      return
    }
    this.store.update((state) => { state.analysis = started.value })
    if (started.value.state === 'running') this.followAnalysis()
  }

  /** Stop following the scope and any analysis poll. */
  dispose(): void {
    this.following?.()
    this.following = undefined
    if (this.poll !== undefined) clearInterval(this.poll)
    this.poll = undefined
  }

  private followAnalysis(): void {
    if (this.poll !== undefined) return
    this.poll = setInterval(() => {
      void this.analysis.status().then((result) => {
        if (!result.ok) return
        this.store.update((state) => { state.analysis = result.value })
        if (result.value.state !== 'running' && this.poll !== undefined) {
          clearInterval(this.poll)
          this.poll = undefined
        }
      })
    }, ANALYSIS_POLL_MS)
  }

  private derive(): void {
    if (this.saving) return
    const scope = this.scope.getSnapshot()
    if (scope.mode === 'memory') {
      this.store.update((state) => {
        state.status = 'ready'
        state.completed = this.localCompleted
        state.error = null
        state.visible = state.reopened || !state.completed
      })
      return
    }
    switch (scope.status) {
      case 'loading':
        this.store.update((state) => { state.status = 'loading'; state.error = null })
        return
      case 'unavailable':
        this.store.update((state) => {
          state.status = 'error'
          state.completed = false
          state.visible = false
          state.error = 'the setup settings are unavailable'
        })
        return
      case 'ready': {
        const completed = scope.value?.[WIZARD_COMPLETED_FIELD] === WIZARD_VERSION
        this.store.update((state) => {
          state.status = 'ready'
          state.completed = completed
          state.error = null
          state.visible = state.reopened || !completed
        })
        return
      }
      /* v8 ignore next -- every current settings scope status is handled above */
      default: return assertNever(scope.status)
    }
  }
}
