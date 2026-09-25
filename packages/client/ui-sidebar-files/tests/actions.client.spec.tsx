// @vitest-environment jsdom
/**
 * The row actions over a scripted listing and a fake fsops transport.
 *
 * What is asserted is the reader's contract: the 3-dots and the right-click
 * open one menu without opening the row, the item lists per row kind, inline
 * rename commit/cancel/failure, the two-step delete, the empty-area create
 * inputs, download through an object URL, copy path values, close/focus
 * behavior, and that every successful mutation re-lists the affected directory.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent } from '@testing-library/react'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { mountBody, ROOT, SESSION } from './mount.client.tsx'
import { zh } from '../src/client/locales.ts'
import type { DirLevel } from '../src/client/store.ts'

const ROOT_LEVEL: DirLevel = {
  entries: [
    { name: 'README.md', type: 'file', size: 12 },
    { name: 'src', type: 'directory' },
    { name: 'pipe', type: 'other' },
  ],
  truncated: false,
}

/** One recorded fsops call. */
interface FsCall {
  readonly method: string
  readonly payload: Record<string, unknown>
}

/** A fake `/sidebar/fsops` transport with per-route replies. */
function fakeServer() {
  const replies = new Map<string, { readonly body: unknown; readonly status: number }>()
  const calls: FsCall[] = []
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = url.slice(url.lastIndexOf('/') + 1)
    calls.push({ method, payload: JSON.parse(String(init?.body)) as Record<string, unknown> })
    const reply = replies.get(method) ?? { body: { ok: true, value: {} }, status: 200 }
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    } as Response
  }) as typeof fetch
  return {
    calls,
    fetch: request,
    reply: (method: string, body: unknown, status = 200): void => { replies.set(method, { body, status }) },
  }
}

