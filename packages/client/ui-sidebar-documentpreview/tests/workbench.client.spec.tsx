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
import { findLineOf, visibleTopLine } from '../src/client/text/lines.ts'
import { documentSlots, ABSOLUTE_PATH, FILE, harness, page, settle } from './fixtures.client.ts'

afterEach(cleanup)

describe('source-line search helpers', () => {
  const pages = [
    { offset: 1, text: 'alpha\nbeta', lines: 2 },
    { offset: 3, text: 'gamma', lines: 1 },
  ]

  it('finds the first match at or below the given line, wrapping once', () => {
    expect(findLineOf(pages, 'BETA', 1)).toBe(2)
    expect(findLineOf(pages, 'gamma', 3)).toBe(3)
    expect(findLineOf(pages, 'gamma', 4)).toBe(3)
    expect(findLineOf(pages, 'missing', 1)).toBeUndefined()
  })

  it('reports the top visible line of a plain view', () => {
    const host = document.createElement('div')
    const row = (line: number, top: number): HTMLElement => {
      const element = document.createElement('div')
      element.setAttribute('data-textpreview-line', String(line))
      Object.defineProperty(element, 'offsetTop', { configurable: true, value: top })
      host.appendChild(element)
      return element
    }
    row(1, 0)
    row(2, 14)
    row(3, 28)
    Object.defineProperty(host, 'scrollTop', { configurable: true, value: 20 })
    expect(visibleTopLine(host)).toBe(2)
    Object.defineProperty(host, 'scrollTop', { configurable: true, value: 0 })
    expect(visibleTopLine(host)).toBe(1)
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

  it('prefers the selected renderer command bridge over the host-owned prompt flow', async () => {
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
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="goto-line"]')!)
    expect(find).toHaveBeenCalledTimes(1)
    expect(gotoLine).toHaveBeenCalledTimes(1)
    expect(prompt).not.toHaveBeenCalled()
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
    const prompt = vi.fn(() => '7')
    vi.stubGlobal('prompt', prompt)
    const view = render(<TextPreview
      {...base}
      useTabInfo={() => ({ ...info, tab: { ...info.tab, actions: { ...info.tab.actions, openResource } } })}
      useDocumentPreviews={selector => selector([plain])}
      renderSlot={() => null}
    />)
    await settle()
    fireEvent.click(view.container.querySelector('[data-textpreview-tool="goto-line"]')!)
    expect(prompt).toHaveBeenCalled()
    expect(openResource).toHaveBeenCalledWith(info.tab.contentId, { params: { line: 7 } })
    vi.unstubAllGlobals()
  })
})
