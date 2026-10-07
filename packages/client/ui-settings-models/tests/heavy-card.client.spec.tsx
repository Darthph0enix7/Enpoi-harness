// @vitest-environment jsdom
/**
 * The detail card: cached ONLINE badge with fail-soft unknown state, the
 * dashboard URL(s) for the mode in use, the polled install job (running shows
 * the bar, stage, and log tail; a failure keeps its error and log tail;
 * success collapses to one line), and the documentation toggle.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { HeavyProviderCard } from '../src/client/HeavyProviderCard.tsx'
import cardStyles from '../src/client/HeavyProviderCard.module.css'
import docsStyles from '../src/client/HeavyProviderDocs.module.css'
import { heavyStatusCache } from '../src/client/heavy-rpc.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  heavyStatusCache.invalidate()
  vi.unstubAllGlobals()
})

const t = (key: keyof typeof en): string => en[key]

/** One gateway envelope response for `/api/enpoiHeavy.*`. */
function envelope(value: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: true, value } }),
  } as unknown as Response)
}

const running = {
  id: 'freellmapi',
  configured: true,
  mode: 'reuse',
  platform: 'linux',
  health: { ok: true, status: 200, checkedAt: 1 },
  detectedPort: 3002,
  detectedEndpoint: 'http://127.0.0.1:3002/v1',
  runtime: { docker: true, podman: false },
  preflight: { path: 'detected', label: 'Use the detected instance', missing: [], requires: [] },
  job: {
    id: 'freellmapi', kind: 'install', state: 'running', stage: 'Clone FreeLLMAPI',
    stageIndex: 0, stageCount: 4, pct: 25, logTail: 'cloning…', startedAt: 1,
  },
}

function stubFetch(answers: { status?: unknown; job?: unknown }): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { method: string }
    if (body.method === 'enpoiHeavy.status') return envelope(answers.status ?? running)
    if (body.method === 'enpoiHeavy.job') return envelope(answers.job ?? {})
    return envelope({})
  }))
}

it('renders the dashboard URL and the polled job, then surfaces a failed run with its log tail', async () => {
  stubFetch({
    job: {
      job: {
        id: 'freellmapi', kind: 'install', state: 'failed', stage: 'Start the stack',
        stageIndex: 2, stageCount: 4, pct: 50, logTail: 'compose exploded', startedAt: 1, finishedAt: 2,
        error: 'Start the stack: exit 1',
      },
    },
  })
  render(<HeavyProviderCard providerId="freellmapi" t={t} />)

  await waitFor(() => { expect(screen.getByText(running.job.stage)).toBeTruthy() })
  expect(screen.getByText(en.heavyJobBackground)).toBeTruthy()
  // The detection offer is the card's first-class surface.
  expect(screen.getByText(en.heavyDetectedOffer.replace('{endpoint}', 'http://127.0.0.1:3002/v1'))).toBeTruthy()
  expect(screen.getByRole('link', { name: `${en.heavyDashboardLocal}: http://127.0.0.1:3002 ↗` })).toBeTruthy()

  await waitFor(
    () => { expect(screen.getByText(`${en.heavyFailed}: Start the stack: exit 1`)).toBeTruthy() },
    { timeout: 6000 },
  )
  expect(screen.getByText('compose exploded')).toBeTruthy()
  expect(screen.queryByText(en.heavyJobBackground)).toBeNull()
  // A failure keeps the progress surface (bar and log) the operator needs.
  const failed = document.querySelector('[data-heavy-progress]') as HTMLElement
  expect(failed).toBeTruthy()
  expect(failed.getAttribute('data-state')).toBe('failed')
})

it('collapses a finished run to one line: no bar, stage, or log tail', async () => {
  stubFetch({
    job: {
      job: {
        id: 'freellmapi', kind: 'install', state: 'succeeded', stage: 'Finishing',
        stageIndex: 3, stageCount: 4, pct: 100, logTail: 'done', startedAt: 1, finishedAt: 2,
      },
    },
  })
  render(<HeavyProviderCard providerId="freellmapi" t={t} />)

  // The status reply starts as a running snapshot; the direct poll settles it.
  await waitFor(() => { expect(screen.getByText(en.heavyJobSucceeded)).toBeTruthy() }, { timeout: 6000 })
  expect(document.querySelector('[data-heavy-progress]')).toBeNull()
  expect(document.querySelector('[data-heavy-log]')).toBeNull()
  expect(screen.queryByText('done')).toBeNull()
  expect(screen.queryByText(en.heavyJobBackground)).toBeNull()
})

it('renders a persisted succeeded snapshot as one line, never the progress block', async () => {
  stubFetch({ status: {
    ...running,
    job: {
      id: 'freellmapi', kind: 'install', state: 'succeeded', stage: 'Finishing',
      stageIndex: 3, stageCount: 4, pct: 100, logTail: 'done', startedAt: 1, finishedAt: 2,
    },
  } })
  render(<HeavyProviderCard providerId="freellmapi" t={t} />)

  await waitFor(() => { expect(screen.getByText(en.heavyJobSucceeded)).toBeTruthy() })
  expect(document.querySelector('[data-heavy-progress]')).toBeNull()
  expect(document.querySelector('[data-heavy-log]')).toBeNull()
})

