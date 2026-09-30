// @vitest-environment jsdom
/**
 * McpMountsChip — the session header's mounted-server chip: renders only with
 * mounts, lists live rows, and closes a server through the capabilities remote.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { McpMountsChip, type McpMountsChipProps } from '../src/client/McpMountsChip.tsx'
import { en } from '../src/client/mcp-mounts-locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function translate(key: keyof typeof en, params?: Record<string, unknown>): string {
  let text = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function renderChip(mounted: string[], fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(fetchImpl)
  vi.stubGlobal('fetch', fetchMock)
  const sessions = createSnapshotStore({
    byId: { s1: { projectionValues: { mcpMounts: { mounted } } } },
  })
  render(<McpMountsChip {...({
    sessionId: 's1',
    useSessions: bindSnapshotSelector(sessions),
    t: translate,
  } as unknown as McpMountsChipProps)} />)
  return fetchMock
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const MOUNTS = { result: { ok: true, value: { mounts: [{ id: 'unreal-mcp', serverName: 'unreal', toolCount: 42 }] } } }

describe('McpMountsChip', () => {
  it('renders nothing without mounts', () => {
    renderChip([], async () => jsonResponse(MOUNTS))
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the count and lists the live rows on open', async () => {
    const fetchMock = renderChip(['unreal-mcp'], async () => jsonResponse(MOUNTS))
    const chip = screen.getByRole('button', { name: en.chipLabel.replace('{count}', '1') })
    fireEvent.click(chip)
    expect(await screen.findByText('unreal')).toBeTruthy()
    expect(screen.getByText(en.toolCount.replace('{count}', '42'))).toBeTruthy()
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
    expect(body.method).toBe('enpoiCapabilities.mcpMounts')
    expect(body.payload.args).toEqual({ sessionId: 's1' })
  })

  it('unmounts a server through the remote and refreshes the rows', async () => {
    let mounts = [{ id: 'unreal-mcp', serverName: 'unreal', toolCount: 42 }]
    const fetchMock = renderChip(['unreal-mcp'], async (url) => {
      if (url === '/api/enpoiCapabilities.mcpUnmount') {
        mounts = []
        return jsonResponse({ result: { ok: true, value: { ok: true, reason: '' } } })
      }
      return jsonResponse({ result: { ok: true, value: { mounts } } })
    })
    fireEvent.click(screen.getByRole('button', { name: en.chipLabel.replace('{count}', '1') }))
    fireEvent.click(await screen.findByRole('button', { name: `${en.unmount}: unreal` }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(call => String(call[0]) === '/api/enpoiCapabilities.mcpUnmount')).toBe(true)
    })
    const unmountCall = fetchMock.mock.calls.find(call => String(call[0]) === '/api/enpoiCapabilities.mcpUnmount')!
    const body = JSON.parse(String((unmountCall[1] as RequestInit).body))
    expect(body.payload.args).toEqual({ sessionId: 's1', server: 'unreal-mcp' })
    await waitFor(() => { expect(screen.queryByText('unreal')).toBeNull() })
  })

  it('surfaces an unmount failure', async () => {
    renderChip(['unreal-mcp'], async (url) => {
      if (url === '/api/enpoiCapabilities.mcpUnmount') {
        return jsonResponse({ result: { ok: true, value: { ok: false, reason: 'not mounted in this session' } } })
      }
      return jsonResponse(MOUNTS)
    })
    fireEvent.click(screen.getByRole('button', { name: en.chipLabel.replace('{count}', '1') }))
    fireEvent.click(await screen.findByRole('button', { name: `${en.unmount}: unreal` }))
    expect(await screen.findByText(en.unmountFailed.replace('{reason}', 'not mounted in this session'))).toBeTruthy()
  })

  it('surfaces a load failure', async () => {
    renderChip(['unreal-mcp'], async () => new Response('nope', { status: 500 }))
    fireEvent.click(screen.getByRole('button', { name: en.chipLabel.replace('{count}', '1') }))
    expect(await screen.findByText(en.loadFailed)).toBeTruthy()
  })
})
