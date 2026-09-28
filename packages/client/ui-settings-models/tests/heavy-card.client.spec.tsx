// @vitest-environment jsdom
/**
 * The detail card: cached ONLINE badge with fail-soft unknown state, the
 * dashboard URL(s) for the mode in use, the polled install job (failed runs
 * show the error and the log tail), and the documentation toggle.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HeavyProviderCard } from '../src/client/HeavyProviderCard.tsx'
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
  expect(screen.getByRole('link', { name: `${en.heavyDashboardServer}: http://100.122.163.25:3002 ↗` })).toBeTruthy()

  await waitFor(
    () => { expect(screen.getByText(`${en.heavyFailed}: Start the stack: exit 1`)).toBeTruthy() },
    { timeout: 6000 },
  )
  expect(screen.getByText('compose exploded')).toBeTruthy()
  expect(screen.queryByText(en.heavyJobBackground)).toBeNull()
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
