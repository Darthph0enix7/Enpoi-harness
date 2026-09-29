/**
 * Models settings and product-onboarding plugin, browser half. It registers
 * the Models page plus the ordered internal-testing and official-DeepSeek
 * onboarding dialogs, whose UI shares this package's modal wrapper. The Host
 * settings and credential contracts stay behind their existing wire APIs.
 * Export discipline:
 * packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the shell's SlotMap merge (the 'shell.overlay' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (settings/credentials invalidations ride the allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ctx.modelDirectories merge and the model locale
// namespace used by the shared picker the group editor embeds.
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ModelsSection } from './ModelsSection.tsx'
import { refreshFromServer as refreshHiddenModels } from './hidden-models.ts'
import type { ModelsSectionInjected } from './ModelsSection.tsx'
import { PoolProviderCardExtras } from './pool-extras.tsx'
import type { PoolExtrasInjected } from './pool-extras.tsx'
import { DeepSeekOnboardingDialog } from './DeepSeekOnboardingDialog.tsx'
import type { DeepSeekOnboardingInjected } from './DeepSeekOnboardingDialog.tsx'
import { WelcomeNotice } from './WelcomeNotice.tsx'
import type { WelcomeNoticeInjected } from './WelcomeNotice.tsx'
import { WelcomeWizard } from './WelcomeWizard.tsx'
import type { WelcomeWizardInjected } from './WelcomeWizard.tsx'
import { SystemAnalysisChip } from './SystemAnalysisChip.tsx'
import type { SystemAnalysisChipInjected } from './SystemAnalysisChip.tsx'
import { SystemAnalysisStore, systemAnalysisApi } from './system-analysis.ts'
import { SetupSection } from './SetupSection.tsx'
import type { SetupSectionInjected } from './SetupSection.tsx'
import { WelcomeNoticeStore } from './welcome-store.ts'
import { WelcomeWizardStore, WIZARD_SETTINGS_NAMESPACE } from './welcome-wizard.ts'
import { analysisApi } from './welcome-rpc.ts'
import { ModelsSettingsStore } from './store.ts'
import type { ModelsWire } from './store.ts'
import { createModelsOperations } from './operations.ts'
import { createCatalogPickerFace } from './picker-face.ts'
import type { ModelPickerFace } from './picker-face.ts'
import { createSettingsSchemaOperations } from './schema-operations.ts'
import { en, zh, type ModelsKey } from './locales.ts'
import { WELCOME_NOTICE_SETTINGS_NAMESPACE } from '../onboarding-copy.ts'
import { Config, ONBOARDING_CONFIG_GLOBAL } from '../onboarding-config.ts'

export type { ModelsSectionInjected, ModelsSectionProps } from './ModelsSection.tsx'
export type { ModelsFooterOwnerProps, ProviderCardExtrasOwnerProps } from './slot-contract.ts'
export type { ModelsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Models page + product-onboarding copy. */
    'settings.models': ModelsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.models'

export type {
  ModelsSettingsState, ProviderDirectoryEntry, ProviderRow,
} from './store.ts'
export type { ModelDiscoveryOutcome, ModelsOperations, SettingsWriteOutcome } from './operations.ts'

/**
 * Refetch the page snapshot only after its first load: an unopened Models
 * page must not fetch on background invalidations.
 * @param controller - the page store.
 */
export function refreshIfLoaded(controller: ModelsSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on each slot through `slots.inject()`.
 */
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings', 'remote.session',
  'configForms', 'settingsSchema',
]

