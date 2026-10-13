import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CatalogEntry } from '../src/catalog.js'
import { jitteredDelay, startUpdateCheckSchedule, UpdateCheckCore } from '../src/service.js'

function entry(version: string, notes: string[] = ['note']): CatalogEntry {
  return { version, commit: 'abc1234', releasedAt: '2026-10-13T12:00:00.000Z', notes }
}

interface Harness {
  core: UpdateCheckCore
  fetchCatalog: ReturnType<typeof vi.fn>
  writeDismissed: ReturnType<typeof vi.fn>
  onFailure: ReturnType<typeof vi.fn>
  dismissedVersion: () => string | null
  setDismissed: (version: string | null) => void
}

function harness(options: {
  version?: string
  channel?: string
  commit?: string
  entries?: CatalogEntry[]
  fetchError?: Error
} = {}): Harness {
  let dismissed: string | null = null
  const fetchCatalog = vi.fn(async () => {
    if (options.fetchError !== undefined) throw options.fetchError
    return options.entries ?? [entry('0.1.7-enpoi.2.84')]
  })
  const writeDismissed = vi.fn((version: string) => { dismissed = version })
  const onFailure = vi.fn()
  const core = new UpdateCheckCore({
    identity: {
      channel: options.channel ?? 'stable',
      version: options.version ?? '0.1.7-enpoi.2.42',
      commit: options.commit ?? 'abc1234',
    },
    fetchCatalog,
    readDismissed: () => dismissed,
    writeDismissed,
    now: () => new Date('2026-10-13T12:00:00.000Z'),
    onFailure,
  })
  return {
    core,
    fetchCatalog,
    writeDismissed,
    onFailure,
    dismissedVersion: () => dismissed,
    setDismissed: (version: string | null) => { dismissed = version },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('UpdateCheckCore', () => {
  it('starts unknown and offers the install identity', () => {
    const { core } = harness()
    expect(core.snapshot()).toEqual({
      state: 'unknown',
      current: { version: '0.1.7-enpoi.2.42', commit: 'abc1234', channel: 'stable' },
    })
  })

  it('finds an available update with the newest entry notes', async () => {
    const { core } = harness({ entries: [entry('0.1.7-enpoi.2.84', ['feat: a', 'fix: b'])] })
    const status = await core.checkNow()
    expect(status.state).toBe('available')
    expect(status.latest).toEqual({
      version: '0.1.7-enpoi.2.84',
      commit: 'abc1234',
      releasedAt: '2026-10-13T12:00:00.000Z',
      notes: ['feat: a', 'fix: b'],
    })
    expect(status.checkedAt).toBe('2026-10-13T12:00:00.000Z')
    expect(status.error).toBeUndefined()
  })

  it('reports current when the install is at or ahead of the catalog', async () => {
    const { core } = harness({ version: '0.1.7-enpoi.2.84' })
    expect((await core.checkNow()).state).toBe('current')
    const ahead = harness({ version: '0.1.7-enpoi.2.85' })
    expect((await ahead.core.checkNow()).state).toBe('current')
  })

  it('stays unknown with an error when the fetch is offline, logging one failure', async () => {
    const { core, onFailure } = harness({ fetchError: new Error('offline') })
    const status = await core.checkNow()
    expect(status.state).toBe('unknown')
    expect(status.error).toContain('offline')
    expect(status.latest).toBeUndefined()
    expect(onFailure).toHaveBeenCalledTimes(1)
  })

  it('stays unknown when the catalog is malformed', async () => {
    const { core } = harness({ fetchError: new Error('catalog fetch failed: malformed document') })
    const status = await core.checkNow()
    expect(status.state).toBe('unknown')
    expect(status.error).toContain('malformed')
  })

  it('keeps the last successful comparison when a later check fails', async () => {
    let failing = false
    const fetchCatalog = vi.fn(async () => {
      if (failing) throw new Error('offline')
      return [entry('0.1.7-enpoi.2.84')]
    })
    const core = new UpdateCheckCore({
      identity: { channel: 'stable', version: '0.1.7-enpoi.2.42', commit: 'abc1234' },
      fetchCatalog,
      readDismissed: () => null,
      writeDismissed: () => {},
      now: () => new Date('2026-10-13T12:00:00.000Z'),
    })
    expect((await core.checkNow()).state).toBe('available')
    failing = true
    const status = await core.checkNow()
    expect(status.state).toBe('available')
    expect(status.error).toContain('offline')
  })

  it('stays unknown with an error for an empty catalog or an uncomparable version', async () => {
    const empty = harness({ entries: [] })
    const emptyStatus = await empty.core.checkNow()
    expect(emptyStatus.state).toBe('unknown')
    expect(emptyStatus.error).toContain('no releases')

    const uncomparable = harness({ version: '' })
    const uncomparableStatus = await uncomparable.core.checkNow()
    expect(uncomparableStatus.state).toBe('unknown')
    expect(uncomparableStatus.error).toContain('uncomparable')
  })

  it('dismisses the offered version and re-arms on a newer one', async () => {
    const first = harness({ entries: [entry('0.1.7-enpoi.2.84')] })
    expect((await first.core.checkNow()).state).toBe('available')
    const dismissed = first.core.dismiss('0.1.7-enpoi.2.84')
    expect(dismissed.state).toBe('dismissed')
    expect(first.writeDismissed).toHaveBeenCalledWith('0.1.7-enpoi.2.84')

    let catalog = [entry('0.1.7-enpoi.2.84')]
    const fetchCatalog = vi.fn(async () => catalog)
    const core = new UpdateCheckCore({
      identity: { channel: 'stable', version: '0.1.7-enpoi.2.42', commit: 'abc1234' },
      fetchCatalog,
      readDismissed: () => '0.1.7-enpoi.2.84',
      writeDismissed: () => {},
      now: () => new Date('2026-10-13T12:00:00.000Z'),
    })
    expect((await core.checkNow()).state).toBe('dismissed')
    catalog = [entry('0.1.7-enpoi.2.85')]
    expect((await core.checkNow()).state).toBe('available')
  })

  it('persists a skip without changing a non-matching available state', async () => {
    const { core } = harness({ entries: [entry('0.1.7-enpoi.2.84')] })
    await core.checkNow()
    const status = core.dismiss('0.1.7-enpoi.2.90')
    expect(status.state).toBe('available')
  })

  it('shares one fetch between concurrent checkNow calls', async () => {
    let resolveFetch: ((entries: CatalogEntry[]) => void) | undefined
    const fetchCatalog = vi.fn(() => new Promise<CatalogEntry[]>((resolve) => { resolveFetch = resolve }))
    const core = new UpdateCheckCore({
      identity: { channel: 'stable', version: '0.1.7-enpoi.2.42', commit: 'abc1234' },
      fetchCatalog,
      readDismissed: () => null,
      writeDismissed: () => {},
    })
    const first = core.checkNow()
    const second = core.checkNow()
    resolveFetch?.([entry('0.1.7-enpoi.2.84')])
    const [a, b] = await Promise.all([first, second])
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    expect(a.state).toBe('available')
    expect(b.state).toBe('available')
  })

  it('returns a fresh snapshot object each call', async () => {
    const { core } = harness()
    await core.checkNow()
    const first = core.snapshot()
    first.latest?.notes.push('mutated')
    expect(core.snapshot().latest?.notes).toEqual(['note'])
  })
})

describe('startUpdateCheckSchedule', () => {
  it('runs the jittered boot check, then the jittered interval, and stops cleanly', () => {
    vi.useFakeTimers()
    const runs: number[] = []
    const stop = startUpdateCheckSchedule({
      run: () => { runs.push(Date.now()) },
      intervalMs: 3_600_000,
      jitterMs: 300_000,
      firstDelayMs: 30_000,
      random: () => 0.5,
    })
    vi.advanceTimersByTime(30_000 + 150_000 - 1)
    expect(runs).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(runs).toHaveLength(1)
    vi.advanceTimersByTime(3_600_000 + 150_000)
    expect(runs).toHaveLength(2)
    stop()
    vi.advanceTimersByTime(24 * 3_600_000)
    expect(runs).toHaveLength(2)
  })

  it('keeps jittered delays inside the configured bounds', () => {
    expect(jitteredDelay(30_000, 300_000, () => 0)).toBe(30_000)
    expect(jitteredDelay(30_000, 300_000, () => 0.999999)).toBe(329_999)
    expect(jitteredDelay(30_000, 0, () => 0.5)).toBe(30_000)
    expect(jitteredDelay(30_000, -5, () => 0.5)).toBe(30_000)
  })
})
