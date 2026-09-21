// @vitest-environment jsdom
/** Section, setup-card, and hand-written editor behavior over a scripted wire face. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  CredentialInfo, RemoteResult, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  ModelsSection, needsSetup, providerCopy, providerTargetLabel, removeProviderProfile,
} from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { ProviderEditor, pathOps } from '../src/client/ProviderEditor.tsx'
import {
  DeepSeekModelsEditor, formatCapacity, modelDrafts, parseCapacity, validateDeepSeekModels,
} from '../src/client/DeepSeekModelsEditor.tsx'
import { apiKeyFailure } from '../src/client/apiKey.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { deriveKeyRef, ModelsSettingsStore } from '../src/client/store.ts'
import { createModelsOperations } from '../src/client/operations.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import type { ModelsWire, ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]
const OPENAI_TARGET = { provider: 'openai', displayName: 'openai' }
const openaiCopy = (template: string): string => providerCopy(template, OPENAI_TARGET)

/** Open one row's capacity disclosure (1-based, as the labels read). */
function expandRow(position: number): void {
  fireEvent.click(screen.getByLabelText(`${en.modelAdvanced} ${String(position)}`))
}

/** The capacity inputs of every open row, in row order. */
function capacityInputs(label: string): HTMLInputElement[] {
  return screen.getAllByLabelText<HTMLInputElement>(new RegExp(label))
}

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
    reasoning: Schema.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    headers: Schema.dict(Schema.string()),
  })),
})

const DeepSeekConfig = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string().pattern(/^https:\/\//),
  reasoningEffort: Schema.union(['off', 'low', 'high', 'max']),
  defaultContextWindow: Schema.number().step(1).min(1),
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    description: Schema.string(),
    contextWindow: Schema.number().step(1).min(1),
  // The adapter declares its catalog as a schema default rather than a
  // composition entry, which is what the restore-defaults path has to read.
  })).default([
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek-V4-Flash',
      description: '',
      contextWindow: 1_000_000,
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      description: '',
      contextWindow: 1_000_000,
    },
  ]),
})

const DEFAULT_DEEPSEEK_MODELS = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    description: 'Preserved hidden detail',
    contextWindow: 1_000_000,
  },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000 },
]

function wireNamespaces(): SettingsNamespaceView[] {
  return [
    {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseURL: 'https://base',
        defaultContextWindow: 1_000_000,
        maxTokens: 256_000,
        models: DEFAULT_DEEPSEEK_MODELS,
      },
      base: { defaultContextWindow: 1_000_000, maxTokens: 256_000, models: DEFAULT_DEEPSEEK_MODELS },
      user: { baseURL: 'https://base' },
      applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'llm-plain',
      schema: JSON.parse(JSON.stringify(Schema.object({
        profiles: Schema.dict(Schema.object({ note: Schema.string() })),
      }).toJSON())) as JsonValue,
      value: {},
      applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'llm-pi-ai',
      schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
      value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' } }, zombie: {} } },
      user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://proxy', headers: { 'X-Team': 'a' } }, zombie: {} } },
      applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'subagent-model-selection',
      schema: JSON.parse(JSON.stringify(Schema.object({ enabled: Schema.boolean().default(false) }).toJSON())) as JsonValue,
      value: { enabled: false },
      applies: 'live',
      secrets: [],
      revision: 4,
    },
  ]
}

/** Credentials answers over the Remote carrier, which has no envelope. */
function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}
/** The codes this page's scripted Host answers refuse with. */
type RefusalCode = 'credential/rejected' | 'gateway/internal' | 'settings/conflict' | 'settings/rejected'

/** One refusal per code, each carrying the details its own code declares. */
const REFUSALS: { [Code in RefusalCode]: (message: string) => RemoteError<Code> } = {
  'credential/rejected': message => new RemoteError('credential/rejected', message, { ref: 'DEEPSEEK_API_KEY' }),
  'gateway/internal': message => new RemoteError('gateway/internal', message, {}),
  'settings/conflict': message =>
    new RemoteError('settings/conflict', message, { ns: 'llm-pi-ai', expected: 4, actual: 5 }),
  'settings/rejected': message => new RemoteError('settings/rejected', message, { ns: 'llm-pi-ai' }),
}
function remoteFail(message: string, code: RefusalCode = 'credential/rejected') {
  return { ok: false as const, error: REFUSALS[code](message) }
}

function scriptedFace(overrides: {
  update?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  set?: ReturnType<typeof vi.fn>
  unset?: ReturnType<typeof vi.fn>
} = {}) {
  const providerNamespace = wireNamespaces().find(view => view.ns === 'llm-pi-ai')!
  const update = overrides.update ?? vi.fn(() => Promise.resolve(remoteOk(providerNamespace)))
  const mutate = overrides.mutate ?? vi.fn(() => Promise.resolve(remoteOk(providerNamespace)))
  const set = overrides.set ?? vi.fn(() => Promise.resolve(remoteOk(undefined)))
  const unset = overrides.unset ?? vi.fn(() => Promise.resolve(remoteOk(undefined)))
  const face = {
    llm: {
      listProviders: vi.fn(() => Promise.resolve(remoteOk([
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'openai', name: 'openai' },
      ]))),
      listConfigurableProviders: vi.fn(() => Promise.resolve(remoteOk([
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
        { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
        { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
        { provider: 'zombie', displayName: 'zombie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zombie'], active: false },
        { provider: 'broken', displayName: 'broken', settingsNs: 'llm-pi-ai', settingsPath: ['nope', 'x'], active: false },
        { provider: 'plain', displayName: 'plain', settingsNs: 'llm-plain', settingsPath: ['profiles', 'plain'], active: false },
      ].map(({ active: _active, ...entry }) => entry)))),
      discoverModels: vi.fn(() => Promise.resolve(remoteOk([]))),
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: wireNamespaces() }))),
      update,
      mutate,
    },
    credentials: {
      // Typed as the Remote answer rather than the success branch alone: a
      // case that scripts a refusal replaces this mock.
      describe: vi.fn((refs: string[]): Promise<RemoteResult<Record<string, CredentialInfo>>> =>
        Promise.resolve(remoteOk(
          Object.fromEntries(refs.map(ref => [ref, {
            configured: ref === 'OPENAI_API_KEY',
            ...ref === 'OPENAI_API_KEY' ? { source: 'file' } : {},
            writable: true,
          }])),
        ))),
      set,
      unset,
    },
  }
  return { face, update, mutate, set, unset }
}

