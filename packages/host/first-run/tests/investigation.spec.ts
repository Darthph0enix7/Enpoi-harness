import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INVESTIGATION_STAGES, PROFILE_DOCUMENT_FILENAME, PROFILE_JSON_FILENAME, REQUIRED_PROFILE_KEYS,
  SYSTEM_ANALYSIS_CORRECTION, SYSTEM_ANALYSIS_PROMPT, isSystemProfile, runSystemInvestigation, stageFromTodos,
} from '../src/investigation.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One fresh scratch workspace. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-first-run-work-'))
  roots.push(root)
  return root
}

const PROFILE = {
  hostKind: 'server',
  usage: { coding: 'repositories' },
  capabilities: { cpu: 'Test CPU, 8 threads', memory: '16 GiB', gpu: 'none' },
  hosting: { containers: [] },
  tooling: { cuda: '12.8 through PyTorch' },
  networking: { tailscale: 'present' },
}

describe('investigation prompt and stage mapping', () => {
  it('pins the checklist, the read-only rule, the todo progress surface, the CUDA paths, and the output contract', () => {
    for (const stage of INVESTIGATION_STAGES.slice(0, -1)) {
      expect(SYSTEM_ANALYSIS_PROMPT).toContain(`\`${stage}\``)
    }
    expect(SYSTEM_ANALYSIS_PROMPT).toContain('read-only')
    expect(SYSTEM_ANALYSIS_PROMPT).toContain('todo_write')
    expect(SYSTEM_ANALYSIS_PROMPT).toContain('nvcc')
    expect(SYSTEM_ANALYSIS_PROMPT).toContain('conda')
    expect(SYSTEM_ANALYSIS_PROMPT).toContain('torch.version.cuda')
    expect(SYSTEM_ANALYSIS_PROMPT).toContain('nvidia-smi')
    expect(SYSTEM_ANALYSIS_PROMPT).toContain('absent ONLY when every plausible path to it is absent')
    for (const key of REQUIRED_PROFILE_KEYS) expect(SYSTEM_ANALYSIS_PROMPT).toContain(`\`${key}\``)
    expect(SYSTEM_ANALYSIS_PROMPT).toContain(PROFILE_JSON_FILENAME)
    expect(SYSTEM_ANALYSIS_PROMPT).toContain(PROFILE_DOCUMENT_FILENAME)
    expect(SYSTEM_ANALYSIS_PROMPT).toContain('## At a glance')
    expect(SYSTEM_ANALYSIS_PROMPT).toContain('capability summary')
    expect(SYSTEM_ANALYSIS_PROMPT).toContain('## Machine')
    expect(SYSTEM_ANALYSIS_CORRECTION).toContain(PROFILE_JSON_FILENAME)
  })

  it('maps the in-progress todo item onto the stage rail and keeps unknown items out', () => {
    expect(stageFromTodos([{ content: 'machine', status: 'in_progress' }])).toBe('machine')
    expect(stageFromTodos([{ content: 'Tooling section (CUDA every path)', status: 'in_progress' }])).toBe('tooling')
    expect(stageFromTodos([{ content: 'runtimes', status: 'in_progress' }])).toBe('runtimes')
    expect(stageFromTodos([{ content: 'write profile', status: 'in_progress' }])).toBe('writing profile')
    expect(stageFromTodos([{ content: 'publish the profile', status: 'in_progress' }])).toBe('writing profile')
    expect(stageFromTodos([{ content: 'machine', status: 'completed' }])).toBeUndefined()
    expect(stageFromTodos([{ content: 'double-check everything', status: 'in_progress' }])).toBeUndefined()
    expect(stageFromTodos([])).toBeUndefined()
  })

  it('validates a published profile at the file boundary', () => {
    expect(isSystemProfile(PROFILE)).toBe(true)
    expect(isSystemProfile(null)).toBe(false)
    expect(isSystemProfile([])).toBe(false)
    expect(isSystemProfile('server')).toBe(false)
    expect(isSystemProfile({ ...PROFILE, hostKind: 7 })).toBe(false)
    expect(isSystemProfile({ hostKind: 'server' })).toBe(false)
    expect(isSystemProfile({ ...PROFILE, hosting: [] })).toBe(false)
  })
})

