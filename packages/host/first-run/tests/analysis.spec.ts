import { describe, expect, it, vi } from 'vitest'
import { createAnalysisRunner, handleRequest, stagePct, type AnalysisDependencies } from '../src/analysis.ts'
import type { SystemScanResult } from '../src/scan.ts'

const RESULT: SystemScanResult = {
  summary: { threads: 8, memoryGiB: 16, services: 4 },
  facts: {
    scannedAt: '2026-09-29T00:00:00.000Z',
    hostname: 'test-host',
    hardware: { cpu: 'Test CPU', threads: 8, memoryGiB: 16 },
    os: { type: 'Linux', release: '6.8', platform: 'linux', arch: 'x64', distribution: 'Test OS' },
    services: { system: 4, user: 0, names: ['a.service'] },
    tooling: [{ name: 'docker', version: '29.1.3' }],
    hosting: { containers: 2, containerNames: ['one', 'two'], listeningPorts: [3000], composeProjects: ['stack'] },
    disk: [{ path: '/', freeGiB: 30, totalGiB: 232 }],
    gpu: null,
  },
}

/** Dependency set with an instantly settling scan and summariser. */
function dependencies(overrides: Partial<AnalysisDependencies> = {}): AnalysisDependencies {
  return {
    scan: async (onStage) => {
      for (const stage of ['hardware', 'operating system', 'services', 'tooling', 'hosting', 'disk', 'GPU'] as const) onStage(stage)
      return RESULT
    },
    summarise: async () => '## Capabilities\n- test machine',
    writeProfile: () => '/tmp/system-profile.md',
    writeScan: () => '/tmp/system-profile.scan.json',
    readProfile: () => null,
    removeProfile: () => {},
    readDecision: () => null,
    writeDecision: () => {},
    route: 'kilo/kilo-auto/free',
    now: () => 1_000,
    ...overrides,
  }
}

