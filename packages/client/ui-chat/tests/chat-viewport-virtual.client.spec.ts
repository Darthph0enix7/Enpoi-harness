// @vitest-environment jsdom

import { expect, it, onTestFinished, vi } from 'vitest'
import { ChatViewport, type ChatVirtualWindow } from '../src/client/chat/use-chat-viewport.ts'

function fixture() {
  const column = document.createElement('div')
  column.dataset.chatFlow = ''
  document.body.append(column)
  const viewport = new ChatViewport()
  onTestFinished(() => {
    viewport.detach()
    column.remove()
    vi.restoreAllMocks()
  })
  Object.defineProperties(column, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 2_000 },
  })
  vi.spyOn(column, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300))
  viewport.attach(column, column)
  return { column, viewport }
}

function turnRow(column: HTMLElement, turn: number, key: string, top: number): void {
  const row = document.createElement('div')
  row.dataset.chatTurn = String(turn)
  row.dataset.chatAnchorKey = key
  row.dataset.chatNodeKey = key
  row.dataset.chatPagingAnchor = ''
  column.append(row)
  vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() =>
    new DOMRect(0, top - column.scrollTop, 500, 60))
}

const virtualWindow = (overrides: Partial<ChatVirtualWindow> = {}): ChatVirtualWindow => ({
  landingForAnchor: () => null,
  landingAtOrAfterTurn: () => null,
  ...overrides,
})

it('lands an unmounted turn from the virtual window offset', () => {
  const h = fixture()
  h.viewport.updateTurns([{ turn: 3, anchorKey: 'node-3', prompt: '', response: '' }])
  h.viewport.setVirtualWindow(virtualWindow({
    landingForAnchor: key => key === 'node-3' ? { key, offset: 800, turn: 3 } : null,
  }))

  const landing = h.viewport.scrollToTurn(3)

  expect(h.column.scrollTop).toBe(776)
  expect(landing?.turn).toBe(3)
  expect(landing?.position).toEqual({ anchorKey: 'node-3', anchorTop: 24, scrollTop: 776 })
})

it('restores a semantic anchor whose row is outside the render window', () => {
  const h = fixture()
  h.viewport.setVirtualWindow(virtualWindow({
    landingForAnchor: key => key === 'saved' ? { key, offset: 800, turn: null } : null,
  }))

  const landing = h.viewport.restore({ anchorKey: 'saved', anchorTop: 40, scrollTop: 999 })

  expect(h.column.scrollTop).toBe(760)
  expect(landing?.position).toEqual({ anchorKey: 'saved', anchorTop: 40, scrollTop: 760 })
})

it('falls back to the virtual window when no rendered row is at or after the turn', () => {
  const h = fixture()
  turnRow(h.column, 1, 'early', 0)
  turnRow(h.column, 2, 'late', 60)
  h.viewport.setVirtualWindow(virtualWindow({
    landingAtOrAfterTurn: turn => turn === 5 ? { key: 'group:g', offset: 1_000, turn: 5 } : null,
  }))

  const landing = h.viewport.scrollToTurnAtOrAfter(5)

  expect(h.column.scrollTop).toBe(976)
  expect(landing?.turn).toBe(5)
  expect(landing?.position?.anchorKey).toBe('group:g')
})

it('keeps the rendered-row scan first and the plain fallback without a virtual window', () => {
  const h = fixture()
  turnRow(h.column, 6, 'rendered', 120)
  const delegate = vi.fn(() => ({ key: 'virtual', offset: 500, turn: 6 }))
  h.viewport.setVirtualWindow(virtualWindow({ landingAtOrAfterTurn: delegate }))

  expect(h.viewport.scrollToTurnAtOrAfter(5)?.position?.anchorKey).toBe('rendered')
  expect(delegate).not.toHaveBeenCalled()

  h.viewport.setVirtualWindow(null)
  expect(h.viewport.scrollToTurnAtOrAfter(5)?.position?.anchorKey).toBe('rendered')
  expect(h.viewport.restore({ anchorKey: 'missing', anchorTop: 24, scrollTop: 900 })?.position).toBeNull()
  expect(h.column.scrollTop).toBe(900)
})
