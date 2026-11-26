// @vitest-environment jsdom
/**
 * Server-backed surface sync: single-flight serialization, conditional
 * `expectedRevision` conflict resolution (adopt vs rebase), and older-server
 * compatibility.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSurfacePersistence, createSidebarRightStore, type SurfaceState } from '../src/client/stores.ts'
import { SurfaceStorage, type SurfaceEnvelope } from '../src/client/surface-storage.ts'

const SESSION = 'session-surface-sync'
const isKnownKind = (kind: string) => kind === 'guide' || kind === 'text'

function makePersistedEnvelope(
  sessionId: string,
  configure: (
    actions: ReturnType<typeof createSidebarRightStore>['create'] extends (k?: string) => infer I
      ? I extends { actions: infer A } ? A : never
      : never,
  ) => void,
  updatedAt = 10,
): SurfaceEnvelope {
  const storage = new Map<string, string>()
  const fake: Storage = {
    get length() { return storage.size },
    clear: () => { storage.clear() },
    getItem: key => storage.get(key) ?? null,
    key: index => [...storage.keys()][index] ?? null,
    removeItem: (key) => { storage.delete(key) },
    setItem: (key, value) => { storage.set(key, value) },
  }
  const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' }))
  const inst = handle.create()
  configure(inst.actions)
  const surface = inst.getSnapshot().bySession[sessionId]!
  const env = new SurfaceStorage(isKnownKind, fake).write(sessionId, surface, {})
  return { value: env.value, updatedAt }
}

function surfaceTitles(surface: SurfaceState | undefined): string[] {
  if (surface === undefined) return []
  return Object.values(surface.layout.tabs).map(tab => tab.title)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('bindSurfaceSync', () => {
  it('serializes pushes per binding and never lets a stale write overwrite a newer one', async () => {
    const putResolvers: Array<(value: unknown) => void> = []
    const sentPatches: Array<{ surface?: SurfaceEnvelope; expectedRevision?: number }> = []
    let inFlight = 0
    let maxInFlight = 0

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
        method: string
        payload: { args: { patch?: { surface?: SurfaceEnvelope; expectedRevision?: number } } }
      }
      if (body.method === 'enpoiUiState.get') {
        return {
          ok: true,
          json: async () => ({ result: { ok: true, value: { updatedAt: 0, revision: 1 } } }),
        }
      }
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      sentPatches.push(body.payload.args.patch ?? {})
      const value = await new Promise<unknown>((resolve) => { putResolvers.push(resolve) })
      inFlight -= 1
      return { ok: true, json: async () => ({ result: { ok: true, value } }) }
    }))

    const persistence = new SurfaceStorage(isKnownKind)
    const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
    const stop = bindSurfacePersistence(instance, SESSION, persistence)

    try {
      await vi.waitFor(() => {
        // Wait for initial get to complete.
        expect(fetch).toHaveBeenCalledTimes(1)
      })

      // First edit -> after 400ms persist + 1000ms push debounce -> put #1 starts.
      instance.actions.openContent(SESSION, { kind: 'text', contentId: 'file:a', title: 'first.txt' }, () => {})
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(1) }, { timeout: 3_000 })
      expect(sentPatches[0]!.expectedRevision).toBe(1)

      // Second edit arrives while put #1 is still in flight; even after debounce
      // expires, put #2 must NOT start until put #1 settles.
      instance.actions.openContent(SESSION, { kind: 'text', contentId: 'file:b', title: 'second.txt' }, () => {})
      await new Promise(resolve => setTimeout(resolve, 1_550))
      expect(sentPatches).toHaveLength(1)
      expect(maxInFlight).toBe(1)

      // Settle put #1 -> put #2 launches immediately with expectedRevision: 2.
      putResolvers[0]!({ ok: true, updatedAt: 20, revision: 2 })
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(2) }, { timeout: 2_000 })
      expect(sentPatches[1]!.expectedRevision).toBe(2)
      const pushedValue = sentPatches[1]!.surface!.value as { layout: { tabs: Record<string, { title: string }> } }
      expect(Object.values(pushedValue.layout.tabs).map(tab => tab.title)).toEqual(['first.txt', 'second.txt'])
      putResolvers[1]!({ ok: true, updatedAt: 30, revision: 3 })
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      stop()
    }
  })

  it('adopts the winning surface on conflict only when server revision is newer and local state has no unsaved edit', async () => {
    const baseEnv = makePersistedEnvelope(SESSION, (actions) => {
      actions.openContent(SESSION, { kind: 'text', contentId: 'file:base', title: 'base.txt' }, () => {})
    }, 10)
    const winnerEnv = makePersistedEnvelope(SESSION, (actions) => {
      actions.openContent(SESSION, { kind: 'text', contentId: 'file:winner', title: 'winner.txt' }, () => {})
    }, 40)

    const sentPatches: Array<{ surface?: SurfaceEnvelope; expectedRevision?: number }> = []
    let putCount = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
        method: string
        payload: { args: { patch?: { surface?: SurfaceEnvelope; expectedRevision?: number } } }
      }
      if (body.method === 'enpoiUiState.get') {
        return {
          ok: true,
          json: async () => ({
            result: { ok: true, value: { updatedAt: 10, revision: 3, surface: baseEnv } },
          }),
        }
      }
      putCount += 1
      sentPatches.push(body.payload.args.patch ?? {})
      if (putCount === 1) {
        // Stale revision <= expectedRevision (3) MUST NOT be adopted; retries once or stays local.
        return {
          ok: true,
          json: async () => ({
            result: {
              ok: true,
              value: {
                ok: false,
                conflict: true,
                updatedAt: 5,
                revision: 2,
                record: { updatedAt: 5, revision: 2, surface: winnerEnv },
              },
            },
          }),
        }
      }
      // Second push hits a genuinely newer server winner at revision 5 -> adopts winner.
      return {
        ok: true,
        json: async () => ({
          result: {
            ok: true,
            value: {
              ok: false,
              conflict: true,
              updatedAt: 40,
              revision: 5,
              record: { updatedAt: 40, revision: 5, surface: winnerEnv },
            },
          },
        }),
      }
    }))

    const persistence = new SurfaceStorage(isKnownKind)
    const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
    const stop = bindSurfacePersistence(instance, SESSION, persistence)

    try {
      await vi.waitFor(() => {
        expect(surfaceTitles(instance.getSnapshot().bySession[SESSION])).toEqual(['base.txt'])
      })

      // Edit 1 conflicts with stale rev 2 -> NOT adopted.
      instance.actions.openContent(SESSION, { kind: 'text', contentId: 'file:local1', title: 'local1.txt' }, () => {})
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(1) }, { timeout: 3_000 })
      expect(sentPatches[0]!.expectedRevision).toBe(3)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(surfaceTitles(instance.getSnapshot().bySession[SESSION])).toEqual(['base.txt', 'local1.txt'])

      // Edit 2 conflicts with newer rev 5 -> adopts winner.txt.
      instance.actions.openContent(SESSION, { kind: 'text', contentId: 'file:local2', title: 'local2.txt' }, () => {})
      await vi.waitFor(() => {
        expect(surfaceTitles(instance.getSnapshot().bySession[SESSION])).toEqual(['winner.txt'])
      }, { timeout: 3_000 })
      expect(sentPatches).toHaveLength(2)
      expect(persistence.read(SESSION)?.surface.layout.tabs).toBeDefined()
    } finally {
      stop()
    }
  })

  it('rebases and retries once on a non-surface conflict or when a newer local edit is in flight', async () => {
    const baseEnv = makePersistedEnvelope(SESSION, (actions) => {
      actions.openContent(SESSION, { kind: 'text', contentId: 'file:base', title: 'base.txt' }, () => {})
    }, 10)
    const otherEnv = makePersistedEnvelope(SESSION, (actions) => {
      actions.openContent(SESSION, { kind: 'text', contentId: 'file:other', title: 'other.txt' }, () => {})
    }, 25)

    const putResolvers: Array<(value: unknown) => void> = []
    const sentPatches: Array<{ surface?: SurfaceEnvelope; expectedRevision?: number }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
        method: string
        payload: { args: { patch?: { surface?: SurfaceEnvelope; expectedRevision?: number } } }
      }
      if (body.method === 'enpoiUiState.get') {
        return {
          ok: true,
          json: async () => ({
            result: { ok: true, value: { updatedAt: 10, revision: 1, surface: baseEnv } },
          }),
        }
      }
      sentPatches.push(body.payload.args.patch ?? {})
      const value = await new Promise<unknown>((resolve) => { putResolvers.push(resolve) })
      return { ok: true, json: async () => ({ result: { ok: true, value } }) }
    }))

    const persistence = new SurfaceStorage(isKnownKind)
    const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
    const stop = bindSurfacePersistence(instance, SESSION, persistence)

    try {
      await vi.waitFor(() => {
        expect(surfaceTitles(instance.getSnapshot().bySession[SESSION])).toEqual(['base.txt'])
      })

      // Case 1: Non-surface revision bump (e.g. draft write bumped rev 1 -> 2, surface still baseEnv).
      instance.actions.openContent(SESSION, { kind: 'text', contentId: 'file:local', title: 'local.txt' }, () => {})
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(1) }, { timeout: 3_000 })
      expect(sentPatches[0]!.expectedRevision).toBe(1)

      putResolvers[0]!({
        ok: false,
        conflict: true,
        updatedAt: 20,
        revision: 2,
        record: { updatedAt: 20, revision: 2, surface: baseEnv },
      })
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(2) }, { timeout: 2_000 })
      expect(sentPatches[1]!.expectedRevision).toBe(2)

      // Even if the retry ALSO conflicts with unchanged surface (same rev bump 3), it retries at most ONCE.
      putResolvers[1]!({
        ok: false,
        conflict: true,
        updatedAt: 21,
        revision: 3,
        record: { updatedAt: 21, revision: 3, surface: baseEnv },
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(sentPatches).toHaveLength(2)
      expect(surfaceTitles(instance.getSnapshot().bySession[SESSION])).toEqual(['base.txt', 'local.txt'])

      // Case 2: Local edit arrives while put #3 is in flight -> conflict with otherEnv
      // must not drop local edit; rebases to rev 4 and pushes newer local state.
      instance.actions.openContent(SESSION, { kind: 'text', contentId: 'file:edit3', title: 'edit3.txt' }, () => {})
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(3) }, { timeout: 3_000 })
      expect(sentPatches[2]!.expectedRevision).toBe(3)

      // Make another local edit right before put #3 settles with conflict (400ms persist timer hasn't even fired yet!).
      instance.actions.openContent(SESSION, { kind: 'text', contentId: 'file:edit4', title: 'edit4.txt' }, () => {})
      putResolvers[2]!({
        ok: false,
        conflict: true,
        updatedAt: 25,
        revision: 4,
        record: { updatedAt: 25, revision: 4, surface: otherEnv },
      })
      // Must NOT adopt otherEnv over edit4.txt; wait for persist+push debounce to send edit4 with expectedRevision: 4.
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(4) }, { timeout: 3_000 })
      expect(sentPatches[3]!.expectedRevision).toBe(4)
      expect(surfaceTitles(instance.getSnapshot().bySession[SESSION])).toEqual(['base.txt', 'local.txt', 'edit3.txt', 'edit4.txt'])
      putResolvers[3]!({ ok: true, updatedAt: 30, revision: 5 })
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      stop()
    }
  })

  it('keeps older servers without revision working with timestamp-ordered adoption and puts', async () => {
    const remoteEnv = makePersistedEnvelope(SESSION, (actions) => {
      actions.openContent(SESSION, { kind: 'text', contentId: 'file:old', title: 'older-server.txt' }, () => {})
    }, 50)
    const sentPatches: Array<{ surface?: SurfaceEnvelope; expectedRevision?: number }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
        method: string
        payload: { args: { patch?: { surface?: SurfaceEnvelope; expectedRevision?: number } } }
      }
      if (body.method === 'enpoiUiState.get') {
        return {
          ok: true,
          json: async () => ({ result: { ok: true, value: { updatedAt: 50, surface: remoteEnv } } }),
        }
      }
      sentPatches.push(body.payload.args.patch ?? {})
      return { ok: true, json: async () => ({ result: { ok: true, value: { updatedAt: 100 } } }) }
    }))

    const persistence = new SurfaceStorage(isKnownKind)
    const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
    const stop = bindSurfacePersistence(instance, SESSION, persistence)

    try {
      await vi.waitFor(() => {
        expect(surfaceTitles(instance.getSnapshot().bySession[SESSION])).toEqual(['older-server.txt'])
      })
      instance.actions.openContent(SESSION, { kind: 'text', contentId: 'file:new', title: 'local-new.txt' }, () => {})
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(1) }, { timeout: 3_000 })
      expect(sentPatches[0]).not.toHaveProperty('expectedRevision')
    } finally {
      stop()
    }
  })

  it('covers RPC failures, identical-content skips, matching-winner conflicts, legacy minting, and teardown', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const flushMicrotasks = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
    }
    try {
      // 1. Failed initial get (HTTP 500) -> silent local-only, mirror becomes no-op.
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
      const persistence1 = new SurfaceStorage(isKnownKind)
      const inst1 = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
      const stop1 = bindSurfacePersistence(inst1, SESSION, persistence1)
      await flushMicrotasks()
      inst1.actions.openContent(SESSION, { kind: 'text', contentId: 'file:a', title: 'a.txt' }, () => {})
      await vi.advanceTimersByTimeAsync(1_500)
      expect(fetch).toHaveBeenCalledTimes(1)
      stop1()
      stop1() // idempotent

      // 2. Non-object get + RPC error responses on put (with message, without message, thrown Error, thrown string).
      localStorage.clear()
      let putAttempt = 0
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as { method: string }
        if (body.method === 'enpoiUiState.get') {
          return { ok: true, json: async () => ({ result: { ok: true, value: null } }) }
        }
        putAttempt += 1
        if (putAttempt === 1) return { ok: true, json: async () => ({ result: { ok: false, error: { message: 'denied' } } }) }
        if (putAttempt === 2) return { ok: true, json: async () => ({ result: { ok: false } }) }
        if (putAttempt === 3) throw new Error('network down')
        if (putAttempt === 4) throw 'string failure'
        return { ok: true, json: async () => ({ result: { ok: true, value: { ok: true, updatedAt: 10, revision: 1 } } }) }
      }))
      const persistence2 = new SurfaceStorage(isKnownKind)
      const inst2 = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
      const stop2 = bindSurfacePersistence(inst2, SESSION, persistence2)
      await flushMicrotasks()
      for (let i = 1; i <= 5; i += 1) {
        inst2.actions.openContent(SESSION, { kind: 'text', contentId: `file:e${i}`, title: `e${i}.txt` }, () => {})
        await vi.advanceTimersByTimeAsync(1_500)
        expect(putAttempt).toBe(i)
      }
      expect(consoleError).toHaveBeenCalledTimes(1)
      stop2()

      // 3. Legacy stored record without updatedAt (mints timestamp and seeds server),
      // editorTabId, matching-winner conflict, stop with pending timer, and unrelated session.
      localStorage.clear()
      const legacyEnv = makePersistedEnvelope(SESSION, (actions) => {
        actions.openContent(SESSION, { kind: 'text', contentId: 'file:ed', title: 'ed.txt', editor: true }, () => {})
      }, 0)
      localStorage.setItem('dsh.sidebar-right.surfaces.v1', JSON.stringify({
        version: 1,
        sessions: { [SESSION]: { ...(legacyEnv.value as Record<string, unknown>), updatedAt: 0 } },
      }))
      let putCall = 0
      const putResolvers3: Array<(v: unknown) => void> = []
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as { method: string }
        if (body.method === 'enpoiUiState.get') {
          return { ok: true, json: async () => ({ result: { ok: true, value: { revision: 0 } } }) }
        }
        putCall += 1
        const val = await new Promise<unknown>((resolve) => { putResolvers3.push(resolve) })
        return { ok: true, json: async () => ({ result: { ok: true, value: val } }) }
      }))
      const persistence3 = new SurfaceStorage(isKnownKind)
      const inst3 = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
      const stop3 = bindSurfacePersistence(inst3, SESSION, persistence3)
      // Unrelated session change hits current === lastSeenSurface branch.
      inst3.actions.open('other-session')
      await flushMicrotasks()
      expect(putCall).toBe(1)
      // Seeded push resolves with conflict where server already holds the exact same surface.
      putResolvers3[0]!({
        ok: false,
        conflict: true,
        updatedAt: 50,
        revision: 2,
        record: { updatedAt: 50, revision: 2, surface: persistence3.payload(SESSION) },
      })
      await flushMicrotasks()
      // Re-trigger mirror while pushTimer is pending (resets pushTimer) then stop() clears pushTimer.
      inst3.actions.openContent(SESSION, { kind: 'text', contentId: 'file:x1', title: 'x1.txt' }, () => {})
      await vi.advanceTimersByTimeAsync(450)
      inst3.actions.openContent(SESSION, { kind: 'text', contentId: 'file:x2', title: 'x2.txt' }, () => {})
      await vi.advanceTimersByTimeAsync(450)
      stop3()

      // 4. Slow initial get: mirror timer fires while get is still in flight (readComplete === false),
      // then get adopts remote (cancels pending pushTimer if re-armed).
      localStorage.clear()
      let resolveGet!: (v: unknown) => void
      const remoteWin = makePersistedEnvelope(SESSION, (actions) => {
        actions.openContent(SESSION, { kind: 'text', contentId: 'file:rw', title: 'rw.txt' }, () => {})
      }, 999)
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as { method: string }
        if (body.method === 'enpoiUiState.get') {
          const val = await new Promise<unknown>((resolve) => { resolveGet = resolve })
          return { ok: true, json: async () => ({ result: { ok: true, value: val } }) }
        }
        return { ok: true, json: async () => ({ result: { ok: true, value: { ok: true, updatedAt: 1, revision: 1 } } }) }
      }))
      const persistence4 = new SurfaceStorage(isKnownKind)
      const inst4 = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
      const stop4 = bindSurfacePersistence(inst4, SESSION, persistence4)
      inst4.actions.openContent(SESSION, { kind: 'text', contentId: 'file:pre', title: 'pre.txt' }, () => {})
      // Advance past 400ms persist + 1000ms push debounce while get is still pending.
      await vi.advanceTimersByTimeAsync(1_500)
      // Re-arm pushTimer before get resolves.
      inst4.actions.openContent(SESSION, { kind: 'text', contentId: 'file:pre2', title: 'pre2.txt' }, () => {})
      await vi.advanceTimersByTimeAsync(450)
      resolveGet({ updatedAt: Date.now() + 60_000, revision: 4, surface: remoteWin })
      await flushMicrotasks()
      expect(surfaceTitles(inst4.getSnapshot().bySession[SESSION])).toEqual(['rw.txt'])
      stop4()

      // 5. Local stored surface is newer than remote -> keeps local and seeds server;
      // also conflict with undefined expectedRevision; also stopped listener + deleted session.
      localStorage.clear()
      const newerLocal = makePersistedEnvelope(SESSION, (actions) => {
        actions.openContent(SESSION, { kind: 'text', contentId: 'file:nl', title: 'nl.txt' }, () => {})
      }, 5_000)
      const cachedLocal = persistence4.readRemote(newerLocal, 5_000)!
      persistence4.cache(SESSION, { surface: cachedLocal.surface, navigation: {}, updatedAt: 5_000 })
      const olderRemote = makePersistedEnvelope(SESSION, (actions) => {
        actions.openContent(SESSION, { kind: 'text', contentId: 'file:or', title: 'or.txt' }, () => {})
      }, 1_000)
      let put5 = 0
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as { method: string }
        if (body.method === 'enpoiUiState.get') {
          // No revision field on get -> expectedRevision starts undefined.
          return { ok: true, json: async () => ({ result: { ok: true, value: { updatedAt: 1_000, surface: olderRemote } } }) }
        }
        put5 += 1
        return {
          ok: true,
          json: async () => ({
            result: {
              ok: true,
              value: {
                ok: false,
                conflict: true,
                updatedAt: 6_000,
                revision: 2,
                record: { updatedAt: 6_000, revision: 2, surface: remoteWin },
              },
            },
          }),
        }
      }))
      const persistence5 = new SurfaceStorage(isKnownKind)
      const inst5 = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
      const stop5 = bindSurfacePersistence(inst5, SESSION, persistence5)
      await flushMicrotasks()
      expect(put5).toBe(1)
      expect(surfaceTitles(inst5.getSnapshot().bySession[SESSION])).toEqual(['rw.txt'])
      // Deleting session before 400ms timer hits `if (surface !== undefined)` false branch.
      inst5.store.update((draft) => {
        draft.bySession = Object.fromEntries(Object.entries(draft.bySession).filter(([key]) => key !== SESSION))
      })
      await vi.advanceTimersByTimeAsync(450)
      // Stopping from a prior subscriber hits `if (stopped) return` in bindSurfacePersistence's subscriber.
      const inst6 = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
      const stopper = { stop: () => {} }
      const unsubFirst = inst6.store.subscribe(() => { stopper.stop() })
      stopper.stop = bindSurfacePersistence(inst6, SESSION, persistence5)
      inst6.actions.open(SESSION)
      unsubFirst()
      stop5()
    } finally {
      vi.useRealTimers()
      consoleError.mockRestore()
    }
  })

  it('skips duplicate serialized push and handles conflict without record or with pending queued edit', async () => {
    vi.useFakeTimers()
    const flushMicrotasks = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
    }
    const remoteBase = makePersistedEnvelope(SESSION, (actions) => {
      actions.openContent(SESSION, { kind: 'text', contentId: 'file:b', title: 'b.txt' }, () => {})
    }, 10)
    const putResolvers: Array<(v: unknown) => void> = []
    const sentPatches: Array<{ surface?: SurfaceEnvelope; expectedRevision?: number }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
        method: string
        payload: { args: { patch?: { surface?: SurfaceEnvelope; expectedRevision?: number } } }
      }
      if (body.method === 'enpoiUiState.get') {
        return { ok: true, json: async () => ({ result: { ok: true, value: { updatedAt: 10, revision: 1, surface: remoteBase } } }) }
      }
      sentPatches.push(body.payload.args.patch ?? {})
      const val = await new Promise<unknown>((resolve) => { putResolvers.push(resolve) })
      return { ok: true, json: async () => ({ result: { ok: true, value: val } }) }
    }))

    const persistence = new SurfaceStorage(isKnownKind)
    const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' })).create()
    const stop = bindSurfacePersistence(instance, SESSION, persistence)
    try {
      await flushMicrotasks()
      expect(surfaceTitles(instance.getSnapshot().bySession[SESSION])).toEqual(['b.txt'])

      // Wait for adoption's own persist+push debounce to run -> skipped as identical to lastPushedJson.
      await vi.advanceTimersByTimeAsync(1_500)
      expect(sentPatches).toHaveLength(0)

      // Local edit -> put #1 starts.
      instance.actions.openContent(SESSION, { kind: 'text', contentId: 'file:c', title: 'c.txt' }, () => {})
      await vi.advanceTimersByTimeAsync(1_500)
      expect(sentPatches).toHaveLength(1)

      // While put #1 is in flight, user edits and its timers finish so pending !== undefined && pushTimer === undefined.
      instance.actions.openContent(SESSION, { kind: 'text', contentId: 'file:d', title: 'd.txt' }, () => {})
      await vi.advanceTimersByTimeAsync(1_500)
      expect(sentPatches).toHaveLength(1)

      // Settle put #1 with conflict that has NO record -> pending ('d.txt') flushes immediately!
      putResolvers[0]!({ ok: false, conflict: true, updatedAt: 20, revision: 2 })
      await flushMicrotasks()
      expect(sentPatches).toHaveLength(2)
      expect(sentPatches[1]!.expectedRevision).toBe(2)

      // Stop while put #2 is in flight -> settling after stop is a no-op.
      stop()
      putResolvers[1]!({ ok: true, updatedAt: 30, revision: 3 })
      await flushMicrotasks()
    } finally {
      vi.useRealTimers()
      stop()
    }
  })
})
