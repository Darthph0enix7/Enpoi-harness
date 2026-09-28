// @vitest-environment jsdom
/** Adding a provider discovers and stores its models before the modal closes. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AddProviderModal } from '../src/client/AddProviderModal.tsx'
import type { ModelsWire } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function wire(discoverModels: ReturnType<typeof vi.fn>, mutate: ReturnType<typeof vi.fn>): ModelsWire {
  return {
    settings: { describe: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate },
    credentials: { describe: vi.fn(), set: vi.fn(async () => ({ ok: true as const, value: undefined })), unset: vi.fn() },
    llm: {
      discoverModels,
      listConfigurableProviders: vi.fn(async () => ({ ok: true as const, value: [] })),
      listProviders: vi.fn(),
      poolStatus: vi.fn(),
      poolResetCooldown: vi.fn(),
      poolTestIdentity: vi.fn(),
    },
  } as unknown as ModelsWire
}

it('discovers and stores the new provider models before closing', async () => {
  const discovery = Promise.withResolvers<{
    ok: true
    value: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>
  }>()
  const mutate = vi.fn(async () => ({ ok: true as const, value: {} }))
  const discoverModels = vi.fn(() => discovery.promise)
  const onClose = vi.fn()
  render(<AddProviderModal
    open
    taken={[]}
    protocols={['openai-completions']}
    api={wire(discoverModels, mutate)}
    t={key => en[key]}
    readOnly={false}
    onClose={onClose}
  />)

  fireEvent.click(screen.getByRole('button', { name: 'Empty Provider' }))
  fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), { target: { value: 'https://api.example/v1' } })
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  // The profile write lands first; discovery then holds the modal open with
  // its visible state until the models land.
  await waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(1) })
  expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', {
    provider: 'provider',
    baseURL: 'https://api.example/v1',
    api: 'openai-completions',
  })
  expect(screen.getByRole('button', { name: en.discovering })).toBeTruthy()
  expect(onClose).not.toHaveBeenCalled()

  discovery.resolve({
    ok: true,
    value: [
      { id: 'm-1', name: 'Model One', contextWindow: 128_000, maxTokens: 8_192 },
      { id: 'm-2' },
    ],
  })
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  expect(mutate).toHaveBeenCalledTimes(2)
  expect(mutate).toHaveBeenLastCalledWith('llm-pi-ai', [{
    op: 'set',
    path: ['providers', 'provider', 'models'],
    value: [
      { id: 'm-1', name: 'Model One', contextWindow: 128_000, maxTokens: 8_192 },
      { id: 'm-2' },
    ],
  }], undefined)
})

it('closes with the provider created when discovery is refused', async () => {
  const mutate = vi.fn(async () => ({ ok: true as const, value: {} }))
  const discoverModels = vi.fn(async () => ({ ok: false as const, error: { code: 'llm/discovery-failed', message: 'no endpoint' } }))
  const onClose = vi.fn()
  render(<AddProviderModal
    open
    taken={[]}
    protocols={['openai-completions']}
    api={wire(discoverModels, mutate)}
    t={key => en[key]}
    readOnly={false}
    onClose={onClose}
  />)

  fireEvent.click(screen.getByRole('button', { name: 'Empty Provider' }))
  fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), { target: { value: 'https://api.example/v1' } })
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  // Only the profile write happened; the route stays created without models.
  expect(mutate).toHaveBeenCalledTimes(1)
})

it('closes with the provider created when discovery rejects', async () => {
  const mutate = vi.fn(async () => ({ ok: true as const, value: {} }))
  const discoverModels = vi.fn(async () => { throw new Error('transport down') })
  const onClose = vi.fn()
  render(<AddProviderModal
    open
    taken={[]}
    protocols={['openai-completions']}
    api={wire(discoverModels, mutate)}
    t={key => en[key]}
    readOnly={false}
    onClose={onClose}
  />)

  fireEvent.click(screen.getByRole('button', { name: 'Empty Provider' }))
  fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), { target: { value: 'https://api.example/v1' } })
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  expect(mutate).toHaveBeenCalledTimes(1)
})

it('offers /models discovery and the manual list when a config-only route resolves no models', async () => {
  const mutate = vi.fn(async () => ({ ok: true as const, value: {} }))
  const discoverModels = vi.fn(async () => ({ ok: false as const, error: { code: 'llm/discovery-failed', message: 'no endpoint' } }))
  const onClose = vi.fn()
  render(<AddProviderModal
    open
    taken={[]}
    protocols={['openai-completions']}
    api={{
      ...wire(discoverModels, mutate),
      llm: {
        discoverModels,
        listConfigurableProviders: vi.fn(async () => ({
          ok: true as const,
          value: [{ provider: 'opencode', displayName: 'OpenCode Zen', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode'], declared: true }],
        })),
        listProviders: vi.fn(),
        poolStatus: vi.fn(),
        poolResetCooldown: vi.fn(),
        poolTestIdentity: vi.fn(),
      },
    } as unknown as ModelsWire}
    t={key => en[key]}
    readOnly={false}
    onClose={onClose}
  />)

  fireEvent.click(screen.getAllByText('OpenCode Zen')[0]!)
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(document.querySelector('[data-add-recovery]')).not.toBeNull() })
  expect(onClose).not.toHaveBeenCalled()
  // Manual list: save writes the ids onto the route and closes.
  const save = screen.getByRole('button', { name: en.addSaveModels })
  expect((save as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByPlaceholderText(en.addModelsHint), { target: { value: 'zen-1\nzen-2' } })
  expect((screen.getByRole('button', { name: en.addSaveModels }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: en.addSaveModels }))
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  const last = mutate.mock.calls.at(-1) as unknown as [
    string,
    Array<{ op: string; path: string[]; value: { models?: unknown } }>,
    unknown,
  ] | undefined
  expect(last?.[0]).toBe('llm-pi-ai')
  expect(last?.[1]).toEqual([{
    op: 'set',
    path: ['providers', 'opencode'],
    value: expect.objectContaining({ models: [{ id: 'zen-1' }, { id: 'zen-2' }] }),
  }])
})

it('retries /models from the recovery panel and rewrites the full profile', async () => {
  const mutate = vi.fn(async () => ({ ok: true as const, value: {} }))
  const discoverModels = vi.fn()
    .mockResolvedValueOnce({ ok: false as const, error: { code: 'llm/discovery-failed', message: 'no endpoint' } })
    .mockResolvedValueOnce({ ok: true as const, value: [{ id: 'zen-1', name: 'Zen One' }] })
  const onClose = vi.fn()
  render(<AddProviderModal
    open
    taken={[]}
    protocols={['openai-completions']}
    api={{
      ...wire(discoverModels, mutate),
      llm: {
        discoverModels,
        listConfigurableProviders: vi.fn(async () => ({
          ok: true as const,
          value: [{ provider: 'opencode', displayName: 'OpenCode Zen', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode'], declared: true }],
        })),
        listProviders: vi.fn(),
        poolStatus: vi.fn(),
        poolResetCooldown: vi.fn(),
        poolTestIdentity: vi.fn(),
      },
    } as unknown as ModelsWire}
    t={key => en[key]}
    readOnly={false}
    onClose={onClose}
  />)

  fireEvent.click(screen.getAllByText('OpenCode Zen')[0]!)
  fireEvent.click(screen.getByRole('button', { name: en.create }))
  await waitFor(() => { expect(document.querySelector('[data-add-recovery]')).not.toBeNull() })
  fireEvent.click(screen.getByRole('button', { name: en.addDiscoverRetry }))
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  const last = mutate.mock.calls.at(-1) as unknown as [
    string,
    Array<{ op: string; path: string[]; value: { models?: unknown } }>,
    unknown,
  ] | undefined
  expect(last?.[1]).toEqual([{
    op: 'set',
    path: ['providers', 'opencode'],
    value: expect.objectContaining({ models: [{ id: 'zen-1', name: 'Zen One' }] }),
  }])
})

it('keeps a repairable recovery panel when the profile write itself names missing models', async () => {
  const mutate = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'settings/invalid', message: 'llm-pi-ai: provider "opencode" resolves no models; the installed catalog does not describe this route' },
  }))
  const discoverModels = vi.fn()
  const onClose = vi.fn()
  render(<AddProviderModal
    open
    taken={[]}
    protocols={['openai-completions']}
    api={wire(discoverModels, mutate)}
    t={key => en[key]}
    readOnly={false}
    onClose={onClose}
  />)

  fireEvent.click(screen.getAllByText('OpenCode Zen')[0]!)
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(document.querySelector('[data-add-recovery]')).not.toBeNull() })
  expect(onClose).not.toHaveBeenCalled()
  expect(discoverModels).not.toHaveBeenCalled()
})

it('closes without recovery when the installed catalog describes the route', async () => {
  const mutate = vi.fn(async () => ({ ok: true as const, value: {} }))
  const discoverModels = vi.fn(async () => ({ ok: true as const, value: [] }))
  const onClose = vi.fn()
  render(<AddProviderModal
    open
    taken={[]}
    protocols={['openai-completions']}
    api={{
      ...wire(discoverModels, mutate),
      llm: {
        discoverModels,
        listConfigurableProviders: vi.fn(async () => ({
          ok: true as const,
          value: [{ provider: 'opencode', displayName: 'OpenCode Zen', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode'], declared: false }],
        })),
        listProviders: vi.fn(),
        poolStatus: vi.fn(),
        poolResetCooldown: vi.fn(),
        poolTestIdentity: vi.fn(),
      },
    } as unknown as ModelsWire}
    t={key => en[key]}
    readOnly={false}
    onClose={onClose}
  />)

  fireEvent.click(screen.getAllByText('OpenCode Zen')[0]!)
  fireEvent.click(screen.getByRole('button', { name: en.create }))
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  expect(document.querySelector('[data-add-recovery]')).toBeNull()
})
