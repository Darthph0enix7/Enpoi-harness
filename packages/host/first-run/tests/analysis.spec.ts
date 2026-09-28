import { describe, expect, it, vi } from 'vitest'
import { createAnalysisRunner, handleRequest, type AnalysisDependencies } from '../src/analysis.ts'
import type { SystemScanResult } from '../src/scan.ts'

const RESULT: SystemScanResult = {
  summary: { threads: 8, memoryGiB: 16, services: 4 },
  markdown: '# System context\n',
}

/** Dependency set with an instantly settling scan. */
function dependencies(overrides: Partial<AnalysisDependencies> = {}): AnalysisDependencies {
  return {
    scan: async (onStage) => { onStage('hardware'); onStage('writing context'); return RESULT },
    write: () => '/tmp/system-context.md',
    read: () => null,
    now: () => 1_000,
    ...overrides,
  }
}

/** Settle the runner's fire-and-forget run. */
async function settled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('system analysis runner', () => {
  it('runs in the background, advances stages, and lands the context', async () => {
    const write = vi.fn(() => '/tmp/system-context.md')
    const runner = createAnalysisRunner(dependencies({ write }))
    expect(runner.status().state).toBe('idle')
    const started = runner.start()
    expect(started.state).toBe('running')
    expect(started.startedAt).toBe(1_000)
    await settled()
    const done = runner.status()
    expect(done.state).toBe('succeeded')
    expect(done.summary).toEqual({ threads: 8, memoryGiB: 16, services: 4 })
    expect(done.contextPath).toBe('/tmp/system-context.md')
    expect(done.pct).toBe(100)
    expect(write).toHaveBeenCalledWith(RESULT.markdown)
  })

  it('keeps a settled run when start is called again', async () => {
    const scan = vi.fn(dependencies().scan)
    const runner = createAnalysisRunner(dependencies({ scan }))
    runner.start()
    await settled()
    runner.start()
    await settled()
    expect(scan).toHaveBeenCalledTimes(1)
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

  it('answers start, status, and context over the route', () => {
    const runner = createAnalysisRunner(dependencies({ read: () => 'scan text' }))
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
    expect(reply('/system-analysis/unknown')).toMatchObject({ status: 404, body: { ok: false } })
  })
})