/**
 * The generated Remote wire the page consumes. The scripted face implements
 * only the calls these specs make, so the narrowing to {@link ModelsWire}
 * happens once here instead of at every mount.
 */
function wireOf(face: ReturnType<typeof scriptedFace>['face']): ModelsWire {
  return face as unknown as ModelsWire
}

type PageContext = ConstructorParameters<typeof ModelsSettingsStore>[0]

/**
 * The page plugin's context, scripted down to the namespaces the page reaches.
 * One context per face, as in production: an editor effect keyed by the context
 * would otherwise re-probe on every render.
 */
const contexts = new WeakMap<object, PageContext>()
function ctxWith(face: object): PageContext {
  const existing = contexts.get(face)
  if (existing !== undefined) return existing
  const ctx = { remote: face } as unknown as PageContext
  contexts.set(face, ctx)
  return ctx
}

/**
 * The cards' injected Host operations over the same script, bound once per face
 * as the plugin body binds them: an editor effect keyed by this face would
 * otherwise re-probe on every render.
 */
const operations = new WeakMap<object, ModelsOperations>()
function operationsWith(face: object): ModelsOperations {
  const existing = operations.get(face)
  if (existing !== undefined) return existing
  const bound = createModelsOperations(ctxWith(face))
  operations.set(face, bound)
  return bound
}

/** One recorded child-slot dispatch: seat name, owner share, kind options. */
type RenderSlotCall = [name: string, owner: Record<string, unknown>, opts?: { entryKey?: string }]

/** Child-slot dispatch stub: records every seat occurrence, renders nothing. */
function stubRenderSlot() {
  return vi.fn((..._call: RenderSlotCall) => null)
}

/** The sidebar row carrying `provider` as its name or slug. */
function providerRow(provider: string): HTMLElement {
  const row = screen.getAllByText(provider)
    .map(node => node.closest<HTMLElement>('[role="button"]'))
    .find(candidate => candidate !== null)
  if (row === undefined || row === null) throw new Error(`no row for ${provider}`)
  return row
}

/**
 * Mount one editor card with the section's close-on-commit behavior: a
 * committed apply unmounts the card, as the page removes it when a row closes.
 */
function EditorHarness(props: {
  provider: string
  displayName: string
  namespace: SettingsNamespaceView
  settingsPath: readonly string[]
  declared?: boolean
  face: object
}): ReactNode {
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <ProviderEditor
      provider={props.provider}
      displayName={props.displayName}
      namespace={props.namespace}
      schema={settingsSchema}
      settingsPath={props.settingsPath}
      operations={operationsWith(props.face)}
      {...props.declared === undefined ? {} : { declared: props.declared }}
      t={t}
      readOnly={false}
      onClose={() => { setOpen(false) }}
    />
  )
}

/** Mount the DeepSeek whole-section editor (its profile path is the section root). */
function renderDeepSeekEditor(face: object, namespace: SettingsNamespaceView = wireNamespaces()[0]!): void {
  render(<EditorHarness provider="deepseek-official" displayName="DeepSeek" namespace={namespace} settingsPath={[]} face={face} />)
}

/** Mount one pi-ai route's editor over the scripted namespace. */
function renderPiAiEditor(face: object, provider: string, declared = false): void {
  render(<EditorHarness provider={provider} displayName={provider} namespace={wireNamespaces()[2]!} settingsPath={['providers', provider]} declared={declared} face={face} />)
}

async function mountFace(scripted: ReturnType<typeof scriptedFace>) {
  const { face, update, mutate, set, unset } = scripted
  const ctx = ctxWith(face)
  const mirror = new SettingsDescribeMirror(ctx)
  const controller = new ModelsSettingsStore(ctx, settingsSchema, mirror)
  await controller.load()
  const renderSlot = stubRenderSlot()
  const injected: ModelsSectionProps = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    api: wireOf(face),
    schema: settingsSchema,
    t,
    picker: null,
    modelT: key => key,
    renderSlot: renderSlot as unknown as ModelsSectionProps['renderSlot'],
  }
  const view = render(<ModelsSection {...injected} />)
  return { view, ctx, face, update, mutate, set, unset, controller, mirror, renderSlot }
}

async function mountSection(overrides: Parameters<typeof scriptedFace>[0] = {}) {
  return mountFace(scriptedFace(overrides))
}

/**
 * Mount the DeepSeek editor card over a freshly scripted wire face. The card
 * is a component in its own right (the onboarding dialog reuses it) and the
 * restored page renders its own detail panel, so the editor specs mount it
 * directly instead of reaching it through the page.
 */
async function mountDeepSeekCard(overrides: Parameters<typeof scriptedFace>[0] = {}) {
  const scripted = scriptedFace(overrides)
  renderDeepSeekEditor(scripted.face)
  return scripted
}

