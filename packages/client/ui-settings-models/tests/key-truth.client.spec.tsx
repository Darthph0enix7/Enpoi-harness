// @vitest-environment jsdom
/**
 * Key truth: a provider's key reads as configured only when the credentials
 * describe reports a resolving value — an environment variable or a stored
 * key. A route that names no reference and has nothing described under its
 * derived one reads as not set, on the provider list, the detail panel, and
 * the add-provider form's key field alike.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteError, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CredentialInfo, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { AddProviderModal } from '../src/client/AddProviderModal.tsx'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { ProviderDetailPanel } from '../src/client/ProviderDetailPanel.tsx'
import { en } from '../src/client/locales.ts'
import { translateEn } from './translate.ts'
import {
  providerKeyConfigured, type ModelsSettingsState, type ModelsSettingsStore, type ModelsWire, type ProviderRow,
} from '../src/client/store.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t = translateEn

/** A credentials answer over the Remote carrier, which has no envelope. */
function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}

/** One pi-ai namespace view for the panel under test. */
function namespace(provider: string): SettingsNamespaceView {
  const profile = { displayName: provider, baseURL: 'https://proxy', api: 'openai-completions', models: [{ id: 'm' }] }
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

/** One provider row; the three key shapes differ only in credential facts. */
function row(provider: string, overrides: Partial<ProviderRow>): ProviderRow {
  return {
    entry: { provider, displayName: provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], active: true },
    configured: true,
    removable: true,
    apiKeyEnv: undefined,
    credential: undefined,
    ...overrides,
  }
}

/** The wire the panel and the section reach; only the pool status read fires. */
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

/** The sidebar row carrying `provider` as its name. */
function providerRow(provider: string): HTMLElement {
  const node = screen.getAllByText(provider)
    .map(candidate => candidate.closest<HTMLElement>('[role="button"]'))
    .find(candidate => candidate !== null)
  if (node === undefined || node === null) throw new Error(`no row for ${provider}`)
  return node
}

it('reads configured only from the credential the row was described under', () => {
  // Env-set or stored reference: the named credential resolves.
  expect(providerKeyConfigured(row('a', { apiKeyEnv: 'A_API_KEY', credential: { configured: true, source: 'env', writable: false } }))).toBe(true)
  // Keyless route with a stored key under its derived reference.
  expect(providerKeyConfigured(row('b', { derivedCredential: { configured: true, source: 'file', writable: true } }))).toBe(true)
  // Keyless route and nothing resolves its derived reference.
  expect(providerKeyConfigured(row('c', { derivedCredential: { configured: false, writable: true } }))).toBe(false)
  // Nothing described at all is not a configured key.
  expect(providerKeyConfigured(row('d', {}))).toBe(false)
})

it('shows a keyless provider without a key as not set in the list', () => {
  const rows: ProviderRow[] = [
    row('keyless', { derivedCredential: { configured: false, writable: true } }),
    row('envkey', { apiKeyEnv: 'ENVKEY_API_KEY', credential: { configured: true, source: 'env', writable: false } }),
    row('storedkey', { apiKeyEnv: 'STOREDKEY_API_KEY', credential: { configured: true, source: 'file', writable: true } }),
  ]
  const state: ModelsSettingsState = {
    status: 'ready', error: null, credentialError: null, writable: true, rows, namespaces: new Map(),
    providerOverrides: {},
  }
  const store = createSnapshotStore<ModelsSettingsState>(state)
  const controller = { store, load: vi.fn(async () => {}) } as unknown as ModelsSettingsStore
  const injected: ModelsSectionProps = {
    controller,
    useSnapshot: bindSnapshotSelector(store),
    api: wire(),
    schema: settingsSchema,
    t,
    picker: null,
    modelT: key => key,
    renderSlot: () => null,
  }
  render(<ModelsSection {...injected} />)

  expect(within(providerRow('keyless')).getByTitle(en.providerMissingKey)).toBeTruthy()
  expect(within(providerRow('envkey')).getByTitle(en.providerConnected)).toBeTruthy()
  expect(within(providerRow('storedkey')).getByTitle(en.providerConnected)).toBeTruthy()
})

it('shows a keyless provider without a key as not set in the detail panel', () => {
  const api = wire()
  render(<ProviderDetailPanel
    row={row('keyless', { derivedCredential: { configured: false, writable: true } })}
    namespace={namespace('keyless')}
    schema={settingsSchema}
    api={api}
    t={t}
    readOnly={false}
    onDelete={vi.fn()}
    onSaved={vi.fn()}
  />)

  expect(screen.getByText('No Key')).toBeTruthy()
  expect(screen.getByPlaceholderText(en.keyPlaceholder)).toBeTruthy()
})