/** One scripted investigation run over a real Cordis context and provided fakes. */
function run(options: {
  readonly permissionSet?: (session: unknown, name: string) => void
  readonly titleRename?: (session: unknown, title: string) => void
  readonly writeOnAttempt?: (attempt: number) => boolean
  readonly hangIdle?: boolean
} = {}) {
  const ctx = new Context()
  const workspace = scratch()
  const followups: string[] = []
  let attempt = 0
  const agent = {
    id: 'system-analysis-test',
    session: { id: 'system-analysis-test' },
    whenIdle: async () => {
      if (options.hangIdle === true) await new Promise(() => {})
    },
    followup(message: { content: readonly { type: string; text?: string }[] }) {
      followups.push(message.content[0]?.text ?? '')
      attempt += 1
      if (options.writeOnAttempt?.(attempt) === true) {
        writeFileSync(join(workspace, PROFILE_JSON_FILENAME), JSON.stringify(PROFILE))
        writeFileSync(join(workspace, PROFILE_DOCUMENT_FILENAME), '## Machine\n\n- detailed facts')
      }
    },
  }
  const handle = {
    agent,
    dispose: vi.fn(async () => {}),
  }
  const agents = {
    create: vi.fn(async (createOptions: Record<string, unknown>) => {
      const setup = createOptions['setup']
      if (typeof setup === 'function') {
        await (setup as (agentCtx: unknown, agent: unknown) => Promise<void>)({
          effect: () => () => {},
        }, agent)
      }
      return handle
    }),
  }
  const presets = {
    resolve: vi.fn(async (id: string) => ({ id })),
    acquireScope: vi.fn(async () => ({ key: {}, [Symbol.asyncDispose]: async () => {} })),
    mount: vi.fn(async (_agentCtx: unknown, id: string) => ({ id })),
  }
  ctx.provide('agents', agents as never)
  ctx.provide('agentPresets', presets as never)
  if (options.permissionSet !== undefined) {
    ctx.provide('permissionPresets', { set: options.permissionSet } as never)
  }
  if (options.titleRename !== undefined) {
    ctx.provide('sessionTitle', { rename: options.titleRename } as never)
  }
  return { ctx, agents, presets, workspace, followups, handle, attempts: () => attempt }
}

const RUN_OPTIONS = {
  provider: 'kilo',
  model: 'kilo-auto/free',
  preset: 'sysadmin',
  permissionPreset: 'workspace-write',
  timeoutMinutes: 15,
} as const

