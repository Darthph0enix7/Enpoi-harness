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
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

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

it('shows the refused platform reason in the heavy form instead of install steps', async () => {
  stubHeavyFetch({ status: {
    id: 'antigravity',
    configured: false,
    platform: 'win32',
    health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
    runtime: { docker: false, podman: false },
    preflight: { path: 'unsupported', label: 'Not supported on Windows', missing: [], requires: [] },
  } })
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

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

it('offers a custom-instance URL on a service reuse and sends the typed address', async () => {
  const { requests } = stubHeavyFetch({})
  const onClose = vi.fn()
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={onClose} />)

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
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={key => en[key]} readOnly={false} onClose={onClose} />)

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
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

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
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={key => en[key]} readOnly={false} onClose={onClose} />)

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
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  // A host address that cannot parse renders as-is instead of crashing the
  // modal; the shipped table's address yields its origin (test above).
  expect(screen.getByPlaceholderText('not-a-url')).toBeTruthy()
})

it('contains modal dialog, content scroller, and documentation inside scrollable surfaces', async () => {
  stubHeavyFetch({})
  render(<AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

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
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

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
  render(<AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={key => en[key]} readOnly={false} onClose={vi.fn()} />)

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
