// @vitest-environment jsdom
/**
 * Add Provider's heavy branch: quirks/dashboard/browser badges are surfaced,
 * the recommended reuse mode writes the route through the host, local mode
 * polls the install job, and commandcode is blocked until its provider
 * package exists.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AddProviderModal } from '../src/client/AddProviderModal.tsx'
import type { ModelsWire } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function wire(): ModelsWire {
  return {
    settings: { describe: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn() },
    credentials: { describe: vi.fn(), set: vi.fn(), unset: vi.fn() },
    llm: {
      discoverModels: vi.fn(),
      listConfigurableProviders: vi.fn(),
      listProviders: vi.fn(),
      poolStatus: vi.fn(),
      poolResetCooldown: vi.fn(),
      poolTestIdentity: vi.fn(),
    },
  } as unknown as ModelsWire
}

/** One gateway envelope response for `/api/enpoiHeavy.*`. */
function envelope(value: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: true, value } }),
  } as unknown as Response)
}

/** Track every heavy method called and answer with canned values. */
function stubHeavyFetch(answers: Record<string, unknown>): { methods: string[] } {
  const methods: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { method: string }
    methods.push(body.method)
    if (body.method === 'enpoiHeavy.manifests') return envelope({ items: [], problems: [] })
    if (body.method === 'enpoiHeavy.status') {
      return envelope(answers.status ?? { id: 'x', configured: false, health: { ok: true, status: 200, checkedAt: 1 } })
    }
    if (body.method === 'enpoiHeavy.reuse') return envelope(answers.reuse ?? { ok: true, health: { ok: true, status: 200, checkedAt: 1 } })
    if (body.method === 'enpoiHeavy.install') return envelope(answers.install ?? { ok: true, job: { id: 'x', kind: 'install', state: 'running', stage: 'Clone', stageIndex: 0, stageCount: 4, pct: 10, logTail: '', startedAt: 1 } })
    if (body.method === 'enpoiHeavy.job') return envelope(answers.job ?? { job: { id: 'x', kind: 'install', state: 'succeeded', stage: 'Done', stageIndex: 4, stageCount: 4, pct: 100, logTail: 'ok', startedAt: 1, finishedAt: 2 } })
    return envelope({})
  }))
  return { methods }
}

it('lists the heavy presets with a Heavy badge and surfaces quirks and mode choice', async () => {
  stubHeavyFetch({})
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

  expect(screen.getByText(en.heavyGroup)).toBeTruthy()
  expect(screen.getByText('FreeLLMAPI')).toBeTruthy()
  fireEvent.click(screen.getByText('FreeLLMAPI'))

  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  expect(screen.getByRole('link', { name: `${en.heavyDashboard} ↗` })).toBeTruthy()
  expect(screen.getAllByText(en.heavyBrowserBadge).length).toBeGreaterThan(0)
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyReuse) })).toBeTruthy()
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) })).toBeTruthy()
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyReuse) })).toHaveProperty('checked', true)
})

it('reuse mode writes the route through the host and closes', async () => {
  const { methods } = stubHeavyFetch({})
  const onClose = vi.fn()
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={onClose} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  expect(methods).toContain('enpoiHeavy.reuse')
})

it('local mode starts the install job and polls it to success', async () => {
  const { methods } = stubHeavyFetch({})
  const onClose = vi.fn()
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={onClose} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) }))
  expect(screen.getByText(en.heavyInstallSteps)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) }, { timeout: 4000 })
  expect(methods).toContain('enpoiHeavy.install')
  expect(methods).toContain('enpoiHeavy.job')
})

it('commandcode is blocked until its custom provider package exists', async () => {
  stubHeavyFetch({})
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('Command Code (keypool)'))
  expect(screen.getByText(en.heavyBlockedTitle)).toBeTruthy()
  const create = screen.getByRole('button', { name: en.create })
  expect(create).toHaveProperty('disabled', true)
})
