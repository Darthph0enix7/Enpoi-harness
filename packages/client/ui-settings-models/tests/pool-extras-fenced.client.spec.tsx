// @vitest-environment jsdom
/**
 * The per-card Key Pool editor writes through the shared revision fence: a
 * conflict re-reads the document and re-applies the operator's draft, and an
 * add retry never duplicates an identity a previous attempt committed.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RemoteResult, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { PoolProviderCardExtras, type PoolProviderCardExtrasProps } from '../src/client/pool-extras.tsx'
import { en } from '../src/client/locales.ts'
import { translateEn } from './translate.client.ts'

afterEach(cleanup)

/** One successful Remote answer. */
function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One stored pool with a single identity. */
function storedPool() {
  return {
    strategy: 'priority-sticky',
    identities: [{ id: 'primary', credentialRef: 'OPENAI_API_KEY', priority: 1, enabled: true }],
  }
}

/** One llm-pi-ai namespace carrying the route's pool. */
function poolNamespace(revision: number): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: {},
    value: {
      providers: {
        openai: { displayName: 'openai', api: 'openai-completions', baseURL: 'https://proxy', pool: storedPool() },
      },
    } as JsonValue,
    autoGenerate: true,
    applies: 'live',
    secrets: [],
    revision,
  }
}

/** Mount the card over a describe that moves the revision on every call. */
function mount(mutate: ReturnType<typeof vi.fn>, set: ReturnType<typeof vi.fn> = vi.fn(async () => ok(undefined))) {
  let revision = 1
  const describe = vi.fn(async () => ok({
    writable: true,
    hasDocument: false,
    namespaces: [poolNamespace(revision++)],
  }))
  const props = {
    provider: {
      provider: 'openai',
      displayName: 'openai',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      active: true,
    },
    configured: true,
    keyConfigured: true,
    settings: { describe, update: vi.fn(), replace: vi.fn(), mutate } as unknown as PoolProviderCardExtrasProps['settings'],
    credentials: { describe: vi.fn(), set, unset: vi.fn() } as unknown as PoolProviderCardExtrasProps['credentials'],
    llm: {
      discoverModels: vi.fn(),
      listConfigurableProviders: vi.fn(),
      listProviders: vi.fn(),
      poolStatus: vi.fn(async () => ok([])),
      poolResetCooldown: vi.fn(),
      poolTestIdentity: vi.fn(),
    },
    t: translateEn,
  } as unknown as PoolProviderCardExtrasProps
  render(<PoolProviderCardExtras {...props} />)
}

/** One conflict refusal with the namespace details. */
function conflictRefusal(ns: string) {
  return { ok: false as const, error: new RemoteError('settings/conflict', 'stale', { ns, expected: 1, actual: 2 }) }
}

it('re-reads and re-applies the strategy after a conflict', async () => {
  const mutate = vi.fn()
    .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
    .mockResolvedValue(ok(undefined))
  mount(mutate)

  const strategy = await screen.findByTitle<HTMLSelectElement>(en.poolStrategy)
  fireEvent.change(strategy, { target: { value: 'balanced' } })

  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
  // The mount read took revision 1; the refused attempt fenced on 2 and the
  // retry on the re-read 3.
  expect(mutate.mock.calls.map(call => call[2])).toEqual([2, 3])
  expect(mutate.mock.calls[1]![1]).toEqual([
    { op: 'set', path: ['providers', 'openai', 'pool', 'strategy'], value: 'balanced' },
  ])
  expect(screen.queryByRole('alert')).toBeNull()
})

it('re-reads and re-applies an identity toggle after a conflict', async () => {
  const mutate = vi.fn()
    .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
    .mockResolvedValue(ok(undefined))
  mount(mutate)

  fireEvent.click(await screen.findByTitle(en.poolDisable))

  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
  const [, ops] = mutate.mock.calls[1] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string; enabled?: boolean }> }>]
  expect(ops[0]?.path).toEqual(['providers', 'openai', 'pool', 'identities'])
  expect(ops[0]?.value).toEqual([{ id: 'primary', credentialRef: 'OPENAI_API_KEY', priority: 1, enabled: false }])
})

it('re-reads and re-applies an added identity after a conflict', async () => {
  const mutate = vi.fn()
    .mockResolvedValueOnce(conflictRefusal('llm-pi-ai'))
    .mockResolvedValue(ok(undefined))
  mount(mutate)

  fireEvent.click(await screen.findByRole('button', { name: en.poolAdd }))
  fireEvent.change(screen.getByLabelText(en.poolName), { target: { value: 'secondary' } })
  fireEvent.change(screen.getByLabelText(en.poolSecret), { target: { value: 'sk-second' } })
  fireEvent.click(screen.getByRole('button', { name: en.poolSave }))

  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
  expect(mutate.mock.calls.map(call => call[2])).toEqual([2, 3])
  const [, ops] = mutate.mock.calls[1] as unknown as [string, Array<{ path: string[]; value: Array<{ id: string }> }>]
  expect(ops[0]?.path).toEqual(['providers', 'openai', 'pool', 'identities'])
  // The fresh map is the base: the draft appends once, never twice.
  expect(ops[0]?.value.map(identity => identity.id)).toEqual(['primary', 'secondary'])
})
