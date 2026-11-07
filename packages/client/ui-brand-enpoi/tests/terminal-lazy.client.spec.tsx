// @vitest-environment jsdom
/**
 * The terminal emulator is deferred: the tab strip and the empty/status states
 * mount without xterm, a failed chunk fetch is retryable, and the transport
 * registry buffers output before any view exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { LazySurface } from '../src/client/lazy-surface.tsx'
import { TerminalPanel } from '../src/client/terminal/TerminalPanel.tsx'
import type { TerminalPanelProps } from '../src/client/terminal/TerminalPanel.tsx'
import { TerminalRegistry } from '../src/client/terminal/registry.ts'
import { brandT } from './brand-i18n.client.ts'

// The real module imports xterm; the spec replaces it with a sentinel view.
vi.mock('../src/client/terminal/TerminalView.tsx', () => ({
  TerminalView: (props: { tab: { id: string } }) => <div data-enpoi-test-terminal-view={props.tab.id} />,
}))

const noop = (): void => { /* rendering-only fixtures */ }

/** Props for one panel snapshot with a single live tab. */
function panelProps(): TerminalPanelProps {
  return {
    sessionId: 's1',
    t: brandT,
    useSessions: (selector: (state: unknown) => unknown) => selector({ byId: { s1: { cwd: '/tmp' } } }),
    useTerminals: (selector: (state: unknown) => unknown) => selector({
      dock: { open: false, height: 260 },
      bySession: {
        s1: {
          tabs: [{
            id: 't1', title: 'Terminal 1', place: 'panel', status: 'running', exitCode: null, error: undefined,
          }],
          active: { panel: 't1', bottom: undefined },
        },
      },
    }),
    openTerminal: noop,
    closeTerminal: noop,
    activateTerminal: noop,
    writeTerminal: noop,
    resizeTerminal: noop,
    subscribeTerminal: () => noop,
    readTerminal: () => '',
    toggleTerminalDock: noop,
    setTerminalDockHeight: noop,
  } as TerminalPanelProps
}

type Deferred = () => Promise<{ default: (props: object) => ReactNode }>

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('terminal emulator deferral', () => {
  it('shows the localized pending marker until the fake chunk resolves', async () => {
    const { container } = render(<TerminalPanel {...panelProps()} />)
    expect(container.querySelector('[data-enpoi-terminal-pending]')?.textContent).toBe(brandT('terminalLoading'))
    await waitFor(() => { expect(container.querySelector('[data-enpoi-test-terminal-view="t1"]')).not.toBeNull() })
    expect(container.querySelector('[data-enpoi-terminal-pending]')).toBeNull()
  })

  it('shows the fallback first and then the lazily imported body', async () => {
    let resolve!: (module: { default: (props: object) => ReactNode }) => void
    const load = (): Promise<{ default: (props: object) => ReactNode }> =>
      new Promise((settle) => { resolve = settle })
    render(<LazySurface load={load} render={Component => <Component />} fallback={<span>PENDING</span>} failed="FAILED" retry="RETRY" />)
    expect(screen.getByText('PENDING')).toBeTruthy()
    await act(async () => { resolve({ default: () => <div>READY</div> }) })
    expect(await screen.findByText('READY')).toBeTruthy()
  })

  it('offers a retry on a failed chunk fetch and recovers with a fresh import', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { /* the boundary owns this failure */ })
    const load = vi.fn<Deferred>()
      .mockRejectedValueOnce(new Error('chunk fetch failed'))
      .mockResolvedValueOnce({ default: () => <div>RECOVERED</div> })
    render(<LazySurface load={load} render={Component => <Component />} fallback={<span>PENDING</span>} failed="FAILED" retry="RETRY" />)
    expect(await screen.findByText('FAILED')).toBeTruthy()
    fireEvent.click(screen.getByText('RETRY'))
    expect(await screen.findByText('RECOVERED')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
  })
})

type Handler<T> = ((event: T) => void) | null

/** One scripted browser socket; the registry only touches event handlers and send. */
class FakeSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeSocket[] = []

  readyState = FakeSocket.OPEN
  onopen: Handler<Event> = null
  onmessage: Handler<MessageEvent<string>> = null
  onclose: Handler<CloseEvent> = null
  onerror: Handler<Event> = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(): void { /* transcript input is not observed here */ }

  close(): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1000 } as CloseEvent)
  }

  open(): void { this.onopen?.(new Event('open')) }

  receive(data: string): void {
    this.onmessage?.({ data: JSON.stringify({ t: 'data', data }) } as MessageEvent<string>)
  }
}

describe('terminal registry without the emulator', () => {
  it('connects and buffers early output before any view mounts', async () => {
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ ok: true, value: { key: 's1:t1', pid: 1, cwd: '/', shell: 'bash', spawned: true } }),
    })))
    const registry = new TerminalRegistry({ keepaliveIntervalMs: 0 })
    registry.open('s1', 'panel', '/tmp')
    await waitFor(() => { expect(FakeSocket.instances).toHaveLength(1) })
    const socket = FakeSocket.instances[0]
    if (socket === undefined) throw new Error('terminal socket was not opened')
    socket.open()
    socket.receive('early output')
    expect(registry.read('s1', 't1')).toBe('early output')
    const chunks: string[] = []
    const unsubscribe = registry.subscribe('s1', 't1', (data) => { chunks.push(data) })
    socket.receive('live output')
    unsubscribe()
    socket.receive('ignored')
    expect(chunks).toEqual(['live output'])
    expect(registry.read('s1', 't1')).toBe('early outputlive outputignored')
    registry.dispose()
  })
})
