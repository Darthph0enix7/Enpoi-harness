// @vitest-environment jsdom
/**
 * RENDER PROOF for the commandcode row:
 * 1. pre-connection — the labelled fallback renders the heavy row as
 *    "Listed — add to configure", health "Not checked", with a "Check now"
 *    affordance and no blocked/planned wording;
 * 2. connected — the same row renders the host manifest's own summary.
 * Each case prints the rendered row text once as the quotable proof.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AddProviderModal } from '../src/client/AddProviderModal.tsx'
import { bindHostHeavyManifests, resetHeavyManifestSource } from '../src/client/heavy-manifest-source.ts'
import { fallbackHeavyManifest } from '../src/client/heavy-providers.ts'
import type { ModelsWire } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  resetHeavyManifestSource()
  vi.unstubAllGlobals()
})

const t = (key: keyof typeof en): string => en[key]

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

/** A refused status probe keeps the health card at "Not checked". */
function stubStatusFailure(): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { method: string }
    const result = body.method === 'enpoiHeavy.status'
      ? { ok: false, error: { message: 'host unreachable' } }
      : { ok: true, value: {} }
    return { ok: true, status: 200, json: async () => ({ result }) } as unknown as Response
  }))
}

/** One compact quote of the rendered panel text (Modal portals to the body). */
function quote(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 700)
}

it('pre-connection proof: the commandcode row is listed and addable, never blocked', async () => {
  stubStatusFailure()
  render(
    <AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={t} readOnly={false} onClose={vi.fn()} />,
  )

  expect(screen.getAllByText(en.heavyListedBadge).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByText('Command Code (keypool)'))
  await waitFor(() => { expect(screen.getByRole('button', { name: en.heavyCheckNow })).toBeTruthy() })
  expect(screen.getByText(en.heavyHealthUnknown)).toBeTruthy()
  expect(screen.queryByText(en.heavyBlockedTitle)).toBeNull()
  expect(screen.getByRole('button', { name: en.create })).toHaveProperty('disabled', false)
  console.info(`[heavy-render-proof] pre-connection commandcode: ${quote()}`)
})

it('browser-badge proof: FreeLLMAPI renders none and its dependency line, Antigravity renders the badge', async () => {
  stubStatusFailure()
  render(
    <AddProviderModal open taken={[]} protocols={['openai-completions', 'anthropic-messages']} api={wire()} t={t} readOnly={false} onClose={vi.fn()} />,
  )

  fireEvent.click(screen.getByText('FreeLLMAPI'))
  await waitFor(() => { expect(screen.getByText(en.heavyQuirks)).toBeTruthy() })
  expect(screen.queryByText(en.heavyBrowserBadge)).toBeNull()
  expect(screen.getByText(/native installers for Linux\/macOS\/Windows; Docker required only for the fallback path/)).toBeTruthy()
  console.info(`[heavy-render-proof] freellmapi (no badge): ${quote()}`)

  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(screen.getByText('Antigravity Proxy'))
  await waitFor(() => { expect(screen.getAllByText(en.heavyBrowserBadge).length).toBeGreaterThan(0) })
  expect(screen.getByText(/native npm package for Linux\/macOS\/Windows/)).toBeTruthy()
  console.info(`[heavy-render-proof] antigravity (badge): ${quote()}`)
})

it('host-connected proof: the same row renders the host manifest summary', async () => {
  stubStatusFailure()
  bindHostHeavyManifests({
    items: [{ ...fallbackHeavyManifest('commandcode')!, label: 'Command Code (host)', summary: 'HOST-TRUTH summary — keypool reuse + provider package.' }],
    platform: 'linux',
  })
  render(
    <AddProviderModal open taken={[]} protocols={['openai-completions']} api={wire()} t={t} readOnly={false} onClose={vi.fn()} />,
  )

  fireEvent.click(screen.getByText('Command Code (host)'))
  await waitFor(() => { expect(screen.getByText('HOST-TRUTH summary — keypool reuse + provider package.')).toBeTruthy() })
  expect(screen.getByRole('button', { name: en.heavyCheckNow })).toBeTruthy()
  console.info(`[heavy-render-proof] host-connected commandcode: ${quote()}`)
})