it('keeps a failed persisted snapshot visible with its error and log tail', async () => {
  stubFetch({ status: {
    ...running,
    job: {
      id: 'freellmapi', kind: 'install', state: 'failed', stage: 'Start the stack',
      stageIndex: 2, stageCount: 4, pct: 50, logTail: 'compose exploded', startedAt: 1, finishedAt: 2,
      error: 'Start the stack: exit 1',
    },
  } })
  render(<HeavyProviderCard providerId="freellmapi" t={t} />)

  await waitFor(() => { expect(screen.getByText(`${en.heavyFailed}: Start the stack: exit 1`)).toBeTruthy() })
  expect(screen.getByText('compose exploded')).toBeTruthy()
  expect(document.querySelector('[data-heavy-progress]')).toBeTruthy()
})

it('opens the full documentation view from the card', async () => {
  stubFetch({})
  render(<HeavyProviderCard providerId="freellmapi" t={t} />)
  // Wait for the status (which carries the host platform) before opening.
  await waitFor(() => { expect(screen.getByText(`${en.heavyHealthOk} · 200`)).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: en.heavyDocumentation }))
  expect(screen.getByText(en.heavyReuseVsLocal)).toBeTruthy()
  expect(screen.getByText(en.heavyPlatformHost.replace('{platform}', 'linux'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.heavyHideDocumentation }))
  expect(screen.queryByText(en.heavyReuseVsLocal)).toBeNull()
})

it('surfaces the local path and its Docker requirement when Docker exists but nothing answers', async () => {
  stubFetch({ status: {
    id: 'freellmapi',
    configured: false,
    platform: 'linux',
    health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
    runtime: { docker: true, podman: false },
    preflight: { path: 'docker', label: 'Install locally (Docker or Podman)', missing: [], requires: ['docker'] },
  } })
  render(<HeavyProviderCard providerId="freellmapi" t={t} />)
  await waitFor(() => {
    expect(screen.getByText(
      `${en.heavyPreflightBest.replace('{label}', 'Install locally (Docker or Podman)')} · ${en.heavyRequiresDocker}`,
    )).toBeTruthy()
  })
})

it('names exactly what is missing when no local runtime is available', async () => {
  stubFetch({ status: {
    id: 'freellmapi',
    configured: false,
    platform: 'linux',
    health: { ok: false, error: 'ECONNREFUSED', checkedAt: 1 },
    runtime: { docker: false, podman: false },
    preflight: {
      path: 'unsupported',
      label: 'Install locally (Docker or Podman)',
      missing: ['Docker Engine + Compose (or Podman)'],
      requires: ['docker'],
    },
  } })
  render(<HeavyProviderCard providerId="freellmapi" t={t} />)
  await waitFor(() => {
    expect(screen.getByText(
      en.heavyPreflightMissing.replace('{missing}', 'Docker Engine + Compose (or Podman)'),
    )).toBeTruthy()
  })
})

it('fails soft when the probe is refused: unknown state, no page error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: false, error: { message: 'gateway responded 503' } } }),
  } as unknown as Response)))
  render(<HeavyProviderCard providerId="freellmapi" t={t} />)
  await waitFor(() => { expect(screen.getByText(en.heavyHealthUnknown)).toBeTruthy() })
  expect(screen.queryByText(/gateway responded 503/)).toBeNull()
})

it('pins the DOM and class contracts for HeavyProviderCard progress card and docs container', async () => {
  stubFetch({})
  render(<HeavyProviderCard providerId="freellmapi" t={t} />)

  // Progress card and log elements carry the contained scroller contracts.
  await waitFor(() => { expect(document.querySelector('[data-heavy-progress]')).toBeTruthy() })
  const progress = document.querySelector('[data-heavy-progress]') as HTMLElement
  expect(progress.className).toContain(cardStyles.heavyProgress)

  const log = document.querySelector('[data-heavy-log]') as HTMLElement
  expect(log).toBeTruthy()
  expect(log.className).toContain(cardStyles.heavyLog)

  // Toggling docs mounts the contained docs section.
  fireEvent.click(screen.getByRole('button', { name: en.heavyDocumentation }))
  await waitFor(() => { expect(document.querySelector('[data-heavy-docs]')).toBeTruthy() })
  const docs = document.querySelector('[data-heavy-docs]') as HTMLElement
  expect(docs.className).toContain(docsStyles.heavyDocs)
})

it('pins the scrollbar rebind and token discipline contract in HeavyProviderCard.module.css', () => {
  const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/HeavyProviderCard.module.css'), 'utf8')
  const themeTokensDir = resolve(import.meta.dirname, '../../ui-theme/src/styles')
  const themeTokens = readdirSync(themeTokensDir)
    .filter(name => name.endsWith('.css'))
    .map(name => readFileSync(resolve(themeTokensDir, name), 'utf8'))
    .join('\n')

  // Elevated-surface scrollbar rebind on the progress/log containers.
  expect(sheet).toContain('--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);')
  expect(sheet).toContain('--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);')

  // Scroller properties on log element.
  expect(sheet).toContain('overflow-y: auto;')
  expect(sheet).toContain('max-height: 240px;')
  expect(sheet).toContain('max-height: 120px;')
  expect(sheet).toContain('overscroll-behavior: contain;')

  // Token discipline: every used variable must be defined in ui-theme styles.
  const named = [...sheet.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
  const undeclared = [...new Set(named)].filter(name => !themeTokens.includes(`  ${String(name)}:`))
  expect(undeclared).toEqual([])

  // Block balancing: no unclosed brackets.
  const bare = sheet.replace(/\/\*[\s\S]*?\*\//g, '')
  expect((bare.match(/\}/g) ?? []).length).toBe((bare.match(/\{/g) ?? []).length)
})
