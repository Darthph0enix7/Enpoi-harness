// @vitest-environment jsdom
/**
 * Add Provider's heavy branch: quirks/dashboard/browser badges are surfaced,
 * the recommended reuse mode writes the route through the host, local mode
 * polls the install job, a preset-only provider reads as listed/addable with
 * an unchecked health affordance, and an early click reports the restart
 * ordering instead of a raw settings.mutate failure.
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
    credentials: { describe: vi.fn(async () => ({ ok: true as const, value: {} })), set: vi.fn(), unset: vi.fn() },
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

/** One refused gateway envelope, as heavyRpc reports a failed host call. */
function errorEnvelope(message: string): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: false, error: { message } } }),
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
      return envelope(answers.status ?? {
        id: 'x',
        configured: false,
        health: { ok: true, status: 200, checkedAt: 1 },
        detectedPort: 3002,
        detectedEndpoint: 'http://127.0.0.1:3002/v1',
        runtime: { docker: true, podman: false },
        preflight: { path: 'detected', label: 'Use the detected instance', missing: [], requires: [] },
      })
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
  // FreeLLMAPI has no browser-bound account flow: no badge, but the local
  // dependency line is explicit.
  expect(screen.queryByText(en.heavyBrowserBadge)).toBeNull()
  expect(screen.getByText(/native installers for Linux\/macOS\/Windows; Docker required only for the fallback path/)).toBeTruthy()
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyReuse) })).toBeTruthy()
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) })).toBeTruthy()
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyReuse) })).toHaveProperty('checked', true)
  // An answering local instance is offered first, and the mode is recommended.
  await waitFor(() => {
    expect(screen.getByText(en.heavyDetectedOffer.replace('{endpoint}', 'http://127.0.0.1:3002/v1'))).toBeTruthy()
  })
})

it('preselects the install path and names missing requirements when nothing answers', async () => {
  stubHeavyFetch({ status: {
    id: 'x',
    configured: false,
    health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
    runtime: { docker: false, podman: false },
    preflight: {
      path: 'unsupported',
      label: 'Install locally (vendor one-liner, Docker)',
      missing: ['Docker Engine + Compose (or Podman)'],
      requires: ['docker'],
    },
  } })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  await waitFor(() => {
    expect(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) })).toHaveProperty('checked', true)
  })
  expect(screen.getByText(
    en.heavyPreflightMissing.replace('{missing}', 'Docker Engine + Compose (or Podman)'),
  )).toBeTruthy()
  // The local mode lists the platform's install steps.
  expect(screen.getByText(en.heavyInstallSteps)).toBeTruthy()
})

it('renders the Self-hosted / heavy group AFTER the mainstream catalog, and search still finds it', () => {
  stubHeavyFetch({})
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

  const popular = screen.getByText('Popular')
  const all = screen.getByText('All Providers')
  const heavy = screen.getByText(en.heavyGroup)
  expect(en.heavyGroup).toBe('Self-hosted / heavy')
  const follows = (first: HTMLElement, second: HTMLElement): boolean =>
    (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  expect(follows(popular, all)).toBe(true)
  expect(follows(all, heavy)).toBe(true)

  // The heavy row sits inside its group, after the All Providers label.
  expect(follows(all, screen.getByText('FreeLLMAPI'))).toBe(true)

  // Search still finds heavy providers through the flat filtered list.
  fireEvent.change(screen.getByPlaceholderText(/Search 212 providers/), { target: { value: 'freellmapi' } })
  expect(screen.getByText('FreeLLMAPI')).toBeTruthy()
  expect(screen.queryByText(en.heavyGroup)).toBeNull()
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

it('a preset-only heavy provider reads as listed — add to configure, health unchecked until the probe', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { method: string }
    if (body.method === 'enpoiHeavy.status') return errorEnvelope('host unreachable')
    return envelope({})
  }))
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

  expect(screen.getAllByText(en.heavyListedBadge).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByText('Command Code (keypool)'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  // Never the blocked/planned wording, and the add stays available.
  expect(screen.queryByText(en.heavyBlockedTitle)).toBeNull()
  expect(screen.queryByText(en.heavyPlannedBadge)).toBeNull()
  const create = screen.getByRole('button', { name: en.create })
  expect(create).toHaveProperty('disabled', false)
  // A refused probe leaves the health card in "Not checked" with a retry.
  await waitFor(() => { expect(screen.getByRole('button', { name: en.heavyCheckNow })).toBeTruthy() })
  expect(screen.getByText(en.heavyHealthUnknown)).toBeTruthy()
})

it('shows the ordering note when the host reports the route namespace unmounted', async () => {
  stubHeavyFetch({ status: {
    id: 'commandcode',
    configured: false,
    health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
    settingsNs: 'commandcode-provider',
    settingsReady: false,
    runtime: { docker: true, podman: false },
    preflight: { path: 'node', label: 'Install locally (provider package + keypool)', missing: [], requires: [] },
  } })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('Command Code (keypool)'))
  await waitFor(() => {
    expect(screen.getByText(en.heavyPendingRestart.replace('{ns}', 'commandcode-provider'))).toBeTruthy()
  })
})

it('a reuse click before the route namespace is mounted reports the restart ordering', async () => {
  const message = 'Available after the next restart — the "commandcode-provider" settings namespace is not registered in the running profile yet (build the profile, then restart the service).'
  const { methods } = stubHeavyFetch({ reuse: {
    ok: false,
    pendingRestart: { ns: 'commandcode-provider', message },
  } })
  const onClose = vi.fn()
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={key => en[key]} readOnly={false} onClose={onClose} />)

  fireEvent.click(screen.getByText('Command Code (keypool)'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(screen.getByText(message)).toBeTruthy() })
  expect(onClose).not.toHaveBeenCalled()
  expect(methods).toContain('enpoiHeavy.reuse')
})
