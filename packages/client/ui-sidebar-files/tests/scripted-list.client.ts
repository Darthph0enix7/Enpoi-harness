/** Deferred directory reads paired with independently controlled watch streams. */
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ListOperatorDirectory, ListWorkspaceDirectory, WatchWorkspaceDirectory } from '../src/client/face.ts'
import type { DirLevel } from '../src/client/store.ts'
import { DirectoryWatches } from './scripted-watch.client.ts'

/** The scripted listing: the mock the face receives, and the hand that settles it. */
export interface ScriptedList {
  readonly watch: WatchWorkspaceDirectory
  readonly watches: DirectoryWatches
  readonly list: Mock<ListWorkspaceDirectory>
  /**
   * The operator document listing, staying pending until the spec settles it.
   * @param level - what the fs route answers.
   */
  readonly operatorList: Mock<ListOperatorDirectory>
  /** Settle the oldest outstanding operator call and let its store write land. */
  readonly settleOperator: (level: DirLevel) => Promise<void>
  /** Paths of operator calls not yet settled, oldest first. */
  readonly outstandingOperator: () => readonly string[]
  /**
   * Settle the oldest outstanding call and let its store write land.
   * @param result - what the endpoint answers.
   */
  readonly settle: (result: RemoteResult<DirLevel>) => Promise<void>
  /**
   * Settle the newest outstanding call first, so an older one can arrive after it.
   * @param result - what the endpoint answers.
   */
  readonly settleLatest: (result: RemoteResult<DirLevel>) => Promise<void>
  /** Paths of calls not yet settled, oldest first. */
  readonly outstanding: () => readonly string[]
  /** Wait for a specific invocation, independently of its response. */
  readonly waitForList: (index: number) => Promise<PendingList>
  /** Settle outstanding reads and await every watch release after the owner aborts. */
  readonly dispose: () => Promise<void>
}

/** One listing awaiting the spec's answer. */
export interface PendingList {
  readonly sessionId: SessionId
  readonly path: string
  readonly signal: AbortSignal
  readonly result: Promise<RemoteResult<DirLevel>>
  resolve(result: RemoteResult<DirLevel>): void
}

/**
 * Build a listing whose every call stays pending until the spec settles it.
 * @returns the scripted listing and watch controls.
 */
export function scriptedList(): ScriptedList {
  const pending: PendingList[] = []
  const calls: PendingList[] = []
  const waiters = new Map<number, (call: PendingList) => void>()
  const watches = new DirectoryWatches()
  const list = vi.fn<ListWorkspaceDirectory>((sessionId, path, signal) => {
    const result = Promise.withResolvers<RemoteResult<DirLevel>>()
    const call = { sessionId, path, signal, result: result.promise, resolve: result.resolve }
    pending.push(call)
    const index = calls.push(call) - 1
    waiters.get(index)?.(call)
    waiters.delete(index)
    return result.promise
  })
  const operatorPending: Array<{
    sessionId: SessionId
    path: string
    signal: AbortSignal
    result: Promise<DirLevel>
    resolve: (level: DirLevel) => void
  }> = []
  const operatorList = vi.fn<ListOperatorDirectory>((sessionId, path, signal) => {
    const result = Promise.withResolvers<DirLevel>()
    operatorPending.push({ sessionId, path, signal, result: result.promise, resolve: result.resolve })
    return result.promise
  })
  const settleOperator = async (level: DirLevel): Promise<void> => {
    const call = operatorPending.shift()
    if (call === undefined) throw new Error('no outstanding operator listing to settle')
    call.resolve(level)
    await call.result
  }
  const land = async (call: PendingList | undefined, result: RemoteResult<DirLevel>): Promise<void> => {
    if (call === undefined) throw new Error('no outstanding listing to settle')
    call.resolve(result)
    await call.result
  }
  return {
    watch: watches.watch,
    watches,
    list,
    operatorList,
    settleOperator,
    outstandingOperator: () => operatorPending.map(call => call.path),
    settle: result => land(pending.shift(), result),
    settleLatest: result => land(pending.pop(), result),
    outstanding: () => pending.map(call => call.path),
    waitForList: (index) => {
      const call = calls[index]
      if (call !== undefined) return Promise.resolve(call)
      return new Promise((resolve) => { waiters.set(index, resolve) })
    },
    dispose: async () => {
      for (const call of pending.splice(0)) {
        call.resolve({ ok: false, error: new RemoteError('gateway/internal', 'fixture closed', {}) })
      }
      const operatorResults = operatorPending.splice(0).map((call) => {
        call.resolve({ entries: [], truncated: false })
        return call.result
      })
      await Promise.all([watches.dispose(), ...calls.map(call => call.result), ...operatorResults])
      waiters.clear()
    },
  }
}
