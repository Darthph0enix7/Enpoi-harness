// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { RevertTray } from '../src/client/chat/RevertTray.tsx'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

function snapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: 's1' as never,
    views: {} as never,
    chat: {
      order: [],
      nodes: {
        get: () => undefined,
        values: () => [],
      } as never,
      locations: {} as never,
      timeline: {} as never,
      legacy: {} as never,
    },
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: false,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    revertFromSeq: null,
    revertShadowedSeqs: [],
    ...overrides,
  }
}

function userNode(seq: number, text: string) {
  return {
    key: `user-${seq}`,
    kind: 'user',
    anchorSeq: seq,
    data: { content: [{ type: 'text', text }], seq },
  }
}

const t = (key: string, params?: Record<string, unknown>): string => {
  if (key === 'revert.trayLabel') return `Reverted (${String(params?.count)})`
  if (key === 'revert.redo') return 'Redo'
  if (key === 'revert.restore') return 'Restore'
  if (key === 'revert.fork') return 'Fork'
  return key
}

describe('RevertTray', () => {
  it('renders null when no revert boundary is active', () => {
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot())) as SnapshotSelectorHook<ConversationSnapshot>
    const { container } = render(<RevertTray useSession={useSession} t={t} revertRestore={vi.fn()} forkAt={vi.fn()} />)
    expect(container.innerHTML).toBe('')
    cleanup()
  })

  it('shows the tray with the reverted count and Redo even with zero reverted queries', () => {
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({ revertFromSeq: 11 }))) as SnapshotSelectorHook<ConversationSnapshot>
    render(<RevertTray useSession={useSession} t={t} revertRestore={vi.fn()} forkAt={vi.fn()} />)
    expect(screen.getByText('Reverted (0)')).toBeTruthy()
    expect(screen.getByText('Redo')).toBeTruthy()
    cleanup()
  })

  it('lists reverted user queries in seq order with Restore and Fork per item', () => {
    const nodes = {
      get: () => undefined,
      values: () => [userNode(16, 'second query'), userNode(25, 'third query')],
    }
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({
      revertFromSeq: 11,
      chat: { order: [], nodes: nodes as never, locations: {} as never, timeline: {} as never, legacy: {} as never },
    }))) as SnapshotSelectorHook<ConversationSnapshot>
    render(<RevertTray useSession={useSession} t={t} revertRestore={vi.fn()} forkAt={vi.fn()} />)
    // Expand
    fireEvent.click(screen.getByText('Reverted (2)'))
    expect(screen.getByText('second query')).toBeTruthy()
    expect(screen.getByText('third query')).toBeTruthy()
    expect(screen.getAllByText('Restore')).toHaveLength(2)
    expect(screen.getAllByText('Fork')).toHaveLength(2)
    cleanup()
  })

  it('restore on row i un-reverts up to and including row i (boundary = next row seq)', () => {
    const nodes = {
      get: () => undefined,
      values: () => [userNode(16, 'second query'), userNode(25, 'third query')],
    }
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({
      revertFromSeq: 11,
      chat: { order: [], nodes: nodes as never, locations: {} as never, timeline: {} as never, legacy: {} as never },
    }))) as SnapshotSelectorHook<ConversationSnapshot>
    const revertRestore = vi.fn()
    render(<RevertTray useSession={useSession} t={t} revertRestore={revertRestore} forkAt={vi.fn()} />)
    fireEvent.click(screen.getByText('Reverted (2)'))
    const restores = screen.getAllByText('Restore')
    // Row 0 (second query): boundary moves to the next row's seq (25).
    fireEvent.click(restores[0]!)
    expect(revertRestore).toHaveBeenCalledWith(25)
    // Row 1 (third query, last): restore everything (undefined).
    fireEvent.click(restores[1]!)
    expect(revertRestore).toHaveBeenCalledWith(undefined)
    cleanup()
  })

  it('Redo restores everything', () => {
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({ revertFromSeq: 11 }))) as SnapshotSelectorHook<ConversationSnapshot>
    const revertRestore = vi.fn()
    render(<RevertTray useSession={useSession} t={t} revertRestore={revertRestore} forkAt={vi.fn()} />)
    fireEvent.click(screen.getByText('Redo'))
    expect(revertRestore).toHaveBeenCalledWith()
    cleanup()
  })

  it('Fork calls forkAt with the item seq', () => {
    const nodes = {
      get: () => undefined,
      values: () => [userNode(16, 'second query')],
    }
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({
      revertFromSeq: 11,
      chat: { order: [], nodes: nodes as never, locations: {} as never, timeline: {} as never, legacy: {} as never },
    }))) as SnapshotSelectorHook<ConversationSnapshot>
    const forkAt = vi.fn()
    render(<RevertTray useSession={useSession} t={t} revertRestore={vi.fn()} forkAt={forkAt} />)
    fireEvent.click(screen.getByText('Reverted (1)'))
    fireEvent.click(screen.getByText('Fork'))
    expect(forkAt).toHaveBeenCalledWith(16)
    cleanup()
  })
})