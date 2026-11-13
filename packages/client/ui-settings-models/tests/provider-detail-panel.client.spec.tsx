// @vitest-environment jsdom
/** The detail panel's local picker state survives settings echoes. */
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { ProviderDetailPanel, mergeRefreshedModels } from '../src/client/ProviderDetailPanel.tsx'
import { applyRefreshedModels } from '../src/client/provider-sync-apply.ts'
import { CATALOG_DECISIONS_CHANGED_EVENT, CATALOG_DECISIONS_MIRROR_KEY } from '../src/client/model-visibility.ts'
import { heavyStatusCache } from '../src/client/heavy-rpc.ts'
import type { ModelsWire, ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { translateEn } from './translate.client.ts'
import { settingsSchema } from './settings-schema.client.ts'
import styles from '../src/client/ModelsSection.module.css'

afterEach(() => {
  cleanup()
  heavyStatusCache.invalidate()
  localStorage.clear()
  vi.unstubAllGlobals()
})

const t = translateEn

const MODELS = [
  { id: 'free-a', name: 'Free A' },
  { id: 'free-b', name: 'Free B' },
  { id: 'free-c', name: 'Free C' },
  { id: 'paid', name: 'Paid' },
]

/** One stored key pool with a single identity. */
function pool(strategy: string) {
  return {
    strategy,
    identities: [{ id: 'primary', credentialRef: 'OPENAI_API_KEY', priority: 1, enabled: true }],
  }
}

/** One model row as the route stores it; only the visibility markers vary here. */
type TestModel = {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean | Record<string, string>
  reasoningEfforts?: false | Record<string, string | null>
  supported_parameters?: string[]
  tools?: boolean
  cost?: Record<string, number>
  input?: string[]
  inputModalities?: string[]
  advertisedInputModalities?: string[]
  nativeFileInputs?: {
    version?: number
    encoder?: string
    mime?: string[]
    perFileBytes?: number
    totalBytes?: number
    maxPayloadBytes?: number
    tokenReserve?: { perFile?: number; perByte?: number }
  }
  isFree?: boolean
  gated?: boolean
  gateReason?: string
  capabilityHints?: { input?: string[]; reasoning?: boolean; source?: string }
  unverified?: boolean
  source?: string
  deprecated?: boolean
}

/** One pi-ai namespace view; a fresh object is the store's settings echo. */
function namespace(
  provider: string,
  models: TestModel[],
  stored?: { strategy?: string; identities?: Array<{ id: string; credentialRef: string; priority?: number; enabled?: boolean }> },
  defaults?: { defaultContextWindow?: number; defaultMaxTokens?: number },
): SettingsNamespaceView {
  const profile = {
    displayName: provider,
    baseURL: 'https://proxy',
    api: 'openai-completions',
    models,
    ...stored === undefined ? {} : { pool: stored },
    ...defaults ?? {},
  }
  return {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { [provider]: profile } },
    user: { providers: { [provider]: profile } },
    autoGenerate: true,
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function row(provider: string): ProviderRow {
  return {
    entry: { provider, displayName: provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], active: true },
    configured: true,
    removable: true,
    apiKeyEnv: `${provider.toUpperCase()}_API_KEY`,
    credential: { configured: true, writable: true },
  }
}

/** The wire face the panel reaches; only the pool status read fires on mount. */
function wire(view?: SettingsNamespaceView): ModelsWire {
  return {
    settings: {
      describe: vi.fn(async () => ({
        ok: true as const,
        value: { writable: true, hasDocument: false, namespaces: view === undefined ? [] : [view] },
      })),
      update: vi.fn(),
      replace: vi.fn(),
      mutate: vi.fn(),
    },
    credentials: {
      describe: vi.fn(),
      set: vi.fn(async () => ({ ok: true as const, value: undefined })),
      unset: vi.fn(),
    },
    llm: {
      discoverModels: vi.fn(),
      listConfigurableProviders: vi.fn(),
      listProviders: vi.fn(),
      poolStatus: vi.fn(async () => ({ ok: true as const, value: [] })),
      poolResetCooldown: vi.fn(),
      poolTestIdentity: vi.fn(),
    },
  } as unknown as ModelsWire
}

function panel(
  provider: string,
  models: TestModel[] = MODELS,
  stored?: { strategy?: string; identities?: Array<{ id: string; credentialRef: string; priority?: number; enabled?: boolean }> },
  defaults?: { defaultContextWindow?: number; defaultMaxTokens?: number },
) {
  const ns = namespace(provider, models, stored, defaults)
  return (
    <ProviderDetailPanel
      row={row(provider)}
      namespace={ns}
      schema={settingsSchema}
      api={wire(ns)}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />
  )
}

it('keeps the model search and three consecutive toggles across a settings echo', () => {
  // The hidden-model write persists through fetch; the echo itself is the
  // fresh namespace identity the store publishes.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { ok: true } }) })))
  const view = render(panel('openai'))
  const search = screen.getByPlaceholderText<HTMLInputElement>(`Search ${MODELS.length} models...`)
  fireEvent.change(search, { target: { value: 'free' } })
  expect(screen.queryByText('Paid')).toBeNull()

  for (const id of ['free-a', 'free-b', 'free-c']) {
    fireEvent.click(screen.getByLabelText(`Hide ${id}`))
  }
  for (const id of ['free-a', 'free-b', 'free-c']) {
    expect(screen.getByLabelText(`Show ${id}`)).toBeTruthy()
  }

  // The backend echo lands: the store republishes a fresh namespace object.
  view.rerender(panel('openai'))

  expect(search.value).toBe('free')
  expect(screen.queryByText('Paid')).toBeNull()
  for (const id of ['free-a', 'free-b', 'free-c']) {
    expect(screen.getByLabelText(`Show ${id}`)).toBeTruthy()
  }
})

it('keeps an in-progress pool edit across a settings echo with the same pool', () => {
  // The strategy write never settles in this test, so the local edit is the
  // only state the select can show; before the value reconciliation, a fresh
  // namespace identity reset it to the stored strategy.
  const never = new Promise<never>(() => {})
  const ns = namespace('openai', MODELS, pool('priority-sticky'))
  const wireFace = { ...wire(ns), settings: { ...wire(ns).settings, mutate: vi.fn(() => never) } } as ModelsWire
  const element = (): ReactElement => (
    <ProviderDetailPanel
      row={row('openai')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />
  )
  const view = render(element())
  const strategy = screen.getByTitle<HTMLSelectElement>('How the pool picks among healthy keys')
  fireEvent.change(strategy, { target: { value: 'balanced' } })
  expect(strategy.value).toBe('balanced')

  // The backend echo lands: a fresh namespace object with the same stored pool.
  view.rerender(element())
  expect(screen.getByTitle<HTMLSelectElement>('How the pool picks among healthy keys').value).toBe('balanced')
})

it('resets the search only when the panel switches provider', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { ok: true } }) })))
  const view = render(panel('openai'))
  const search = screen.getByPlaceholderText<HTMLInputElement>(`Search ${MODELS.length} models...`)
  fireEvent.change(search, { target: { value: 'free' } })

  view.rerender(panel('anthropic'))

  expect(screen.getByPlaceholderText<HTMLInputElement>(`Search ${MODELS.length} models...`).value).toBe('')
})

it('renders a 501 identity-test answer as a disabled explanatory state, not a failure', async () => {
  const hint = 'Command Code identity testing is not implemented; run scripts/live-gate.mjs'
  const wireFace = wire()
  wireFace.llm.poolTestIdentity = vi.fn(async () => ({
    ok: true as const,
    value: { ok: false, status: 501, error: hint },
  })) as unknown as ModelsWire['llm']['poolTestIdentity']
  render(
    <ProviderDetailPanel
      row={row('commandcode')}
      namespace={namespace('commandcode', MODELS, pool('priority-sticky'))}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByTitle(en.poolTest))
  // The host said "not implemented", not "credential failed": every identity's
  // test button is disabled and carries the explanation as its tooltip, and
  // the card shows the same explanation.
  const disabled = await screen.findByTitle<HTMLButtonElement>(hint)
  expect(disabled.disabled).toBe(true)
})

it('renders the detail panel root container with the detailPanel class contract', () => {
  const { container } = render(panel('openai'))
  const panelEl = container.querySelector(`.${styles.detailPanel}`)
  expect(panelEl).not.toBeNull()
  expect(panelEl?.className).toContain(styles.detailPanel)
})

it('states the picker verdict on the eye and lets the operator override any hide', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { ok: true } }) })))
  render(panel('gateway', [
    { id: 'gateway/auto-free', name: 'Auto Free', isFree: true },
    { id: 'gateway/auto-efficient', name: 'Auto Efficient', isFree: false, gated: true, gateReason: 'sign-in required' },
    { id: 'gateway/silent-gate', name: 'Silent Gate', gated: true },
    { id: 'gateway/undisclosed', name: 'Undisclosed' },
  ]))

  const paid = screen.getByLabelText<HTMLButtonElement>('Show gateway/auto-efficient')
  expect(paid.disabled).toBe(false)
  expect(paid.title).toContain('sign-in required')
  // A gate the listing never explained still renders off, with a generic title.
  const silent = screen.getByLabelText<HTMLButtonElement>('Show gateway/silent-gate')
  expect(silent.disabled).toBe(false)
  expect(silent.title).toBe('Hidden in picker (click to show)')
  expect(screen.getByLabelText<HTMLButtonElement>('Hide gateway/auto-free').disabled).toBe(false)
  // An absent free/paid marker is undisclosed, not a paid claim.
  expect(screen.getByLabelText<HTMLButtonElement>('Hide gateway/undisclosed').disabled).toBe(false)

  // The operator clicks a gate-hidden row: it is pinned shown, not hidden again.
  fireEvent.click(paid)
  expect(screen.getByLabelText<HTMLButtonElement>('Hide gateway/auto-efficient').disabled).toBe(false)
  expect(JSON.parse(localStorage.getItem('dsh_shown_models_v1') ?? '{}')).toEqual({ gateway: ['gateway/auto-efficient'] })
})

