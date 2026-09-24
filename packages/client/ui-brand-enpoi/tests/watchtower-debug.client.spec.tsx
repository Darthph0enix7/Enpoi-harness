// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { WatchtowerView, type WatchtowerViewProps } from '../src/client/WatchtowerView.tsx'
import { buildDebugReportMarkdown } from '../src/client/debug-view.ts'

const DIGEST = {
  sessionId: 'session-debug-1',
  state: {
    latch: 'waiting_approval',
    since: 1_700_000_000_000,
    source: 'host-latch',
    activeDescendants: 2,
    descendantsExact: true,
    lastTurnEnd: { turn: 4, reason: 'error', at: 1_700_000_000_500, error: { code: 'RATE_LIMIT', message: 'provider said no' } },
  },
  model: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
  recentFailures: [
    { seq: 7, provider: 'antigravity', model: 'gemini-3.8-flash-tiered', code: 'RATE_LIMIT', message: 'provider said no', link: 2, next: { provider: 'deepseek', model: 'deepseek-chat' } },
  ],
  recentToolCalls: [
    { tool: 'bash', status: 'error', argumentPreview: 'ls /nope', error: { name: 'ToolError', code: 'ENOENT', reason: 'no such file' } },
    { tool: 'read', status: 'ok', argumentPreview: 'plan.md', resultPreview: 'ok' },
  ],
  injectionIndex: [{ kind: 'runtime-context', chars: 1200, seq: 42 }],
  subagentTree: [{ childSessionId: 'session-child-abc', mode: 'continuable', quiet: false, status: 'running', queryPreview: 'research' }],
  pendingInteractions: [{ kind: 'approval', askId: 'ask-1', toolName: 'bash', reason: 'rm -rf', since: 1_700_000_000_100 }],
}

const SNAPSHOT = {
  capturedAt: 1_700_000_000_200,
  sessionId: 'session-debug-1',
  provider: 'antigravity',
  model: 'gemini-3.8-flash-tiered',
  system: { chars: 14429, sha256: 'a'.repeat(64) },
  tools: ['bash', 'read', 'session_debug'],
  messages: [{ role: 'system', chars: 100 }, { role: 'user', chars: 20 }],
  bodiesIncluded: false,
}

const INCIDENTS = {
  generatedAt: 1_700_000_000_300,
  items: [
    { at: 1, severity: 'error', source: 'session', kind: 'provider-error', code: 'DRATE00', message: 'rate limit', sessionId: 'session-debug-1' },
  ],
}

/** Install a fetch stub answering the wire envelope for the three debug RPCs. */
function stubRpc(overrides: { digest?: unknown; snapshot?: unknown; incidents?: unknown } = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const method = JSON.parse(String(init?.body)).method as string
    const value = method === 'session.digest'
      ? overrides.digest ?? { ok: true, value: DIGEST }
      : method === 'session.requestSnapshot'
        ? overrides.snapshot ?? { ok: true, value: SNAPSHOT }
        : overrides.incidents ?? { ok: true, value: INCIDENTS }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: 'test', result: value }), { status: 200 })
  }))
}

function viewProps(extra: { useSessionStatus?: unknown } = {}): WatchtowerViewProps {
  return {
    sessionId: 'session-debug-1',
    useSession: <S,>(selector: (s: { sessionId: string; displayTitle: string }) => S): S => selector({ sessionId: 'session-debug-1', displayTitle: 'Debug session' }),
    useProjection: <T,>(): T => undefined as T,
    ...extra as WatchtowerViewProps,
  }
}

describe('Watchtower Live Debug card', () => {
  beforeEach(() => { stubRpc() })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders latch, descendants, model, last turn error, tools, injections and subagents from the digest RPC', async () => {
    render(<WatchtowerView {...viewProps()} />)
    await waitFor(() => { expect(screen.getByText('Live Debug')).toBeTruthy() })
    await waitFor(() => { expect(screen.getByText('waiting_approval')).toBeTruthy() })
    const text = document.body.textContent ?? ''
    expect(text).toContain('antigravity/gemini-3.8-flash-tiered')
    expect(text).toContain('host-latch')
    expect(text).toContain('RATE_LIMIT')
    expect(text).toContain('1: antigravity/gemini-3.8-flash-tiered RATE_LIMIT→deepseek')
    expect(text).toContain('runtime-context')
    expect(text).toContain('3 tools · 2 messages')
    expect(text).toContain('1 this session')
    expect(text).toContain('↓2')
  })

  it('answers a live approval through the client answer path when one is mounted', async () => {
    const answer = vi.fn(async () => {})
    const useSessionStatus = <S,>(selector: (map: Map<string, { pendingInteraction: unknown }>) => S): S =>
      selector(new Map([['session-debug-1', { pendingInteraction: { kind: 'approval', key: 'k1', answer } }]]))
    render(<WatchtowerView {...viewProps({ useSessionStatus })} />)
    const button = await screen.findByText('Allow once')
    fireEvent.click(button)
    expect(answer).toHaveBeenCalledWith('allowed-once')
  })

  it('degrades to a clear debug unavailable line when the digest RPC fails', async () => {
    stubRpc({ digest: { ok: false, error: { code: 'session/not-found', message: 'not attached' } } })
    render(<WatchtowerView {...viewProps()} />)
    await waitFor(() => { expect(screen.getByText(/debug unavailable/)).toBeTruthy() })
    expect(screen.getByText(/session\/not-found/)).toBeTruthy()
  })

  it('copies the same markdown sections dsh-debug report writes', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<WatchtowerView {...viewProps()} />)
    const button = await screen.findByText('Copy debug report')
    fireEvent.click(button)
    await waitFor(() => { expect(writeText).toHaveBeenCalledTimes(1) })
    const markdown = String((writeText.mock.calls[0] as unknown as [string])[0])
    for (const heading of ['# Session debug report', '## Execution state', '## Last turn end', '## Pending asks', '## Recent tool calls', '## Injection index', '## Subagent tree', '## Request snapshot', '## Incidents']) {
      expect(markdown).toContain(heading)
    }
    expect(markdown).toContain('session_debug')
  })

  it('builds a digest-only report with an explicit error row when snapshot/incidents fail', () => {
    const markdown = buildDebugReportMarkdown({
      sessionId: 'session-debug-1',
      generatedAt: 1_700_000_000_000,
      digest: DIGEST as never,
      snapshot: null,
      incidents: null,
      errors: ['session/requestSnapshot failed: session/not-found: no capture', 'diagnostics/list failed: gateway/error: down'],
    })
    expect(markdown).toContain('> ERROR session/requestSnapshot failed')
    expect(markdown).toContain('## Request snapshot')
    expect(markdown).toContain('unavailable')
    expect(markdown).toContain('| 1 | `bash` | error |')
  })
})
