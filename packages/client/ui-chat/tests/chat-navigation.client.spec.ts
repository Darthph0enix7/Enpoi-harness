/** Turn-jump policy: a loaded rail mark must never become a dead click. */

import { describe, expect, it, vi } from 'vitest'
import { ChatNavigation, type ChatNavigationInput } from '../src/client/chat/use-chat-navigation.ts'
import { ChatReading } from '../src/client/chat/use-chat-reading.ts'
import { ChatViewport, type ViewportLanding } from '../src/client/chat/use-chat-viewport.ts'
import { ScrollFollow } from '../src/client/chat/use-scroll-follow.ts'
import type { TurnRailItem } from '../src/client/chat/turn-rail-items.ts'

function loadedItem(turn: number): TurnRailItem {
  return { turn, prompt: '', response: '', anchor: { kind: 'loaded', key: `anchor-${String(turn)}` } }
}

function landing(turn: number): ViewportLanding {
  return { metrics: { top: 0, floor: 0, height: 0 }, position: null, turn }
}

function harness() {
  const viewport = new ChatViewport()
  const reading = new ChatReading(
    viewport,
    { save: () => {}, read: () => null },
    { initialized: true, followingTail: false, activeTurn: null },
    () => {},
    new ScrollFollow(false, 24),
  )
  const input: ChatNavigationInput = {
    firstSeq: null,
    hasMore: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    loadThrough: vi.fn(() => Promise.resolve()),
  }
  const navigation = new ChatNavigation(viewport, reading, input, () => {})
  return { navigation, viewport, reading }
}

describe('ChatNavigation loaded-turn jumps', () => {
  it('lands on the named turn when its row is mounted', () => {
    const { navigation, viewport, reading } = harness()
    const direct = landing(2)
    const scrollToTurn = vi.spyOn(viewport, 'scrollToTurn').mockReturnValue(direct)
    const fallback = vi.spyOn(viewport, 'scrollToTurnAtOrAfter')
    const accept = vi.spyOn(reading, 'acceptNavigation')

    navigation.navigateToTurn(loadedItem(2))

    expect(scrollToTurn).toHaveBeenCalledWith(2)
    expect(fallback).not.toHaveBeenCalled()
    expect(accept).toHaveBeenCalledWith(direct)
  })

  it('falls back to the nearest rendered turn at or after an unlandable loaded mark', () => {
    const { navigation, viewport, reading } = harness()
    const scrollToTurn = vi.spyOn(viewport, 'scrollToTurn').mockReturnValue(null)
    const nearest = landing(3)
    const fallback = vi.spyOn(viewport, 'scrollToTurnAtOrAfter').mockReturnValue(nearest)
    const accept = vi.spyOn(reading, 'acceptNavigation')

    navigation.navigateToTurn(loadedItem(2))

    expect(scrollToTurn).toHaveBeenCalledWith(2)
    expect(fallback).toHaveBeenCalledWith(2)
    expect(accept).toHaveBeenCalledWith(nearest)
  })

  it('stays quiet when neither the mark nor any later row can land', () => {
    const { navigation, viewport, reading } = harness()
    vi.spyOn(viewport, 'scrollToTurn').mockReturnValue(null)
    const fallback = vi.spyOn(viewport, 'scrollToTurnAtOrAfter').mockReturnValue(null)
    const accept = vi.spyOn(reading, 'acceptNavigation')

    navigation.navigateToTurn(loadedItem(2))

    expect(fallback).toHaveBeenCalledWith(2)
    expect(accept).not.toHaveBeenCalled()
  })
})
