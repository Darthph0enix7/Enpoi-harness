// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    pending: null,
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  // Recents/favorites live in localStorage: without a reset, a later case sees
  // the previous case's model twice (Recents + provider group).
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return { ok: true as const, value: undefined }
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    // OpenChamber-style picker: model trigger shows model name, effort pill shows effort name
    const modelTrigger = screen.getByRole('button', { name: 'DeepSeek-V4-Flash' })
    expect(modelTrigger.textContent).toContain('DeepSeek-V4-Flash')
    const effortTrigger = screen.getByRole('button', { name: 'High' })
    expect(effortTrigger.textContent).toContain('High')

    fireEvent.click(effortTrigger)
    // effort popover shows Off/High/Max without description
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy()
    // High appears both as trigger and as selected option
    expect(screen.getAllByRole('button', { name: 'High' }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Max' })).toBeTruthy()
    expect(screen.queryByText('Largest budget')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Max' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      // after selection the effort pill now reads Max
      expect(screen.getByRole('button', { name: 'Max' }).textContent).toContain('Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    // Model pill shows Model, effort pill shows Default (provider default)
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy()
    const effortTrigger = screen.getByRole('button', { name: 'Default' })
    expect(effortTrigger.textContent).toContain('Default')
    fireEvent.click(effortTrigger)
    // popover should contain Default and Standard
    expect(screen.getAllByRole('button', { name: 'Default' }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Standard' })).toBeTruthy()
  })

  it('offers the provider default to clear a saved effort a no-ladder model cannot take', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: { provider: 'provider', model: 'model', reasoningEffort: 'high' },
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{ id: 'model', name: 'Model' }],
      }],
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return { ok: true as const, value: undefined }
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    // The stale effort stays visible rather than silently disappearing, so a
    // session resumed onto a model whose provider discloses no ladder has an
    // explicit action to clear it.
    const effortTrigger = screen.getByRole('button', { name: 'high' })
    expect(effortTrigger.textContent).toContain('high')
    fireEvent.click(effortTrigger)
    fireEvent.click(screen.getByRole('button', { name: 'Default' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'provider', model: 'model' })
    })
  })

  it('offers the provider default when the saved effort is not in the model’s ladder', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: { provider: 'provider', model: 'model', reasoningEffort: 'max' },
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: {
            efforts: [{ id: 'standard', name: 'Standard' }],
            defaultEffort: 'standard',
          },
        }],
      }],
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return { ok: true as const, value: undefined }
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'max' }))
    fireEvent.click(screen.getByRole('button', { name: 'Default' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'provider', model: 'model' })
    })
  })

  it('shows the durable model id when the catalog has no matching display name', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    // OpenChamber shows raw model id when not in catalog (title/modelLabel is model id alone)
    const trigger = screen.getByRole('button', { name: 'removed-model' })
    expect(trigger.textContent).toContain('removed-model')
    fireEvent.click(trigger)
    // no reasoning pill when model not found
    expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull()
    // picker popover contains the available model, not the removed one, and hides description
    expect(screen.getByText('DeepSeek-V4-Flash')).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
    // only the trigger contains removed-model, the list does not duplicate it
    expect(screen.getAllByText('removed-model').length).toBe(1)
  })

  it('shows loading until the catalog and Session projection are both ready', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: null,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    // OpenChamber fallback while loading: shows the fallback label, not the loading key,
    // because the component derives modelLabel from fallback when current is null.
    expect(screen.getByRole('button', { name: '请选择模型' }).textContent)
      .toContain('请选择模型')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'High' })).toBeTruthy()
    })
  })

  it.each([false, true])('announces rejected selections with ownership guidance only for held writers (%s)', async (sessionInUse) => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      const error = sessionInUse
        ? new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('owned') })
        : new RemoteError('session/model-unavailable', 'session already contains images', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
      directory.set(state({ groups, status: 'error', error: 'unrelated catalog refresh' }))
      return { ok: false as const, error }
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    // Open the model picker and choose the second model via its row text (div, not menuitemradio)
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' }))
    // picker renders model rows as divs with span.modelNameText; clicking the text bubbles to the row
    fireEvent.click(screen.getByText('DeepSeek-V4-Pro'))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toBe(sessionInUse
      ? zh['error.sessionInUse']
      : '模型操作失败：session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('portals the placed menu card to body and closes only on truly-outside mousedown', () => {
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })
    try {
      const { container } = render(<ModelSelect
        locked={false}
        available
        directory={createSnapshotStore(state())}
        load={vi.fn()}
        select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
        t={t}
      />)
      const trigger = screen.getByRole('button', { name: 'DeepSeek-V4-Flash' })
      fireEvent.click(trigger)
      const menu = screen.getByRole('menu')
      // Outside the composer subtree — column overflow clips cannot crop it.
      expect(container.contains(menu)).toBe(false)
      expect(menu.parentElement).toBe(document.body)
      // jsdom anchor rects are all zero, so the measured 200x300 card clamps
      // to the 12px viewport margin on both axes.
      expect(menu.style.left).toBe('12px')
      expect(menu.style.top).toBe('12px')
      // Interactions inside the trigger subtree or the portaled card stay open.
      fireEvent.mouseDown(menu)
      fireEvent.mouseDown(trigger)
      fireEvent.blur(trigger, { relatedTarget: menu })
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
  })

  it('re-anchors the card when its own size changes and releases the observer on close', () => {
    /** One recorded ResizeObserver instance, so the test can drive its callback. */
    interface Recorded {
      callback: ResizeObserverCallback
      observed: Element[]
      disconnected: boolean
    }
    const made: Recorded[] = []
    vi.stubGlobal('ResizeObserver', class {
      private readonly record: Recorded

      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, observed: [], disconnected: false }
        made.push(this.record)
      }

      observe(element: Element): void { this.record.observed.push(element) }
      disconnect(): void { this.record.disconnected = true }
    })
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400)
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300)
    vi.stubGlobal('innerWidth', 1200)
    vi.stubGlobal('innerHeight', 800)
    const rect = {
      left: 0, right: 1000, top: 800, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect
    const anchorRect = vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)
    try {
      render(<ModelSelect
        locked={false}
        available
        directory={createSnapshotStore(state())}
        load={vi.fn()}
        select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
        t={t}
      />)
      fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' }))
      const menu = screen.getByRole('menu')
      // 400x300 card hung off the trigger's top-right corner, bottom-clamped to the 12px margin.
      expect(menu.style.left).toBe('600px')
      expect(menu.style.top).toBe('488px')
      expect(made).toHaveLength(1)
      expect(made[0]?.observed).toEqual([menu])

      // Collapse shrinks the card with no state change, scroll, or window resize:
      // only the observer notices, and the card re-anchors instead of floating.
      height.mockReturnValue(120)
      act(() => { made[0]?.callback([], {} as ResizeObserver) })
      expect(menu.style.left).toBe('600px')
      expect(menu.style.top).toBe('668px')

      // Expanding from fully collapsed grows the card again: the clamp keeps it
      // fully inside the viewport instead of clipping below the screen.
      height.mockReturnValue(700)
      act(() => { made[0]?.callback([], {} as ResizeObserver) })
      expect(menu.style.top).toBe('88px')
      expect(Number.parseFloat(menu.style.top) + 700).toBeLessThanOrEqual(800 - 12)

      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
      expect(made[0]?.disconnected).toBe(true)
    } finally {
      width.mockRestore()
      height.mockRestore()
      anchorRect.mockRestore()
    }
  })

  it('still places the card where ResizeObserver does not exist', () => {
    // jsdom's own condition, and any host without the API: the picker must fall
    // back to scroll/resize placement rather than fail at open.
    vi.stubGlobal('ResizeObserver', undefined)
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' }))
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(undefined)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect catalog capability display', () => {
  it('renders disclosed context windows only, marks a route-default window assumed, and flags an unverified row', () => {
    const unknownWindow = { id: 'gemini-9-unknown', name: 'Gemini 9 Unknown' }
    const exactWindow = { id: 'exact-window', name: 'Exact Window', contextWindow: 65_536 }
    const assumedWindow = {
      id: 'assumed-window',
      name: 'Assumed Window',
      contextWindow: 262_144,
      contextWindowSource: 'default' as const,
    }
    const unverified = { id: 'unverified-model', name: 'Unverified Model', unverified: true }
    const groups = [{
      id: 'gateway',
      name: 'Gateway',
      models: [unknownWindow, exactWindow, assumedWindow, unverified],
    }]
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({
        current: { provider: 'gateway', model: 'exact-window' },
        groups,
      }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Exact Window' }))

    // An undisclosed window prints no capacity: the deleted id-family fallback
    // must never resurface as a guessed 1M/128K badge.
    expect(screen.queryByText('1M')).toBeNull()
    expect(screen.queryByText('128K')).toBeNull()
    expect(screen.getByText('65K')).toBeTruthy()
    // A route-default window is presented as assumed, not as a disclosed fact.
    expect(screen.getByText('约 262K（假定）')).toBeTruthy()
    expect(screen.getByText('未验证')).toBeTruthy()
  })

  it('omits noisy advertised modality tags in the picker dropdown', () => {
    const declared = {
      id: 'declared',
      name: 'Declared',
      inputModalities: ['text', 'image'] as const,
      advertisedInputModalities: ['text', 'image', 'audio', 'video', 'pdf'] as const,
    }
    const native = {
      id: 'native',
      name: 'Native',
      inputModalities: ['text', 'image'] as const,
      advertisedInputModalities: ['text', 'image'] as const,
    }
    // An unknown effective list does not turn text/image into disclosure-only
    // tokens: only audio/video/pdf lack a native encoder.
    const unstatedEffective = {
      id: 'unstated-effective',
      name: 'Unstated Effective',
      advertisedInputModalities: ['text', 'image'] as const,
    }
    const groups = [{
      id: 'gateway',
      name: 'Gateway',
      models: [declared, native, unstatedEffective],
    }]
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({
        current: { provider: 'gateway', model: 'native' },
        groups,
      }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Native' }))

    // Picker rows stay clean: no raw modality tokens or noisy declared-not-sent tags
    expect(screen.queryByText('已声明，未原生发送')).toBeNull()
    for (const modality of ['audio', 'video', 'pdf']) {
      expect(screen.queryByText(modality)).toBeNull()
    }
  })

  it('prefers disclosed maxInputTokens over an assumed default contextWindow in picker rows', () => {
    const inputOnly = {
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      contextWindow: 262_144,
      contextWindowSource: 'default' as const,
      maxInputTokens: 372_000,
      maxInputTokensSource: 'configured' as const,
    }
    const groups = [{
      id: 'cliproxyapi',
      name: 'CLIProxyAPI',
      models: [inputOnly],
    }]
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state({
        current: { provider: 'cliproxyapi', model: 'gpt-5.6-sol' },
        groups,
      }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /GPT 5\.6 Sol/ }))
    expect(screen.getAllByText('372K').length).toBeGreaterThan(0)
    expect(screen.queryByText(/262K/)).toBeNull()
  })
})