it('shows an environment-set key and a stored key as configured in the detail panel', () => {
  const api = wire()
  const view = render(<ProviderDetailPanel
    row={row('envkey', { apiKeyEnv: 'ENVKEY_API_KEY', credential: { configured: true, source: 'env', writable: false } })}
    namespace={namespace('envkey')}
    schema={settingsSchema}
    api={api}
    t={t}
    readOnly={false}
    onDelete={vi.fn()}
    onSaved={vi.fn()}
  />)
  expect(screen.getByText('Connected')).toBeTruthy()
  expect(screen.getByPlaceholderText('•••••••••••••••• (Configured)')).toBeTruthy()

  view.rerender(<ProviderDetailPanel
    row={row('storedkey', { apiKeyEnv: 'STOREDKEY_API_KEY', credential: { configured: true, source: 'file', writable: true } })}
    namespace={namespace('storedkey')}
    schema={settingsSchema}
    api={api}
    t={t}
    readOnly={false}
    onDelete={vi.fn()}
    onSaved={vi.fn()}
  />)
  expect(screen.getByText('Connected')).toBeTruthy()
  expect(screen.getByPlaceholderText('•••••••••••••••• (Configured)')).toBeTruthy()
})

/** The add-provider form's wire, with the credential probe scripted. */
function modalWire(describe: ModelsWire['credentials']['describe']): ModelsWire {
  return {
    settings: { describe: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
    credentials: { describe, set: vi.fn(async () => ({ ok: true as const, value: undefined })), unset: vi.fn() },
    llm: {
      discoverModels: vi.fn(),
      listConfigurableProviders: vi.fn(async () => ({ ok: true as const, value: [] })),
      listProviders: vi.fn(),
      poolStatus: vi.fn(),
      poolResetCooldown: vi.fn(),
      poolTestIdentity: vi.fn(),
    },
  } as unknown as ModelsWire
}

function renderModal(describe: ModelsWire['credentials']['describe']) {
  const view = render(<AddProviderModal
    open
    taken={[]}
    protocols={['openai-completions']}
    api={modalWire(describe)}
    t={t}
    readOnly={false}
    onClose={vi.fn()}
  />)
  fireEvent.click(screen.getAllByText('OpenCode Zen')[0]!)
  return view
}

it('labels a preset env reference as not set when nothing resolves it', async () => {
  renderModal(vi.fn(async () => remoteOk({ OPENCODE_API_KEY: { configured: false, writable: true } })))
  await waitFor(() => {
    expect(screen.getByPlaceholderText('Env ref: OPENCODE_API_KEY \u2014 not set')).toBeTruthy()
  })
})

it('labels a preset env reference as configured when it resolves', async () => {
  renderModal(vi.fn(async () => remoteOk({
    OPENCODE_API_KEY: { configured: true, source: 'env', writable: false } as CredentialInfo,
  })))
  await waitFor(() => {
    expect(screen.getByPlaceholderText('Env ref: OPENCODE_API_KEY \u2014 configured')).toBeTruthy()
  })
})

it('keeps the plain env reference when the probe answers nothing or refuses', async () => {
  const absent = vi.fn(async () => remoteOk<Record<string, CredentialInfo>>({}))
  const first = renderModal(absent)
  await waitFor(() => { expect(absent).toHaveBeenCalled() })
  expect(screen.getByPlaceholderText('Env ref: OPENCODE_API_KEY')).toBeTruthy()
  first.unmount()

  const refused = vi.fn(async () => ({
    ok: false as const,
    error: new RemoteError('credential/rejected', 'refused', { ref: 'OPENCODE_API_KEY' }),
  }))
  const second = renderModal(refused)
  await waitFor(() => { expect(refused).toHaveBeenCalled() })
  expect(screen.getByPlaceholderText('Env ref: OPENCODE_API_KEY')).toBeTruthy()
  second.unmount()

  const rejected = vi.fn(async () => { throw new Error('transport down') })
  const third = renderModal(rejected)
  await waitFor(() => { expect(rejected).toHaveBeenCalled() })
  expect(screen.getByPlaceholderText('Env ref: OPENCODE_API_KEY')).toBeTruthy()
  third.unmount()
})

it('asks a keyless preset for no key at all', async () => {
  const describe = vi.fn(async () => remoteOk<Record<string, CredentialInfo>>({}))
  render(<AddProviderModal
    open
    taken={[]}
    protocols={['openai-completions']}
    api={modalWire(describe)}
    t={t}
    readOnly={false}
    onClose={vi.fn()}
  />)
  fireEvent.click(screen.getAllByText('Kilo Gateway')[0]!)
  expect(screen.getByPlaceholderText(en.keylessApiKeyPlaceholder)).toBeTruthy()
})