it('follows a published picker decision when the rules engine hides a row, and can override it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { ok: true } }) })))
  render(panel('gateway', [{ id: 'rule-hidden', name: 'Rule Hidden' }]))
  expect(screen.getByLabelText<HTMLButtonElement>('Hide rule-hidden').disabled).toBe(false)

  await act(async () => {
    localStorage.setItem(CATALOG_DECISIONS_MIRROR_KEY, JSON.stringify({
      'gateway/rule-hidden': { state: 'hidden', reason: 'hidden by rule: no-training' },
    }))
    window.dispatchEvent(new CustomEvent(CATALOG_DECISIONS_CHANGED_EVENT))
  })

  const eye = screen.getByLabelText<HTMLButtonElement>('Show rule-hidden')
  expect(eye.disabled).toBe(false)
  expect(eye.title).toContain('no-training')

  // Overriding a rule hide pins the model shown for the picker.
  fireEvent.click(eye)
  expect(screen.getByLabelText<HTMLButtonElement>('Hide rule-hidden').disabled).toBe(false)
  expect(JSON.parse(localStorage.getItem('dsh_shown_models_v1') ?? '{}')).toEqual({ gateway: ['rule-hidden'] })
})

/** The heavy status envelope for a healthy configured Antigravity route. */
function heavyStatus(): unknown {
  return {
    id: 'antigravity',
    configured: true,
    health: { ok: true, status: 200, checkedAt: 1 },
    platform: 'linux',
    runtime: { docker: false, podman: false },
    preflight: { path: 'node', label: 'Install locally (npm + user service)', missing: [], requires: [] },
  }
}

/** Stub the gateway so the heavy card's status read answers. */
function stubHeavyFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { method?: string }
    if (body.method === 'enpoiHeavy.status') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { ok: true, value: heavyStatus() } }),
      } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { ok: true, value: {} } }),
    } as unknown as Response
  }))
}

it('auto-populates a healthy heavy route with no models, without a Refresh click', async () => {
  stubHeavyFetch()
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)', contextWindow: 200_000, maxTokens: 64_000 }],
  }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('antigravity', [])
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('antigravity')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  await waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(1) })
  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  const [, ops] = mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string }> }>]
  expect(ops[0]?.path).toEqual(['providers', 'antigravity', 'models'])
  expect(ops[0]?.value.map(model => model.id)).toEqual(['gemini-3.1-pro-high'])
})

it('the automatic pass keeps a configured id the discovered catalog does not advertise', async () => {
  stubHeavyFetch()
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' }],
  }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  // The row an older build wrote: the fabricated fallback id alone.
  const ns = namespace('antigravity', [{ id: 'gemini-2.5-flash' }])
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('antigravity')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  await waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(1) })
  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  const [, ops] = mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string }> }>]
  // Discovery merges, never replaces: the configured id stays ahead of the
  // newly advertised one.
  expect(ops[0]?.value.map(model => model.id)).toEqual(['gemini-2.5-flash', 'gemini-3.1-pro-high'])
})

it('an automatic heavy refresh failure stays silent; the manual path still reports it', async () => {
  stubHeavyFetch()
  const discoverModels = vi.fn(async () => ({
    ok: false as const,
    error: { message: 'No accounts available' },
  }))
  const ns = namespace('antigravity', [])
  const base = wire(ns)
  const wireFace = {
    ...base,
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('antigravity')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  await waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(1) })
  // Fail-soft: the automatic pass renders nothing; the Models Refresh button
  // remains the surface that reports the failure.
  expect(screen.queryByText(/Refresh failed/)).toBeNull()
  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await waitFor(() => { expect(screen.getByText(/Refresh failed: No accounts available/)).toBeTruthy() })
})

it('Refresh merges the answer into settings without deleting or stripping configured models', async () => {
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [
      // Re-listed bare: every configured per-id field must survive.
      { id: 'configured' },
      // Newly advertised: appended after the configured rows.
      { id: 'advertised', name: 'Advertised', inputModalities: ['text', 'image'] },
    ],
  }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('gateway', [
    {
      id: 'configured',
      name: 'Hand Name',
      contextWindow: 111_111,
      maxTokens: 2_222,
      reasoning: true,
      tools: true,
      input: ['text', 'image'],
    },
    { id: 'retired', name: 'Retired', contextWindow: 9_999 },
  ])
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('gateway')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  const [, ops] = mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: TestModel[] }>]
  expect(ops[0]?.path).toEqual(['providers', 'gateway', 'models'])
  expect(ops[0]?.value).toEqual([
    // The advertised-but-bare id keeps its configured fields untouched.
    {
      id: 'configured',
      name: 'Hand Name',
      contextWindow: 111_111,
      maxTokens: 2_222,
      reasoning: true,
      tools: true,
      input: ['text', 'image'],
    },
    // The configured id the answer omitted stays exactly as configured.
    { id: 'retired', name: 'Retired', contextWindow: 9_999 },
    // The newly advertised id carries what the answer disclosed.
    { id: 'advertised', name: 'Advertised', input: ['text', 'image'] },
  ])
})

it('Refresh never writes route capacity defaults into a newly advertised row', async () => {
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'fresh' }],
  }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('gateway', [], undefined, { defaultContextWindow: 1_000_000, defaultMaxTokens: 16_384 })
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('gateway')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  const [, ops] = mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: TestModel[] }>]
  // Route defaults are execution fallbacks, not per-model facts: an
  // undisclosed capacity stays absent from the stored row.
  expect(ops[0]?.value).toEqual([{ id: 'fresh', name: 'fresh' }])
})

it('renders no capability badges from id heuristics alone', () => {
  render(panel('gateway', [
    { id: 'xiaomi/mimo-v2.6-pro' },
    { id: 'space-bunny-preview' },
    { id: 'openai/gpt-5-mini' },
    { id: 'claude-sonnet-4-6' },
    { id: 'zzz-mystery-model' },
  ]))

  // An id alone states nothing: no tools default, no reasoning, no modality.
  expect(screen.queryByTitle('Tool Calling')).toBeNull()
  expect(screen.queryByTitle('Reasoning / Thinking')).toBeNull()
  expect(screen.queryByTitle('Vision / Image')).toBeNull()
  expect(screen.queryByTitle('Audio Processing')).toBeNull()
  expect(screen.queryByTitle('Video Processing')).toBeNull()
  expect(screen.queryByTitle('Documents & Files')).toBeNull()
})

it('renders disclosed capability badges as facts and stored hints as unverified', () => {
  // The model cards render both a name and an id tag; name the rows so the id
  // tag is a unique anchor for scoping assertions to one card.
  const { container } = render(panel('gateway', [
    // Disclosed: structured modalities and explicit flags are facts.
    { id: 'vendor/solid-model', name: 'Solid', input: ['text', 'image'], reasoning: true, tools: true },
    // Nothing disclosed: no badge comes from the id table.
    { id: 'openai/gpt-5-mini', name: 'Unstated' },
    // The sync's labeled, override-applied hints suppress the shipped claims.
    { id: 'claude-sonnet-owner', name: 'Owner Hidden', capabilityHints: { input: [], source: 'owner-override' } },
    // A persisted owner pin renders, but only as an unverified hint.
    { id: 'zzz-pinned-model', name: 'Pinned', capabilityHints: { input: ['audio'], reasoning: true, source: 'owner-override' } },
    // The sync's own row shape: floor input/reasoning plus the labeled hints
    // (the floor is not a disclosure of absence).
    {
      id: 'zzz-synced-hinted',
      name: 'Synced',
      input: ['text'],
      reasoning: false,
      unverified: true,
      capabilityHints: { input: ['image', 'pdf'], reasoning: true, source: 'shipped-hints' },
    },
  ]))
  const cardFor = (id: string): Element => {
    const tag = screen.getByText(id)
    const card = tag.closest(`.${styles['modelCard']}`)
    expect(card).not.toBeNull()
    return card as Element
  }
  const badge = (id: string, title: string): HTMLElement | null => within(cardFor(id) as HTMLElement).queryByTitle(title)
  const hintBadge = (id: string, capability: string): HTMLElement => {
    const found = within(cardFor(id) as HTMLElement).getByTitle(`${capability} — ${en.capHintUnverified}`)
    return found
  }
  expect(container.querySelectorAll(`.${styles['modelCard']}`)).toHaveLength(5)

  // Disclosed facts render without the hint marker.
  expect(badge('vendor/solid-model', 'Vision / Image')?.getAttribute('data-hint')).toBeNull()
  expect(badge('vendor/solid-model', 'Reasoning / Thinking')?.getAttribute('data-hint')).toBeNull()
  expect(badge('vendor/solid-model', 'Tool Calling')?.getAttribute('data-hint')).toBeNull()

  // Nothing disclosed: the id table no longer manufactures a badge.
  expect(badge('openai/gpt-5-mini', 'Vision / Image')).toBeNull()
  expect(badge('openai/gpt-5-mini', 'Reasoning / Thinking')).toBeNull()
  expect(badge('openai/gpt-5-mini', 'Documents & Files')).toBeNull()
  expect(badge('openai/gpt-5-mini', 'Tool Calling')).toBeNull()

  // A stored hint set is shown, but every hinted badge names its uncertainty.
  expect(badge('claude-sonnet-owner', 'Vision / Image')).toBeNull()
  expect(badge('claude-sonnet-owner', 'Documents & Files')).toBeNull()
  expect(badge('claude-sonnet-owner', 'Reasoning / Thinking')).toBeNull()
  expect(hintBadge('zzz-pinned-model', 'Audio Processing').getAttribute('data-hint')).toBe('audio')
  expect(hintBadge('zzz-pinned-model', 'Audio Processing').getAttribute('data-unverified')).toBe('true')
  expect(hintBadge('zzz-pinned-model', 'Reasoning / Thinking').getAttribute('data-hint')).toBe('reasoning')

  // The sync's floor values yield to its own labeled hints, and its row-level
  // unverified marker renders as a badge.
  expect(hintBadge('zzz-synced-hinted', 'Vision / Image').getAttribute('data-hint')).toBe('vision')
  expect(hintBadge('zzz-synced-hinted', 'Documents & Files').getAttribute('data-hint')).toBe('files')
  expect(hintBadge('zzz-synced-hinted', 'Reasoning / Thinking').getAttribute('data-hint')).toBe('reasoning')
  expect(within(cardFor('zzz-synced-hinted') as HTMLElement).getByTitle(en.capUnverifiedHint).textContent)
    .toBe(en.capUnverifiedBadge)
  expect(within(cardFor('zzz-synced-hinted') as HTMLElement).getByText(en.capHintUnverified)).toBeTruthy()
})