/**
 * Register the Models section once the `settings.section` declaration is on
 * the ledger, wire its store to the connection, and keep it fresh on every
 * pushed invalidation (settings, credentials, or provider topology).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const page = globalThis as Partial<Record<typeof ONBOARDING_CONFIG_GLOBAL, unknown>>
  const payload = page[ONBOARDING_CONFIG_GLOBAL]
  const configured = Config(payload === undefined ? {} : payload)
  const credentialOnboarding = configured.credentialOnboarding && !('dshDesktop' in globalThis)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-models: copy dictionaries')

  const schema = createSettingsSchemaOperations(ctx.settingsSchema)
  // Bound once here, where the Remote namespaces are declared in this plugin's
  // own `inject`; the detail panel and the add modal receive the wire faces and
  // never a context.
  const wire: ModelsWire = {
    credentials: ctx.remote.credentials,
    llm: ctx.remote.llm,
    settings: ctx.remote.settings,
  }
  // Bound once here, where the Remote namespaces are declared in this plugin's
  // own `inject`; the cards receive callbacks and never a context.
  const operations = createModelsOperations(ctx)
  const controller = new ModelsSettingsStore(ctx, schema, ctx.configForms.describe())
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as ModelsSectionInjected['t']
  // The embedded picker reads its own package's dictionary; the namespace is
  // registered by ui-model-selection (a soft service edge, see `picker`).
  const modelT = ctx.locale.bind('model')
  // The group editor's picker face is resolved lazily through `ctx.get`, not a
  // fiber inject: the Models page must render even when the model-selection
  // plugin is absent, and a lazy read sees the service regardless of which
  // plugin activated first.
  const pickerDisposers: Array<() => void> = []
  let pickerFace: ModelPickerFace | null | undefined
  const picker = (): ModelPickerFace | null => {
    if (pickerFace !== undefined) return pickerFace
    const service = ctx.get('modelDirectories')
    if (service === undefined) {
      pickerFace = null
      return null
    }
    const created = createCatalogPickerFace(service.catalog)
    pickerDisposers.push(created.dispose)
    pickerFace = created.face
    return pickerFace
  }
  const injected = (): ModelsSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    api: wire,
    schema,
    t,
    picker: picker(),
    modelT,
  })
  const deepSeekOnboardingInjected = (): DeepSeekOnboardingInjected => ({
    automatic: credentialOnboarding,
    controller,
    hooks: { models: controller.store },
    operations,
    schema,
    t,
  })
  // The scope's own memory mode is what keeps a remote browser process-local,
  // so the store needs no isLoopback branch of its own.
  const welcomeController = new WelcomeNoticeStore(ctx.configForms.get<Record<string, unknown>>(WELCOME_NOTICE_SETTINGS_NAMESPACE))
  const welcomeInjected = (): WelcomeNoticeInjected => ({
    controller: welcomeController,
    hooks: { welcome: welcomeController.store },
    t,
  })
  // First-run setup: one store drives the wizard step and the Setup section's
  // reopen action, so both surfaces agree on the completion marker.
  const wizardController = new WelcomeWizardStore(
    ctx.configForms.get<Record<string, unknown>>(WIZARD_SETTINGS_NAMESPACE),
    analysisApi,
  )
  const wizardInjected = (): WelcomeWizardInjected => ({
    store: wizardController,
    hooks: { wizard: wizardController.store, models: controller.store },
    modelsController: controller,
    operations,
    api: wire,
    schema,
    t,
  })
  const setupInjected = (): SetupSectionInjected => ({
    store: wizardController,
    hooks: { wizard: wizardController.store },
    t,
  })
  // The frame-wide system-analysis chip owns its own store: it auto-starts the
  // analysis on a machine with no profile, follows the run, and carries the
  // accept/reject decision independently of the wizard.
  const analysisController = new SystemAnalysisStore(systemAnalysisApi)
  const analysisInjected = (): SystemAnalysisChipInjected => ({
    actions: {
      open: () => { void analysisController.open() },
      accept: () => { void analysisController.accept() },
      reject: () => { void analysisController.reject() },
      dismiss: () => { void analysisController.dismiss() },
      retry: () => { void analysisController.retry() },
    },
    hooks: { analysis: analysisController.store },
  })
  // The Key Pool extension's Remote faces are bound once here, where the
  // namespaces are declared in this plugin's own `inject`; the components
  // receive callbacks and data and never a context.
  const poolExtrasInjected = (): PoolExtrasInjected => ({
    settings: ctx.remote.settings,
    credentials: ctx.remote.credentials,
    llm: ctx.remote.llm,
    t,
  })

  // Pushed invalidations converge every open surface without polling. The
  // configForms injection makes ui-settings activate first, and remote
  // dispatch preserves listener order; its listener therefore starts the
  // mirror refresh before this store joins that refresh. The welcome notice
  // follows its settings scope, so it needs no subscription here.
  ctx.effect(() => {
    const refreshModels = (): void => { refreshIfLoaded(controller) }
    // The page's join: the settings namespaces its provider rows render from
    // plus `enpoi-orchestration` (hidden models / group registry). A commit to
    // any other namespace cannot change a row, so the page does not reload.
    const pageNamespaces = (): ReadonlySet<string> => new Set(
      controller.store.getSnapshot().rows
        .map(row => row.entry.settingsNs)
        .filter(ns => ns !== ''))
    // Cross-client live sync for the hidden-model map: an
    // enpoi-orchestration commit in any other client is debounced, then merged
    // into the local store (the settings page and the model picker both
    // subscribe to its change event).
    let hiddenRefreshTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleHiddenModelsRefresh = (): void => {
      if (hiddenRefreshTimer !== undefined) clearTimeout(hiddenRefreshTimer)
      hiddenRefreshTimer = setTimeout(() => {
        hiddenRefreshTimer = undefined
        void refreshHiddenModels()
      }, 250)
    }
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns) => {
        if (ns === 'enpoi-orchestration') {
          scheduleHiddenModelsRefresh()
          refreshModels()
          return
        }
        if (pageNamespaces().has(ns)) refreshModels()
      }),
      ctx.remote.$on('credentials/record-updated', refreshModels),
      ctx.remote.$on('credentials/reference-updated', refreshModels),
      ctx.remote.$on('llm/adapters-updated', refreshModels),
      ctx.on('connection/reset', refreshModels),
    ]
    return () => {
      if (hiddenRefreshTimer !== undefined) clearTimeout(hiddenRefreshTimer)
      welcomeController.dispose()
      wizardController.dispose()
      analysisController.dispose()
      for (const dispose of pickerDisposers) dispose()
      for (const dispose of disposers) dispose()
    }
  }, 'ui-settings-models: pushed invalidations')
  // The chip reads the host state once on activation: a fresh machine starts
  // the analysis in the background, a stored profile offers the decision.
  ctx.effect(() => {
    void analysisController.load()
    return () => { analysisController.dispose() }
  }, 'ui-settings-models: system-analysis auto-start')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    label: () => t('nav'),
    inject: injected,
    children: {
      'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
      'settings.models.footer': { kind: 'list', scope: 'root' },
    },
  }, ModelsSection))
  // Key Pool UI rides the Models page's official extension seats. The
  // per-card editor registration stays (inert — the restored page edits the
  // pool in its detail panel's Keys card). The Usage & Quota footer card was
  // REMOVED by operator directive: it never reported real quota (these
  // upstreams return no rate-limit headers) and it cluttered the page.
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-pi-ai',
    inject: poolExtrasInjected,
  }, PoolProviderCardExtras))
  if (!('dshDesktop' in globalThis)) ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'welcome-notice',
    order: -100,
    inject: welcomeInjected,
  }, WelcomeNotice))
  // First-run setup leads the coordinator queue: the wizard hands the slot to
  // the welcome notice when it completes or when the marker already exists.
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'welcome-wizard',
    order: -200,
    inject: wizardInjected,
  }, WelcomeWizard))
  // The Setup row re-runs the flow later; the store's reopen flag overrides
  // the completion marker for the next blank session.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'setup',
    order: 90,
    label: () => t('wizSetupNav'),
    inject: setupInjected,
  }, SetupSection))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'deepseek-official',
    children: { 'settings.models.sign-in': { kind: 'single', scope: 'root' } },
    order: 0,
    inject: deepSeekOnboardingInjected,
  }, DeepSeekOnboardingDialog))
  // Frame-wide bottom-right chip: progress phases, the ready decision, and the
  // failure retry. It lives in the shell overlay so it outlives every panel.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'system-analysis',
    locale: NS,
    inject: analysisInjected,
  }, SystemAnalysisChip))
}