describe('runSystemInvestigation', () => {
  it('creates the preset session in its workspace, enforces the preset, titles it, prompts it, and returns the publication', async () => {
    const permissionSet = vi.fn()
    const titleRename = vi.fn()
    const test = run({ permissionSet, titleRename, writeOnAttempt: () => true })
    const stages: string[] = []
    const result = await runSystemInvestigation({ ctx: test.ctx, workspace: test.workspace, ...RUN_OPTIONS }, {
      onStage: stage => stages.push(stage),
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ profile: PROFILE, document: '## Machine\n\n- detailed facts' })
    const createOptions = test.agents.create.mock.calls[0]?.[0] as Record<string, unknown>
    expect(createOptions['meta']).toMatchObject({ cwd: test.workspace, agentPreset: 'sysadmin' })
    expect(createOptions['agentOptions']).toEqual({ provider: 'kilo', model: 'kilo-auto/free' })
    expect(test.presets.resolve).toHaveBeenCalledWith('sysadmin')
    expect(test.presets.mount).toHaveBeenCalledWith(expect.anything(), 'sysadmin')
    expect(permissionSet).toHaveBeenCalledWith(expect.anything(), 'workspace-write')
    expect(titleRename).toHaveBeenCalledWith(expect.anything(), 'System analysis')
    expect(test.followups).toEqual([SYSTEM_ANALYSIS_PROMPT])
    expect(stages).toEqual([])
    expect(test.handle.dispose).toHaveBeenCalledTimes(1)
    await test.ctx.fiber.dispose()
  })

  it('clears a stale workspace before the run so an earlier artifact cannot be published', async () => {
    const test = run({ writeOnAttempt: () => false })
    writeFileSync(join(test.workspace, PROFILE_JSON_FILENAME), JSON.stringify(PROFILE))
    writeFileSync(join(test.workspace, PROFILE_DOCUMENT_FILENAME), 'stale')
    await expect(runSystemInvestigation({ ctx: test.ctx, workspace: test.workspace, ...RUN_OPTIONS }, {
      onStage: () => {},
      signal: new AbortController().signal,
    })).rejects.toThrow(/ended without writing/u)
    await test.ctx.fiber.dispose()
  })

  it('corrects a turn that ended without the two files, within the bounded attempts', async () => {
    const test = run({ writeOnAttempt: attempt => attempt === 2 })
    const result = await runSystemInvestigation({ ctx: test.ctx, workspace: test.workspace, ...RUN_OPTIONS }, {
      onStage: () => {},
      signal: new AbortController().signal,
    })
    expect(result.profile).toEqual(PROFILE)
    expect(test.attempts()).toBe(2)
    expect(test.followups[1]).toBe(SYSTEM_ANALYSIS_CORRECTION)
    await test.ctx.fiber.dispose()
  })

  it('fails loud when the agent runtime or the preset registry is absent', async () => {
    const bare = new Context()
    await expect(runSystemInvestigation({ ctx: bare, workspace: scratch(), ...RUN_OPTIONS }, {
      onStage: () => {},
      signal: new AbortController().signal,
    })).rejects.toThrow(/agent runtime/u)
    bare.provide('agents', {} as never)
    await expect(runSystemInvestigation({ ctx: bare, workspace: scratch(), ...RUN_OPTIONS }, {
      onStage: () => {},
      signal: new AbortController().signal,
    })).rejects.toThrow(/preset registry/u)
    await bare.fiber.dispose()
  })

  it('reports an unavailable permission preset and still completes', async () => {
    const test = run({
      permissionSet: () => { throw new Error('unknown preset "workspace-write"') },
      writeOnAttempt: () => true,
    })
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    await expect(runSystemInvestigation({ ctx: test.ctx, workspace: test.workspace, ...RUN_OPTIONS }, {
      onStage: () => {},
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ profile: { hostKind: 'server' } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('permission preset'), 'workspace-write', expect.anything())
    await test.ctx.fiber.dispose()
  })

  it('bounds the run by its configured timeout', async () => {
    const test = run({ writeOnAttempt: () => false, hangIdle: true })
    await expect(runSystemInvestigation({
      ctx: test.ctx, workspace: test.workspace, ...RUN_OPTIONS, timeoutMinutes: 0.0005,
    }, {
      onStage: () => {},
      signal: new AbortController().signal,
    })).rejects.toThrow(/did not finish within/u)
    expect(test.handle.dispose).toHaveBeenCalledTimes(1)
    await test.ctx.fiber.dispose()
  })

  it('follows the caller cancellation signal', async () => {
    const test = run({ writeOnAttempt: () => false })
    const controller = new AbortController()
    const pending = runSystemInvestigation({ ctx: test.ctx, workspace: test.workspace, ...RUN_OPTIONS }, {
      onStage: () => {},
      signal: controller.signal,
    })
    controller.abort(new Error('operator cancelled'))
    await expect(pending).rejects.toThrow(/operator cancelled/u)
    await test.ctx.fiber.dispose()
  })
})