it('treats an explicit reasoning:false as a fact and leaves undisclosed capabilities empty', () => {
  render(panel('gateway', [{ id: 'openai/gpt-5-api', name: 'No Think', reasoning: false }]))
  expect(screen.queryByTitle('Reasoning / Thinking')).toBeNull()
  expect(screen.queryByTitle('Vision / Image')).toBeNull()
  expect(screen.queryByTitle('Tool Calling')).toBeNull()
})

it('marks advertised audio/video/pdf as declared but not sent natively', () => {
  render(panel('gateway', [
    {
      id: 'declared-only',
      name: 'Declared Only',
      input: ['text', 'image', 'audio', 'video', 'pdf'],
      advertisedInputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    },
    {
      id: 'native',
      name: 'Native',
      input: ['text', 'image'],
      advertisedInputModalities: ['text', 'image'],
    },
  ]))

  const cardFor = (id: string): HTMLElement => {
    const tag = screen.getByText(id)
    const card = tag.closest(`.${styles['modelCard']}`)
    expect(card).not.toBeNull()
    return card as HTMLElement
  }
  expect(within(cardFor('declared-only')).getByTitle('Vision / Image')).toBeTruthy()
  expect(within(cardFor('declared-only')).queryByTitle('Audio Processing')).toBeNull()
  expect(within(cardFor('declared-only')).getByTitle(en.capDeclaredNotNativeTitle.replace('{capability}', en.capAudio))).toBeTruthy()
  expect(cardFor('declared-only').querySelector('[data-advertised-only="audio"]')).toBeTruthy()
  expect(cardFor('declared-only').querySelector('[data-advertised-only="video"]')).toBeTruthy()
  expect(cardFor('declared-only').querySelector('[data-advertised-only="pdf"]')).toBeTruthy()
  expect(within(cardFor('declared-only')).getByText(en.capDeclaredNotNative)).toBeTruthy()
  expect(cardFor('native').querySelector('[data-advertised-only]')).toBeNull()
})

it('treats a declared native-file descriptor as native support instead of declared-only', () => {
  const descriptor = (mime: string[]) => ({
    version: 1,
    encoder: 'openai-chat-file',
    mime,
    perFileBytes: 1_000,
    totalBytes: 2_000,
    maxPayloadBytes: 4_000,
    tokenReserve: { perFile: 10, perByte: 0.5 },
  })
  render(panel('gateway', [
    {
      id: 'native-pdf',
      name: 'Native PDF',
      input: ['text', 'pdf'],
      advertisedInputModalities: ['text', 'pdf'],
      nativeFileInputs: descriptor(['application/pdf']),
    },
    {
      id: 'native-audio-declared-pdf',
      name: 'Native Audio',
      input: ['text', 'audio', 'pdf'],
      advertisedInputModalities: ['text', 'audio', 'pdf'],
      nativeFileInputs: descriptor(['audio/mpeg']),
    },
  ]))

  const findCard = (modelId: string): HTMLElement => {
    const el = screen.getByText(modelId).closest(`.${styles['modelCard']}`)
    if (el === null) throw new Error(`card for ${modelId} not found`)
    return el as HTMLElement
  }
  expect(within(findCard('native-pdf')).getByTitle('Documents & Files')).toBeTruthy()
  expect(findCard('native-pdf').querySelector('[data-advertised-only="pdf"]')).toBeNull()
  expect(within(findCard('native-pdf')).queryByText(en.capDeclaredNotNative)).toBeNull()
  // Only the kind the encoder carries becomes native; the declared PDF stays
  // disclosure-side while native audio gains its badge.
  expect(within(findCard('native-audio-declared-pdf')).getByTitle('Audio Processing')).toBeTruthy()
  expect(findCard('native-audio-declared-pdf').querySelector('[data-advertised-only="audio"]')).toBeNull()
  expect(findCard('native-audio-declared-pdf').querySelector('[data-advertised-only="pdf"]')).toBeTruthy()
})

describe('mergeRefreshedModels', () => {
  it('merges only disclosed values and never invents capacities', () => {
    const configured: TestModel[] = [{ id: 'm' }]
    expect(mergeRefreshedModels(configured, [{ id: 'm' }])[0]).toEqual({ id: 'm', name: 'm' })
    expect(mergeRefreshedModels(configured, [{ id: 'm', contextWindow: 1_000, maxTokens: 2_000 }])[0])
      .toEqual({ id: 'm', name: 'm', contextWindow: 1_000, maxTokens: 2_000 })
  })

  it('keeps entries without a usable id and collapses duplicate ids', () => {
    const merged = mergeRefreshedModels(
      [{ id: '' }, { id: undefined as unknown as string }, { id: 'dup', name: 'First' }, { id: 'dup', name: 'Second' }],
      [{ id: 'dup', name: 'Fresh' }, { id: 'dup', name: 'Fresh again' }, { id: 'new' }],
    )
    expect(merged.map(model => model.id)).toEqual(['', undefined, 'dup', 'new'])
    // The first answer for a duplicate id is the one that refreshes.
    expect(merged[2]).toEqual({ id: 'dup', name: 'Fresh' })
  })

  it('refreshes an advertised id in place and preserves per-id fields the answer omits', () => {
    const configured: TestModel[] = [
      { id: 'a', name: 'Hand', contextWindow: 111, maxTokens: 22, reasoning: true, tools: true, input: ['text', 'image'] },
      { id: 'b', name: 'Bee', contextWindow: 333 },
      { id: 'c', name: 'Cee' },
      { id: 'd' },
      { id: 'e', name: 'Eee', contextWindow: 555, maxTokens: 66 },
      { id: 'f', name: 'Eff', contextWindow: 777 },
    ]
    const discovered = [
      // A name echoing the id keeps the configured name; nothing else disclosed.
      { id: 'a', name: 'a' },
      // A rich disclosure refreshes in place, gaps and all.
      {
        id: 'b',
        name: 'Bee Live',
        contextWindow: 444,
        maxTokens: 55,
        inputModalities: ['text', 'image', 'audio'],
        reasoning: false,
        reasoningEfforts: { high: 'high' },
        supported_parameters: ['tools'],
        tools: false,
        cost: { input: 1 },
        gated: true,
        gateReason: 'sign-in required',
        isFree: false,
      },
      // A nameless answer keeps the configured name; capacities stay configured.
      { id: 'c' },
      // No configured name and no answer name: the id is the label.
      { id: 'd' },
      // An empty modality list states no answer.
      { id: 'e', inputModalities: [] },
      // A gate without a reason is still a gate.
      { id: 'f', gated: true },
    ]

    expect(mergeRefreshedModels(configured, discovered)).toEqual([
      { id: 'a', name: 'Hand', contextWindow: 111, maxTokens: 22, reasoning: true, tools: true, input: ['text', 'image'] },
      {
        id: 'b',
        name: 'Bee Live',
        contextWindow: 444,
        maxTokens: 55,
        input: ['text', 'image', 'audio'],
        reasoning: false,
        reasoningEfforts: { high: 'high' },
        supported_parameters: ['tools'],
        tools: false,
        cost: { input: 1 },
        gated: true,
        gateReason: 'sign-in required',
        isFree: false,
      },
      { id: 'c', name: 'Cee' },
      { id: 'd', name: 'd' },
      { id: 'e', name: 'Eee', contextWindow: 555, maxTokens: 66 },
      { id: 'f', name: 'Eff', contextWindow: 777, gated: true },
    ])
  })

  it('drops a stale configured ladder when the endpoint explicitly reports an empty one', () => {
    const configured: TestModel[] = [
      { id: 'm', name: 'Hand', reasoning: true, reasoningEfforts: { high: 'high', off: null } },
      // Nothing disclosed keeps the stored ladder: absence is not a retraction.
      { id: 'n', reasoning: true, reasoningEfforts: { low: 'low' } },
    ]
    expect(mergeRefreshedModels(configured, [
      // The endpoint states no selectable level; the disclosed reasoning flag
      // stays, and the stale effort mapping does not.
      { id: 'm', reasoning: true, reasoningEfforts: {} },
      { id: 'n', reasoning: true },
    ])).toEqual([
      { id: 'm', name: 'Hand', reasoning: true },
      { id: 'n', name: 'n', reasoning: true, reasoningEfforts: { low: 'low' } },
    ])
  })

  it('preserves a disclosed false and a populated ladder, including its off meaning', () => {
    const merged = mergeRefreshedModels([], [
      // An explicit false is an answer and survives as one.
      { id: 'plain', reasoning: false, reasoningEfforts: false },
      // A usable ladder keeps the canonical spelling; discovery's empty
      // `off` wire becomes the schema's `null`.
      { id: 'ladder', reasoning: true, reasoningEfforts: { low: 'low', high: 'high', off: '' } },
      // A stated but unusable ladder is omitted rather than persisted.
      { id: 'empty', reasoning: true, reasoningEfforts: {} },
    ])
    expect(merged).toEqual([
      { id: 'plain', name: 'plain', reasoning: false, reasoningEfforts: false },
      { id: 'ladder', name: 'ladder', reasoning: true, reasoningEfforts: { off: null, low: 'low', high: 'high' } },
      { id: 'empty', name: 'empty', reasoning: true },
    ])
  })

  it('appends an advertised id the configuration does not name, carrying what it disclosed', () => {
    const merged = mergeRefreshedModels(
      [{ id: 'kept' }],
      [
        // A real label, capacities, modalities, and a gate reason.
        {
          id: 'g',
          name: 'Gee',
          contextWindow: 4_000,
          maxTokens: 500,
          inputModalities: ['text', 'pdf'],
          tools: true,
          gated: true,
          gateReason: 'sign-in required',
        },
        // A name echoing the id is not a label; an empty modality list is not a claim.
        { id: 'h', name: 'h', inputModalities: [] },
        // Nothing but an id: no capacities and no capabilities are invented.
        { id: 'i' },
      ],
    )

    expect(merged).toEqual([
      { id: 'kept' },
      {
        id: 'g',
        name: 'Gee',
        contextWindow: 4_000,
        maxTokens: 500,
        input: ['text', 'pdf'],
        tools: true,
        gated: true,
        gateReason: 'sign-in required',
      },
      // The answer left these rows unsized: no route default fills them.
      { id: 'h', name: 'h' },
      { id: 'i', name: 'i' },
    ])
  })
})

