// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
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
  if (key === 'revert.conflictsTitle') return 'File Conflicts'
  if (key === 'revert.conflictDesc') return 'Manual edits detected — file kept untouched'
  if (key === 'revert.missingDesc') return 'File is missing on disk'
  if (key === 'revert.unavailableDesc') return 'Snapshot unavailable'
  if (key === 'revert.btnKeep') return 'Keep My Version'
  if (key === 'revert.btnRestore') return 'Force Revert'
  if (key === 'revert.btnRecreate') return 'Save Beside'
  if (key === 'revert.btnRecreateFile') return 'Recreate File'
  if (key === 'revert.btnLeaveDeleted') return 'Leave Deleted'
  if (key === 'revert.btnDismiss') return 'Dismiss'
  if (key === 'revert.affectedFiles') return `Affected Files (${String(params?.count)})`
  if (key === 'revert.statusRestored') return 'Restored'
  if (key === 'revert.statusTrashed') return 'Trashed'
  if (key === 'revert.statusNoChange') return 'No change'
  if (key === 'revert.statusConflict') return 'Conflict'
  if (key === 'revert.statusError') return 'Error'
  return key
}

describe('RevertTray', () => {
  it('renders null when no revert boundary is active and no conflicts exist', () => {
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) =>
      selector(snapshot())) as SnapshotSelectorHook<ConversationSnapshot>
    const { container } = render(
      <RevertTray
        {...DOCK_PROPS}
        useSession={useSession}
        t={t}
        revertRestore={vi.fn()}
        forkAt={vi.fn()}
        openFile={vi.fn()}
        resolveFileConflict={vi.fn()}
      />,
    )
    expect(container.innerHTML).toBe('')
    cleanup()
  })

  it('renders null when no user nodes exist at or after boundary and no conflicts exist', () => {
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) =>
      selector(snapshot({ revertFromSeq: 11 }))) as SnapshotSelectorHook<ConversationSnapshot>
    const { container } = render(
      <RevertTray
        {...DOCK_PROPS}
        useSession={useSession}
        t={t}
        revertRestore={vi.fn()}
        forkAt={vi.fn()}
        openFile={vi.fn()}
        resolveFileConflict={vi.fn()}
      />,
    )
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
    render(
      <RevertTray
        {...DOCK_PROPS}
        useSession={useSession}
        t={t}
        revertRestore={vi.fn()}
        forkAt={vi.fn()}
        openFile={vi.fn()}
        resolveFileConflict={vi.fn()}
      />,
    )
    // Expand
    fireEvent.click(screen.getByText('Reverted messages (3)'))
    expect(screen.getByText('first query')).toBeTruthy()
    expect(screen.getByText('second query')).toBeTruthy()
    expect(screen.getByText('third query')).toBeTruthy()
    expect(screen.getAllByText('Restore')).toHaveLength(3)
    expect(screen.getAllByText('Fork')).toHaveLength(3)
    cleanup()
  })

  it('restore on row < last moves boundary and populates draft; restore on last row restores all', () => {
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
    render(
      <RevertTray
        {...DOCK_PROPS}
        useSession={useSession}
        t={t}
        revertRestore={revertRestore}
        forkAt={vi.fn()}
        openFile={vi.fn()}
        resolveFileConflict={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText('Reverted messages (2)'))
    const restores = screen.getAllByText('Restore')

    // Row 0 (first query): restore up to first query -> boundary moves to seq 16 and sets draft
    fireEvent.click(restores[0]!)
    expect(revertRestore).toHaveBeenCalledWith(16)
    expect(mockSetDraft).toHaveBeenCalledWith('second query')

    // Row 1 (second query, last): restore all
    fireEvent.click(restores[1]!)
    expect(revertRestore).toHaveBeenCalledWith()
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
    render(
      <RevertTray
        {...DOCK_PROPS}
        useSession={useSession}
        t={t}
        revertRestore={vi.fn()}
        forkAt={forkAt}
        openFile={vi.fn()}
        resolveFileConflict={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText('Reverted messages (1)'))
    fireEvent.click(screen.getByText('Fork'))
    expect(forkAt).toHaveBeenCalledWith(16)
    cleanup()
  })

  it('renders Conflict Banner even when revertFromSeq is null (Oracle Item 3)', () => {
    const resolveFileConflict = vi.fn()
    const openFile = vi.fn()
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({
      revertFromSeq: null,
      revertFileConflicts: [{
        conflictId: 'c1',
        targetKey: '/home/adam/src/App.tsx',
        displayPath: 'src/App.tsx',
        state: 'conflict',
        preSha: 'sha1',
        postSha: 'sha2',
        currentSha: 'sha3',
      }],
    }))) as SnapshotSelectorHook<ConversationSnapshot>

    render(
      <RevertTray
        {...DOCK_PROPS}
        useSession={useSession}
        t={t}
        revertRestore={vi.fn()}
        forkAt={vi.fn()}
        openFile={openFile}
        resolveFileConflict={resolveFileConflict}
      />,
    )

    expect(screen.getByText('File Conflicts')).toBeTruthy()
    expect(screen.getByText('App.tsx')).toBeTruthy()
    expect(screen.getByText('Manual edits detected — file kept untouched')).toBeTruthy()
    expect(screen.getByText('Keep My Version')).toBeTruthy()
    expect(screen.getByText('Force Revert')).toBeTruthy()
    expect(screen.getByText('Save Beside')).toBeTruthy()

    // Click file chip -> openFile called
    fireEvent.click(screen.getByText('App.tsx'))
    expect(openFile).toHaveBeenCalledWith('src/App.tsx')

    // Click Keep -> resolveFileConflict('c1', 'keep')
    fireEvent.click(screen.getByText('Keep My Version'))
    expect(resolveFileConflict).toHaveBeenCalledWith('c1', 'keep')

    cleanup()
  })

  it('renders state-dependent buttons for missing and unavailable conflicts (Oracle Item 5)', async () => {
    const resolveFileConflict = vi.fn()
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({
      revertFromSeq: null,
      revertFileConflicts: [
        {
          conflictId: 'c-missing',
          targetKey: '/proj/deleted.ts',
          displayPath: 'deleted.ts',
          state: 'missing',
          preSha: 's1',
          postSha: 's2',
          currentSha: null,
        },
        {
          conflictId: 'c-unavail',
          targetKey: '/proj/large.bin',
          displayPath: 'large.bin',
          state: 'unavailable',
          preSha: null,
          postSha: null,
          currentSha: 's3',
        },
      ],
    }))) as SnapshotSelectorHook<ConversationSnapshot>

    render(
      <RevertTray
        {...DOCK_PROPS}
        useSession={useSession}
        t={t}
        revertRestore={vi.fn()}
        forkAt={vi.fn()}
        openFile={vi.fn()}
        resolveFileConflict={resolveFileConflict}
      />,
    )

    // Missing buttons
    expect(screen.getByText('deleted.ts')).toBeTruthy()
    expect(screen.getByText('File is missing on disk')).toBeTruthy()
    expect(screen.getByText('Recreate File')).toBeTruthy()
    expect(screen.getByText('Leave Deleted')).toBeTruthy()

    // Unavailable buttons
    expect(screen.getByText('large.bin')).toBeTruthy()
    expect(screen.getByText('Snapshot unavailable')).toBeTruthy()
    expect(screen.getByText('Dismiss')).toBeTruthy()

    // Click Recreate File
    await act(async () => {
      fireEvent.click(screen.getByText('Recreate File'))
    })
    expect(resolveFileConflict).toHaveBeenCalledWith('c-missing', 'recreate')

    // Click Dismiss
    await act(async () => {
      fireEvent.click(screen.getByText('Dismiss'))
    })
    expect(resolveFileConflict).toHaveBeenCalledWith('c-unavail', 'keep')

    cleanup()
  })

  it('renders Affected Files list with clickable chips and outcome badges', () => {
    const openFile = vi.fn()
    const nodes = {
      get: () => undefined,
      values: () => [userNode(10, 'write file')],
    }
    const useSession = ((selector: (s: ConversationSnapshot) => unknown) => selector(snapshot({
      revertFromSeq: 10,
      chat: { order: [], nodes: nodes as never, locations: {} as never, timeline: {} as never, legacy: {} as never },
      revertFileOutcomes: {
        '/proj/src/index.ts': { status: 'restored', toSha: 'sha1' },
        '/proj/src/temp.ts': { status: 'trashed', dest: '/trash/temp.ts' },
        '/proj/src/config.json': { status: 'no_op' },
        '/proj/src/other.ts': { status: 'pending_conflict' },
        '/proj/src/unknown.xyz': { status: 'custom_status' },
      },
    }))) as SnapshotSelectorHook<ConversationSnapshot>

    render(
      <RevertTray
        {...DOCK_PROPS}
        useSession={useSession}
        t={t}
        revertRestore={vi.fn()}
        forkAt={vi.fn()}
        openFile={openFile}
        resolveFileConflict={vi.fn()}
      />,
    )

    // Header shows count
    expect(screen.getByText('5 files')).toBeTruthy()

    // Expand
    fireEvent.click(screen.getByText('Reverted messages (1)'))

    expect(screen.getByText('Affected Files (5)')).toBeTruthy()
    expect(screen.getByText('index.ts')).toBeTruthy()
    expect(screen.getByText('Restored')).toBeTruthy()
    expect(screen.getByText('temp.ts')).toBeTruthy()
    expect(screen.getByText('Trashed')).toBeTruthy()
    expect(screen.getByText('config.json')).toBeTruthy()
    expect(screen.getByText('No change')).toBeTruthy()
    expect(screen.getByText('other.ts')).toBeTruthy()
    expect(screen.getByText('Conflict')).toBeTruthy()
    // Fallback status arm
    expect(screen.getByText('custom_status')).toBeTruthy()

    // Click on index.ts chip -> openFile called
    fireEvent.click(screen.getByText('index.ts'))
    expect(openFile).toHaveBeenCalledWith('/proj/src/index.ts')

    cleanup()
  })
})
