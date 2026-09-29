import { describe, expect, it, vi } from 'vitest'
import {
  ANALYSIS_STAGES, Config, createAnalysisRunner, handleRequest, stagePct,
  type AnalysisDependencies, type AnalysisRunner,
} from '../src/analysis.ts'
import type { InvestigationOutcome } from '../src/investigation.ts'

describe('analysis plugin config', () => {
  it('defaults the investigation session to the shipped system-analysis permission preset', () => {
    expect(Config({})).toMatchObject({ permissionPreset: 'system-analysis' })
  })
})

const OUTCOME: InvestigationOutcome = {
  profile: {
    hostKind: 'server',
    usage: { coding: 'repositories' },
    capabilities: { cpu: 'Test CPU, 8 threads', memory: '16 GiB', gpu: 'none' },
    hosting: { containers: [] },
    tooling: { cuda: '12.8 through PyTorch' },
    networking: { tailscale: 'present' },
  },
  document: '## Machine\n\n- test machine',
}

/** Dependency set with an instantly settling investigation. */
function dependencies(overrides: Partial<AnalysisDependencies> = {}): AnalysisDependencies {
  return {
    investigate: async (onStage) => {
      await Promise.resolve()
      for (const stage of ANALYSIS_STAGES.slice(0, -1)) onStage(stage)
      return OUTCOME
    },
    writeProfile: () => '/tmp/system-profile.md',
    writeProfileJson: () => '/tmp/system-profile.json',
    readProfile: () => null,
    removeProfile: () => {},
    readDecision: () => null,
    writeDecision: () => {},
    route: 'kilo/kilo-auto/free',
    preset: 'sysadmin',
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

/** Answer one route request and parse the JSON body back out. */
function reply(runner: AnalysisRunner, url: string, method: 'GET' | 'POST' = 'GET'): { status: number; body: unknown } {
  let status = 0
  let body = ''
  const res = {
    setHeader: () => {},
    end: (chunk: string) => { body = chunk },
    set statusCode(value: number) { status = value },
    get statusCode() { return status },
  }
  handleRequest(runner, { url, method } as never, res as never)
  return { status, body: JSON.parse(body) }
}

describe('system analysis runner', () => {
  it('runs in the background, advances the checklist stages, and lands both artifacts', async () => {
    const writeProfile = vi.fn((_markdown: string) => '/tmp/system-profile.md')
    const writeProfileJson = vi.fn(() => '/tmp/system-profile.json')
    const runner = createAnalysisRunner(dependencies({ writeProfile, writeProfileJson }))
    expect(runner.status().state).toBe('idle')
    const started = runner.start()
    expect(started.state).toBe('running')
    expect(started.stage).toBe('machine')
    expect(started.startedAt).toBe(1_000)
    expect(started.stageCount).toBe(8)
    await settled()
    const done = runner.status()
    expect(done.state).toBe('succeeded')
    expect(done.contextPath).toBe('/tmp/system-profile.md')
    expect(done.pct).toBe(100)
    expect(writeProfileJson).toHaveBeenCalledWith(JSON.stringify(OUTCOME.profile, null, 2))
    const document = writeProfile.mock.calls[0]?.[0] ?? ''
    expect(document).toContain('# System profile')
    expect(document).toContain('1970-01-01T00:00:01.000Z')
    expect(document).toContain('sysadmin agent on kilo/kilo-auto/free')
    expect(document).toContain('## Machine')
  })

  it('derives one stage position into a bounded percentage', () => {
    expect(stagePct(0, 8)).toBe(0)
    expect(stagePct(7, 8)).toBe(88)
    expect(stagePct(100, 8)).toBe(88)
    expect(stagePct(-3, 8)).toBe(0)
    expect(stagePct(3, 0)).toBe(0)
  })

  it('publishes non-decreasing percentages inside 0 to 100 for a whole run', async () => {
    const samples: Array<{ stage: string; stageIndex: number; pct: number }> = []
    const record = (): void => {
      const current = runner.status()
      samples.push({ stage: current.stage, stageIndex: current.stageIndex, pct: current.pct })
    }
    const runner = createAnalysisRunner(dependencies({
      investigate: async (onStage) => {
        for (const stage of ANALYSIS_STAGES.slice(0, -1)) {
          onStage(stage)
          record()
        }
        return OUTCOME
      },
      writeProfile: () => {
        record()
        return '/tmp/system-profile.md'
      },
    }))
    runner.start()
    await settled()
    expect(samples.map(sample => sample.pct)).toEqual([0, 13, 25, 38, 50, 63, 75, 88])
    expect(samples.map(sample => sample.stage)).toEqual([
      'machine', 'usage', 'hosting', 'tooling', 'runtimes', 'networking', 'resources', 'writing profile',
    ])
    for (const sample of samples) {
      expect(sample.pct).toBeGreaterThanOrEqual(0)
      expect(sample.pct).toBeLessThanOrEqual(100)
      expect(sample.stageIndex).toBeGreaterThanOrEqual(0)
      expect(sample.stageIndex).toBeLessThanOrEqual(8)
    }
    expect(runner.status().pct).toBe(100)
  })

  it('ignores a repeated or unknown stage so the rail never moves backwards', async () => {
    const runner = createAnalysisRunner(dependencies({
      investigate: async (onStage) => {
        onStage('tooling')
        expect(runner.status()).toMatchObject({ stage: 'tooling', stageIndex: 3 })
        onStage('tooling')
        expect(runner.status()).toMatchObject({ stage: 'tooling', stageIndex: 3 })
        onStage('resources')
        onStage('machine')
        expect(runner.status()).toMatchObject({ stage: 'machine', stageIndex: 0 })
        return OUTCOME
      },
    }))
    runner.start()
    await settled()
    expect(runner.status().state).toBe('succeeded')
  })

  it('keeps a settled run when start is called again', async () => {
    const investigate = vi.fn(dependencies().investigate)
    const runner = createAnalysisRunner(dependencies({ investigate, readProfile: () => '# System profile\n' }))
    runner.start()
    await settled()
    runner.start()
    await settled()
    expect(investigate).toHaveBeenCalledTimes(1)
  })

  it('restarts a settled run whose document was removed', async () => {
    const investigate = vi.fn(dependencies().investigate)
    let stored: string | null = '# System profile\n'
    const runner = createAnalysisRunner(dependencies({ investigate, readProfile: () => stored }))
    runner.start()
    await settled()
    expect(investigate).toHaveBeenCalledTimes(1)
    stored = null
    expect(runner.start().state).toBe('running')
    await settled()
    expect(investigate).toHaveBeenCalledTimes(2)
  })

  it('reports a failed investigation without throwing and keeps no profile', async () => {
    const runner = createAnalysisRunner(dependencies({
      investigate: async () => { throw new Error('unknown agent preset: sysadmin') },
    }))
    runner.start()
    await settled()
    const failed = runner.status()
    expect(failed.state).toBe('failed')
    expect(failed.error).toBe('unknown agent preset: sysadmin')
    expect(runner.context()).toBeNull()
  })

  it('removes a half-written publication when the document write fails after the JSON write', async () => {
    const writeProfileJson = vi.fn(() => '/tmp/system-profile.json')
    const removeProfile = vi.fn()
    const runner = createAnalysisRunner(dependencies({
      writeProfileJson,
      writeProfile: () => { throw new Error('disk full') },
      removeProfile,
    }))
    runner.start()
    await settled()
    const failed = runner.status()
    expect(writeProfileJson).toHaveBeenCalledOnce()
    expect(failed.state).toBe('failed')
    expect(failed.error).toBe('disk full')
    expect(removeProfile).toHaveBeenCalledOnce()
  })

  it('hands the investigation a signal that follows the plugin lifetime', async () => {
    const lifetime = new AbortController()
    const seen = vi.fn()
    const runner = createAnalysisRunner(dependencies({
      investigate: (onStage, signal) => {
        seen(signal.aborted)
        onStage('machine')
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
      },
    }), lifetime.signal)
    runner.start()
    await settled()
    expect(seen).toHaveBeenCalledWith(false)
    lifetime.abort(new Error('unloaded'))
    await settled()
    expect(runner.status()).toMatchObject({ state: 'failed', error: 'aborted' })
  })

  it('accepts by recording the decision and rejecting by removing the document', () => {
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
      readProfile: () => 'profile text',
      readDecision: () => decision,
      writeDecision: (next) => { decision = next },
    }))
    expect(reply(runner, '/system-analysis/status')).toMatchObject({ status: 200, body: { ok: true, job: { state: 'idle' } } })
    expect(reply(runner, '/system-analysis/start', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { state: 'running' } } })
    expect(reply(runner, '/system-analysis/context')).toMatchObject({ status: 200, body: { ok: true, text: 'profile text' } })
    expect(reply(runner, '/system-analysis/accept', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'accepted' } } })
    expect(reply(runner, '/system-analysis/reject', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'rejected' } } })
    expect(reply(runner, '/system-analysis/unknown')).toMatchObject({ status: 404, body: { ok: false } })
  })

  it('refuses a GET on start with 405 without launching the investigation', async () => {
    const investigate = vi.fn(dependencies().investigate)
    const runner = createAnalysisRunner(dependencies({ investigate }))
    expect(reply(runner, '/system-analysis/start')).toMatchObject({ status: 405, body: { ok: false, message: expect.any(String) } })
    await settled()
    expect(investigate).not.toHaveBeenCalled()
    expect(runner.status().state).toBe('idle')
    // The correct method still starts the run.
    expect(reply(runner, '/system-analysis/start', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { state: 'running' } } })
    await settled()
    expect(investigate).toHaveBeenCalledTimes(1)
  })

  it('accepts GET only for the reads and POST only for the actions', () => {
    let decision: 'accepted' | 'rejected' | null = null
    const runner = createAnalysisRunner(dependencies({
      readProfile: () => 'profile text',
      readDecision: () => decision,
      writeDecision: (next) => { decision = next },
    }))
    expect(reply(runner, '/system-analysis/status', 'POST')).toMatchObject({ status: 405, body: { ok: false, message: expect.any(String) } })
    expect(reply(runner, '/system-analysis/context', 'POST')).toMatchObject({ status: 405, body: { ok: false, message: expect.any(String) } })
    // A refused decision never reaches the runner.
    expect(reply(runner, '/system-analysis/accept')).toMatchObject({ status: 405, body: { ok: false, message: expect.any(String) } })
    expect(reply(runner, '/system-analysis/reject')).toMatchObject({ status: 405, body: { ok: false, message: expect.any(String) } })
    expect(decision).toBeNull()
    // The correct methods still pass.
    expect(reply(runner, '/system-analysis/context')).toMatchObject({ status: 200, body: { ok: true, text: 'profile text' } })
    expect(reply(runner, '/system-analysis/accept', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'accepted' } } })
    expect(reply(runner, '/system-analysis/reject', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'rejected' } } })
  })
})