it('manual Refresh uses the removal-aware host pipeline when providerSync answers', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('providerSync.refreshRoute')) {
      return {
        ok: true,
        json: async () => ({
          result: {
            ok: true,
            value: {
              route: 'gateway',
              models: [{ id: 'kept-server', name: 'Kept Fresh' }],
              removed: ['removed-server'],
              deprecated: [],
              degraded: false,
              source: 'live',
              authority: 'catalog',
              fetchedAt: 5,
            },
          },
        }),
      } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  const discoverModels = vi.fn()
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('gateway', [
    { id: 'kept-server' },
    { id: 'removed-server' },
    { id: 'hand', source: 'manual' },
  ])
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('gateway')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  const [, ops] = mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string }> }>]
  expect(ops[0]?.path).toEqual(['providers', 'gateway', 'models'])
  // Replace semantics: the host answer wins, the host's `removed` list is the
  // sole deletion gate (so the unlisted manual row survives), and the
  // discovery path was not consulted.
  expect(ops[0]?.value.map(model => model.id)).toEqual(['kept-server', 'hand'])
  expect(discoverModels).not.toHaveBeenCalled()
})

it('manual Refresh falls back to the non-deleting discovery merge when the RPC is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)))
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'advertised', name: 'Advertised' }],
  }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('gateway', [{ id: 'configured' }])
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('gateway')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await waitFor(() => { expect(discoverModels).toHaveBeenCalled() })
  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  const [, ops] = mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string }> }>]
  // The fallback merges and never deletes.
  expect(ops[0]?.value.map(model => model.id)).toEqual(['configured', 'advertised'])
})

it('manual Refresh drops a stale ladder when the discovery fallback reports an empty one', async () => {
  // provider-sync is unavailable, so the plain discovery merge owns the write.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)))
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'configured', reasoning: true, reasoningEfforts: {} }],
  }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('gateway', [{ id: 'configured', reasoning: true, reasoningEfforts: { high: 'high' } }])
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('gateway')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  const [, ops] = mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: Array<Record<string, unknown>> }>]
  // The endpoint's explicit empty ladder clears the stale mapping; the
  // disclosed reasoning flag stays, and no ladder is invented.
  expect(ops[0]?.value).toEqual([{ id: 'configured', name: 'configured', reasoning: true }])
})

it('manual Refresh keeps a degraded host answer\'s empty ladder out of the persisted route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: {
        ok: true,
        value: {
          route: 'gateway',
          models: [{ id: 'kept-server', reasoning: true, reasoningEfforts: {} }],
          removed: [],
          deprecated: [],
          degraded: true,
          degradedReason: 'shrink guard',
          source: 'live',
          authority: 'catalog',
          fetchedAt: 5,
        },
      },
    }),
  } as unknown as Response)))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('gateway', [{ id: 'kept-server' }])
  const base = wire(ns)
  const api = { ...base, settings: { ...base.settings, mutate } } as unknown as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('gateway')}
      namespace={ns}
      schema={settingsSchema}
      api={api}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  const [, ops] = mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: Array<Record<string, unknown>> }>]
  // A degraded answer still replaces membership, but an invalid empty ladder
  // never reaches the settings write.
  expect(ops[0]?.value).toEqual([{ id: 'kept-server', reasoning: true }])
})

describe('applyRefreshedModels', () => {
  it('takes the answer as the base, keeps unlisted rows, and drops only reported removals', () => {
    const current: TestModel[] = [
      { id: 'kept-server', name: 'Kept' },
      { id: 'removed-server', name: 'Gone' },
      // The panel's own draft row, not yet written back and carrying no manual
      // stamp: the host never reported it removed, so it must survive.
      { id: 'typed-row', name: 'Typed' },
      { id: 'hand', name: 'Hand', source: 'manual' },
      { id: 'hand-in-answer', source: 'manual' },
      { id: '', source: 'manual' },
    ]
    const answer = [
      { id: 'kept-server', name: 'Kept Fresh' },
      { id: 'new-from-server' },
      { id: 'hand-in-answer', source: 'manual' },
      { name: 'no-id' },
    ]
    expect(applyRefreshedModels(current, answer, ['removed-server'])).toEqual([
      { id: 'kept-server', name: 'Kept Fresh' },
      { id: 'new-from-server' },
      { id: 'hand-in-answer', source: 'manual' },
      { name: 'no-id' },
      { id: 'typed-row', name: 'Typed' },
      { id: 'hand', name: 'Hand', source: 'manual' },
    ])
  })

  it('survives a refresh whose answer omits a typed row the host did not report removed', () => {
    // F4: the host answer is replace-semantics for what it lists, but the
    // `removed` list is the only deletion gate — an omitted non-manual row the
    // operator just typed is retained with its fields and stamp.
    const current: TestModel[] = [{ id: 'typed', name: 'Typed', contextWindow: 42 }]
    expect(applyRefreshedModels(current, [{ id: 'server-row' }], [])).toEqual([
      { id: 'server-row' },
      { id: 'typed', name: 'Typed', contextWindow: 42 },
    ])
    // The same row is dropped once the host reports it removed.
    expect(applyRefreshedModels(current, [{ id: 'server-row' }], ['typed'])).toEqual([
      { id: 'server-row' },
    ])
  })
})

it('renders the deprecated-upstream badge on a pinned-in-use model row', () => {
  render(panel('gateway', [
    { id: 'active', name: 'Active' },
    { id: 'retired', name: 'Retired', deprecated: true, source: 'pinned-in-use' },
  ]))
  const badge = document.querySelector('[data-model-badge="deprecated"]')
  expect(badge?.textContent).toBe(en.modelDeprecatedBadge)
  expect(badge?.getAttribute('title')).toBe(en.modelDeprecatedHint)
  expect(document.querySelectorAll('[data-model-badge="deprecated"]')).toHaveLength(1)
})

it('manual Refresh reports a failed settings write after the host refresh answers', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: {
        ok: true,
        value: {
          route: 'gateway', models: [{ id: 'kept-server' }], removed: [], deprecated: [],
          degraded: false, source: 'live', authority: 'catalog', fetchedAt: 5,
        },
      },
    }),
  } as unknown as Response)))
  const mutate = vi.fn(async () => ({ ok: false as const, error: { message: 'write refused' } }))
  const ns = namespace('gateway', [{ id: 'kept-server' }])
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
  } as unknown as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('gateway')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await waitFor(() => { expect(screen.getByText(/Refresh failed: write refused/)).toBeTruthy() })
})

it('manual Refresh treats an unusable RPC payload as unavailable and falls back to discovery', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ result: { ok: true, value: { route: 'gateway' } } }),
  } as unknown as Response)))
  const discoverModels = vi.fn(async () => ({ ok: true as const, value: [{ id: 'advertised' }] }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('gateway', [{ id: 'configured' }])
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('gateway')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await waitFor(() => { expect(discoverModels).toHaveBeenCalled() })
})

/** One conflict refusal with the details the panel's fence reports. */
function conflictRefusal(ns: string) {
  return { ok: false as const, error: new RemoteError('settings/conflict', 'stale', { ns, expected: 0, actual: 1 }) }
}

/**
 * A panel wire whose describe hands out `first` once and `second` afterwards,
 * so a conflict retry must replan against a different revision.
 */
function movingConflictWire(
  first: SettingsNamespaceView,
  second: SettingsNamespaceView,
  mutate: ReturnType<typeof vi.fn>,
): ModelsWire {
  const base = wire(first)
  const describe = vi.fn()
    .mockResolvedValueOnce({ ok: true as const, value: { writable: true, hasDocument: false, namespaces: [first] } })
    .mockResolvedValue({ ok: true as const, value: { writable: true, hasDocument: false, namespaces: [second] } })
  return { ...base, settings: { ...base.settings, describe, mutate } } as unknown as ModelsWire
}

/** Render the detail panel for one route over an explicit wire. */
function renderPanel(
  provider: string,
  ns: SettingsNamespaceView,
  api: ModelsWire,
  onSaved: (view?: SettingsNamespaceView) => void = vi.fn(),
): ReturnType<typeof render> {
  return render(
    <ProviderDetailPanel
      row={row(provider)}
      namespace={ns}
      schema={settingsSchema}
      api={api}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={onSaved}
    />,
  )
}

