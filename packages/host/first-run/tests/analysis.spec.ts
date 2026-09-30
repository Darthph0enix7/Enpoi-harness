import { describe, expect, it, vi } from 'vitest'
import {
  ANALYSIS_STAGES, Config, createAnalysisRunner, handleRequest, stagePct,
  type AnalysisConfig, type AnalysisDependencies, type AnalysisRunner,
} from '../src/analysis.ts'
import { documentViolations, type InvestigationOutcome } from '../src/investigation.ts'

describe('analysis plugin config', () => {
  it('defaults the investigation session to the shipped system-analysis permission preset', () => {
    // The schema's call signature takes the resolved config; the loader passes
    // partial entries and the schema applies every default.
    expect(Config({} as AnalysisConfig)).toMatchObject({ permissionPreset: 'system-analysis' })
  })
})

const OUTCOME: InvestigationOutcome = {
  profile: {
    hostKind: 'server',
    purpose: 'self-hosted machine for software projects, services, and AI experiments',
    hardware: {
      cpu: 'server-class x86-64, 28 threads',
      memory: '64 GiB class',
      gpu: 'discrete NVIDIA accelerator, 24 GB class',
      disk: 'SSD storage, moderate headroom',
    },
    usage: { development: true, hosting: true },
    hosting: { containers: true, reverseProxy: true },
    networking: { vpnMesh: true, tunnels: true },
    tooling: { languages: 'several managed runtimes' },
  },
  document: '## At a glance\n\n- A self-hosted machine for projects and services.',
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
    removeDecision: () => {},
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
    expect(started.stageCount).toBe(6)
    await settled()
    const done = runner.status()
    expect(done.state).toBe('succeeded')
    expect(done.contextPath).toBe('/tmp/system-profile.md')
    expect(done.pct).toBe(100)
    expect(writeProfileJson).toHaveBeenCalledWith(JSON.stringify(OUTCOME.profile, null, 2))
    const document = writeProfile.mock.calls[0]?.[0] ?? ''
    expect(document).toContain('# System profile')
    expect(document).toContain('sysadmin agent. The structured profile')
    expect(document).toContain('## At a glance')
    // The header owns the one document title.
    expect(document.match(/^# /gmu)).toHaveLength(1)
    // The stored document is stable: no timestamp and no version-like fact.
    expect(document).not.toMatch(/\d{4}-\d{2}-\d{2}T/u)
    expect(documentViolations(document)).toEqual([])
  })

  it('publishes a new profile undecided: the previous decision marker is cleared', async () => {
    const removeDecision = vi.fn()
    const runner = createAnalysisRunner(dependencies({ removeDecision }))
    runner.start()
    await settled()
    expect(removeDecision).toHaveBeenCalledOnce()
  })

  it('drops an agent-authored title above the body instead of doubling the header', async () => {
    const writeProfile = vi.fn((_markdown: string) => '/tmp/system-profile.md')
    const runner = createAnalysisRunner(dependencies({
      writeProfile,
      investigate: async (onStage) => {
        await Promise.resolve()
        for (const stage of ANALYSIS_STAGES.slice(0, -1)) onStage(stage)
        return { ...OUTCOME, document: '# System profile\n\n## At a glance\n\n- A self-hosted machine.\n' }
      },
    }))
    runner.start()
    await settled()
    const document = writeProfile.mock.calls[0]?.[0] ?? ''
    expect(document.match(/^# /gmu)).toHaveLength(1)
    expect(document).toContain('## At a glance')
  })

  it('derives one stage position into a bounded percentage', () => {
    expect(stagePct(0, 6)).toBe(0)
    expect(stagePct(5, 6)).toBe(83)
    expect(stagePct(100, 6)).toBe(83)
    expect(stagePct(-3, 6)).toBe(0)
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
    expect(samples.map(sample => sample.pct)).toEqual([0, 17, 33, 50, 67, 83])
    expect(samples.map(sample => sample.stage)).toEqual([
      'machine', 'usage', 'hosting', 'networking', 'tooling', 'writing profile',
    ])
    for (const sample of samples) {
      expect(sample.pct).toBeGreaterThanOrEqual(0)
      expect(sample.pct).toBeLessThanOrEqual(100)
      expect(sample.stageIndex).toBeGreaterThanOrEqual(0)
      expect(sample.stageIndex).toBeLessThanOrEqual(ANALYSIS_STAGES.length)
    }
    expect(runner.status().pct).toBe(100)
  })

  it('ignores a repeated or unknown stage so the rail never moves backwards', async () => {
    const runner = createAnalysisRunner(dependencies({
      investigate: async (onStage) => {
        onStage('tooling')
        expect(runner.status()).toMatchObject({ stage: 'tooling', stageIndex: 4 })
        onStage('tooling')
        expect(runner.status()).toMatchObject({ stage: 'tooling', stageIndex: 4 })
        onStage('networking')
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
    let decision: 'accepted' | 'rejected' | 'seen' | null = null
    const writeDecision = vi.fn((next: 'accepted' | 'rejected' | 'seen') => { decision = next })
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

  it('records seen once for a stored undecided profile and never touches the files', () => {
    let decision: 'accepted' | 'rejected' | 'seen' | null = null
    const writeDecision = vi.fn((next: 'accepted' | 'rejected' | 'seen') => { decision = next })
    const removeProfile = vi.fn()
    let stored: string | null = '# System profile\n'
    const runner = createAnalysisRunner(dependencies({
      writeDecision,
      removeProfile,
      readProfile: () => stored,
      readDecision: () => decision,
    }))
    expect(runner.seen()).toMatchObject({ decision: 'seen', hasProfile: true })
    expect(writeDecision).toHaveBeenCalledWith('seen')
    expect(removeProfile).not.toHaveBeenCalled()
    // A recorded decision makes the marker a no-op: it never overwrites one.
    expect(runner.seen()).toMatchObject({ decision: 'seen' })
    expect(writeDecision).toHaveBeenCalledTimes(1)
    expect(runner.accept()).toMatchObject({ decision: 'accepted' })
    expect(runner.seen()).toMatchObject({ decision: 'accepted' })
    expect(writeDecision).toHaveBeenCalledTimes(2)
    // Nothing stored: seen cannot create a review, and accept/reject still work.
    decision = null
    stored = null
    expect(runner.seen()).toMatchObject({ decision: null })
    expect(writeDecision).toHaveBeenCalledTimes(2)
    expect(runner.accept()).toMatchObject({ decision: 'accepted' })
    expect(runner.reject()).toMatchObject({ decision: 'rejected', hasProfile: false })
    expect(removeProfile).toHaveBeenCalledTimes(1)
  })

  it('answers start, status, context, accept, reject, seen, and unknown paths over the route', () => {
    let decision: 'accepted' | 'rejected' | 'seen' | null = null
    const runner = createAnalysisRunner(dependencies({
      readProfile: () => 'profile text',
      readDecision: () => decision,
      writeDecision: (next) => { decision = next },
    }))
    expect(reply(runner, '/system-analysis/status')).toMatchObject({ status: 200, body: { ok: true, job: { state: 'idle', decision: null } } })
    expect(reply(runner, '/system-analysis/start', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { state: 'running' } } })
    expect(reply(runner, '/system-analysis/context')).toMatchObject({ status: 200, body: { ok: true, text: 'profile text' } })
    expect(reply(runner, '/system-analysis/seen', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'seen', hasProfile: true } } })
    expect(reply(runner, '/system-analysis/status')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'seen' } } })
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
    let decision: 'accepted' | 'rejected' | 'seen' | null = null
    const runner = createAnalysisRunner(dependencies({
      readProfile: () => 'profile text',
      readDecision: () => decision,
      writeDecision: (next) => { decision = next },
    }))
    expect(reply(runner, '/system-analysis/status', 'POST')).toMatchObject({ status: 405, body: { ok: false, message: expect.any(String) } })
    expect(reply(runner, '/system-analysis/context', 'POST')).toMatchObject({ status: 405, body: { ok: false, message: expect.any(String) } })
    // A refused action never reaches the runner, seen included.
    expect(reply(runner, '/system-analysis/accept')).toMatchObject({ status: 405, body: { ok: false, message: expect.any(String) } })
    expect(reply(runner, '/system-analysis/reject')).toMatchObject({ status: 405, body: { ok: false, message: expect.any(String) } })
    expect(reply(runner, '/system-analysis/seen')).toMatchObject({ status: 405, body: { ok: false, message: expect.any(String) } })
    expect(decision).toBeNull()
    // The correct methods still pass.
    expect(reply(runner, '/system-analysis/context')).toMatchObject({ status: 200, body: { ok: true, text: 'profile text' } })
    expect(reply(runner, '/system-analysis/seen', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'seen' } } })
    expect(reply(runner, '/system-analysis/accept', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'accepted' } } })
    expect(reply(runner, '/system-analysis/reject', 'POST')).toMatchObject({ status: 200, body: { ok: true, job: { decision: 'rejected' } } })
  })
})
