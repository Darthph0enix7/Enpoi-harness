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
    revertShadowRanges: [],
    ...overrides,
  }
}

const mockSetDraft = vi.fn()

const DOCK_PROPS = {
  sessionId: 's1' as never,
  session: {} as never,
  input: {} as never,
  useSessions: () => ({} as never),
  useWorkspaces: () => ({} as never),
  useProjection: () => (undefined as never),
  useInput: () => ({} as never),
  inputActions: { setDraft: mockSetDraft } as never,
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
  if (key === 'revert.trayLabel') return `Reverted messages (${String(params?.count)})`
  if (key === 'revert.restore') return 'Restore'
  if (key === 'revert.fork') return 'Fork'
  return key
}

describe('RevertTray', () => {
  it('renders null when no revert boundary is active', () => {
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot())) as SnapshotSelectorHook<ConversationSnapshot>
    const { container } = render(<RevertTray {...DOCK_PROPS} useSession={useSession} t={t} revertRestore={vi.fn()} forkAt={vi.fn()} />)
    expect(container.innerHTML).toBe('')
    cleanup()
  })

  it('renders null when no user nodes exist at or after boundary', () => {
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({ revertFromSeq: 11 }))) as SnapshotSelectorHook<ConversationSnapshot>
    const { container } = render(<RevertTray {...DOCK_PROPS} useSession={useSession} t={t} revertRestore={vi.fn()} forkAt={vi.fn()} />)
    expect(container.innerHTML).toBe('')
    cleanup()
  })

  it('lists all reverted user queries in seq order with Restore and Fork per item', () => {
    const nodes = {
      get: () => undefined,
      values: () => [userNode(11, 'first query'), userNode(16, 'second query'), userNode(25, 'third query')],
    }
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({
      revertFromSeq: 11,
      chat: { order: [], nodes: nodes as never, locations: {} as never, timeline: {} as never, legacy: {} as never },
    }))) as SnapshotSelectorHook<ConversationSnapshot>
    render(<RevertTray {...DOCK_PROPS} useSession={useSession} t={t} revertRestore={vi.fn()} forkAt={vi.fn()} />)
    // Expand
    fireEvent.click(screen.getByText('Reverted messages (3)'))
    expect(screen.getByText('first query')).toBeTruthy()
    expect(screen.getByText('second query')).toBeTruthy()
    expect(screen.getByText('third query')).toBeTruthy()
    expect(screen.getAllByText('Restore')).toHaveLength(3)
    expect(screen.getAllByText('Fork')).toHaveLength(3)
    cleanup()
  })

  it('restore on row 0 restores all; restore on row > 0 moves boundary and populates draft', () => {
    const nodes = {
      get: () => undefined,
      values: () => [userNode(11, 'first query'), userNode(16, 'second query')],
    }
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({
      revertFromSeq: 11,
      chat: { order: [], nodes: nodes as never, locations: {} as never, timeline: {} as never, legacy: {} as never },
    }))) as SnapshotSelectorHook<ConversationSnapshot>
    const revertRestore = vi.fn()
    mockSetDraft.mockClear()
    render(<RevertTray {...DOCK_PROPS} useSession={useSession} t={t} revertRestore={revertRestore} forkAt={vi.fn()} />)
    fireEvent.click(screen.getByText('Reverted messages (2)'))
    const restores = screen.getAllByText('Restore')
    
    // Row 0 (earliest): restore all
    fireEvent.click(restores[0]!)
    expect(revertRestore).toHaveBeenCalledWith()

    // Row 1 (second query): boundary moves to seq 16 and sets draft
    fireEvent.click(restores[1]!)
    expect(revertRestore).toHaveBeenCalledWith(16)
    expect(mockSetDraft).toHaveBeenCalledWith('second query')
    cleanup()
  })

  it('Fork calls forkAt with the item seq', () => {
    const nodes = {
      get: () => undefined,
      values: () => [userNode(16, 'second query')],
    }
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({
      revertFromSeq: 16,
      chat: { order: [], nodes: nodes as never, locations: {} as never, timeline: {} as never, legacy: {} as never },
    }))) as SnapshotSelectorHook<ConversationSnapshot>
    const forkAt = vi.fn()
    render(<RevertTray {...DOCK_PROPS} useSession={useSession} t={t} revertRestore={vi.fn()} forkAt={forkAt} />)
    fireEvent.click(screen.getByText('Reverted messages (1)'))
    fireEvent.click(screen.getByText('Fork'))
    expect(forkAt).toHaveBeenCalledWith(16)
    cleanup()
  })
})