describe('fenced conflict retries', () => {
  it('re-applies the save draft after a conflict and writes the fresh revision', async () => {
    const mutate = vi.fn()
      .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
      .mockResolvedValue({ ok: true as const, value: undefined })
    const first = namespace('gateway', MODELS)
    const api = movingConflictWire(first, { ...namespace('gateway', MODELS), revision: 1 }, mutate)
    renderPanel('gateway', first, api)

    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), { target: { value: 'https://mine/v1' } })
    const saves = screen.getAllByRole('button', { name: en.save })
    fireEvent.click(saves[saves.length - 1]!)

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    expect(mutate.mock.calls.map(call => call[2])).toEqual([0, 1])
    // The retry carries leaf operations re-applied from the draft, never a
    // replayed whole-profile snapshot.
    expect(mutate.mock.calls[1]![1]).toEqual([
      { op: 'set', path: ['providers', 'gateway', 'displayName'], value: 'gateway' },
      { op: 'set', path: ['providers', 'gateway', 'baseURL'], value: 'https://mine/v1' },
      { op: 'set', path: ['providers', 'gateway', 'api'], value: 'openai-completions' },
    ])
    expect(screen.getByText(en.savedLabel)).toBeTruthy()
  })

  it('re-applies the host refresh answer after a conflict and reports its outcome', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('providerSync.refreshRoute')) {
        return {
          ok: true,
          json: async () => ({
            result: {
              ok: true,
              value: {
                route: 'gateway',
                models: [{ id: 'kept-server', name: 'Kept Fresh' }],
                removed: ['removed-server'],
                deprecated: ['deprecated-kept'],
                degraded: false,
                source: 'live',
                authority: 'catalog',
                fetchedAt: 5,
              },
            },
          }),
        } as unknown as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    }))
    const mutate = vi.fn()
      .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
      .mockResolvedValue({ ok: true as const, value: undefined })
    const models = [
      { id: 'kept-server' },
      { id: 'removed-server' },
      { id: 'typed', name: 'Typed' },
    ]
    const first = namespace('gateway', models)
    const api = movingConflictWire(first, { ...namespace('gateway', models), revision: 1 }, mutate)
    renderPanel('gateway', first, api)

    fireEvent.click(screen.getByTitle('Refresh catalog from provider'))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    expect(mutate.mock.calls.map(call => call[2])).toEqual([0, 1])
    const [, ops] = mutate.mock.calls[1] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string }> }>]
    // The answer is the base, the host's removed list is the sole deletion
    // gate, and the typed row the host never reported survives.
    expect(ops[0]?.value.map(model => model.id)).toEqual(['kept-server', 'typed'])
    // F24: the toast reports the pruned/deprecated outcome.
    await screen.findByText(t('refreshedModelsReport', { count: 2, removed: 1, deprecated: 1 }))
  })

  it('reports a degraded refresh that withheld removals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          ok: true,
          value: {
            route: 'gateway',
            models: [{ id: 'kept-server' }],
            removed: [],
            deprecated: [],
            degraded: true,
            degradedReason: 'shrink guard',
            source: 'live',
            authority: 'catalog',
            fetchedAt: 5,
          },
        },
      }),
    } as unknown as Response)))
    const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const first = namespace('gateway', [{ id: 'kept-server' }])
    const base = wire(first)
    const api = { ...base, settings: { ...base.settings, mutate } } as unknown as ModelsWire
    renderPanel('gateway', first, api)

    fireEvent.click(screen.getByTitle('Refresh catalog from provider'))

    await screen.findByText(t('refreshedModelsDegraded', { count: 1, reason: 'shrink guard' }))
  })

  it('re-applies the pool strategy after a conflict', async () => {
    const mutate = vi.fn()
      .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
      .mockResolvedValue({ ok: true as const, value: undefined })
    const first = namespace('openai', MODELS, pool('priority-sticky'))
    const api = movingConflictWire(first, { ...namespace('openai', MODELS, pool('priority-sticky')), revision: 1 }, mutate)
    renderPanel('openai', first, api)

    fireEvent.change(screen.getByTitle(en.poolStrategyTitle), { target: { value: 'balanced' } })

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    expect(mutate.mock.calls.map(call => call[2])).toEqual([0, 1])
    expect(mutate.mock.calls[1]![1]).toEqual([
      { op: 'set', path: ['providers', 'openai', 'pool', 'strategy'], value: 'balanced' },
    ])
  })

  it('re-applies a pool identity toggle after a conflict', async () => {
    const mutate = vi.fn()
      .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
      .mockResolvedValue({ ok: true as const, value: undefined })
    const first = namespace('openai', MODELS, pool('priority-sticky'))
    const api = movingConflictWire(first, { ...namespace('openai', MODELS, pool('priority-sticky')), revision: 1 }, mutate)
    renderPanel('openai', first, api)

    fireEvent.click(screen.getByTitle(en.poolDisable))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    const [, ops] = mutate.mock.calls[1] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string; enabled?: boolean }> }>]
    expect(ops[0]?.path).toEqual(['providers', 'openai', 'pool', 'identities'])
    expect(ops[0]?.value).toEqual([{ id: 'primary', credentialRef: 'OPENAI_API_KEY', priority: 1, enabled: false }])
  })

  it('re-applies a pool reorder after a conflict against the fresh order', async () => {
    const two = {
      strategy: 'priority-sticky',
      identities: [
        { id: 'a', credentialRef: 'A', priority: 1, enabled: true },
        { id: 'b', credentialRef: 'B', priority: 2, enabled: true },
      ],
    }
    const mutate = vi.fn()
      .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
      .mockResolvedValue({ ok: true as const, value: undefined })
    const first = namespace('openai', MODELS, two)
    const api = movingConflictWire(first, { ...namespace('openai', MODELS, two), revision: 1 }, mutate)
    renderPanel('openai', first, api)

    fireEvent.click(screen.getAllByTitle(en.poolMoveDown)[0]!)

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    const [, ops] = mutate.mock.calls[1] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string; priority?: number }> }>]
    expect(ops[0]?.value.map(identity => [identity.id, identity.priority])).toEqual([['b', 1], ['a', 2]])
  })

  it('re-applies a pool identity deletion after a conflict', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const mutate = vi.fn()
      .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
      .mockResolvedValue({ ok: true as const, value: undefined })
    const first = namespace('openai', MODELS, pool('priority-sticky'))
    const api = movingConflictWire(first, { ...namespace('openai', MODELS, pool('priority-sticky')), revision: 1 }, mutate)
    renderPanel('openai', first, api)

    fireEvent.click(screen.getByTitle(en.poolDelete))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    // The last identity going drops the whole pool node.
    expect(mutate.mock.calls[1]![1]).toEqual([{ op: 'unset', path: ['providers', 'openai', 'pool'] }])
  })

  it('re-applies a pool identity add after a conflict without duplicating it', async () => {
    const mutate = vi.fn()
      .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
      .mockResolvedValue({ ok: true as const, value: undefined })
    const first = namespace('openai', MODELS, pool('priority-sticky'))
    const api = movingConflictWire(first, { ...namespace('openai', MODELS, pool('priority-sticky')), revision: 1 }, mutate)
    renderPanel('openai', first, api)

    fireEvent.click(screen.getByTitle(en.poolAdd))
    fireEvent.change(screen.getByPlaceholderText(en.poolNamePlaceholder), { target: { value: 'secondary' } })
    fireEvent.change(screen.getByPlaceholderText(en.poolSecretPlaceholder), { target: { value: 'sk-second' } })
    fireEvent.click(screen.getByRole('button', { name: en.poolSave }))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    const [, ops] = mutate.mock.calls[1] as unknown as [string, Array<{ path: string[]; value: { identities: Array<{ id: string }> } }>]
    expect(ops[0]?.path).toEqual(['providers', 'openai', 'pool'])
    expect(ops[0]?.value.identities.map(identity => identity.id)).toEqual(['primary', 'secondary'])
  })

  it('re-applies the pool conversion after a conflict', async () => {
    const mutate = vi.fn()
      .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
      .mockResolvedValue({ ok: true as const, value: undefined })
    const first = namespace('gateway', MODELS)
    const api = movingConflictWire(first, { ...namespace('gateway', MODELS), revision: 1 }, mutate)
    renderPanel('gateway', first, api)

    fireEvent.click(screen.getByTitle(en.poolConvertHint))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    type PoolMutationCall = [
      string,
      Array<{ path: string[]; value: { strategy: string; identities: Array<{ id: string; credentialRef: string }> } }>,
    ]
    const [, ops] = mutate.mock.calls[1] as unknown as PoolMutationCall
    expect(ops[0]?.path).toEqual(['providers', 'gateway', 'pool'])
    expect(ops[0]?.value.strategy).toBe('priority-sticky')
    expect(ops[0]?.value.identities).toEqual([{ id: 'primary', credentialRef: 'GATEWAY_API_KEY', priority: 1, enabled: true }])
  })
})

it('clears the armed refresh-toast timer when the panel unmounts', async () => {
  const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)))
  const discoverModels = vi.fn(async () => ({ ok: true as const, value: [{ id: 'fresh' }] }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const first = namespace('gateway', [{ id: 'configured' }])
  const base = wire(first)
  const api = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire
  const view = renderPanel('gateway', first, api)

  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await screen.findByText(t('refreshedModels', { count: 2 }))
  const before = clearSpy.mock.calls.length
  view.unmount()
  expect(clearSpy.mock.calls.length).toBeGreaterThan(before)
  clearSpy.mockRestore()
})

it('automatic heavy population prefers the host refreshRoute answer when mounted', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { method?: string }
    if (body.method === 'enpoiHeavy.status') {
      return { ok: true, status: 200, json: async () => ({ result: { ok: true, value: heavyStatus() } }) } as unknown as Response
    }
    if (body.method === 'providerSync.refreshRoute') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            ok: true,
            value: {
              route: 'antigravity', models: [{ id: 'server-fresh', name: 'Server Fresh' }],
              removed: [], deprecated: [], degraded: false, source: 'live', authority: 'catalog', fetchedAt: 5,
            },
          },
        }),
      } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  const discoverModels = vi.fn()
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('antigravity', [])
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('antigravity')} namespace={ns} schema={settingsSchema} api={wireFace} t={t}
      readOnly={false} onDelete={vi.fn()} onSaved={vi.fn()}
    />,
  )

  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  const [, ops] = mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string }> }>]
  expect(ops[0]?.value.map(model => model.id)).toEqual(['server-fresh'])
  expect(discoverModels).not.toHaveBeenCalled()
})

it('automatic heavy population writes no route default capacities without the host RPC', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { method?: string }
    if (body.method === 'enpoiHeavy.status') {
      return { ok: true, status: 200, json: async () => ({ result: { ok: true, value: heavyStatus() } }) } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  }))
  const discoverModels = vi.fn(async () => ({ ok: true as const, value: [{ id: 'fresh' }] }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('antigravity', [], undefined, { defaultContextWindow: 262_144, defaultMaxTokens: 32_768 })
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('antigravity')} namespace={ns} schema={settingsSchema} api={wireFace} t={t}
      readOnly={false} onDelete={vi.fn()} onSaved={vi.fn()}
    />,
  )

  await waitFor(() => { expect(discoverModels).toHaveBeenCalled() })
  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  const [, ops] = mutate.mock.calls[0] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string }> }>]
  expect(ops[0]?.value).toEqual([{ id: 'fresh', name: 'fresh' }])
})