describe('ModelsSection', () => {
  it('renders nothing before the slot injects its dependencies', () => {
    const uninjected = {} as ModelsSectionProps
    render(<ModelsSection {...uninjected} />)
    expect(document.body.textContent).toBe('')
  })

  it('renders the provider list with each row carrying its credential state', async () => {
    await mountSection()
    // openai's key is stored; DeepSeek's is not. The sidebar marks both.
    expect(within(providerRow('openai')).getByTitle(en.providerConnected)).toBeTruthy()
    expect(within(providerRow('DeepSeek')).getByTitle(en.providerMissingKey)).toBeTruthy()
  })

  it('selects a provider on click and shows its detail panel', async () => {
    await mountSection()
    // The page opens on the first configured row; clicking another switches it.
    expect(screen.getAllByRole('heading', { name: 'DeepSeek' }).length).toBeGreaterThan(0)
    fireEvent.click(providerRow('openai'))
    const heading = screen.getByRole('heading', { name: 'openai' })
    expect(heading).toBeTruthy()
    // The unkeyed route's detail panel asks for a key.
    fireEvent.click(providerRow('DeepSeek'))
    expect(screen.getByPlaceholderText('Enter API key')).toBeTruthy()
  })

  it('filters the provider list through the sidebar search box', async () => {
    await mountSection()
    const search = screen.getByPlaceholderText(en.providersFilterPlaceholder)
    fireEvent.change(search, { target: { value: 'deep' } })
    expect(screen.queryByText('openai')).toBeNull()
    expect(providerRow('DeepSeek')).toBeTruthy()
    fireEvent.change(search, { target: { value: '' } })
    expect(providerRow('openai')).toBeTruthy()
  })

  it('marks a confirmed missing reference and leaves native state connected', async () => {
    const { face } = scriptedFace()
    face.credentials.describe.mockImplementation((refs: string[]) => Promise.resolve(remoteOk(
      Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
    )))
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={wireOf(face)}
      schema={settingsSchema}
      t={t}
      picker={null}
      modelT={key => key}
      renderSlot={() => null}
    />)

    // A confirmed-missing reference paints the warning dot.
    const missing = within(providerRow('openai')).getByTitle(en.providerMissingKey)
    expect(missing.className).toContain('statusDotYellow')
    // `zombie` names no reference, so it authenticates natively and reads as
    // connected rather than missing a key.
    expect(within(providerRow('zombie')).getByTitle(en.providerConnected)).toBeTruthy()
  })

  it('decides setup need from the row state and the read-only posture', () => {
    const entry = { provider: 'p', displayName: 'p', settingsNs: 'llm-deepseek', settingsPath: [], active: true }
    const row = (configured: boolean): ProviderRow => ({
      entry,
      configured,
      removable: false,
      apiKeyEnv: 'X',
      credential: undefined,
    })
    expect(needsSetup(row(false), false)).toBe(true)
    expect(needsSetup(row(true), false)).toBe(false)
    // A resolved profile needs no setup even when its credential is absent;
    // only the unresolved ones are setup candidates.
    expect(needsSetup(row(false), true)).toBe(false)
    expect(needsSetup(undefined, false)).toBe(true)
  })

  it('derives conventional credential references from route ids', () => {
    expect(deriveKeyRef('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(deriveKeyRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
  })

  it('uses one stable provider identity in action copy', () => {
    const target = { provider: 'deepseek-official', displayName: 'DeepSeek' }
    expect(providerTargetLabel(target)).toBe('DeepSeek (deepseek-official)')
    expect(providerCopy(en.deleteTitle, target)).toBe('Delete DeepSeek (deepseek-official)?')
    expect(providerTargetLabel(OPENAI_TARGET)).toBe('openai')
  })

  it('names only changed fields instead of rebuilding the section', () => {
    expect(pathOps(['providers', 'openai'], { baseURL: 'https://old', reasoning: 'high' }, { reasoning: 'high' }))
      .toEqual([{ op: 'unset', path: ['providers', 'openai', 'baseURL'] }])
    expect(pathOps([], { b: 1 }, { b: 2, d: 3 }))
      .toEqual([{ op: 'set', path: ['b'], value: 2 }, { op: 'set', path: ['d'], value: 3 }])
    expect(pathOps([], undefined, {})).toEqual([])
    expect(pathOps([], { a: 1 }, { a: 1 })).toEqual([])
  })

  it('reuses the provider editor as a required credential-only onboarding form', async () => {
    let finishSet: ((response: { ok: true; value: undefined }) => void) | undefined
    const set = vi.fn(() => new Promise<{ ok: true; value: undefined }>((resolve) => {
      finishSet = resolve
    }))
    const { face, mutate } = scriptedFace({ set })
    const onClose = vi.fn()
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')

    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      hideTitle
      namespace={wireNamespaces()[0]!}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      credentialOnly
      credentialRequired
      autoFocusCredential
      cancelLabelKey="onboardingLater"
      submitLabelKey="onboardingSave"
      submitBusyLabelKey="onboardingSaving"
      onClose={onClose}
    />)

    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    const save = screen.getByText<HTMLButtonElement>(en.onboardingSave)
    expect(document.activeElement).toBe(key)
    expect(key.required).toBe(true)
    expect(save.disabled).toBe(true)
    expect(screen.getByText(en.onboardingLater)).toBeTruthy()
    expect(screen.queryByText(en.customized)).toBeNull()
    expect(screen.queryByLabelText(en.baseUrl)).toBeNull()

    fireEvent.change(key, { target: { value: '   ' } })
    expect(screen.getByText(en.keyRequired)).toBeTruthy()
    expect(key.getAttribute('aria-invalid')).toBe('true')
    expect(save.disabled).toBe(true)

    fireEvent.change(key, { target: { value: '  sk-onboarding  ' } })
    expect(screen.queryByText(en.keyRequired)).toBeNull()
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    expect(await screen.findByText(en.onboardingSaving)).toBeTruthy()
    expect(set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-onboarding')
    expect(mutate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    if (finishSet === undefined) throw new Error('credential write did not start')
    await act(async () => {
      finishSet?.(remoteOk(undefined))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('applies customized deepseek fields as path ops', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getByText(en.customized))
    const baseURL = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    // The deepseek placeholder is pinned to the public endpoint, not the
    // effective value (which may reflect a launch-environment override).
    expect(baseURL.placeholder).toBe('https://api.deepseek.com')
    fireEvent.change(baseURL, { target: { value: 'https://next2' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // Only the field that actually changed: reasoningEffort was already
    // 'high' in the loaded profile, so it produces no op.
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{ op: 'set', path: ['baseURL'], value: 'https://next2' }],
      0,
    ])
  })

  it('materializes inherited models and adds an arbitrary DeepSeek id', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getByText(en.customized))
    expect(screen.getByText(en.modelsInherited)).toBeTruthy()
    expect(screen.getAllByLabelText(new RegExp(en.modelId)).map(input => (input as HTMLInputElement).value))
      .toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])

    fireEvent.click(screen.getByText(en.addModel))
    const ids = screen.getAllByLabelText(new RegExp(en.modelId))
    const names = screen.getAllByLabelText(new RegExp(en.modelName))
    expandRow(3)
    fireEvent.change(ids[2] as HTMLInputElement, { target: { value: 'private-preview' } })
    fireEvent.change(names[2] as HTMLInputElement, { target: { value: 'Private Preview' } })
    // Only row 3 is open, so its capacity is addressed by its own label.
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 3`), { target: { value: '131072' } })
    fireEvent.click(within(screen.getByRole('group', { name: `${en.modelInputTypes} 3` })).getByRole('checkbox', { name: en.modelInputImage }))
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{
        op: 'set',
        path: ['models'],
        value: [
          ...DEFAULT_DEEPSEEK_MODELS,
          { id: 'private-preview', name: 'Private Preview', contextWindow: 131_072, inputModalities: ['text', 'image'] },
        ],
      }],
      0,
    ])
  })

  it('edits the shared DeepSeek card while preserving the YAML protocol selection', async () => {
    const namespace: SettingsNamespaceView = {
      ...wireNamespaces()[0]!,
      ns: 'llm-deepseek',
      value: { protocol: 'messages', apiKeyEnv: 'DEEPSEEK_API_KEY', models: DEFAULT_DEEPSEEK_MODELS },
      user: {},
    }
    const { face, mutate, set } = scriptedFace({
      mutate: vi.fn(() => Promise.resolve(remoteOk(namespace))),
    })
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={namespace}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.click(screen.getByText(en.customized))
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).placeholder)
      .toBe('https://api.deepseek.com/anthropic')
    expect(screen.queryByLabelText(en.customApi)).toBeNull()
    expect(screen.getByText(en.deepSeekEndpointHint)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-messages-test' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://messages.example/anthropic' } })
    fireEvent.change(screen.getByLabelText(`${en.modelName} 1`), { target: { value: 'Messages Flash' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-messages-test') })
    expect(mutate.mock.calls).toEqual([[
      'llm-deepseek',
      [
        { op: 'set', path: ['baseURL'], value: 'https://messages.example/anthropic' },
        { op: 'set', path: ['models'], value: [
          { ...DEFAULT_DEEPSEEK_MODELS[0], name: 'Messages Flash' },
          DEFAULT_DEEPSEEK_MODELS[1],
        ] },
      ],
      0,
    ]])
  })

  it('rejects duplicate DeepSeek model ids before writing', async () => {
    const { mutate } = await mountDeepSeekCard()
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.click(screen.getByText(en.addModel))
    const ids = screen.getAllByLabelText(new RegExp(en.modelId))
    fireEvent.change(ids[2] as HTMLInputElement, { target: { value: 'deepseek-v4-flash' } })
    fireEvent.click(screen.getByText(en.apply))

    await screen.findByText(`Model 3: ${en.modelIdDuplicate}`)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('validates every adapter-owned model catalog invariant', () => {
    expect(modelDrafts(undefined)).toEqual([])
    expect(modelDrafts([null, 'bad', { id: 'ok' }])).toEqual([{}, {}, { id: 'ok' }])
    expect(validateDeepSeekModels([{}])).toEqual({ index: 0, key: 'modelIdRequired' })
    expect(validateDeepSeekModels([{ id: 'same' }, { id: 'same' }]))
      .toEqual({ index: 1, key: 'modelIdDuplicate' })
    expect(validateDeepSeekModels([{ id: 'model', name: '' }]))
      .toEqual({ index: 0, key: 'modelNameInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: null }]))
      .toEqual({ index: 0, key: 'modelContextInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: 1.5 }]))
      .toEqual({ index: 0, key: 'modelContextInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: 0 }]))
      .toEqual({ index: 0, key: 'modelContextInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', contextWindow: 1 }])).toBeUndefined()
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: null }]))
      .toEqual({ index: 0, key: 'modelMaxTokensInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: 1.5 }]))
      .toEqual({ index: 0, key: 'modelMaxTokensInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: 0 }]))
      .toEqual({ index: 0, key: 'modelMaxTokensInvalid' })
    expect(validateDeepSeekModels([{ id: 'model', maxTokens: 8192 }])).toBeUndefined()
  })

  it('reads context windows written as counts, thousands, or millions', () => {
    expect(parseCapacity('')).toBeUndefined()
    expect(parseCapacity('   ')).toBeUndefined()
    expect(parseCapacity('131072')).toBe(131_072)
    expect(parseCapacity(' 256K ')).toBe(256_000)
    expect(parseCapacity('256k')).toBe(256_000)
    expect(parseCapacity('1M')).toBe(1_000_000)
    expect(parseCapacity('1m')).toBe(1_000_000)
    // 1M is 1000K, not 1024K: capacities are quoted in decimal.
    expect(parseCapacity('1M')).toBe(parseCapacity('1000K'))
    // 2.3 * 1e6 is a few ULPs high in binary floating point; an integral
    // intent must not become a fractional count the validator rejects.
    expect(parseCapacity('2.3M')).toBe(2_300_000)
    expect(Number.isInteger(parseCapacity('1.5M'))).toBe(true)
    // A genuinely fractional count survives as one, for the validator to reject.
    expect(parseCapacity('0.0001K')).toBeCloseTo(0.1)
    expect(parseCapacity('abc')).toBeNaN()
    expect(parseCapacity('1G')).toBeNaN()
    expect(parseCapacity('1M1')).toBeNaN()
  })

  it('spells a stored count in the shortest form that round-trips', () => {
    expect(formatCapacity(1_000_000)).toBe('1M')
    expect(formatCapacity(256_000)).toBe('256K')
    expect(formatCapacity(1_500_000)).toBe('1500K')
    expect(formatCapacity(131_072)).toBe('131072')
    // Values the validator will reject are shown as-is rather than dressed up.
    expect(formatCapacity(Number.NaN)).toBe('NaN')
    expect(formatCapacity(0)).toBe('0')
    for (const text of ['1M', '256K', '131072', '1500K']) {
      expect(formatCapacity(parseCapacity(text) as number)).toBe(text)
    }
  })

  it('accepts a suffixed context window and stores the plain count', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getByText(en.customized))
    expandRow(1)
    expandRow(2)
    const windows = capacityInputs(en.contextWindow)
    // The inherited 1000000 reads back short.
    expect((windows[0] as HTMLInputElement).value).toBe('1M')

    // Keystrokes stay verbatim while the row has focus, so typing `1000` does
    // not rewrite itself to `1K` mid-word.
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: '1000' } })
    expect((windows[0] as HTMLInputElement).value).toBe('1000')
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: '1000K' } })
    expect((windows[0] as HTMLInputElement).value).toBe('1000K')
    // Blur settles the row to the canonical spelling of the same count.
    fireEvent.blur(windows[0] as HTMLInputElement)
    expect((windows[0] as HTMLInputElement).value).toBe('1M')

    fireEvent.change(windows[1] as HTMLInputElement, { target: { value: '256K' } })
    fireEvent.blur(windows[1] as HTMLInputElement)
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{
        op: 'set',
        path: ['models'],
        value: [
          { ...DEFAULT_DEEPSEEK_MODELS[0], contextWindow: 1_000_000 },
          { ...DEFAULT_DEEPSEEK_MODELS[1], contextWindow: 256_000 },
        ],
      }],
      0,
    ])
  })

  it('keeps unreadable context-window text on screen and refuses the write', async () => {
    const { mutate } = await mountDeepSeekCard()
    fireEvent.click(screen.getByText(en.customized))
    expandRow(1)
    expandRow(2)
    const windows = capacityInputs(en.contextWindow)
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: '1 gazillion' } })
    // Blurring a row that is not the edited one leaves the buffer alone.
    fireEvent.blur(windows[1] as HTMLInputElement)
    fireEvent.blur(windows[0] as HTMLInputElement)
    // The text the user typed is still there to correct.
    expect((windows[0] as HTMLInputElement).value).toBe('1 gazillion')

    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(`Model 1: ${en.modelContextInvalid}`)
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each([
    ['the schema default', undefined],
    ['the composition entry', { models: [{ id: 'pinned-by-deployment' }] }],
  ])('restores %s the moment the override is dropped, not after a reload', async (_label, base) => {
    // The regression: reset read the EFFECTIVE value, which still carries the
    // stored override until the unset is applied — so the rows did not change
    // and the catalog only looked restored after reopening the card.
    const { face } = scriptedFace()
    const stored = { models: [{ id: 'user-only-model', name: 'User Only' }] }
    const overridden: SettingsNamespaceView = {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: { ...stored, defaultContextWindow: 1_000_000 },
      ...base === undefined ? {} : { base },
      user: stored,
      applies: 'live',
      secrets: [],
      revision: 0,
    }
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={overridden}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      onClose={() => {}}
    />)
    fireEvent.click(screen.getByText(en.customized))
    expect(screen.getByText(en.modelsCustomized)).toBeTruthy()
    expect(screen.getAllByLabelText(new RegExp(en.modelId)).map(input => (input as HTMLInputElement).value))
      .toEqual(['user-only-model'])

    fireEvent.click(screen.getByText(en.resetModels))

    expect(screen.getByText(en.modelsInherited)).toBeTruthy()
    expect(screen.getAllByLabelText(new RegExp(en.modelId)).map(input => (input as HTMLInputElement).value))
      .toEqual(base === undefined ? ['deepseek-v4-flash', 'deepseek-v4-pro'] : ['pinned-by-deployment'])
  })

  it('keeps every row\'s unreadable text, not just the last one edited', async () => {
    // The regression: one active buffer meant editing a second row displaced
    // the first, which then fell back to rendering its stored NaN as `NaN` —
    // losing the text the user was told they could still correct.
    await mountDeepSeekCard()
    fireEvent.click(screen.getByText(en.customized))
    expandRow(1)
    expandRow(2)
    const windows = capacityInputs(en.contextWindow)
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: 'not a number' } })
    fireEvent.blur(windows[0] as HTMLInputElement)
    fireEvent.change(windows[1] as HTMLInputElement, { target: { value: '2M' } })

    expect((windows[0] as HTMLInputElement).value).toBe('not a number')
    expect((windows[1] as HTMLInputElement).value).toBe('2M')
  })

  it('re-keys the typed text around a removed row', async () => {
    await mountDeepSeekCard()
    fireEvent.click(screen.getByText(en.customized))
    const windows = (): HTMLInputElement[] => capacityInputs(en.contextWindow)
    const removeRow = (at: number): void => {
      fireEvent.click(screen.getAllByLabelText(new RegExp(en.removeModel))[at] as HTMLElement)
    }
    // Three rows, with text parked on the outer two.
    fireEvent.click(screen.getByText(en.addModel))
    expandRow(1)
    expandRow(2)
    expandRow(3)
    fireEvent.change(windows()[0] as HTMLInputElement, { target: { value: 'top text' } })
    fireEvent.blur(windows()[0] as HTMLInputElement)
    fireEvent.change(windows()[2] as HTMLInputElement, { target: { value: 'bottom text' } })
    fireEvent.blur(windows()[2] as HTMLInputElement)

    // Dropping the middle row leaves the row above untouched and carries the
    // row below down with its own text, rather than stranding it.
    removeRow(1)
    expect(windows()).toHaveLength(2)
    expect((windows()[0] as HTMLInputElement).value).toBe('top text')
    expect((windows()[1] as HTMLInputElement).value).toBe('bottom text')

    // Dropping a row that holds text takes that text with it; the survivor
    // keeps its own rather than inheriting the deleted row's.
    removeRow(0)
    expect(windows()).toHaveLength(1)
    expect((windows()[0] as HTMLInputElement).value).toBe('bottom text')
  })

  it('drops the typed text when reset replaces the rows it annotated', async () => {
    // The regression: reset removed the override but left the buffer, so an
    // inherited row displayed text no settings layer stores — and because an
    // unreadable buffer never settles, it stayed there indefinitely.
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getByText(en.customized))
    expandRow(1)
    const windows = capacityInputs(en.contextWindow)
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: 'garbage' } })
    fireEvent.blur(windows[0] as HTMLInputElement)
    fireEvent.click(screen.getByText(en.resetModels))

    // Reset collapses every row, so the restored capacity needs opening again.
    expandRow(1)
    const restored = capacityInputs(en.contextWindow)
    expect((restored[0] as HTMLInputElement).value).toBe('1M')

    // Reset put the draft back where it started, so Apply writes nothing at
    // all rather than persisting whatever the stale text had parsed to.
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(screen.queryByText(en.apply)).toBeNull() })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('edits an output cap per model and carries its text across a removal', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getByText(en.customized))
    expandRow(1)
    expandRow(2)
    // The profile's own cap is the placeholder both rows inherit.
    expect(capacityInputs(en.maxTokens).map(input => input.placeholder)).toEqual(['256K', '256K'])

    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 2`), { target: { value: '64K' } })
    fireEvent.blur(screen.getByLabelText(`${en.maxTokens} 2`))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 2`).value).toBe('64K')

    // Dropping the row above carries the cap text down with its own row.
    fireEvent.click(screen.getAllByLabelText(new RegExp(en.removeModel))[0] as HTMLElement)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 1`).value).toBe('64K')
    // The disclosure closes on a second press.
    expandRow(1)
    expect(screen.queryByLabelText(`${en.maxTokens} 1`)).toBeNull()

    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{
        op: 'set',
        path: ['models'],
        value: [{ ...DEFAULT_DEEPSEEK_MODELS[1], maxTokens: 64_000 }],
      }],
      0,
    ])
  })

  it('settles a pasted id and refuses whitespace that would never match', async () => {
    await mountDeepSeekCard()
    fireEvent.click(screen.getByText(en.customized))
    const ids = screen.getAllByLabelText<HTMLInputElement>(new RegExp(en.modelId))
    fireEvent.change(ids[0] as HTMLInputElement, { target: { value: '  deepseek-v4-flash  ' } })
    fireEvent.blur(ids[0] as HTMLInputElement)
    expect((ids[0] as HTMLInputElement).value).toBe('deepseek-v4-flash')
    // A settled id needs no second trim.
    fireEvent.blur(ids[0] as HTMLInputElement)
    expect((ids[0] as HTMLInputElement).value).toBe('deepseek-v4-flash')

    // An id that is only whitespace is as absent as an empty one, and a padded
    // id is a duplicate of its trimmed twin.
    expect(validateDeepSeekModels([{ id: '   ' }])).toEqual({ index: 0, key: 'modelIdRequired' })
    expect(validateDeepSeekModels([{ id: 'model' }, { id: 'model ' }]))
      .toEqual({ index: 1, key: 'modelIdDuplicate' })
  })

  it('renders malformed draft fallbacks without inventing catalog values', () => {
    render(<DeepSeekModelsEditor
      models={[{}]}
      overridden={false}
      defaultContextWindow={undefined}
      defaultMaxTokens={undefined}
      t={t}
      disabled={true}
      onChange={vi.fn()}
      onReset={vi.fn()}
    />)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('')
    expandRow(1)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 1`).placeholder)
      .toBe(en.contextWindowPlaceholder)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 1`).placeholder)
      .toBe(en.maxTokensPlaceholder)
  })

  it('can empty and reset the model override, then clear optional fields without dropping hidden data', async () => {
    const { mutate } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteOk(wireNamespaces()[0]))),
    })
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.click(screen.getAllByLabelText(new RegExp(en.removeModel))[0] as HTMLElement)
    fireEvent.click(screen.getByLabelText(new RegExp(en.removeModel)))
    expect(screen.getByText(en.modelsEmpty)).toBeTruthy()
    fireEvent.click(screen.getByText(en.resetModels))
    expect(screen.getByText(en.modelsInherited)).toBeTruthy()

    const names = screen.getAllByLabelText(new RegExp(en.modelName))
    expandRow(1)
    const windows = capacityInputs(en.contextWindow)
    fireEvent.change(names[0] as HTMLInputElement, { target: { value: '' } })
    fireEvent.change(windows[0] as HTMLInputElement, { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{
        op: 'set',
        path: ['models'],
        value: [
          { id: 'deepseek-v4-flash', description: 'Preserved hidden detail' },
          DEFAULT_DEEPSEEK_MODELS[1],
        ],
      }],
      0,
    ])
  })

  it('clears an inherited override with an unset op, never a whole-section replace', async () => {
    // A whole-section replace would clobber sibling overrides to clear one field.
    const { mutate } = await mountDeepSeekCard()
    fireEvent.click(screen.getByText(en.customized))
    const url = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(url.value).toBe('https://base')
    fireEvent.change(url, { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // This editor clears one field through an unset op so it cannot clobber
    // sibling overrides with a whole-section replacement.
    expect(mutate.mock.calls[0]).toEqual([
      'llm-deepseek',
      [{ op: 'unset', path: ['baseURL'] }],
      0,
    ])
  })

  it('pins the deepseek placeholder and clears typed input back to inherited', async () => {
    const { face } = scriptedFace()
    const bare: SettingsNamespaceView = {
      ns: 'llm-deepseek',
      schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
      value: {},
      applies: 'live',
      secrets: [],
      revision: 0,
    }
    const { ProviderEditor } = await import('../src/client/ProviderEditor.tsx')
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={bare}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      onClose={() => {}}
    />)
    fireEvent.click(screen.getByText(en.customized))
    const baseURL = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(baseURL.placeholder).toBe('https://api.deepseek.com')
    fireEvent.change(baseURL, { target: { value: 'https://x' } })
    expect(baseURL.value).toBe('https://x')
    fireEvent.change(baseURL, { target: { value: '' } })
    expect(baseURL.value).toBe('')
  })

  it('rejects an invalid draft before writing', async () => {
    const { mutate } = await mountDeepSeekCard()
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'not-a-url' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(/baseURL/)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('edits a pi-ai profile with the curated fields only', async () => {
    const scripted = scriptedFace()
    renderPiAiEditor(scripted.face, 'openai')
    // The configured credential shows as the stored placeholder.
    const editorKey = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    await waitFor(() => { expect(editorKey.placeholder).toBe(en.keyStored) })
    // pi-ai carries Base URL too: the stored override shows as the value and
    // the effective profile endpoint as its placeholder source.
    fireEvent.click(screen.getByText(en.customized))
    const url = screen.getByLabelText<HTMLInputElement>(en.baseUrl)
    expect(url.value).toBe('https://proxy')
    fireEvent.change(url, { target: { value: 'https://proxy/v2' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(scripted.mutate).toHaveBeenCalledTimes(1) })
    // Only the edited field travels: apiKeyEnv and headers were already stored
    // with these values, so no op restates them.
    expect(scripted.mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'openai', 'baseURL'], value: 'https://proxy/v2' }],
      0,
    ])
  })

  it('adds a dormant provider with a derived reference and stores its key', async () => {
    const scripted = scriptedFace()
    renderPiAiEditor(scripted.face, 'anthropic')
    // A dormant profile has no endpoint anywhere: the pi-ai placeholder
    // falls back to the provider-default wording.
    fireEvent.click(screen.getByText(en.customized))
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).placeholder).toBe(en.baseUrlDefault)
    const addKey = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    expect(addKey.placeholder).toBe(en.keyPlaceholderNative)
    fireEvent.change(addKey, { target: { value: 'sk-ant' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(scripted.mutate).toHaveBeenCalledTimes(1) })
    expect(scripted.mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'anthropic', 'apiKeyEnv'], value: 'ANTHROPIC_API_KEY' }],
      0,
    ])
    await waitFor(() => { expect(scripted.set).toHaveBeenCalledWith('ANTHROPIC_API_KEY', 'sk-ant') })
  })

  it('keeps pi-ai provider-native authentication when no key is entered', async () => {
    const scripted = scriptedFace()
    renderPiAiEditor(scripted.face, 'anthropic')
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(scripted.mutate).toHaveBeenCalledOnce() })
    expect(scripted.mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'anthropic'], value: {} }],
      0,
    ])
    expect(scripted.set).not.toHaveBeenCalled()
  })

  it('retries only the credential after refreshed settings already committed', async () => {
    const committed = wireNamespaces()[2]!
    const afterSettings: SettingsNamespaceView = {
      ...committed,
      value: { providers: {
        ...(committed.value as { providers: object }).providers,
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      } },
      user: { providers: {
        ...(committed.user as { providers: object }).providers,
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      } },
      revision: 1,
    }
    const mutate = vi.fn(() => Promise.resolve(remoteOk(afterSettings)))
    const set = vi.fn()
      .mockResolvedValueOnce(remoteFail('credential store unavailable'))
      .mockResolvedValueOnce(remoteOk(undefined))
    const scripted = scriptedFace({ mutate, set })
    renderPiAiEditor(scripted.face, 'anthropic')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.keyInput), { target: { value: 'sk-ant' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText('credential store unavailable')
    expect(mutate).toHaveBeenCalledOnce()
    // The accepted profile write advanced the editor's committed baseline, so
    // the retry re-runs only the credential write.
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(set).toHaveBeenCalledTimes(2) })
    expect(mutate).toHaveBeenCalledOnce()
    expect(set).toHaveBeenLastCalledWith('ANTHROPIC_API_KEY', 'sk-ant')
  })

  it('surfaces a rejected settings write and never stores the key after it', async () => {
    const scripted = scriptedFace({
      mutate: vi.fn(() => Promise.resolve(remoteFail('llm-pi-ai: unknown pi-ai provider "bogus"', 'settings/rejected'))),
    })
    renderPiAiEditor(scripted.face, 'anthropic')
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.keyInput), { target: { value: 'sk-x' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(/unknown pi-ai provider/)
    expect(scripted.set).not.toHaveBeenCalled()
  })

  it('renders the card without the stored-key hint when the credential probe is refused', async () => {
    const scripted = scriptedFace()
    scripted.face.credentials.describe = vi.fn(() => Promise.resolve(remoteFail('no credential provider')))
    renderDeepSeekEditor(scripted.face)
    const key = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    expect(key.placeholder).toBe(en.keyPlaceholder)
  })

  it('tells the user to reopen when another writer moved the namespace first', async () => {
    // The stale-draft overwrite: two tabs open the same card, the other saves,
    // and this one must be refused rather than replay its opening snapshot.
    const { set } = await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteFail('changed since it was read', 'settings/conflict'))),
    })
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.baseUrl), { target: { value: 'https://mine' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(en.conflict)
    expect(set).not.toHaveBeenCalled()
  })

  it('keeps the card usable after a refused write', async () => {
    await mountDeepSeekCard({
      mutate: vi.fn(() => Promise.resolve(remoteFail('the host refused', 'settings/rejected'))),
    })
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.baseUrl), { target: { value: 'https://next' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText('the host refused')
    // Not stuck in `applying…`: the finally cleared busy, so Apply is live again.
    expect(screen.getByText(en.apply)).toBeTruthy()
  })

  it('surfaces a shadowed credential write on the card', async () => {
    const scripted = scriptedFace({
      set: vi.fn(() => Promise.resolve(remoteFail('credentials: DEEPSEEK_API_KEY is shadowed by the read-only environment'))),
    })
    renderDeepSeekEditor(scripted.face)
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    fireEvent.change(key, { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByText(en.apply))
    await screen.findByText(/shadowed by the read-only environment/)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('locks the key input when the launch environment provides the credential', async () => {
    const scripted = scriptedFace()
    scripted.face.credentials.describe.mockImplementation((refs: string[]) => Promise.resolve(remoteOk(
      Object.fromEntries(refs.map(ref => [ref, {
        configured: ref === 'OPENAI_API_KEY', source: 'env', writable: false,
      }])),
    )))
    renderPiAiEditor(scripted.face, 'openai')
    const editorKey = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    await waitFor(() => { expect(editorKey.placeholder).toBe(en.keyEnvLocked) })
    expect(editorKey.disabled).toBe(true)
  })

  it('keeps a failed credential describe silent and the input usable', async () => {
    const scripted = scriptedFace()
    scripted.face.credentials.describe.mockImplementation(() => Promise.resolve(remoteFail('down', 'gateway/internal')))
    renderPiAiEditor(scripted.face, 'openai')
    const editorKey = await screen.findByLabelText<HTMLInputElement>(en.keyInput)
    expect(editorKey.placeholder).toBe(en.keyPlaceholderNative)
    fireEvent.change(editorKey, { target: { value: 'sk-live' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(scripted.set).toHaveBeenCalledTimes(1) })
  })

  it('requires confirmation before removing a user-added provider', async () => {
    const { mutate, unset } = await mountSection()
    fireEvent.click(providerRow('openai'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    const dialog = screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })
    expect(dialog.textContent).toContain(openaiCopy(en.deleteDescriptionWithCredential))
    expect(unset).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    fireEvent.click(within(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) }))
      .getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    fireEvent.click(within(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) }))
      .getByRole('button', { name: en.confirmDeleteAction }))
    await waitFor(() => { expect(unset).toHaveBeenCalledWith('OPENAI_API_KEY') })
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(unset.mock.invocationCallOrder[0]).toBeLessThan(mutate.mock.invocationCallOrder[0] as number)
    expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    expect(mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'unset', path: ['providers', 'openai'] }],
      undefined,
    ])
  })

  it('blocks duplicate deletion while the confirmed removal is pending', async () => {
    let resolveRemoval!: (response: { ok: true; value: SettingsNamespaceView }) => void
    const mutate = vi.fn(() => new Promise<{ ok: true; value: SettingsNamespaceView }>((resolve) => {
      resolveRemoval = resolve
    }))
    await mountSection({ mutate })
    fireEvent.click(providerRow('openai'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    const dialog = screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.confirmDeleteAction })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(confirm.disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.cancel }).disabled).toBe(true)
    expect(within(dialog).getByRole('button', { name: en.deletingAction })).toBe(confirm)
    await act(async () => { resolveRemoval(remoteOk(wireNamespaces()[2]!)) })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    })
  })

  it('renders the load failure with a retry control', async () => {
    const face = scriptedFace()
    face.face.llm.listProviders = vi.fn(() => Promise.resolve(remoteFail('directory down', 'gateway/internal'))) as never
    const controller = new ModelsSettingsStore(
      ctxWith(face.face), settingsSchema, new SettingsDescribeMirror(ctxWith(face.face)))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={wireOf(face.face)}
      schema={settingsSchema}
      t={t}
      picker={null}
      modelT={key => key}
      renderSlot={() => null}
    />)
    expect(screen.getByText(/directory down/)).toBeTruthy()
    fireEvent.click(screen.getByText(en.retry))
    await waitFor(() => { expect(screen.queryByText(/directory down/)).toBeNull() })
  })

  it('disables mutations for a read-only provider', async () => {
    const { face } = await mountSection()
    face.settings.describe.mockImplementation(() => Promise.resolve(remoteOk({
      writable: false,
      hasDocument: false,
      namespaces: wireNamespaces(),
    })))
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    await controller.load()
    cleanup()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={wireOf(face)}
      schema={settingsSchema}
      t={t}
      picker={null}
      modelT={key => key}
      renderSlot={() => null}
    />)
    // The sidebar's add action and the detail panel's delete are both inert.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.addProviderAction }).disabled).toBe(true)
    fireEvent.click(providerRow('openai'))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.remove }).disabled).toBe(true)
  })

  it('loads on first render of an idle controller', async () => {
    const { face } = scriptedFace()
    const controller = new ModelsSettingsStore(ctxWith(face), settingsSchema, new SettingsDescribeMirror(ctxWith(face)))
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={wireOf(face)}
      schema={settingsSchema}
      t={t}
      picker={null}
      modelT={key => key}
      renderSlot={() => null}
    />)
    await screen.findByText('DeepSeek')
  })

  it('removes by unsetting the profile path, never by rebuilding the section', async () => {
    // The page only needs to name the profile path; rebuilding the section
    // would widen the write for no benefit.
    const { face, mutate, controller } = await mountSection()
    await removeProviderProfile(
      { api: wireOf(face) },
      controller,
      { settingsNs: 'llm-plain', settingsPath: ['ghost-profile'] },
    )
    expect(mutate.mock.calls[0]).toEqual([
      'llm-plain',
      [{ op: 'unset', path: ['ghost-profile'] }],
      undefined,
    ])
  })

  it('keeps the snapshot untouched and reports the message when a removal write is refused', async () => {
    const { face, controller } = await mountSection({
      mutate: vi.fn(() => Promise.resolve(remoteFail('read-only', 'settings/rejected'))),
    })
    const before = controller.store.getSnapshot().rows
    const failure = await removeProviderProfile(
      { api: wireOf(face) },
      controller,
      { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    )
    expect(failure).toBe('read-only')
    expect(controller.store.getSnapshot().rows).toBe(before)
  })

  it('keeps a failed identified deletion recoverable in its confirmation dialog', async () => {
    const mutate = vi.fn()
      .mockResolvedValueOnce(remoteFail('the host refused', 'settings/rejected'))
      .mockResolvedValueOnce(remoteOk(wireNamespaces()[2]!))
    const { unset } = await mountSection({ mutate })
    fireEvent.click(providerRow('openai'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    const dialog = screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })
    const confirm = within(dialog).getByRole('button', { name: en.confirmDeleteAction })
    fireEvent.click(confirm)
    await within(dialog).findByText('the host refused')
    expect(screen.getByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBe(dialog)
    expect(unset).toHaveBeenCalledOnce()
    expect(mutate).toHaveBeenCalledOnce()

    fireEvent.click(confirm)
    await waitFor(() => { expect(unset).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: openaiCopy(en.deleteTitle) })).toBeNull()
    })
  })

  it('retains credentials that are not identified as page-managed', async () => {
    const { unset, mutate } = await mountSection()
    const target = { provider: 'zombie', displayName: 'zombie' }
    fireEvent.click(providerRow('zombie'))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.deleteTitle, target) })
    expect(dialog.textContent).toContain(providerCopy(en.deleteDescription, target))
    fireEvent.click(within(dialog).getByRole('button', { name: en.confirmDeleteAction }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
    expect(unset).not.toHaveBeenCalled()
    expect(mutate.mock.calls[0]).toEqual([
      'llm-pi-ai',
      [{ op: 'unset', path: ['providers', 'zombie'] }],
      undefined,
    ])
  })

  it('does not remove provider settings when its managed credential removal is refused', async () => {
    const { face, controller, mutate } = await mountSection({
      unset: vi.fn(() => Promise.resolve(remoteFail('credential is read-only'))),
    })
    const failure = await removeProviderProfile(
      { api: wireOf(face) },
      controller,
      {
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        credentialRef: 'OPENAI_API_KEY',
      },
    )
    expect(failure).toBe('credential is read-only')
    expect(mutate).not.toHaveBeenCalled()
  })

})

