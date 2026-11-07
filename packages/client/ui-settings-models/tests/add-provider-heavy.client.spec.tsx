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
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AddProviderModal } from '../src/client/AddProviderModal.tsx'
import modalStyles from '../src/client/AddProviderModal.module.css'
import docsStyles from '../src/client/HeavyProviderDocs.module.css'
import { fallbackHeavyManifest } from '../src/client/heavy-providers.ts'
import { bindHostHeavyManifests, resetHeavyManifestSource } from '../src/client/heavy-manifest-source.ts'
import type { ModelsWire } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { translateEn } from './translate.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetHeavyManifestSource()
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

/** Track every heavy method (and its args) called and answer with canned values. */
function stubHeavyFetch(answers: Record<string, unknown>): {
  methods: string[]
  requests: Array<{ method: string; args: { request?: Record<string, unknown> } }>
} {
  const methods: string[] = []
  const requests: Array<{ method: string; args: { request?: Record<string, unknown> } }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { method: string; payload?: { args?: { request?: Record<string, unknown> } } }
    methods.push(body.method)
    requests.push({ method: body.method, args: body.payload?.args ?? {} })
    if (body.method === 'enpoiHeavy.manifests') return envelope(answers.manifests ?? { items: [], problems: [] })
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
  return { methods, requests }
}

it('lists the heavy presets with a Heavy badge and surfaces quirks and mode choice', async () => {
  stubHeavyFetch({})
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  expect(screen.getByText(en.heavyGroup)).toBeTruthy()
  expect(screen.getByText('FreeLLMAPI')).toBeTruthy()
  fireEvent.click(screen.getByText('FreeLLMAPI'))

  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  expect(screen.getByRole('link', { name: `${en.heavyDashboard} ↗` })).toBeTruthy()
  // FreeLLMAPI has no browser-bound account flow: no badge, but the local
  // dependency line is explicit.
  expect(screen.queryByText(en.heavyBrowserBadge)).toBeNull()
  expect(screen.getByText(/Linux uses Docker\/Podman compose; macOS\/Windows use the vendor desktop app/)).toBeTruthy()
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
      label: 'Install locally (Docker or Podman)',
      missing: ['Docker Engine + Compose (or Podman)'],
      requires: ['docker'],
    },
  } })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

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

it('shows the refused platform reason in the heavy form instead of install steps', async () => {
  stubHeavyFetch({ status: {
    id: 'antigravity',
    configured: false,
    platform: 'win32',
    health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
    runtime: { docker: false, podman: false },
    preflight: { path: 'unsupported', label: 'Not supported on Windows', missing: [], requires: [] },
  } })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('Antigravity Proxy'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) }))
  await waitFor(() => {
    expect(screen.getByText(/POSIX user service \(systemd or launchd\)/)).toBeTruthy()
  })
  expect(screen.getAllByText(/Not supported on Windows/).length).toBeGreaterThan(0)
  expect(screen.getByText(en.heavyInstallSteps)).toBeTruthy()
  // The refused variant renders its reason, never a step list.
  expect(screen.queryByText('Install the proxy package')).toBeNull()
})