it('Test Connection reports an installed-catalog fallback instead of a silent success', async () => {
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'masked', source: 'catalog', fallbackReason: 'HTTP 401 unauthorized' }],
  }))
  const ns = namespace('gateway', [{ id: 'configured' }])
  const base = wire(ns)
  const wireFace = { ...base, llm: { ...base.llm, discoverModels } } as unknown as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('gateway')} namespace={ns} schema={settingsSchema} api={wireFace} t={t}
      readOnly={false} onDelete={vi.fn()} onSaved={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: en.test }))
  await waitFor(() => {
    expect(screen.getByText(new RegExp(en.discoveryCatalogFallback.replace('{reason}', 'HTTP 401 unauthorized').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy()
  })
})

it('Refresh reports an installed-catalog fallback and still merges its rows', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)))
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'masked', name: 'Masked', source: 'catalog', fallbackReason: 'HTTP 401 unauthorized' }],
  }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const ns = namespace('gateway', [{ id: 'configured' }])
  const base = wire(ns)
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('gateway')} namespace={ns} schema={settingsSchema} api={wireFace} t={t}
      readOnly={false} onDelete={vi.fn()} onSaved={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByTitle('Refresh catalog from provider'))
  await waitFor(() => {
    expect(screen.getByText(/HTTP 401 unauthorized/)).toBeTruthy()
  })
  await waitFor(() => { expect(mutate).toHaveBeenCalled() })
})

it('opens one model metadata dialog per row and writes only after Save', async () => {
  const ns = namespace('openai', MODELS)
  const base = wire(ns)
  const mutate = vi.fn<ModelsWire['settings']['mutate']>(async () => ({ ok: true as const, value: ns }))
  const wireFace = { ...base, settings: { ...base.settings, mutate } } as ModelsWire
  const onSaved = vi.fn()
  render(
    <ProviderDetailPanel
      row={row('openai')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={onSaved}
    />,
  )

  fireEvent.click(screen.getByLabelText(en.editModelMetadata.replace('{id}', 'free-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
  expect(mutate).not.toHaveBeenCalled()

  fireEvent.click(dialog.getByRole('button', { name: en.cancel }))
  expect(screen.queryByRole('dialog', { name: en.metadataDialogTitle })).toBeNull()
  expect(mutate).not.toHaveBeenCalled()

  fireEvent.click(screen.getByLabelText(en.editModelMetadata.replace('{id}', 'free-a')))
  const reopened = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.change(reopened.getByLabelText(en.modelName), { target: { value: 'Free A Renamed' } })
  fireEvent.click(reopened.getByRole('button', { name: en.save }))

  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
  expect(base.settings.describe).toHaveBeenCalled()
  expect(mutate.mock.calls[0]?.[0]).toBe('llm-pi-ai')
  expect(mutate.mock.calls[0]?.[2]).toBe(0)
  await waitFor(() => { expect(onSaved).toHaveBeenCalledTimes(1) })
})

it('loads the installed catalog on demand and edits its rows as overrides', async () => {
  const ns = namespace('openai', [])
  const base = wire(ns)
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'catalog-a', name: 'Catalog A', contextWindow: 64_000, maxTokens: 4_096 }],
  }))
  const mutate = vi.fn<ModelsWire['settings']['mutate']>(async () => ({ ok: true as const, value: ns }))
  const wireFace = {
    ...base,
    settings: { ...base.settings, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire
  const onSaved = vi.fn()
  render(
    <ProviderDetailPanel
      row={row('openai')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={onSaved}
    />,
  )

  // Opening the card never probes on its own; the operator asks for the
  // installed catalog.
  expect(discoverModels).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.metadataLoadCatalog }))
  await waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(1) })
  expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', { provider: 'openai' })
  const rowButton = await screen.findByLabelText(en.editModelMetadata.replace('{id}', 'catalog-a'))
  fireEvent.click(rowButton)

  expect(screen.getByText(en.metadataCatalogNotice)).toBeTruthy()
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  expect(dialog.getByLabelText<HTMLInputElement>(en.modelId).readOnly).toBe(true)
  // Inherited catalog facts are placeholders, not submitted values: a blank
  // field means "keep the catalog answer", so saving one edit cannot
  // materialize the whole model into an override.
  const context = dialog.getByLabelText<HTMLInputElement>(en.metadataContextWindow)
  expect(context.value).toBe('')
  expect(context.placeholder).toBe('64000')
  fireEvent.change(dialog.getByLabelText(en.modelName), { target: { value: 'Catalog A Renamed' } })
  fireEvent.click(dialog.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
  expect(mutate.mock.calls[0]?.[1]).toEqual([{
    op: 'set',
    path: ['providers', 'openai', 'modelOverrides', 'catalog-a', 'name'],
    value: 'Catalog A Renamed',
  }])
  expect(onSaved).toHaveBeenCalledWith(ns)
})

it('disables metadata editing with an explanation for an unknown provider family', async () => {
  const ns = { ...namespace('mystery', MODELS), ns: 'llm-unknown' }
  const unknownRow = row('mystery')
  render(
    <ProviderDetailPanel
      row={{ ...unknownRow, entry: { ...unknownRow.entry, settingsNs: 'llm-unknown' } }}
      namespace={ns}
      schema={settingsSchema}
      api={wire(ns)}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  const edit = screen.getByLabelText<HTMLButtonElement>(en.editModelMetadata.replace('{id}', 'free-a'))
  expect(edit.disabled).toBe(true)
  expect(edit.title).toBe(en.metadataEditingUnavailable)
  fireEvent.click(edit)
  expect(screen.queryByRole('dialog', { name: en.metadataDialogTitle })).toBeNull()
})

it('reports a fenced metadata conflict and keeps the dialog open', async () => {
  const ns = namespace('openai', MODELS)
  const base = wire(ns)
  const mutate = vi.fn<ModelsWire['settings']['mutate']>(async () => ({
    ok: false as const,
    error: new RemoteError('settings/conflict', 'stale revision', {
      ns: 'llm-pi-ai', expected: 0, actual: 1,
    }),
  }))
  const wireFace = { ...base, settings: { ...base.settings, mutate } } as ModelsWire
  const onSaved = vi.fn()
  render(
    <ProviderDetailPanel
      row={row('openai')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={onSaved}
    />,
  )

  fireEvent.click(screen.getByLabelText(en.editModelMetadata.replace('{id}', 'free-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.change(dialog.getByLabelText(en.modelName), { target: { value: 'Contended' } })
  fireEvent.click(dialog.getByRole('button', { name: en.save }))

  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(4) })
  const alert = await dialog.findByRole('alert')
  expect(alert.textContent).toContain(en.cleanupConflict)
  expect(onSaved).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: en.metadataDialogTitle })).toBeTruthy()
})

