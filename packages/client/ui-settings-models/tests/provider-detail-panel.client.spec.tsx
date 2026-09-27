// @vitest-environment jsdom
/** The detail panel's local picker state survives settings echoes. */
import type { ReactElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderDetailPanel } from '../src/client/ProviderDetailPanel.tsx'
import type { ModelsWire, ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(() => {
  cleanup()
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

/** One pi-ai namespace view; a fresh object is the store's settings echo. */
function namespace(
  provider: string,
  models: Array<{ id: string; name?: string }>,
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

function panel(provider: string, models = MODELS) {
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