it('a keyless provider offers no key field and states the anonymous route', async () => {
  stubHeavyFetch({})
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('Antigravity Proxy'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  // The keyless note replaces the unified-key field for a `none` auth route.
  expect(screen.getByText(en.heavyAuthNone)).toBeTruthy()
  expect(screen.queryByPlaceholderText(en.heavyKeyPlaceholder)).toBeNull()
})

it('renders the Self-hosted / heavy group AFTER the mainstream catalog, and search still finds it', () => {
  stubHeavyFetch({})
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

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
  fireEvent.change(screen.getByPlaceholderText(/Search \d+ providers/), { target: { value: 'freellmapi' } })
  expect(screen.getByText('FreeLLMAPI')).toBeTruthy()
  expect(screen.queryByText(en.heavyGroup)).toBeNull()
})

it('reuse mode writes the route through the host and closes', async () => {
  const { methods } = stubHeavyFetch({})
  const onClose = vi.fn()
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={onClose} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  expect(methods).toContain('enpoiHeavy.reuse')
})

it('offers a custom-instance URL on a service reuse and sends the typed address', async () => {
  const { requests } = stubHeavyFetch({})
  const onClose = vi.fn()
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={onClose} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  expect(screen.getByText(en.heavyCustomLabel)).toBeTruthy()
  // The field takes an origin only (the host applies the declared paths); a
  // non-loopback address is accepted explicitly: the operator typed it.
  const field = screen.getByPlaceholderText('http://127.0.0.1:3002')
  fireEvent.change(field, { target: { value: 'http://192.168.1.10:4000/v1' } })
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  const reuse = requests.find(request => request.method === 'enpoiHeavy.reuse')
  expect(reuse?.args.request).toEqual({ id: 'freellmapi', baseURL: 'http://192.168.1.10:4000/v1' })
})

it('a direct vendor route gets no custom-instance field and sends no baseURL', async () => {
  const { requests } = stubHeavyFetch({})
  const onClose = vi.fn()
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={translateEn} readOnly={false} onClose={onClose} />)

  fireEvent.click(screen.getByText('Command Code'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  expect(screen.queryByText(en.heavyCustomLabel)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  const reuse = requests.find(request => request.method === 'enpoiHeavy.reuse')
  expect(reuse?.args.request).toEqual({ id: 'commandcode' })
})

it('local mode starts the install job and polls it to success', async () => {
  const { methods } = stubHeavyFetch({})
  const onClose = vi.fn()
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={onClose} />)

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
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  expect(screen.getAllByText(en.heavyListedBadge).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByText('Command Code'))
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
    preflight: { path: 'node', label: 'Link the provider package, then use the vendor endpoint', missing: [], requires: [] },
  } })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('Command Code'))
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
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={translateEn} readOnly={false} onClose={onClose} />)

  fireEvent.click(screen.getByText('Command Code'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => { expect(screen.getByText(message)).toBeTruthy() })
  expect(onClose).not.toHaveBeenCalled()
  expect(methods).toContain('enpoiHeavy.reuse')
})

it('a malformed host manifest address falls back to its raw text in the origin placeholder', async () => {
  const base = fallbackHeavyManifest('freellmapi')!
  bindHostHeavyManifests({
    items: [{ ...base, reuse: { ...base.reuse, baseURL: 'not-a-url' } }],
    platform: 'linux',
    problems: [],
  })
  stubHeavyFetch({})
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  // A host address that cannot parse renders as-is instead of crashing the
  // modal; the shipped table's address yields its origin (test above).
  expect(screen.getByPlaceholderText('not-a-url')).toBeTruthy()
})

it('contains modal dialog, content scroller, and documentation inside scrollable surfaces', async () => {
  stubHeavyFetch({})
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('Command Code'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })

  // The modal dialog must carry the contained layout and dialog class contract.
  const dialog = document.querySelector('[class*="addProviderDialog"]') as HTMLElement
  expect(dialog).toBeTruthy()
  expect(dialog.className).toContain(modalStyles.dialog)

  // The modal content wrapper must carry the scrollable scroller class.
  const content = dialog.querySelector(`.${modalStyles.content}`) as HTMLElement
  expect(content).toBeTruthy()

  // Opening the docs panel mounts the contained docs section inside the modal body.
  const docsBtn = screen.getByRole('button', { name: en.heavyDocumentation })
  fireEvent.click(docsBtn)
  await waitFor(() => {
    expect(screen.getByText(en.heavyHideDocumentation)).toBeTruthy()
  })

  const docsSection = document.querySelector('[data-heavy-docs]') as HTMLElement
  expect(docsSection).toBeTruthy()
  expect(docsSection.className).toContain(docsStyles.heavyDocs)

  // Controls in the footer remain mounted, reachable, and unpushed.
  expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
  expect(screen.getByRole('button', { name: en.create })).toBeTruthy()
})

it('contains local install steps list as a contained scrollable container', async () => {
  stubHeavyFetch({})
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) }))

  await waitFor(() => {
    expect(screen.getByText(en.heavyInstallSteps)).toBeTruthy()
  })

  const stepsList = document.querySelector('[data-heavy-steps-list]') as HTMLElement
  expect(stepsList).toBeTruthy()
  expect(stepsList.className).toContain(modalStyles.heavyStepsList)
})

