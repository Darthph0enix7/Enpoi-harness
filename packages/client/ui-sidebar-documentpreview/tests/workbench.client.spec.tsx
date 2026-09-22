// @vitest-environment jsdom
/**
 * The workbench quick actions: the host's find/go-to-line over loaded source
 * lines, the download through the fenced route, the clipboard writes, and the
 * capability-gated toolbar entries.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { TextPreview } from '../src/client/TextPreview.tsx'
import type { TextPreviewProps } from '../src/client/TextPreview.tsx'
import type { DocumentPreviewDefinition } from '../src/client/document/registry.ts'
import { copyPlainText, downloadSessionFile } from '../src/client/quick-actions.ts'
import { findLinesOf } from '../src/client/text/lines.ts'
import { documentSlots, ABSOLUTE_PATH, FILE, harness, page, settle } from './fixtures.client.ts'

afterEach(cleanup)

describe('source-line search helpers', () => {
  const pages = [
    { offset: 1, text: 'alpha\nbeta', lines: 2 },
    { offset: 3, text: 'gamma', lines: 1 },
  ]

  it('lists every loaded line holding the term, in source order, ignoring case', () => {
    expect(findLinesOf(pages, 'a')).toEqual([1, 2, 3])
    expect(findLinesOf(pages, 'BETA')).toEqual([2])
    expect(findLinesOf(pages, 'missing')).toEqual([])
    expect(findLinesOf(pages, '')).toEqual([])
  })
})

describe('download and clipboard', () => {
  it('downloads through the fenced route and hands the browser the file', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ({
      ok: true, status: 200, json: async () => ({
        ok: true, value: { base64: btoa('contents'), name: 'notes.md' },
      }),
    }) as unknown as Response)
    ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    await downloadSessionFile(FILE)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/sidebar/fsops/fs.download')
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: FILE.sessionId, path: FILE.path })
    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('writes the clipboard through the browser API', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    await copyPlainText('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })
})

describe('capability-gated toolbar entries', () => {
  it('offers find and go to line for a source renderer and hides them for bytes', async () => {
    const h = harness({ 1: page(1, ['one\ntwo'], true) })
    const base = h.props()
    const address = 'dsh-resource://file/session/s-1/work/notes.md'
    const plain: DocumentPreviewDefinition = {
      id: 'plain', extensions: ['md'], priority: 'builtin', title: () => 'Plain', loading: 'text-pages', wrap: true,
      capabilities: { search: true, gotoLine: true },
    }
    const image: DocumentPreviewDefinition = {
      id: 'image', extensions: ['png'], priority: 'builtin', title: () => 'Image', loading: 'bytes-complete',
      binaryExtensions: ['png'],
    }
    const renderSlot = documentSlots((_key, owner, opts) => {
      void owner
      void opts
      return null
    })
    const useDocumentPreviews: TextPreviewProps['useDocumentPreviews'] = selector => selector([plain])
    const props = { ...base, useDocumentPreviews, renderSlot, readAllText: vi.fn(async () => 'disk text') }
    const info = props.useTabInfo()
    const view = render(<TextPreview
      {...props}
      useTabInfo={() => ({ ...info, tab: { ...info.tab, contentId: address } })}
    />)
    await settle()
    expect(view.container.querySelector('[data-textpreview-tool="find"]')).not.toBeNull()
    expect(view.container.querySelector('[data-textpreview-tool="goto-line"]')).not.toBeNull()
    expect(view.container.querySelector('[data-textpreview-tool="download"]')).not.toBeNull()
    expect(view.container.querySelector('[data-textpreview-tool="copy-path"]')).not.toBeNull()
    expect(view.container.querySelector('[data-textpreview-tool="copy-content"]')).not.toBeNull()
    cleanup()
    const imageAddress = 'dsh-resource://file/session/s-1/work/clip.png'
    h.bytes.mockResolvedValue({ ok: true, value: {
      absolutePath: ABSOLUTE_PATH, version: 'v1', offset: 0, data: new TextEncoder().encode('png'), bytes: 3, eof: true,
    } })
    const imageView = render(<TextPreview
      {...props}
      useTabInfo={() => ({ ...info, tab: { ...info.tab, contentId: imageAddress } })}
      useDocumentPreviews={selector => selector([plain, image])}
    />)
    await settle()
    expect(imageView.container.querySelector('[data-textpreview-tool="find"]')).toBeNull()
    expect(imageView.container.querySelector('[data-textpreview-tool="goto-line"]')).toBeNull()
    expect(imageView.container.querySelector('[data-textpreview-tool="copy-content"]')).toBeNull()
    expect(imageView.container.querySelector('[data-textpreview-tool="download"]')).not.toBeNull()
  })

  it('opens the themed go-to-line popover and hands the renderer the number, never a prompt', async () => {
    const h = harness({ 1: page(1, ['one\ntwo'], true) })
    const base = h.props()
    const info = base.useTabInfo()
    const plain: DocumentPreviewDefinition = {
      id: 'plain', extensions: ['md'], priority: 'builtin', title: () => 'Plain', loading: 'text-pages', wrap: true,
      capabilities: { search: true, gotoLine: true },
    }
    const find = vi.fn()
    const gotoLine = vi.fn()
    const prompt = vi.fn()
    vi.stubGlobal('prompt', prompt)
    const renderSlot = documentSlots((_key, owner, opts) => {
      void opts
      // A renderer-owned body: register its commands on mount, like the editor.
      ;(owner as unknown as { commandsRef?: (value: unknown) => void }).commandsRef?.({ find, gotoLine })
      return createElement('div', null, 'renderer-owned')
    })
    const view = render(<TextPreview
      {...base}
      useDocumentPreviews={selector => selector([plain])}
      renderSlot={renderSlot}
      readAllText={vi.fn(async () => 'disk text')}
      useTabInfo={() => info}
    />)
    await settle()
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="find"]')!)
    expect(find).toHaveBeenCalledTimes(1)
    // Go to line opens our popover; the renderer's jump happens on Enter.
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="goto-line"]')!)
    const field = view.container.querySelector<HTMLInputElement>('[data-textpreview-popover="goto"] input')!
    expect(field).not.toBeNull()
    fireEvent.change(field, { target: { value: '12' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(gotoLine).toHaveBeenCalledWith(12)
    expect(prompt).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-textpreview-popover="goto"]')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('navigates go-to-line through the tab line parameter for a host-owned view', async () => {
    const h = harness({ 1: page(1, ['one\ntwo'], true) })
    const base = h.props()
    const info = base.useTabInfo()
    const openResource = vi.fn()
    const plain: DocumentPreviewDefinition = {
      id: 'plain', extensions: ['md'], priority: 'builtin', title: () => 'Plain', loading: 'text-pages', wrap: true,
      capabilities: { search: true, gotoLine: true },
    }
    const prompt = vi.fn()
    vi.stubGlobal('prompt', prompt)
    const view = render(<TextPreview
      {...base}
      useTabInfo={() => ({ ...info, tab: { ...info.tab, actions: { ...info.tab.actions, openResource } } })}
      useDocumentPreviews={selector => selector([plain])}
      renderSlot={() => null}
    />)
    await settle()
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="goto-line"]')!)
    const field = view.container.querySelector<HTMLInputElement>('[data-textpreview-popover="goto"] input')!
    fireEvent.change(field, { target: { value: '7' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(openResource).toHaveBeenCalledWith(info.tab.contentId, { params: { line: 7 } })
    // Esc closes without navigating.
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="goto-line"]')!)
    const reopened = view.container.querySelector<HTMLInputElement>('[data-textpreview-popover="goto"] input')!
    fireEvent.keyDown(reopened, { key: 'Escape' })
    expect(view.container.querySelector('[data-textpreview-popover="goto"]')).toBeNull()
    expect(prompt).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('opens the host find popover with a count and working next/prev for a source view', async () => {
    const h = harness({ 1: page(1, ['one\ntwo\none'], true) })
    const base = h.props()
    const info = base.useTabInfo()
    const plain: DocumentPreviewDefinition = {
      id: 'plain', extensions: ['md'], priority: 'builtin', title: () => 'Plain', loading: 'text-pages', wrap: true,
      capabilities: { search: true, gotoLine: true },
    }
    const view = render(<TextPreview
      {...base}
      useTabInfo={() => info}
      useDocumentPreviews={selector => selector([plain])}
      renderSlot={() => null}
    />)
    await settle()
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="find"]')!)
    const field = view.container.querySelector<HTMLInputElement>('[data-textpreview-popover="find"] input')!
    expect(field).not.toBeNull()
    fireEvent.change(field, { target: { value: 'one' } })
    expect(view.container.querySelector('[data-textpreview-find-count]')?.textContent).toBe('find.count(index=1,total=2)')
    fireEvent.click(view.container.querySelector('[data-textpreview-find-next]')!)
    expect(view.container.querySelector('[data-textpreview-find-count]')?.textContent).toBe('find.count(index=2,total=2)')
    fireEvent.click(view.container.querySelector('[data-textpreview-find-prev]')!)
    expect(view.container.querySelector('[data-textpreview-find-count]')?.textContent).toBe('find.count(index=1,total=2)')
    fireEvent.change(field, { target: { value: 'missing' } })
    expect(view.container.querySelector('[data-textpreview-find-count]')?.textContent).toBe('find.noMatch')
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(view.container.querySelector('[data-textpreview-popover="find"]')).toBeNull()
  })

  it('keeps Mod-F and Mod-G on our own surfaces, not the browser', async () => {
    const h = harness({ 1: page(1, ['one\ntwo'], true) })
    const base = h.props()
    const info = base.useTabInfo()
    const plain: DocumentPreviewDefinition = {
      id: 'plain', extensions: ['md'], priority: 'builtin', title: () => 'Plain', loading: 'text-pages', wrap: true,
      capabilities: { search: true, gotoLine: true },
    }
    const view = render(<TextPreview
      {...base}
      useTabInfo={() => info}
      useDocumentPreviews={selector => selector([plain])}
      renderSlot={() => null}
    />)
    await settle()
    fireEvent.keyDown(view.container.firstElementChild!, { key: 'g', metaKey: true })
    expect(view.container.querySelector('[data-textpreview-popover="goto"]')).not.toBeNull()
    fireEvent.keyDown(view.container.querySelector('[data-textpreview-popover="goto"] input')!, { key: 'Escape' })
    fireEvent.keyDown(view.container.firstElementChild!, { key: 'f', ctrlKey: true })
    expect(view.container.querySelector('[data-textpreview-popover="find"]')).not.toBeNull()
  })
})