describe('apiKeyFailure', () => {
  it('treats a blank field as no failure — it means keep the stored key', () => {
    expect(apiKeyFailure('')).toBeUndefined()
  })

  it.each([
    ['a printable-ASCII key', 'sk-0123456789'],
    ['a padded key, which the caller trims', '  sk-abc  '],
    ['the printable-ASCII boundary characters', '!~'],
    ['a hyphenated key carrying an equals sign', 'sk-ABC=xyz'],
    ['an all-upper-case key ending in base64 padding', 'ABCD=='],
    ['an all-upper-case key ending in one padding character', 'MNOPQRST='],
  ])('accepts %s', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBeUndefined()
  })

  it.each([
    ['spaces', '   '],
    ['a tab', '\t'],
  ])('fails a field holding only %s instead of silently dropping it', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBe('keyBlank')
  })

  it.each([
    ['an emoji', 'sk-\u{1F600}'],
    ['CJK text', 'sk-你好'],
    ['full-width punctuation', 'sk-abc，'],
    ['an interior space', 'sk-abc def'],
    ['a C0 control character', 'sk-abc\x01'],
    ['a latin-1 character', 'sk-café'],
  ])('fails %s as illegal characters', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBe('keyIllegalCharacters')
  })

  it.each([
    ['a pasted environment line', 'DEEPSEEK_API_KEY=sk-abc'],
    ['double quotes', '"sk-abc"'],
    ['single quotes', '\'sk-abc\''],
    ['backticks', '`sk-abc`'],
  ])('fails %s as a format failure', (_label, draft) => {
    expect(apiKeyFailure(draft)).toBe('keyIllegalCharacters')
  })

  it('needs a matching closing quote before it calls a value wrapped', () => {
    // A lone quote and an unbalanced one are legal printable ASCII, so the
    // heuristic leaves them alone rather than guessing at a paste error.
    expect(apiKeyFailure('"')).toBeUndefined()
    expect(apiKeyFailure('"a')).toBeUndefined()
  })
})