it('contains progress card and log tail as contained surfaces with ≤8 KB log without pushing controls', async () => {
  const hugeLog = 'step execution line\n'.repeat(450) // ~9 KB log
  stubHeavyFetch({
    install: {
      ok: true,
      job: {
        id: 'freellmapi',
        kind: 'install',
        state: 'running',
        stage: 'Extracting images',
        stageIndex: 1,
        stageCount: 4,
        pct: 35,
        logTail: hugeLog,
        startedAt: 1,
      },
    },
    job: {
      job: {
        id: 'freellmapi',
        kind: 'install',
        state: 'running',
        stage: 'Extracting images',
        stageIndex: 1,
        stageCount: 4,
        pct: 35,
        logTail: hugeLog,
        startedAt: 1,
      },
    },
  })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) }))
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => {
    expect(document.querySelector('[data-heavy-progress]')).toBeTruthy()
  })

  const progress = document.querySelector('[data-heavy-progress]') as HTMLElement
  expect(progress.className).toContain(modalStyles.heavyProgress)

  const log = document.querySelector('[data-heavy-log]') as HTMLElement
  expect(log).toBeTruthy()
  expect(log.className).toContain(modalStyles.heavyLog)
  expect(log.textContent).toContain('step execution line')

  // Back and Installing buttons in the footer remain mounted and accessible.
  expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
  expect(screen.getByRole('button', { name: en.heavyInstalling })).toBeTruthy()
})

it('never rerenders a succeeded install snapshot as a progress track with its old log', async () => {
  const stale = {
    id: 'freellmapi',
    kind: 'install',
    state: 'succeeded',
    stage: 'Finishing',
    stageIndex: 4,
    stageCount: 4,
    pct: 100,
    logTail: 'old log from days ago',
    startedAt: 1,
    finishedAt: 2,
  }
  stubHeavyFetch({ install: { ok: true, job: stale }, job: { job: stale } })
  const onClose = vi.fn()
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={onClose} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) }))
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  // The succeeded snapshot closes the modal but is never painted as progress.
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  expect(document.querySelector('[data-heavy-progress]')).toBeNull()
  expect(document.querySelector('[data-heavy-log]')).toBeNull()
  expect(screen.queryByText('old log from days ago')).toBeNull()
})

it('preserves reuse mode and displays auth required notice when probe returns 401 without auto-flipping to local', async () => {
  stubHeavyFetch({
    status: {
      id: 'freellmapi',
      configured: false,
      health: { ok: false, status: 401, error: 'Unauthorized', checkedAt: 1 },
      preflight: { path: 'unsupported', label: 'Install locally', missing: ['docker'], requires: ['docker'] },
    },
  })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })

  // 1. Must NOT auto-flip to 'local': stays on 'reuse'
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyReuse) })).toHaveProperty('checked', true)
  // 2. Health badge displays Auth required · 401
  expect(screen.getByText(new RegExp(`${en.heavyHealthAuth} · 401`))).toBeTruthy()
  // 3. Preflight note indicates reachable at endpoint — auth required
  expect(screen.getByText(/authorization required \(HTTP 401\)/)).toBeTruthy()
})

it('disables Create button in local mode when preflight is unsupported but allows reuse mode', async () => {
  stubHeavyFetch({
    status: {
      id: 'freellmapi',
      configured: false,
      health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
      preflight: { path: 'unsupported', label: 'Install locally (Docker or Podman)', missing: ['docker'], requires: ['docker'] },
    },
  })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })

  // Nothing answered → local mode was auto-selected, preflight is unsupported → Create button is disabled
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) })).toHaveProperty('checked', true)
  expect(screen.getByRole('button', { name: en.create })).toHaveProperty('disabled', true)

  // Switching back to reuse mode (e.g. to point to a custom URL or save offline) re-enables Create
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.heavyReuse) }))
  expect(screen.getByRole('button', { name: en.create })).toHaveProperty('disabled', false)
})

it('displays platform-resolved deps and diskHint for darwin rather than base values', async () => {
  stubHeavyFetch({
    status: {
      id: 'freellmapi',
      configured: false,
      platform: 'darwin',
      health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
      preflight: { path: 'vendor-app', label: 'Install locally (vendor desktop app, no Docker)', missing: [], requires: [] },
    },
  })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) }))

  // Must show the Darwin override deps, NOT the base Docker dependencies
  await waitFor(() => {
    expect(screen.getByText(/macOS 11\+/)).toBeTruthy()
    expect(screen.getByText(/~250 MB app; data in ~/)).toBeTruthy()
  })
  expect(screen.queryByText(/Docker Engine or Podman/)).toBeNull()
})