it('appends a separate entry when a model ID changes instead of renaming the old row', async () => {
  const ns = namespace('openai', MODELS)
  const base = wire(ns)
  const mutate = vi.fn<ModelsWire['settings']['mutate']>(async () => ({ ok: true as const, value: ns }))
  const wireFace = { ...base, settings: { ...base.settings, mutate } } as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('openai')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByLabelText(en.editModelMetadata.replace('{id}', 'free-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.change(dialog.getByLabelText(en.modelId), { target: { value: 'free-a-copy' } })
  fireEvent.click(dialog.getByRole('button', { name: en.save }))

  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
  const ops = mutate.mock.calls[0]?.[1] as Array<{ op: string; path: string[]; value?: { id?: string } }>
  // Save-as: one appended row, no operation that rewrites row 0 or any
  // session/reference that named the old id.
  expect(ops).toHaveLength(1)
  expect(ops[0]?.op).toBe('set')
  expect(ops[0]?.path).toEqual(['providers', 'openai', 'models', String(MODELS.length)])
  expect(ops[0]?.value?.id).toBe('free-a-copy')
})

it('previews the inherited catalog value after resetting a catalog override', async () => {
  const baseNs = namespace('openai', [])
  const profile = {
    displayName: 'openai', baseURL: 'https://proxy', api: 'openai-completions', models: [],
    modelOverrides: { 'catalog-a': { name: 'Catalog Override' } },
  }
  const ns = {
    ...baseNs,
    value: { providers: { openai: profile } },
    user: { providers: { openai: profile } },
  }
  const base = wire(ns)
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'catalog-a', name: 'Catalog A', contextWindow: 64_000 }],
  }))
  const wireFace = { ...base, llm: { ...base.llm, discoverModels } } as unknown as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('openai')}
      namespace={ns}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: en.metadataLoadCatalog }))
  await waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(1) })
  expect(screen.getByText('Catalog Override')).toBeTruthy()

  fireEvent.click(await screen.findByLabelText(en.editModelMetadata.replace('{id}', 'catalog-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  const name = dialog.getByLabelText<HTMLInputElement>(en.modelName)
  expect(name.value).toBe('Catalog Override')
  fireEvent.click(dialog.getByRole('button', {
    name: en.metadataResetField.replace('{field}', en.modelName),
  }))
  expect(name.value).toBe('')
  expect(name.placeholder).toBe('Catalog A')
})

it('shows effective base models read-only until the user section stores its list', () => {
  const baseNs = namespace('openai', [])
  const ns = {
    ...baseNs,
    value: {
      providers: {
        openai: {
          displayName: 'openai', baseURL: 'https://proxy', api: 'openai-completions',
          models: [{ id: 'shipped-model', name: 'Shipped Model', contextWindow: 32_000 }],
        },
      },
    },
    user: { providers: { openai: { displayName: 'My OpenAI' } } },
  }
  render(
    <ProviderDetailPanel
      row={row('openai')}
      namespace={ns}
      schema={settingsSchema}
      api={wire(ns)}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  expect(screen.getByText('Shipped Model')).toBeTruthy()
  expect(screen.getByText(en.metadataPiAiInheritedModelsHint)).toBeTruthy()
  const edit = screen.getByLabelText<HTMLButtonElement>(en.editModelMetadata.replace('{id}', 'shipped-model'))
  expect(edit.disabled).toBe(true)
  expect(edit.title).toBe(en.metadataPiAiInheritedModelsHint)
  fireEvent.click(edit)
  expect(screen.queryByRole('dialog', { name: en.metadataDialogTitle })).toBeNull()
})

it('retries a metadata conflict with only the fields the operator changed', async () => {
  const initial = namespace('openai', [{
    id: 'free-a', name: 'Free A', contextWindow: 128_000, maxTokens: 4_096,
    cost: { input: 0.27, output: 1.1 },
  }])
  const revisedModels = [{
    id: 'free-a', name: 'Free A', contextWindow: 256_000, maxTokens: 4_096,
    cost: { input: 0.27, output: 9.9 },
  }]
  const revised = { ...namespace('openai', revisedModels), revision: 1 }
  const base = wire(initial)
  const describe = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: { writable: true, hasDocument: false, namespaces: [initial] },
    })
    .mockResolvedValueOnce({
      ok: true as const,
      value: { writable: true, hasDocument: false, namespaces: [revised] },
    })
  const mutate = vi.fn<ModelsWire['settings']['mutate']>()
    .mockResolvedValueOnce({
      ok: false as const,
      error: new RemoteError('settings/conflict', 'stale', {
        ns: 'llm-pi-ai', expected: 0, actual: 1,
      }),
    })
    .mockResolvedValueOnce({ ok: true as const, value: revised })
  const wireFace = { ...base, settings: { ...base.settings, describe, mutate } } as ModelsWire
  render(
    <ProviderDetailPanel
      row={row('openai')}
      namespace={initial}
      schema={settingsSchema}
      api={wireFace}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  fireEvent.click(screen.getByLabelText(en.editModelMetadata.replace('{id}', 'free-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.change(dialog.getByLabelText(en.modelName), { target: { value: 'Free A Mine' } })
  fireEvent.click(dialog.getByText(en.metadataDetails))
  fireEvent.change(dialog.getByLabelText(en.metadataInputPrice), { target: { value: '0.5' } })
  fireEvent.click(dialog.getByRole('button', { name: en.save }))

  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
  expect(describe).toHaveBeenCalledTimes(2)
  expect(mutate.mock.calls[1]?.[2]).toBe(1)
  const ops = mutate.mock.calls[1]?.[1] as Array<{ op: string; path: string[]; value?: unknown }>
  const paths = ops.map(op => op.path.join('.'))
  expect(paths).toContain('providers.openai.models.0.name')
  expect(paths).toContain('providers.openai.models.0.cost.input')
  // The concurrent writer's untouched context window and output price survive.
  expect(paths.some(path => path.endsWith('.contextWindow'))).toBe(false)
  expect(paths.some(path => path.endsWith('.cost.output'))).toBe(false)
})

it('disables DeepSeek metadata editing when only adapter-default models resolve', () => {
  const baseNs = namespace('openai', [])
  const ns = {
    ...baseNs,
    ns: 'llm-deepseek',
    value: {
      displayName: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128_000 }],
    },
    user: { displayName: 'DeepSeek' },
  }
  const baseRow = row('deepseek')
  render(
    <ProviderDetailPanel
      row={{ ...baseRow, entry: { ...baseRow.entry, settingsNs: 'llm-deepseek', settingsPath: [] } }}
      namespace={ns}
      schema={settingsSchema}
      api={wire(ns)}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  expect(screen.getByText('DeepSeek Chat')).toBeTruthy()
  expect(screen.getByText(en.metadataDeepseekUnavailable)).toBeTruthy()
  const edit = screen.getByLabelText<HTMLButtonElement>(en.editModelMetadata.replace('{id}', 'deepseek-chat'))
  expect(edit.disabled).toBe(true)
  expect(edit.title).toBe(en.metadataDeepseekUnavailable)
})

it('keeps an open metadata draft across a settings echo', () => {
  const initial = namespace('openai', MODELS)
  const element = (ns: SettingsNamespaceView): ReactElement => (
    <ProviderDetailPanel
      row={row('openai')}
      namespace={ns}
      schema={settingsSchema}
      api={wire(ns)}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />
  )
  const view = render(element(initial))
  fireEvent.click(screen.getByLabelText(en.editModelMetadata.replace('{id}', 'free-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.change(dialog.getByLabelText(en.modelName), { target: { value: 'Draft Name' } })

  view.rerender(element(namespace('openai', [
    { id: 'free-a', name: 'Free A', contextWindow: 256_000 },
    { id: 'free-b', name: 'Free B' },
  ])))

  const reopened = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  expect(reopened.getByLabelText<HTMLInputElement>(en.modelName).value).toBe('Draft Name')
})

it('enables DeepSeek metadata when the route stores its model list', () => {
  const baseNs = namespace('openai', [])
  const profile = {
    displayName: 'DeepSeek',
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128_000, maxTokens: 8_192 }],
  }
  const ns = { ...baseNs, ns: 'llm-deepseek', value: profile, user: profile }
  const baseRow = row('deepseek')
  render(
    <ProviderDetailPanel
      row={{ ...baseRow, entry: { ...baseRow.entry, settingsNs: 'llm-deepseek', settingsPath: [] } }}
      namespace={ns}
      schema={settingsSchema}
      api={wire(ns)}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  const edit = screen.getByLabelText<HTMLButtonElement>(en.editModelMetadata.replace('{id}', 'deepseek-chat'))
  expect(edit.disabled).toBe(false)
  fireEvent.click(edit)
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  expect(dialog.getByLabelText<HTMLInputElement>(en.modelName).value).toBe('DeepSeek Chat')
})

it('disables catalog editing for a pi-ai route under endpoint authority', () => {
  const baseNs = namespace('openai', [])
  const profile = {
    displayName: 'openai', models: [], catalogAuthority: 'endpoint',
  }
  const ns = {
    ...baseNs,
    value: { providers: { openai: profile } },
    user: { providers: { openai: profile } },
  }
  render(
    <ProviderDetailPanel
      row={row('openai')}
      namespace={ns}
      schema={settingsSchema}
      api={wire(ns)}
      t={t}
      readOnly={false}
      onDelete={vi.fn()}
      onSaved={vi.fn()}
    />,
  )

  expect(screen.queryByRole('button', { name: en.metadataLoadCatalog })).toBeNull()
  expect(screen.getByText(en.noModelsFound)).toBeTruthy()
})

describe('catalog refresh with model overrides', () => {
  it('refuses before any network call while overrides are already configured', async () => {
    const ns = namespace('openai', [])
    const profile = {
      displayName: 'openai', baseURL: 'https://proxy', api: 'openai-completions', models: [],
      modelOverrides: { 'catalog-a': { name: 'Pinned' } },
    }
    const view = {
      ...ns,
      value: { providers: { openai: profile } },
      user: { providers: { openai: profile } },
    }
    const base = wire(view)
    const discoverModels = vi.fn()
    const mutate = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const wireFace = {
      ...base,
      settings: { ...base.settings, mutate },
      llm: { ...base.llm, discoverModels },
    } as unknown as ModelsWire
    render(
      <ProviderDetailPanel
        row={row('openai')} namespace={view} schema={settingsSchema} api={wireFace} t={t}
        readOnly={false} onDelete={vi.fn()} onSaved={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle(en.refreshCatalogTitle))
    expect(await screen.findByText(en.refreshBlockedModelOverrides)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(discoverModels).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('refuses a hosted refresh when a concurrent override appears before the fenced write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          ok: true,
          value: {
            route: 'gateway', models: [{ id: 'server-fresh' }], removed: [], deprecated: [],
            degraded: false, source: 'live', authority: 'catalog', fetchedAt: 5,
          },
        },
      }),
    } as unknown as Response)))
    const first = namespace('gateway', MODELS)
    const second = namespace('gateway', MODELS)
    const secondProfile = {
      displayName: 'gateway', baseURL: 'https://proxy', api: 'openai-completions', models: MODELS,
      modelOverrides: { 'free-a': { name: 'Pinned' } },
    }
    second.value = { providers: { gateway: secondProfile } }
    second.user = { providers: { gateway: secondProfile } }
    second.revision = 1
    const mutate = vi.fn()
      .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
      .mockResolvedValue({ ok: true as const, value: second })
    const api = movingConflictWire(first, second, mutate)
    renderPanel('gateway', first, api)

    fireEvent.click(screen.getByTitle(en.refreshCatalogTitle))
    expect(await screen.findByText(en.refreshBlockedModelOverrides)).toBeTruthy()
    // The refusal happens inside the retry planner: no accepted write follows
    // the conflicting attempt, and the new overrides stay untouched.
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(secondProfile.modelOverrides).toEqual({ 'free-a': { name: 'Pinned' } })
  })

  it('refuses a fallback discovery write against a fresher profile with overrides', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)))
    const first = namespace('gateway', MODELS)
    const fresh = namespace('gateway', MODELS)
    const freshProfile = {
      displayName: 'gateway', baseURL: 'https://proxy', api: 'openai-completions', models: MODELS,
      modelOverrides: { 'free-a': { name: 'Fresh Override' } },
    }
    fresh.value = { providers: { gateway: freshProfile } }
    fresh.user = { providers: { gateway: freshProfile } }
    fresh.revision = 1
    const base = wire(first)
    const describe = vi.fn(async () => ({
      ok: true as const,
      value: { writable: true, hasDocument: false, namespaces: [fresh] },
    }))
    const discoverModels = vi.fn(async () => ({
      ok: true as const,
      value: [{ id: 'server-fresh', name: 'Server Fresh' }],
    }))
    const mutate = vi.fn()
    const wireFace = {
      ...base,
      settings: { ...base.settings, describe, mutate },
      llm: { ...base.llm, discoverModels },
    } as unknown as ModelsWire
    renderPanel('gateway', first, wireFace)

    fireEvent.click(screen.getByTitle(en.refreshCatalogTitle))
    expect(await screen.findByText(en.refreshBlockedModelOverrides)).toBeTruthy()
    expect(discoverModels).toHaveBeenCalledTimes(1)
    expect(mutate).not.toHaveBeenCalled()
    expect(freshProfile.modelOverrides).toEqual({ 'free-a': { name: 'Fresh Override' } })
  })
})

