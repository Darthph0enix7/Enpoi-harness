// @vitest-environment jsdom
/** The detail panel's local picker state survives settings echoes. */
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderDetailPanel, mergeRefreshedModels } from '../src/client/ProviderDetailPanel.tsx'
import { CATALOG_DECISIONS_CHANGED_EVENT, CATALOG_DECISIONS_MIRROR_KEY } from '../src/client/model-visibility.ts'
import { heavyStatusCache } from '../src/client/heavy-rpc.ts'
import type { ModelsWire, ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { translateEn } from './translate.ts'
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
  reasoningEfforts?: Record<string, string | null>
  supported_parameters?: string[]
  tools?: boolean
  cost?: Record<string, number>
  input?: string[]
  isFree?: boolean
  gated?: boolean
  gateReason?: string
  capabilityHints?: { input?: string[]; reasoning?: boolean; source?: string }
  unverified?: boolean
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
function wire(): ModelsWire {
  return {
    settings: { describe: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
    credentials: { describe: vi.fn(), set: vi.fn(), unset: vi.fn() },
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

function panel(provider: string, models: TestModel[] = MODELS) {
  return (
    <ProviderDetailPanel
      row={row(provider)}
      namespace={namespace(provider, models)}
      schema={settingsSchema}
      api={wire()}
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
  const wireFace = { ...wire(), settings: { ...wire().settings, mutate: vi.fn(() => never) } } as ModelsWire
  const element = (): ReactElement => (
    <ProviderDetailPanel
      row={row('openai')}
      namespace={namespace('openai', MODELS, pool('priority-sticky'))}
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

it('states the picker verdict on the eye: non-free rows off and locked, free rows on', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { ok: true } }) })))
  render(panel('gateway', [
    { id: 'gateway/auto-free', name: 'Auto Free', isFree: true },
    { id: 'gateway/auto-efficient', name: 'Auto Efficient', isFree: false, gated: true, gateReason: 'sign-in required' },
    { id: 'gateway/silent-gate', name: 'Silent Gate', gated: true },
    { id: 'gateway/undisclosed', name: 'Undisclosed' },
  ]))

  const paid = screen.getByLabelText<HTMLButtonElement>('Show gateway/auto-efficient')
  expect(paid.disabled).toBe(true)
  expect(paid.title).toContain('sign-in required')
  // A gate the listing never explained still renders off, with a generic title.
  const silent = screen.getByLabelText<HTMLButtonElement>('Show gateway/silent-gate')
  expect(silent.disabled).toBe(true)
  expect(silent.title).toBe('Hidden in picker by provider or rule')
  expect(screen.getByLabelText<HTMLButtonElement>('Hide gateway/auto-free').disabled).toBe(false)
  // An absent free/paid marker is undisclosed, not a paid claim.
  expect(screen.getByLabelText<HTMLButtonElement>('Hide gateway/undisclosed').disabled).toBe(false)
})