it('retargets dashboard URL to custom remote endpoint origin without embedding tokens or secrets', async () => {
  stubHeavyFetch({
    status: {
      id: 'freellmapi',
      configured: false,
      health: { ok: true, status: 200, checkedAt: 1 },
      detectedEndpoint: 'http://127.0.0.1:3002/v1',
    },
  })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })

  // Enter custom remote base URL with secret/token query string
  const customInput = document.querySelector('[data-heavy-custom-url]') as HTMLInputElement
  expect(customInput).toBeTruthy()
  fireEvent.change(customInput, { target: { value: 'http://100.122.163.25:8317?secret=supersecret#admin' } })

  await waitFor(() => {
    const dashboardLink = screen.getByRole('link', { name: new RegExp(en.heavyDashboard) })
    expect(dashboardLink.getAttribute('href')).toBe('http://100.122.163.25:8317')
    expect(dashboardLink.getAttribute('href')).not.toContain('secret')
    expect(dashboardLink.getAttribute('href')).not.toContain('127.0.0.1')
  })
})

it('keeps direct delivery provider (Command Code) on reuse mode even without detection', async () => {
  stubHeavyFetch({
    status: {
      id: 'commandcode',
      configured: false,
      health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
      preflight: { path: 'vendor-app', label: 'Link package', missing: [], requires: [] },
    },
  })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('Command Code'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })

  // Direct delivery must NEVER auto-flip to local mode, even when undetected/unreachable
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyReuse) })).toHaveProperty('checked', true)
})

it('allows Create in reuse mode on win32 even when local install is unsupported on win32', async () => {
  stubHeavyFetch({
    status: {
      id: 'antigravity',
      configured: false,
      platform: 'win32',
      health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
      preflight: { path: 'unsupported', label: 'Not supported on Windows', missing: [], requires: [] },
    },
  })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('Antigravity Proxy'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })

  // Auto-flip selects local when nothing answers; win32 local install is unsupported -> Create is disabled
  await waitFor(() => {
    expect(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) })).toHaveProperty('checked', true)
  })
  expect(screen.getByRole('button', { name: en.create })).toHaveProperty('disabled', true)

  // Switching to reuse mode on win32 allows Create (for pointing to custom or network proxy)
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.heavyReuse) }))
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyReuse) })).toHaveProperty('checked', true)
  expect(screen.getByRole('button', { name: en.create })).toHaveProperty('disabled', false)
})

it('keeps healthy endpoints on reuse mode without auto-flipping to local', async () => {
  stubHeavyFetch({
    status: {
      id: 'antigravity',
      configured: false,
      health: { ok: true, status: 200, checkedAt: 1 },
      detectedEndpoint: 'http://127.0.0.1:8082',
    },
  })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('Antigravity Proxy'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })

  // Healthy detected endpoint must stay on reuse mode
  expect(screen.getByRole('radio', { name: new RegExp(en.heavyReuse) })).toHaveProperty('checked', true)
})

it('binds asynchronous Add status results by manifest id and generation so late response cannot contaminate switched provider', async () => {
  let resolveFirstStatus!: (resp: Response) => void
  const firstStatusPromise = new Promise<Response>((resolve) => {
    resolveFirstStatus = resolve
  })

  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { method: string; payload?: { args?: { request?: { id?: string } } } }
    if (body.method === 'enpoiHeavy.status') {
      const id = body.payload?.args?.request?.id
      if (id === 'freellmapi') {
        return firstStatusPromise
      }
      if (id === 'antigravity') {
        return envelope({
          id: 'antigravity',
          configured: false,
          health: { ok: true, status: 200, checkedAt: 100 },
          detectedEndpoint: 'http://127.0.0.1:8082',
        })
      }
    }
    return envelope({})
  }))

  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  // 1. Select FreeLLMAPI (initiates first status request which hangs)
  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })

  // 2. Click Back and select Antigravity Proxy
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(screen.getByText('Antigravity Proxy'))
  await waitFor(() => {
    // Antigravity resolves immediately with healthy 200
    expect(screen.getByText(/Healthy · 200/)).toBeTruthy()
  })

  // 3. Late FreeLLMAPI status resolves with 401
  resolveFirstStatus(await envelope({
    id: 'freellmapi',
    configured: false,
    health: { ok: false, status: 401, error: 'Unauthorized', checkedAt: 200 },
  }))

  // 4. Antigravity must NOT be contaminated by FreeLLMAPI's late 401 response!
  await new Promise(r => setTimeout(r, 50))
  expect(screen.queryByText(/Auth required · 401/)).toBeNull()
  expect(screen.getByText(/Healthy · 200/)).toBeTruthy()
})

