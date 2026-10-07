// @vitest-environment jsdom
/** The detail panel's local picker state survives settings echoes. */
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderDetailPanel } from '../src/client/ProviderDetailPanel.tsx'
import { CATALOG_DECISIONS_CHANGED_EVENT, CATALOG_DECISIONS_MIRROR_KEY } from '../src/client/model-visibility.ts'
import { heavyStatusCache } from '../src/client/heavy-rpc.ts'
import type { ModelsWire, ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'
import styles from '../src/client/ModelsSection.module.css'

afterEach(() => {
  cleanup()
  heavyStatusCache.invalidate()
  localStorage.clear()
  vi.unstubAllGlobals()
})

const t = (key: keyof typeof en): string => en[key]

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
  isFree?: boolean
  gated?: boolean
  gateReason?: string
}

/** One pi-ai namespace view; a fresh object is the store's settings echo. */
function namespace(
  provider: string,
  models: TestModel[],
  stored?: { strategy?: string; identities?: Array<{ id: string; credentialRef: string; priority?: number; enabled?: boolean }> },
): SettingsNamespaceView {
  const profile = {
    displayName: provider,
    baseURL: 'https://proxy',
    api: 'openai-completions',
    models,
    ...stored === undefined ? {} : { pool: stored },
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

  fireEvent.click(screen.getByTitle('Test this API key'))
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

it('the automatic pass replaces a stale fabricated fallback row with the discovered catalog', async () => {
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
  // Discovery replaces the whole list: the stale id is pruned, not kept.
  expect(ops[0]?.value.map(model => model.id)).toEqual(['gemini-3.1-pro-high'])
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