/** Settle the runner's fire-and-forget run. */
async function settled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('system analysis runner', () => {
  it('runs in the background, advances every stage, and lands the profile', async () => {
    const writeProfile = vi.fn((_markdown: string) => '/tmp/system-profile.md')
    const writeScan = vi.fn(() => '/tmp/system-profile.scan.json')
    const runner = createAnalysisRunner(dependencies({ writeProfile, writeScan }))
    expect(runner.status().state).toBe('idle')
    const started = runner.start()
    expect(started.state).toBe('running')
    expect(started.startedAt).toBe(1_000)
    expect(started.stageCount).toBe(9)
    await settled()
    const done = runner.status()
    expect(done.state).toBe('succeeded')
    expect(done.summary).toEqual({ threads: 8, memoryGiB: 16, services: 4 })
    expect(done.contextPath).toBe('/tmp/system-profile.md')
    expect(done.pct).toBe(100)
    expect(writeScan).toHaveBeenCalledWith(JSON.stringify(RESULT.facts, null, 2))
    const document = writeProfile.mock.calls[0]?.[0] ?? ''
    expect(document).toContain('# System profile')
    expect(document).toContain('1970-01-01T00:00:01.000Z')
    expect(document).toContain('kilo/kilo-auto/free')
    expect(document).toContain('## Capabilities')
  })

  it('derives one stage position into a bounded percentage', () => {
    expect(stagePct(0, 9)).toBe(0)
    expect(stagePct(8, 9)).toBe(89)
    expect(stagePct(100, 9)).toBe(89)
    expect(stagePct(-3, 9)).toBe(0)
    expect(stagePct(3, 0)).toBe(0)
  })

  it('publishes non-decreasing percentages inside 0 to 100 for a whole run', async () => {
    const samples: Array<{ stage: string; stageIndex: number; pct: number }> = []
    const record = (): void => {
      const current = runner.status()
      samples.push({ stage: current.stage, stageIndex: current.stageIndex, pct: current.pct })
    }
    const runner = createAnalysisRunner(dependencies({
      scan: async (onStage) => {
        for (const stage of ['hardware', 'operating system', 'services', 'tooling', 'hosting', 'disk', 'GPU'] as const) {
          onStage(stage)
          record()
        }
        return RESULT
      },
      summarise: async () => {
        record()
        return '## Capabilities\n- test machine'
      },
      writeProfile: () => {
        record()
        return '/tmp/system-profile.md'
      },
    }))
    runner.start()
    await settled()
    expect(samples.map(sample => sample.pct)).toEqual([0, 11, 22, 33, 44, 56, 67, 78, 89])
    expect(samples.map(sample => sample.stage)).toEqual([
      'hardware', 'operating system', 'services', 'tooling', 'hosting', 'disk', 'GPU', 'summarising', 'writing profile',
    ])
    for (const sample of samples) {
      expect(sample.pct).toBeGreaterThanOrEqual(0)
      expect(sample.pct).toBeLessThanOrEqual(100)
      expect(sample.stageIndex).toBeGreaterThanOrEqual(0)
      expect(sample.stageIndex).toBeLessThanOrEqual(9)
    }
    expect(runner.status().pct).toBe(100)
  })

  it('keeps a settled run when start is called again', async () => {
    const scan = vi.fn(dependencies().scan)
    const runner = createAnalysisRunner(dependencies({ scan, readProfile: () => '# System profile\n' }))
    runner.start()
    await settled()
    runner.start()
    await settled()
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('restarts a settled run whose document was removed', async () => {
    const scan = vi.fn(dependencies().scan)
    let stored: string | null = '# System profile\n'
    const runner = createAnalysisRunner(dependencies({ scan, readProfile: () => stored }))
    runner.start()
    await settled()
    expect(scan).toHaveBeenCalledTimes(1)
    stored = null
    expect(runner.start().state).toBe('running')
    await settled()
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('reports a failed scan without throwing', async () => {
    const runner = createAnalysisRunner(dependencies({ scan: async () => { throw new Error('no probes') } }))
    runner.start()
    await settled()
    const failed = runner.status()
    expect(failed.state).toBe('failed')
    expect(failed.error).toBe('no probes')
    expect(runner.context()).toBeNull()
  })

  it('reports a failed summariser with its reason', async () => {
    const runner = createAnalysisRunner(dependencies({ summarise: async () => { throw new Error('route refused') } }))
    runner.start()
    await settled()
    expect(runner.status()).toMatchObject({ state: 'failed', error: 'route refused' })
  })

  it('accepts by recording the decision and rejecting by removing the document', async () => {
    let decision: 'accepted' | 'rejected' | null = null
    const writeDecision = vi.fn((next: 'accepted' | 'rejected') => { decision = next })
    const removeProfile = vi.fn()
    let stored: string | null = '# System profile\n'
    const runner = createAnalysisRunner(dependencies({
      writeDecision,
      removeProfile: () => { removeProfile(); stored = null },
      readProfile: () => stored,
      readDecision: () => decision,
    }))
    expect(runner.status().hasProfile).toBe(true)
    expect(runner.accept()).toMatchObject({ decision: 'accepted' })
    expect(writeDecision).toHaveBeenCalledWith('accepted')
    expect(runner.reject()).toMatchObject({ decision: 'rejected', hasProfile: false })
    expect(removeProfile).toHaveBeenCalledTimes(1)
    expect(writeDecision).toHaveBeenLastCalledWith('rejected')
  })

  it('answers start, status, context, accept, reject, and unknown paths over the route', () => {
    let decision: 'accepted' | 'rejected' | null = null
    const runner = createAnalysisRunner(dependencies({
      readProfile: () => 'scan text',
      readDecision: () => decision,
      writeDecision: (next) => { decision = next },
    }))
    const reply = (url: string): { status: number; body: unknown } => {
      let status = 0
      let body = ''
      const res = {
        setHeader: () => {},
        end: (chunk: string) => { body = chunk },
        set statusCode(value: number) { status = value },
        get statusCode() { return status },
      }
      handleRequest(runner, { url } as never, res as never)
      return { status, body: JSON.parse(body) }
    }
    expect(reply('/system-analysis/status')).toMatchObject({ status: 200, body: { ok: true, job: { state: 'idle' } } })
    expect(reply('/system-analysis/start')).toMatchObject({ status: 200, body: { ok: true, job: { state: 'running' } } })
    expect(reply('/system-analysis/context')).toMatchObject({ status: 200, body: { ok: true, text: 'scan text' } })
    expect(reply('/system-analysis/accept')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'accepted' } } })
    expect(reply('/system-analysis/reject')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'rejected' } } })
    expect(reply('/system-analysis/unknown')).toMatchObject({ status: 404, body: { ok: false } })
  })
})