it('pins the scrollbar rebind and token discipline contract in AddProviderModal.module.css', () => {
  const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/AddProviderModal.module.css'), 'utf8')
  const themeTokensDir = resolve(import.meta.dirname, '../../ui-theme/src/styles')
  const themeTokens = readdirSync(themeTokensDir)
    .filter(name => name.endsWith('.css'))
    .map(name => readFileSync(resolve(themeTokensDir, name), 'utf8'))
    .join('\n')

  // Elevated-surface scrollbar rebind on the containers.
  expect(sheet).toContain('--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);')
  expect(sheet).toContain('--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);')

  // Scroller properties on dialog, content, steps list, and log.
  expect(sheet).toContain('overflow-y: auto;')
  expect(sheet).toContain('max-height: min(840px, 100%);')
  expect(sheet).toContain('overscroll-behavior: contain;')
  expect(sheet).toContain('position: sticky;')

  // Token discipline: every used variable must be defined in ui-theme styles.
  const named = [...sheet.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
  const undeclared = [...new Set(named)].filter(name => !themeTokens.includes(`  ${String(name)}:`))
  expect(undeclared).toEqual([])

  // Block balancing: no unclosed brackets.
  const bare = sheet.replace(/\/\*[\s\S]*?\*\//g, '')
  expect((bare.match(/\}/g) ?? []).length).toBe((bare.match(/\{/g) ?? []).length)
})

it('hides the local key field for the self-keying CLIProxyAPI installer and never sends a key', async () => {
  const stub = stubHeavyFetch({ status: {
    id: 'cliproxyapi',
    configured: false,
    mode: 'local',
    installedByHarness: true,
    platform: 'linux',
    bootstrapPath: '/home/tester/.dsh/providers/cliproxyapi/config.yaml',
    managementKeyPath: '/home/tester/.dsh/providers/cliproxyapi/config.yaml',
    health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
    preflight: { path: 'node', label: 'Install locally (verified release + user service)', missing: [], requires: [] },
  } })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('CLIProxyAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  await waitFor(() => { expect(screen.getByRole('radio', { name: new RegExp(en.heavyLocal) })).toHaveProperty('checked', true) })

  // The installer owns the key: no client key field, and the secretless path
  // hint names where the generated key lives.
  expect(screen.queryByText(en.heavyKeyLabel)).toBeNull()
  expect(screen.getByText(en.heavySelfKeyedKeyNotice)).toBeTruthy()
  expect(screen.getByText(en.heavyInstallKeyPath.replace('{path}', '/home/tester/.dsh/providers/cliproxyapi/config.yaml'))).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: en.create }))
  await waitFor(() => { expect(stub.requests.some(request => request.method === 'enpoiHeavy.install')).toBe(true) })
  const install = stub.requests.find(request => request.method === 'enpoiHeavy.install')
  expect(install?.args.request).toEqual({ id: 'cliproxyapi' })
})

it('keeps the dialog open with a warning when a reuse reply reports a failed catalog', async () => {
  stubHeavyFetch({
    status: {
      id: 'freellmapi',
      configured: false,
      health: { ok: true, status: 200, checkedAt: 1 },
      detectedEndpoint: 'http://127.0.0.1:3002/v1',
    },
    reuse: {
      ok: true,
      health: { ok: true, status: 200, checkedAt: 1 },
      catalog: { state: 'unauthorized', models: [], status: 401, error: 'bad key', source: 'endpoint' },
    },
  })
  const onClose = vi.fn()
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={translateEn} readOnly={false} onClose={onClose} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: en.create }))

  await waitFor(() => {
    expect(screen.getByText(en.heavyReuseCatalogFailed.replace('{state}', 'unauthorized').replace('{detail}', ' (bad key)'))).toBeTruthy()
  })
  expect(onClose).not.toHaveBeenCalled()
})