/** Mount the body with the fake transport installed before `createFsOps` runs. */
async function mountActions() {
  const server = fakeServer()
  vi.stubGlobal('fetch', server.fetch)
  const mounted = mountBody()
  // Watch-first contract: the root lists only once its watch reports ready.
  await act(async () => { await mounted.script.watches.ready(ROOT) })
  return { ...mounted, server }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** One row by its absolute path. */
function row(container: HTMLElement, path: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-files-path="${path}"]`)
  if (found === null) throw new Error(`no row for ${path}`)
  return found
}

/** The open menu's item labels, in order. */
function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
    .map(button => button.textContent ?? '')
}

/** One menu item by its action id. */
function item(id: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`[role="menu"] [data-files-menu-item="${id}"]`)
  if (found === null) throw new Error(`no menu item ${id}`)
  return found
}

/** Open one row's menu through its 3-dots. */
function openDots(container: HTMLElement, path: string): void {
  const trigger = row(container, path).querySelector<HTMLElement>('[data-files-actions]')
  if (trigger === null) throw new Error(`no 3-dots for ${path}`)
  fireEvent.click(trigger)
}

describe('row menu and file actions', () => {
  it('opens the file menu from the 3-dots without opening the file, and right-click opens the same list', async () => {
    const { view, script, tabActions } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const file = row(view.container, `${ROOT}/README.md`)
    openDots(view.container, `${ROOT}/README.md`)
    expect(tabActions.openResource).not.toHaveBeenCalled()
    expect(menuLabels()).toEqual([
      zh['menu.open'], zh['menu.download'], zh['menu.rename'],
      zh['menu.delete'], zh['menu.copyPath'], zh['menu.copyRelative'],
    ])
    expect(document.activeElement).toBe(item('open'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(file.querySelector('button'))

    // Right-click suppresses the browser menu and opens the same list; Open
    // routes through the owner exactly as the row's own click does.
    expect(fireEvent.contextMenu(file)).toBe(false)
    expect(item('open')).not.toBeNull()
    // The portaled menu suppresses the browser menu on its own surface too.
    const menu = document.querySelector('[role="menu"]')!
    expect(fireEvent.contextMenu(menu)).toBe(false)
    fireEvent.click(item('open'))
    expect(tabActions.openResource).toHaveBeenCalledWith(fileAddressFor(SESSION, ROOT, `${ROOT}/README.md`))
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('opens the directory menu on right-click too', async () => {
    const { view, script } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    expect(fireEvent.contextMenu(row(view.container, `${ROOT}/src`))).toBe(false)
    expect(menuLabels()).toEqual([
      zh['menu.newFile'], zh['menu.newFolder'], zh['menu.rename'],
      zh['menu.delete'], zh['menu.copyPath'], zh['menu.copyRelative'],
    ])
  })

  it('offers the directory actions, expands a collapsed directory, and creates a file inline', async () => {
    const { view, script, server } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    openDots(view.container, `${ROOT}/src`)
    expect(menuLabels()).toEqual([
      zh['menu.newFile'], zh['menu.newFolder'], zh['menu.rename'],
      zh['menu.delete'], zh['menu.copyPath'], zh['menu.copyRelative'],
    ])
    fireEvent.click(item('new-file'))
    // The collapsed directory opens before the inline row can show; under the
    // watch-first contract its listing starts once the new subscription is ready.
    await act(async () => { await script.watches.ready(`${ROOT}/src`) })
    expect(script.list).toHaveBeenLastCalledWith(SESSION, `${ROOT}/src`, expect.any(AbortSignal))
    await act(() => script.settle({ ok: true, value: { entries: [], truncated: false } }))
    const input = document.querySelector<HTMLInputElement>('[data-files-create]')!
    expect(input.getAttribute('aria-label')).toBe(zh['menu.newFile'])
    fireEvent.change(input, { target: { value: '  new.ts  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {})
    expect(server.calls).toEqual([
      { method: 'fs.create', payload: { sessionId: SESSION, parent: `${ROOT}/src`, name: 'new.ts' } },
    ])
    expect(document.querySelector('[data-files-create]')).toBeNull()
    // The affected level is re-listed, and the new entry shows once it lands.
    expect(script.list).toHaveBeenLastCalledWith(SESSION, `${ROOT}/src`, expect.any(AbortSignal))
    await act(() => script.settle({ ok: true, value: { entries: [{ name: 'new.ts', type: 'file' }], truncated: false } }))
    expect(row(view.container, `${ROOT}/src/new.ts`)).not.toBeNull()
  })

  it('offers the empty-area actions, creates a directory inline at the root, and refreshes', async () => {
    const { view, script, server } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const area = view.container.querySelector('[data-files-area]')!
    expect(fireEvent.contextMenu(area)).toBe(false)
    expect(menuLabels()).toEqual([zh['menu.newFile'], zh['menu.newFolder'], zh['menu.refresh']])

    fireEvent.click(item('new-folder'))
    const input = document.querySelector<HTMLInputElement>('[data-files-create]')!
    expect(document.querySelector('[data-files-row="create"]')).not.toBeNull()
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {})
    expect(server.calls).toEqual([
      { method: 'fs.mkdir', payload: { sessionId: SESSION, parent: ROOT, name: 'docs' } },
    ])
    expect(script.list).toHaveBeenLastCalledWith(SESSION, ROOT, expect.any(AbortSignal))
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))

    fireEvent.contextMenu(area)
    fireEvent.click(item('refresh'))
    expect(script.list).toHaveBeenLastCalledWith(SESSION, ROOT, expect.any(AbortSignal))
    // The in-place refresh re-lists without clearing the rows already shown.
    expect(row(view.container, `${ROOT}/src`)).not.toBeNull()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
  })

  it('keeps a failed create input with the host message inline', async () => {
    const { view, script, server } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    server.reply('fs.mkdir', { ok: false, error: { code: 'exists', message: 'already there' } }, 409)
    const area = view.container.querySelector('[data-files-area]')!
    fireEvent.contextMenu(area)
    fireEvent.click(item('new-folder'))
    const input = document.querySelector<HTMLInputElement>('[data-files-create]')!
    fireEvent.change(input, { target: { value: 'src' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {})
    expect(document.querySelector<HTMLInputElement>('[data-files-create]')!.value).toBe('src')
    expect(document.querySelector('[data-files-error]')?.textContent).toBe('already there')
  })

  it('cancels the inline create on Escape and on an empty name, with no request', async () => {
    const { view, script, server } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const area = view.container.querySelector('[data-files-area]')!
    fireEvent.contextMenu(area)
    fireEvent.click(item('new-file'))
    const input = document.querySelector<HTMLInputElement>('[data-files-create]')!
    // A key that is neither Enter nor Escape changes nothing.
    fireEvent.keyDown(input, { key: 'x' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(document.querySelector('[data-files-error]')?.textContent).toBe(zh['error.emptyName'])
    fireEvent.keyDown(document.querySelector<HTMLInputElement>('[data-files-create]')!, { key: 'Escape' })
    expect(document.querySelector('[data-files-create]')).toBeNull()
    expect(server.calls).toEqual([])
  })
})

describe('row rename', () => {
  it('renames inline on Enter, reloads the parent, and cancels with Escape', async () => {
    const { view, script, server } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    openDots(view.container, `${ROOT}/README.md`)
    fireEvent.click(item('rename'))
    const input = document.querySelector<HTMLInputElement>('[data-files-rename]')!
    expect(input.value).toBe('README.md')
    // The input owns its clicks and ignores keys that are not Enter/Escape.
    fireEvent.click(input)
    fireEvent.keyDown(input, { key: 'x' })
    expect(document.querySelector('[data-files-rename]')).not.toBeNull()
    // Escape first: the input disappears and nothing is sent.
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.querySelector('[data-files-rename]')).toBeNull()
    expect(server.calls).toEqual([])

    openDots(view.container, `${ROOT}/README.md`)
    fireEvent.click(item('rename'))
    const again = document.querySelector<HTMLInputElement>('[data-files-rename]')!
    fireEvent.change(again, { target: { value: 'GUIDE.md' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    await act(async () => {})
    expect(server.calls).toEqual([
      { method: 'fs.rename', payload: { sessionId: SESSION, from: `${ROOT}/README.md`, to: `${ROOT}/GUIDE.md` } },
    ])
    expect(document.querySelector('[data-files-rename]')).toBeNull()
    expect(script.list).toHaveBeenLastCalledWith(SESSION, ROOT, expect.any(AbortSignal))
    await act(() => script.settle({ ok: true, value: { entries: [{ name: 'GUIDE.md', type: 'file' }], truncated: false } }))
    expect(row(view.container, `${ROOT}/GUIDE.md`)).not.toBeNull()
    expect(view.container.querySelector(`[data-files-path="${ROOT}/README.md"]`)).toBeNull()
  })

  it('sends nothing when the name did not change, and keeps the input on a host failure', async () => {
    const { view, script, server } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    openDots(view.container, `${ROOT}/README.md`)
    fireEvent.click(item('rename'))
    fireEvent.keyDown(document.querySelector<HTMLInputElement>('[data-files-rename]')!, { key: 'Enter' })
    expect(server.calls).toEqual([])
    expect(document.querySelector('[data-files-rename]')).toBeNull()

    server.reply('fs.rename', { ok: false, error: { code: 'exists', message: 'target exists' } }, 409)
    openDots(view.container, `${ROOT}/README.md`)
    fireEvent.click(item('rename'))
    const input = document.querySelector<HTMLInputElement>('[data-files-rename]')!
    fireEvent.change(input, { target: { value: 'GUIDE.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {})
    expect(document.querySelector<HTMLInputElement>('[data-files-rename]')!.value).toBe('GUIDE.md')
    expect(document.querySelector('[data-files-error]')?.textContent).toBe('target exists')
  })

  it('keeps the rename input with an inline error when the name is emptied', async () => {
    const { view, script, server } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    openDots(view.container, `${ROOT}/README.md`)
    fireEvent.click(item('rename'))
    const input = document.querySelector<HTMLInputElement>('[data-files-rename]')!
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(document.querySelector('[data-files-error]')?.textContent).toBe(zh['error.emptyName'])
    expect(document.querySelector('[data-files-rename]')).not.toBeNull()
    expect(server.calls).toEqual([])
  })

  it('renames a directory inline, collapsed and expanded', async () => {
    const { view, script, server } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    // Collapsed: the editing row carries the closed-folder glyph; Escape leaves it.
    fireEvent.contextMenu(row(view.container, `${ROOT}/src`))
    fireEvent.click(item('rename'))
    expect(document.querySelector<HTMLInputElement>('[data-files-rename]')!.value).toBe('src')
    fireEvent.keyDown(document.querySelector<HTMLInputElement>('[data-files-rename]')!, { key: 'Escape' })

    // Expanded: the editing row carries the open-folder glyph, and Enter commits.
    act(() => { fireEvent.click(row(view.container, `${ROOT}/src`).querySelector('button')!) })
    await act(async () => { await script.watches.ready(`${ROOT}/src`) })
    await act(() => script.settle({ ok: true, value: { entries: [], truncated: false } }))
    fireEvent.contextMenu(row(view.container, `${ROOT}/src`))
    fireEvent.click(item('rename'))
    const input = document.querySelector<HTMLInputElement>('[data-files-rename]')!
    fireEvent.change(input, { target: { value: 'lib' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => {})
    expect(server.calls).toEqual([
      { method: 'fs.rename', payload: { sessionId: SESSION, from: `${ROOT}/src`, to: `${ROOT}/lib` } },
    ])
    expect(script.list).toHaveBeenLastCalledWith(SESSION, ROOT, expect.any(AbortSignal))
  })
})

describe('delete, download, copy', () => {
  it('deletes only after the in-menu confirmation, then the row disappears', async () => {
    const { view, script, server } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    openDots(view.container, `${ROOT}/README.md`)
    expect(menuLabels()).toContain(zh['menu.delete'])
    fireEvent.click(item('delete'))
    expect(menuLabels()).toEqual([zh['menu.deleteConfirm']])
    fireEvent.click(item('delete-confirm'))
    await act(async () => {})
    expect(server.calls).toEqual([
      { method: 'fs.delete', payload: { sessionId: SESSION, path: `${ROOT}/README.md` } },
    ])
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(script.list).toHaveBeenLastCalledWith(SESSION, ROOT, expect.any(AbortSignal))
    await act(() => script.settle({ ok: true, value: { entries: [{ name: 'src', type: 'directory' }], truncated: false } }))
    expect(view.container.querySelector(`[data-files-path="${ROOT}/README.md"]`)).toBeNull()
  })

  it('reports a failed delete in the body notice', async () => {
    const { view, script, server } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    server.reply('fs.delete', { ok: false, error: { code: 'io', message: 'locked' } }, 500)
    openDots(view.container, `${ROOT}/README.md`)
    fireEvent.click(item('delete'))
    fireEvent.click(item('delete-confirm'))
    await act(async () => {})
    expect(view.container.querySelector('[data-files-notice]')?.textContent)
      .toBe(zh['error.opFailed'].replace('{message}', 'locked'))
  })

  it('downloads through fs.download and saves the blob behind an object URL', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:dl')
    const revokeObjectURL = vi.fn((_url: string) => {})
    const url = URL as unknown as {
      createObjectURL: (blob: Blob) => string
      revokeObjectURL: (url: string) => void
    }
    const original = { createObjectURL: url.createObjectURL, revokeObjectURL: url.revokeObjectURL }
    url.createObjectURL = createObjectURL
    url.revokeObjectURL = revokeObjectURL
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    try {
      const { view, script, server } = await mountActions()
      await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
      server.reply('fs.download', { ok: true, value: { base64: 'aGVsbG8=', size: 5, name: 'README.md' } })
      openDots(view.container, `${ROOT}/README.md`)
      fireEvent.click(item('download'))
      await act(async () => {})
      expect(server.calls).toEqual([
        { method: 'fs.download', payload: { sessionId: SESSION, path: `${ROOT}/README.md` } },
      ])
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect((createObjectURL.mock.calls[0]![0] as Blob).size).toBe(5)
      expect(downloads).toEqual(['README.md'])
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:dl')
      expect(document.querySelector('[role="menu"]')).toBeNull()
    } finally {
      url.createObjectURL = original.createObjectURL
      url.revokeObjectURL = original.revokeObjectURL
    }
  })

  it('copies the absolute and workspace-relative paths, showing a brief copied label', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.useFakeTimers()
    try {
      const { view, script } = await mountActions()
      await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
      openDots(view.container, `${ROOT}/README.md`)
      fireEvent.click(item('copy-path'))
      await act(async () => {})
      expect(writeText).toHaveBeenLastCalledWith(`${ROOT}/README.md`)
      expect(item('copy-path').textContent).toBe(zh.copied)
      act(() => { vi.advanceTimersByTime(1200) })
      expect(item('copy-path').textContent).toBe(zh['menu.copyPath'])

      fireEvent.click(item('copy-relative'))
      await act(async () => {})
      expect(writeText).toHaveBeenLastCalledWith('README.md')
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('reports a failed copy in the body notice', async () => {
    const writeText = vi.fn((_text: string) => Promise.reject(new Error('denied')))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const { view, script } = await mountActions()
      await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
      openDots(view.container, `${ROOT}/README.md`)
      fireEvent.click(item('copy-path'))
      await act(async () => {})
      expect(view.container.querySelector('[data-files-notice]')?.textContent)
        .toBe(zh['error.opFailed'].replace('{message}', 'denied'))
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })
})

describe('menu dismissal and keyboard', () => {
  it('closes on an outside pointerdown and returns focus to the row', async () => {
    const { view, script } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const file = row(view.container, `${ROOT}/README.md`)
    openDots(view.container, `${ROOT}/README.md`)
    fireEvent.pointerDown(document.body)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(file.querySelector('button'))
  })

  it('navigates the menu with the arrow keys, Home, and End', async () => {
    const { view, script } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    openDots(view.container, `${ROOT}/README.md`)
    expect(document.activeElement).toBe(item('open'))
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('download'))
    fireEvent.keyDown(document, { key: 'End' })
    expect(document.activeElement).toBe(item('copy-relative'))
    fireEvent.keyDown(document, { key: 'Home' })
    expect(document.activeElement).toBe(item('open'))
    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('copy-relative'))

    // A non-navigation key changes nothing; a pointerdown inside the list
    // keeps it open; with nothing focused in the list, arrows are a no-op.
    fireEvent.keyDown(document, { key: 'x' })
    fireEvent.pointerDown(item('copy-relative'))
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    item('copy-relative').blur()
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })

  it('gives an other row no 3-dots and no menu, only the suppressed browser menu', async () => {
    const { view, script } = await mountActions()
    await act(() => script.settle({ ok: true, value: ROOT_LEVEL }))
    const other = row(view.container, `${ROOT}/pipe`)
    expect(other.querySelector('[data-files-actions]')).toBeNull()
    expect(fireEvent.contextMenu(other)).toBe(false)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})