it('offers legacy manual-field resets and writes the proper unset plan', async () => {
  const models = [{
    id: 'legacy', name: 'Legacy', contextWindow: 128_000, source: 'manual', cost: { input: 0.2 },
  }]
  const ns = namespace('gateway', models)
  const base = wire(ns)
  const mutate = vi.fn<ModelsWire['settings']['mutate']>(async () => ({ ok: true as const, value: ns }))
  const wireFace = { ...base, settings: { ...base.settings, mutate } } as ModelsWire
  renderPanel('gateway', ns, wireFace)

  fireEvent.click(screen.getByLabelText(en.editModelMetadata.replace('{id}', 'legacy')))
  let dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  expect(dialog.getByRole('button', {
    name: en.metadataResetField.replace('{field}', en.modelName),
  })).toBeTruthy()
  expect(dialog.getByRole('button', {
    name: en.metadataResetField.replace('{field}', en.metadataContextWindow),
  })).toBeTruthy()
  expect(dialog.queryByRole('button', {
    name: en.metadataResetField.replace('{field}', en.metadataPricing),
  })).toBeNull()
  fireEvent.click(dialog.getByRole('button', {
    name: en.metadataResetField.replace('{field}', en.modelName),
  }))
  fireEvent.click(dialog.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
  const firstOps = mutate.mock.calls[0]?.[1] as Array<{ op: string; path: string[]; value?: unknown }>
  expect(firstOps).toContainEqual({ op: 'unset', path: ['providers', 'gateway', 'models', '0', 'name'] })
  expect(firstOps).toContainEqual({
    op: 'set', path: ['providers', 'gateway', 'models', '0', 'manualFields'], value: ['contextWindow'],
  })
  expect(firstOps.some(op => op.path.includes('cost'))).toBe(false)

  fireEvent.click(screen.getByLabelText(en.editModelMetadata.replace('{id}', 'legacy')))
  dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.click(dialog.getByRole('button', { name: en.metadataResetAll }))
  fireEvent.click(dialog.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
  const secondOps = mutate.mock.calls[1]?.[1] as Array<{ op: string; path: string[] }>
  expect(secondOps).toContainEqual({ op: 'unset', path: ['providers', 'gateway', 'models', '0', 'name'] })
  expect(secondOps).toContainEqual({ op: 'unset', path: ['providers', 'gateway', 'models', '0', 'contextWindow'] })
  expect(secondOps).toContainEqual({ op: 'unset', path: ['providers', 'gateway', 'models', '0', 'source'] })
})

it('does not offer the load-catalog action on a search miss', () => {
  const discoverModels = vi.fn()
  const ns = namespace('openai', MODELS)
  const base = wire(ns)
  const wireFace = { ...base, llm: { ...base.llm, discoverModels } } as unknown as ModelsWire
  renderPanel('openai', ns, wireFace)

  fireEvent.change(screen.getByPlaceholderText(`Search ${MODELS.length} models...`), {
    target: { value: 'no-such-model' },
  })
  expect(screen.getByText(en.noModelsMatching.replace('{query}', 'no-such-model'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.metadataLoadCatalog })).toBeNull()
  expect(discoverModels).not.toHaveBeenCalled()
})

it('refuses a metadata save when the user model list disappears before the fresh read', async () => {
  const initial = namespace('openai', MODELS)
  const removedProfile = {
    displayName: 'openai', baseURL: 'https://proxy', api: 'openai-completions',
  }
  const removed = {
    ...namespace('openai', MODELS),
    user: { providers: { openai: removedProfile } },
    revision: 1,
  }
  const base = wire(initial)
  const describe = vi.fn(async () => ({
    ok: true as const,
    value: { writable: true, hasDocument: false, namespaces: [removed] },
  }))
  const mutate = vi.fn()
  const wireFace = {
    ...base,
    settings: { ...base.settings, describe, mutate },
  } as unknown as ModelsWire
  renderPanel('openai', initial, wireFace)

  fireEvent.click(screen.getByLabelText(en.editModelMetadata.replace('{id}', 'free-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.change(dialog.getByLabelText(en.modelName), { target: { value: 'Renamed' } })
  fireEvent.click(dialog.getByRole('button', { name: en.save }))

  expect((await dialog.findByRole('alert')).textContent).toContain(en.metadataPiAiInheritedModelsHint)
  expect(mutate).not.toHaveBeenCalled()
})

it('reports a duplicate model ID from the fenced plan without writing', async () => {
  const ns = namespace('gateway', MODELS)
  const base = wire(ns)
  const mutate = vi.fn()
  const wireFace = { ...base, settings: { ...base.settings, mutate } } as ModelsWire
  renderPanel('gateway', ns, wireFace)

  fireEvent.click(screen.getByLabelText(en.editModelMetadata.replace('{id}', 'free-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.change(dialog.getByLabelText(en.modelId), { target: { value: 'free-b' } })
  fireEvent.click(dialog.getByRole('button', { name: en.save }))

  expect((await dialog.findByRole('alert')).textContent).toBe(en.metadataOpsDuplicateId)
  expect(mutate).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: en.metadataDialogTitle })).toBeTruthy()
})

it('refuses a catalog metadata save when the fresh profile now stores models', async () => {
  const ns = namespace('openai', [])
  const base = wire(ns)
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'catalog-a', name: 'Catalog A' }],
  }))
  const materialized = namespace('openai', [{ id: 'catalog-a', name: 'Catalog A' }])
  const describe = vi.fn(async () => ({
    ok: true as const,
    value: { writable: true, hasDocument: false, namespaces: [materialized] },
  }))
  const mutate = vi.fn()
  const wireFace = {
    ...base,
    settings: { ...base.settings, describe, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire
  renderPanel('openai', ns, wireFace)

  fireEvent.click(screen.getByRole('button', { name: en.metadataLoadCatalog }))
  fireEvent.click(await screen.findByLabelText(en.editModelMetadata.replace('{id}', 'catalog-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.change(dialog.getByLabelText(en.modelName), { target: { value: 'Draft Catalog' } })
  fireEvent.click(dialog.getByRole('button', { name: en.save }))

  expect((await dialog.findByRole('alert')).textContent).toBe(en.metadataCatalogChanged)
  expect(mutate).not.toHaveBeenCalled()
  expect(dialog.getByLabelText<HTMLInputElement>(en.modelName).value).toBe('Draft Catalog')
  expect(screen.getByRole('dialog', { name: en.metadataDialogTitle })).toBeTruthy()
})

it('refuses a catalog metadata retry when a conflict reveals materialized models', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)))
  const initial = namespace('openai', [])
  const materialized = { ...namespace('openai', [{ id: 'catalog-a', name: 'Catalog A' }]), revision: 1 }
  const base = wire(initial)
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'catalog-a', name: 'Catalog A' }],
  }))
  const describe = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: { writable: true, hasDocument: false, namespaces: [initial] },
    })
    .mockResolvedValue({
      ok: true as const,
      value: { writable: true, hasDocument: false, namespaces: [materialized] },
    })
  const mutate = vi.fn()
    .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
    .mockResolvedValue({ ok: true as const, value: materialized })
  const wireFace = {
    ...base,
    settings: { ...base.settings, describe, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire
  renderPanel('openai', initial, wireFace)

  fireEvent.click(screen.getByRole('button', { name: en.metadataLoadCatalog }))
  fireEvent.click(await screen.findByLabelText(en.editModelMetadata.replace('{id}', 'catalog-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.change(dialog.getByLabelText(en.modelName), { target: { value: 'Draft Catalog' } })
  fireEvent.click(dialog.getByRole('button', { name: en.save }))

  expect((await dialog.findByRole('alert')).textContent).toBe(en.metadataCatalogChanged)
  // Only the conflicting attempt ran; the retry refused before planning.
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(dialog.getByLabelText<HTMLInputElement>(en.modelName).value).toBe('Draft Catalog')
})

it('refuses a catalog metadata save when the fresh profile switched to endpoint authority', async () => {
  const ns = namespace('openai', [])
  const endpointNs = namespace('openai', [])
  const profile = {
    displayName: 'openai', baseURL: 'https://proxy', api: 'openai-completions',
    models: [], catalogAuthority: 'endpoint',
  }
  const describe = vi.fn(async () => ({
    ok: true as const,
    value: {
      writable: true,
      hasDocument: false,
      namespaces: [{
        ...endpointNs,
        value: { providers: { openai: profile } },
        user: { providers: { openai: profile } },
      }],
    },
  }))
  const base = wire(ns)
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'catalog-a', name: 'Catalog A' }],
  }))
  const mutate = vi.fn()
  const wireFace = {
    ...base,
    settings: { ...base.settings, describe, mutate },
    llm: { ...base.llm, discoverModels },
  } as unknown as ModelsWire
  renderPanel('openai', ns, wireFace)

  fireEvent.click(screen.getByRole('button', { name: en.metadataLoadCatalog }))
  fireEvent.click(await screen.findByLabelText(en.editModelMetadata.replace('{id}', 'catalog-a')))
  const dialog = within(screen.getByRole('dialog', { name: en.metadataDialogTitle }))
  fireEvent.change(dialog.getByLabelText(en.modelName), { target: { value: 'Draft Catalog' } })
  fireEvent.click(dialog.getByRole('button', { name: en.save }))

  expect((await dialog.findByRole('alert')).textContent).toBe(en.metadataCatalogChanged)
  expect(mutate).not.toHaveBeenCalled()
})

it('refreshes against inherited base models instead of treating the user overlay as empty', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      result: {
        ok: true,
        value: {
          route: 'gateway', models: [{ id: 'server-b', name: 'Server B' }],
          removed: [], deprecated: [], degraded: false, source: 'live',
          authority: 'catalog', fetchedAt: 5,
        },
      },
    }),
  } as unknown as Response)))
  const baseNs = namespace('gateway', [{ id: 'base-a', name: 'Base A' }])
  const ns = {
    ...baseNs,
    value: { providers: { gateway: { displayName: 'gateway', baseURL: 'https://proxy', api: 'openai-completions', models: [{ id: 'base-a', name: 'Base A' }] } } },
    user: { providers: { gateway: { displayName: 'gateway' } } },
  }
  const base = wire(ns)
  const mutate = vi.fn<ModelsWire['settings']['mutate']>(async () => ({ ok: true as const, value: ns }))
  const wireFace = { ...base, settings: { ...base.settings, mutate } } as ModelsWire
  renderPanel('gateway', ns, wireFace)

  fireEvent.click(screen.getByTitle(en.refreshCatalogTitle))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
  const ops = mutate.mock.calls[0]?.[1] as Array<{ op: string; path: string[]; value: Array<{ id: string }> }>
  expect(ops[0]?.value.map(model => model.id)).toEqual(['server-b', 'base-a'])
})