it('follows a published picker decision when the rules engine hides a row', async () => {
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
  expect(eye.disabled).toBe(true)
  expect(eye.title).toContain('no-training')
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
  const wireFace = {
    ...wire(),
    settings: { ...wire().settings, mutate },
    llm: { ...wire().llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('antigravity')}
      namespace={namespace('antigravity', [])}
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
  const wireFace = {
    ...wire(),
    settings: { ...wire().settings, mutate },
    llm: { ...wire().llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('antigravity')}
      // The row an older build wrote: the fabricated fallback id alone.
      namespace={namespace('antigravity', [{ id: 'gemini-2.5-flash' }])}
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
  const wireFace = {
    ...wire(),
    llm: { ...wire().llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('antigravity')}
      namespace={namespace('antigravity', [])}
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
  const wireFace = {
    ...wire(),
    settings: { ...wire().settings, mutate },
    llm: { ...wire().llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('gateway')}
      namespace={namespace('gateway', [
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
      ])}
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

it('Refresh sizes a newly advertised id from the route profile capacity defaults', async () => {
  const discoverModels = vi.fn(async () => ({
    ok: true as const,
    value: [{ id: 'fresh' }],
  }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: undefined }))
  const wireFace = {
    ...wire(),
    settings: { ...wire().settings, mutate },
    llm: { ...wire().llm, discoverModels },
  } as unknown as ModelsWire

  render(
    <ProviderDetailPanel
      row={row('gateway')}
      namespace={namespace('gateway', [], undefined, { defaultContextWindow: 1_000_000, defaultMaxTokens: 16_384 })}
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
  // The panel never invents 131072/8192: an undisclosed capacity takes the
  // route's configured default, and nothing else.
  expect(ops[0]?.value).toEqual([{ id: 'fresh', name: 'fresh', contextWindow: 1_000_000, maxTokens: 16_384 }])
})

it('recognizes the current audio, video, and reasoning families by id when no structured data exists', () => {
  render(panel('gateway', [
    { id: 'xiaomi/mimo-v2.6-pro' },
    { id: 'xiaomi/mimo-v2.5' },
    { id: 'meta/muse-spark-1.2-contributor' },
    { id: 'meta/muse-spark-1.3-contributor' },
    { id: 'space-bunny-preview' },
    { id: 'openai/gpt-6-astra' },
    { id: 'moonshotai/kimi-k2.6' },
    { id: 'x-ai/grok-4.6' },
    { id: 'qwen/qwen3.8-max' },
    { id: 'z-ai/glm-4.7' },
    { id: 'tencent/hy3-preview' },
    { id: 'tencent/hy4-preview' },
    { id: 'meituan/longcat-2.0' },
    { id: 'minimax-m2.7' },
    { id: 'omen-alpha' },
  ]))

  // Audio: the mimo v2.6/v2.5 and muse-spark contributor families, plus the
  // already-covered minimax-m2.7.
  expect(screen.getAllByTitle('Audio Processing')).toHaveLength(5)
  // Video: the space-bunny family, plus the already-covered minimax-m2.7.
  expect(screen.getAllByTitle('Video Processing')).toHaveLength(2)
  // Reasoning: every listed family but space-bunny (14 of 15 rows).
  expect(screen.getAllByTitle('Reasoning / Thinking')).toHaveLength(14)
})

it('renders disclosed capability badges as facts and id-hinted badges distinctly', () => {
  // The model cards render both a name and an id tag; name the rows so the id
  // tag is a unique anchor for scoping assertions to one card.
  const { container } = render(panel('gateway', [
    // Disclosed: structured modalities and explicit flags are facts.
    { id: 'vendor/solid-model', name: 'Solid', input: ['text', 'image'], reasoning: true, tools: true },
    // Nothing disclosed: every badge is a hint from the shared table.
    { id: 'openai/gpt-5-mini', name: 'Hinted Mini' },
    // The sync's labeled, override-applied hints suppress the shipped claims.
    { id: 'claude-sonnet-owner', name: 'Owner Hidden', capabilityHints: { input: [], source: 'owner-override' } },
    // A persisted owner pin renders even where the shipped table matches nothing.
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
  expect(container.querySelectorAll(`.${styles['modelCard']}`)).toHaveLength(5)

  // Disclosed facts render without the hint marker.
  expect(badge('vendor/solid-model', 'Vision / Image')?.getAttribute('data-hint')).toBeNull()
  expect(badge('vendor/solid-model', 'Reasoning / Thinking')?.getAttribute('data-hint')).toBeNull()
  expect(badge('vendor/solid-model', 'Tool Calling')?.getAttribute('data-hint')).toBeNull()

  // Nothing-disclosed badges carry the hint marker (gpt-5 and its pdf operand).
  expect(badge('openai/gpt-5-mini', 'Vision / Image')?.getAttribute('data-hint')).toBe('vision')
  expect(badge('openai/gpt-5-mini', 'Reasoning / Thinking')?.getAttribute('data-hint')).toBe('reasoning')
  expect(badge('openai/gpt-5-mini', 'Documents & Files')?.getAttribute('data-hint')).toBe('files')
  expect(badge('openai/gpt-5-mini', 'Audio Processing')).toBeNull()

  // The persisted hint set is authoritative: the shipped `claude` claims do
  // not leak back in, and an owner pin renders without a shipped match.
  expect(badge('claude-sonnet-owner', 'Vision / Image')).toBeNull()
  expect(badge('claude-sonnet-owner', 'Documents & Files')).toBeNull()
  expect(badge('claude-sonnet-owner', 'Reasoning / Thinking')).toBeNull()
  expect(badge('zzz-pinned-model', 'Audio Processing')?.getAttribute('data-hint')).toBe('audio')
  expect(badge('zzz-pinned-model', 'Reasoning / Thinking')?.getAttribute('data-hint')).toBe('reasoning')

  // The sync's floor values yield to its own labeled hints.
  expect(badge('zzz-synced-hinted', 'Vision / Image')?.getAttribute('data-hint')).toBe('vision')
  expect(badge('zzz-synced-hinted', 'Documents & Files')?.getAttribute('data-hint')).toBe('files')
  expect(badge('zzz-synced-hinted', 'Reasoning / Thinking')?.getAttribute('data-hint')).toBe('reasoning')
})

it('treats an explicit reasoning:false as a fact that blocks the reasoning hint', () => {
  render(panel('gateway', [{ id: 'openai/gpt-5-api', name: 'No Think', reasoning: false }]))
  expect(screen.queryByTitle('Reasoning / Thinking')).toBeNull()
  // The undisclosed modality is still a labeled hint.
  expect(screen.getByTitle('Vision / Image').getAttribute('data-hint')).toBe('vision')
})

describe('mergeRefreshedModels', () => {
  it('accepts only positive integer capacity defaults', () => {
    const configured: TestModel[] = [{ id: 'm' }]
    const discovered = [{ id: 'm' }]
    expect(mergeRefreshedModels(configured, discovered, { contextWindow: 0, maxTokens: 'none' })[0])
      .toEqual({ id: 'm', name: 'm' })
    expect(mergeRefreshedModels(configured, discovered, { contextWindow: 1.5 })[0])
      .toEqual({ id: 'm', name: 'm' })
    expect(mergeRefreshedModels(configured, discovered, { contextWindow: 1_000, maxTokens: 2_000 })[0])
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
      { contextWindow: 9_000, maxTokens: 900 },
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
      // The route defaults size the rows the answer left unsized.
      { id: 'h', name: 'h', contextWindow: 9_000, maxTokens: 900 },
      { id: 'i', name: 'i', contextWindow: 9_000, maxTokens: 900 },
    ])
  })
})
