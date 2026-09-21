// @vitest-environment jsdom
/**
 * Dynamic settings page UX fixes:
 * - a pushed refresh does not discard a focused draft (Fix 1);
 * - a hung write times out, rolls back, and releases the per-role queue (Fix 2);
 * - a write failure survives a tab switch through the section status line (Fix 3);
 * - pushes with an unchanged role slice do not re-describe (Fix 4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DynamicSettingsProps } from '../src/client/dynamic/DynamicSettings.tsx'

/** One parsed request body, with the fields these specs read. */
interface RequestBody {
  method: string
  rpcId?: string
  payload?: { args: { ops?: Array<{ op: string; path: string[]; value?: unknown }> } }
}

/** One JSON response envelope. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** One `settings.describe` answer carrying the enpoi-orchestration namespace. */
function describeResponse(value: Record<string, unknown>, revision: number): Response {
  return jsonResponse({ result: { ok: true, value: { namespaces: [{ ns: 'enpoi-orchestration', revision, value }] } } })
}

/** One successful `settings.mutate` answer. */
function mutateOk(revision: number): Response {
  return jsonResponse({ result: { ok: true, value: { revision } } })
}

/** One rejected `settings.mutate` answer. */
function mutateRejected(): Response {
  return jsonResponse({ result: { ok: false, error: { code: 'internal', message: 'nope', details: {} } } })
}

/** One `enpoiRoles.list` answer; empty keeps the panel on the settings layer. */
function effectiveRolesResponse(): Response {
  return jsonResponse({ result: { ok: true, value: { roles: [] } } })
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})

describe('Fix 1 — a focused draft survives a pushed refresh', () => {
  it('keeps typed text through a push, and lets the store win after blur+commit', async () => {
    let serverLabel = 'Server One'
    const mutations: RequestBody[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as RequestBody
      if (body.method === 'settings.describe') {
        return describeResponse({ roles: { fixer: { label: serverLabel } } }, 1)
      }
      if (body.method === 'enpoiRoles.list') return effectiveRolesResponse()
      mutations.push(body)
      return mutateOk(1)
    }))
    const mod = await import('../src/client/dynamic/RolesPanel.tsx')
    render(<mod.RolesPanel />)
    await screen.findByText('Server One')

    fireEvent.click(screen.getByLabelText('Edit Server One'))
    const input = screen.getByLabelText('Label for Server One') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Typed Draft' } })

    // Another client writes: the push re-describes while the field is focused.
    serverLabel = 'Server Two'
    await act(async () => { await mod.refreshRoleSettings() })
    expect(input.value).toBe('Typed Draft')

    // Blur commits the draft; once it settles a later push wins again.
    fireEvent.blur(input)
    await waitFor(() => { expect(mutations).toHaveLength(1) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    serverLabel = 'Server Three'
    await act(async () => { await mod.refreshRoleSettings() })
    await waitFor(() => { expect(input.value).toBe('Server Three') })
  })
})

describe('Fix 2 — a hung write times out and releases the queue', () => {
  it('rolls back the optimistic value and accepts the next edit', async () => {
    let hanging = true
    const mutations: RequestBody[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as RequestBody
      if (body.method === 'settings.describe') return describeResponse({ roles: {} }, 1)
      if (body.method === 'enpoiRoles.list') return effectiveRolesResponse()
      mutations.push(body)
      if (hanging) return new Promise<Response>(() => { /* never settles */ })
      return mutateOk(1)
    }))
    const mod = await import('../src/client/dynamic/RolesPanel.tsx')
    const { getStatus } = await import('../src/client/dynamic/status.ts')
    const { WRITE_TIMEOUT_MS } = await import('../src/client/dynamic/write-timeout.ts')
    render(<mod.RolesPanel />)
    await screen.findByText('The Oracle')

    vi.useFakeTimers()
    fireEvent.click(screen.getByLabelText('Retire Fixer'))
    expect(screen.getByText('retired')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(mutations).toHaveLength(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS + 1) })
    vi.useRealTimers()

    await waitFor(() => { expect(screen.queryByText('retired')).toBeNull() })
    expect(getStatus()).toBe('Could not save Fixer — the change was reverted.')

    // The queue released: a later edit for the same role issues a fresh write.
    hanging = false
    fireEvent.click(screen.getByLabelText('Retire Fixer'))
    await waitFor(() => { expect(mutations).toHaveLength(2) })
  })
})

describe('Fix 3 — a write failure survives a tab switch', () => {
  it('renders the failed write in the section status line after switching tabs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as RequestBody
      if (body.method === 'settings.describe') return describeResponse({ roles: {} }, 1)
      return mutateRejected()
    }))
    const mod = await import('../src/client/dynamic/DynamicSettings.tsx')
    const { setStatus } = await import('../src/client/dynamic/status.ts')
    setStatus(null)
    render(<mod.DynamicSettings {...({} as DynamicSettingsProps)} />)
    await screen.findByText('The Oracle')

    fireEvent.click(screen.getByLabelText('Retire Fixer'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Could not save Fixer — the change was reverted.')

    // Switch tabs: RolesPanel unmounts, but the section status line stays.
    fireEvent.click(screen.getByRole('button', { name: 'Prompts' }))
    expect(screen.getByText('ROLE PERSONAS')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Could not save Fixer — the change was reverted.')
  })
})

describe('Fix 4 — unchanged pushes do not re-describe', () => {
  it('describes once and skips two pushes with an unchanged role slice', async () => {
    let serverRoles: Record<string, unknown> = {}
    let panelDescribes = 0
    let revision = 1
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as RequestBody
      if (body.method === 'settings.describe') {
        if (String(body.rpcId).startsWith('dynamic-describe')) panelDescribes += 1
        revision += 1
        return describeResponse({ roles: serverRoles }, revision)
      }
      if (body.method === 'enpoiRoles.list') return effectiveRolesResponse()
      return mutateOk(revision)
    }))
    const mod = await import('../src/client/dynamic/RolesPanel.tsx')
    const registry = await import('../src/client/role-registry.ts')
    render(<mod.RolesPanel />)
    await screen.findByText('The Oracle')
    const before = panelDescribes
    expect(before).toBe(1)

    await act(async () => { await registry.refreshFromServer() })
    await act(async () => { await registry.refreshFromServer() })
    expect(panelDescribes).toBe(1)

    // A changed slice still refreshes exactly once.
    serverRoles = { fixer: { label: 'Server Fixer' } }
    await act(async () => { await registry.refreshFromServer() })
    await waitFor(() => { expect(panelDescribes).toBe(2) })
  })
})
