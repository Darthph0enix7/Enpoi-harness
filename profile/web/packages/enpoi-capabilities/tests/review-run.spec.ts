import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  buildReviewRunCommand, installReviewRunTool, readReviewRunnerOverride, resolveReviewInterpreter,
  renderReviewRun, reviewRunEnv, reviewRunSummary, REVIEW_RUN_DEFAULT_TIMEOUT_MS, REVIEW_RUN_MAX_TIMEOUT_MS,
  REVIEW_RUN_SPEC_RELATIVE_PATH, REVIEW_RUNNERS,
} from '../src/review-run'
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'

/** Scratch roots created by this spec file; removed after the file finishes. */
const scratchRoots: string[] = []

afterAll(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fresh writable workspace root for spec/venv probing (removed in afterAll). */
function scratchWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'review-run-ws-'))
  scratchRoots.push(root)
  return root
}

/** Write `.dsh/review-run.json` under the workspace root. */
function writeSpec(root: string, body: string): void {
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, REVIEW_RUN_SPEC_RELATIVE_PATH), body)
}

/** Create an executable placeholder file. */
function touchExecutable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
}

interface FakeToolDefinition {
  name: string
  execute: (args: unknown, exec: { agent?: unknown; signal?: AbortSignal }) => Promise<unknown>
}

interface Registered {
  definition: FakeToolDefinition
  specs: ShellExecSpec[]
}

function fakeShell(sandboxMode: string | undefined): { shell: unknown; specs: ShellExecSpec[] } {
  const specs: ShellExecSpec[] = []
  const shell = {
    sandboxMode,
    resolve(request: ShellExecRequest): ShellExecSpec {
      return {
        command: request.command,
        workdir: request.workdir ?? '/ws',
        timeoutMs: request.timeoutMs ?? 1000,
        onExpiry: 'kill',
        stdoutMaxBytes: 65536,
        signal: request.signal,
        env: request.env,
        sandboxPolicy: request.sandboxPolicy,
      }
    },
    async execute(spec: ShellExecSpec) {
      specs.push(spec)
      return {
        status: 'completed',
        exitCode: 0,
        signal: null,
        done: Promise.resolve(),
        result: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: '1 passed', truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: { mode: spec.sandboxPolicy?.mode ?? 'read-only', denied: false },
        }),
      }
    },
  }
  return { shell, specs }
}

async function setup(options: { sandboxMode?: string | undefined; withPolicy?: boolean; workspaceRoot?: string; sessionMode?: string } = {}): Promise<Registered> {
  const ctx = new Context()
  let registered: FakeToolDefinition | undefined
  ctx.provide('tools', {
    register(definition: FakeToolDefinition) {
      registered = definition
      return () => {}
    },
  } as never)
  const { shell, specs } = fakeShell('sandboxMode' in options ? options.sandboxMode : 'workspace-write')
  ctx.provide('shell', shell as never)
  if (options.withPolicy !== false) {
    ctx.provide('sandboxPolicy', {
      resolve: (request?: { session?: { id?: string } }) => ({
        mode: options.sessionMode ?? 'workspace-write',
        workspaceRoot: options.workspaceRoot ?? '/ws',
        sessionId: request?.session?.id,
      }),
    } as never)
  }
  await ctx.plugin({ apply: (pluginCtx: Context) => { installReviewRunTool(pluginCtx) } })
  await ctx.fiber.await()
  if (registered === undefined) throw new Error('review_run was not registered')
  return { definition: registered, specs }
}

const oracle = { id: 'a1', session: { header: { agentPreset: 'oracle' } } }
const fixer = { id: 'a2', session: { header: { agentPreset: 'fixer' } } }
/** A delegated reviewer child: parent preset in the header, identity in its own descriptor. */
const oracleChild = {
  id: 'a3',
  session: {
    header: { agentPreset: 'orchestrator' },
    ownEvents: () => [{ type: 'subagent/descriptor', data: { label: 'oracle review: check', persona: 'You are the Oracle — senior reviewer.' } }],
  },
}
/** A delegated non-reviewer child: same parent preset, a non-reviewer descriptor. */
const fixerChild = {
  id: 'a4',
  session: {
    header: { agentPreset: 'orchestrator' },
    ownEvents: () => [{ type: 'subagent/descriptor', data: { label: 'fixer: probe', persona: 'You are the Fixer — implementation specialist.' } }],
  },
}

describe('real tools registry registration', () => {
  it('registers against the real ToolRuntime and its output schema accepts every result shape', async () => {
    const ctx = new Context()
    ctx.provide('systemPrompt', {
      context: () => {},
      section: () => {},
      tools: () => {},
      getContextOrder: () => 0,
      getSectionOrder: () => 0,
    } as never)
    await ctx.plugin(ToolRuntime as never)
    const { shell } = fakeShell('workspace-write')
    ctx.provide('shell', shell as never)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/ws' }) } as never)
    await ctx.plugin({ apply: (pluginCtx: Context) => { installReviewRunTool(pluginCtx) } })
    await ctx.fiber.await()
    const tools = (ctx as unknown as {
      tools: { get(name: string, scope?: unknown): { output: { schema: never } } | undefined }
    }).tools
    // The inject gate activates on its own fiber; wait for the registration.
    await vi.waitFor(() => { expect(tools.get('review_run')).toBeDefined() })
    const tool = tools.get('review_run')
    const schema = tool!.output.schema
    expect(validateJsonSchemaValue(schema, {
      runner: 'pytest', command: 'python3 -m pytest -q', exitCode: 0, signal: null, timedOut: false,
      sandbox: { mode: 'read-only', denied: false }, stdout: '771 passed', stderr: '',
    })).toEqual([])
    expect(validateJsonSchemaValue(schema, {
      runner: 'pytest', command: 'x', exitCode: null, signal: 'SIGKILL', timedOut: true,
      sandbox: null, stdout: '', stderr: '', error: 'boom',
    })).toEqual([])
  })
})

describe('review_run rendering', () => {
  it('prints an explicit exit status and summary on success and failure', () => {
    const base = {
      runner: 'pytest', command: 'python3 -m pytest -q', signal: null, timedOut: false,
      sandbox: { mode: 'workspace-write', denied: false }, stderr: '',
    }
    const success = renderReviewRun(undefined, {
      ...base, exitCode: 0,
      stdout: '\u001b[32m\u001b[32m\u001b[1m771 passed\u001b[0m, \u001b[33m110 skipped\u001b[0m\u001b[32m in 7.04s\u001b[0m\u001b[0m',
    })
    expect(success[0]?.text).toContain('[exit code: 0]')
    expect(success[0]?.text).toContain('[summary: 771 passed, 110 skipped in 7.04s]')
    const failure = renderReviewRun(undefined, { ...base, exitCode: 1, stdout: '2 failed, 3 passed' })
    expect(failure[0]?.text).toContain('[exit code: 1]')
    expect(failure[0]?.text).toContain('[summary: 2 failed, 3 passed]')
  })

  it('omits the summary when the runner printed no tally', () => {
    const rendered = renderReviewRun(undefined, {
      runner: 'node-test', command: 'x', exitCode: 0, signal: null, timedOut: false,
      sandbox: { mode: 'workspace-write', denied: false }, stdout: 'all clean', stderr: '',
    })
    expect(rendered[0]?.text).toContain('[exit code: 0]')
    expect(rendered[0]?.text).not.toContain('[summary:')
    expect(reviewRunSummary('all clean')).toBeUndefined()
  })
})

describe('review_run registration fence', () => {
  it('registers nothing without a confining executor or a sandbox policy service', async () => {
    await expect(setup({ sandboxMode: undefined })).rejects.toThrow(/not registered/)
    await expect(setup({ withPolicy: false })).rejects.toThrow(/not registered/)
  })

  it('runs the fixed command with a scratch writable root and an untouched checkout for an oracle seat', async () => {
    const { definition, specs } = await setup()
    expect(definition.name).toBe('review_run')
    const value = await definition.execute(
      { runner: 'pytest', target: 'tests/unit/test_x.py' },
      { agent: oracle, signal: new AbortController().signal },
    )
    expect(value).toMatchObject({ runner: 'pytest', exitCode: 0, stdout: '1 passed' })
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({
      command: "python3 -m pytest -q 'tests/unit/test_x.py'",
      workdir: '/ws',
      timeoutMs: REVIEW_RUN_DEFAULT_TIMEOUT_MS,
      env: { PYTHONDONTWRITEBYTECODE: '1' },
    })
    // The writable root is the private scratch dir (plus platform temp by
    // mode semantics), never the checkout at workdir.
    const policy = specs[0]?.sandboxPolicy as { mode: string; workspaceRoot: string } | undefined
    expect(policy?.mode).toBe('workspace-write')
    expect(policy?.workspaceRoot).not.toBe('/ws')
    expect(existsSync(policy?.workspaceRoot ?? '')).toBe(false)
  })

  it('fails closed for a read-only session instead of widening it', async () => {
    const { definition, specs } = await setup({ sessionMode: 'read-only' })
    const value = await definition.execute({ runner: 'pytest' }, { agent: oracleChild })
    expect(value).toMatchObject({ error: expect.stringMatching(/read-only/) as unknown as string })
    expect(specs).toHaveLength(0)
  })

  it('refuses non-reviewer roles in the tool body even when policy is bypassed', async () => {
    const { definition, specs } = await setup()
    await expect(definition.execute({ runner: 'pytest' }, { agent: fixer }))
      .resolves.toMatchObject({ error: expect.stringMatching(/reviewer\/oracle seats/) as unknown as string })
    await expect(definition.execute({ runner: 'pytest' }, { agent: fixerChild }))
      .resolves.toMatchObject({ error: expect.stringMatching(/reviewer\/oracle seats/) as unknown as string })
    expect(specs).toHaveLength(0)
  })

  it('admits a delegated reviewer child identified by its own descriptor', async () => {
    const { definition, specs } = await setup()
    const value = await definition.execute({ runner: 'pytest' }, { agent: oracleChild })
    expect(value).toMatchObject({ exitCode: 0 })
    expect(specs).toHaveLength(1)
  })

  it('clamps the requested timeout into the accepted window', async () => {
    const { definition, specs } = await setup()
    await definition.execute({ runner: 'node-test', timeoutSeconds: 9999 }, { agent: oracle })
    expect(specs[0]?.timeoutMs).toBe(REVIEW_RUN_MAX_TIMEOUT_MS)
  })

  it('returns a bounded error value instead of throwing when execution fails', async () => {
    const ctx = new Context()
    let registered: FakeToolDefinition | undefined
    ctx.provide('tools', { register: (definition: FakeToolDefinition) => { registered = definition; return () => {} } } as never)
    const { shell } = fakeShell('workspace-write')
    const failing = Object.assign({}, shell, { execute: vi.fn(async () => { throw new Error('spawn denied') }) })
    ctx.provide('shell', failing as never)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/ws' }) } as never)
    await ctx.plugin({ apply: (pluginCtx: Context) => { installReviewRunTool(pluginCtx) } })
    await ctx.fiber.await()
    const value = await registered?.execute({ runner: 'pytest' }, { agent: oracle }) as { error?: string }
    expect(value.error).toContain('spawn denied')
  })
})

describe('workspace-aware runner resolution', () => {
  it('prefers a workspace venv interpreter over the bare python3 fallback', () => {
    const root = scratchWorkspace()
    touchExecutable(join(root, '.venv/bin/python'))
    expect(buildReviewRunCommand('pytest', 'tests/x.py', root))
      .toBe(`${join(root, '.venv/bin/python')} -m pytest -q 'tests/x.py'`)
    expect(buildReviewRunCommand('pytest', undefined, root)).toBe(`${join(root, '.venv/bin/python')} -m pytest -q`)
    // A runner without interpreter candidates keeps its fixed argv[0].
    expect(buildReviewRunCommand('node-test', 'tests/x.js', root)).toBe("node --test 'tests/x.js'")
  })

  it('reads a validated spec override and merges its env without displacing the read-only accommodation', () => {
    const root = scratchWorkspace()
    writeSpec(root, JSON.stringify({ pytest: { interpreter: process.execPath, env: { PYTHONPATH: 'src' } } }))
    const override = readReviewRunnerOverride(root, 'pytest')
    expect(override).toEqual({ interpreter: process.execPath, env: { PYTHONPATH: 'src' } })
    expect(buildReviewRunCommand('pytest', 'tests', root, override))
      .toBe(`${process.execPath} -m pytest -q 'tests'`)
    expect(reviewRunEnv(override)).toEqual({ PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: 'src' })
    expect(resolveReviewInterpreter(root, REVIEW_RUNNERS['pytest'] as never, undefined)).toBe('python3')
  })

  it('rejects malformed specs loud', () => {
    const unknownRunner = scratchWorkspace()
    writeSpec(unknownRunner, JSON.stringify({ mocha: { interpreter: process.execPath } }))
    expect(() => readReviewRunnerOverride(unknownRunner, 'pytest')).toThrow(/unknown runner/)
    const relative = scratchWorkspace()
    writeSpec(relative, JSON.stringify({ pytest: { interpreter: 'python3' } }))
    expect(() => readReviewRunnerOverride(relative, 'pytest')).toThrow(/absolute path/)
    const missing = scratchWorkspace()
    writeSpec(missing, JSON.stringify({ pytest: { interpreter: '/no/such/python' } }))
    expect(() => readReviewRunnerOverride(missing, 'pytest')).toThrow(/not an executable file/)
    const badEnv = scratchWorkspace()
    writeSpec(badEnv, JSON.stringify({ pytest: { interpreter: process.execPath, env: { DSH_FAKE: 'x' } } }))
    expect(() => readReviewRunnerOverride(badEnv, 'pytest')).toThrow(/may not set managed/)
    const loaderEnv = scratchWorkspace()
    writeSpec(loaderEnv, JSON.stringify({ pytest: { interpreter: process.execPath, env: { LD_PRELOAD: '/tmp/evil.so' } } }))
    expect(() => readReviewRunnerOverride(loaderEnv, 'pytest')).toThrow(/dynamic-loader/)
    const notJson = scratchWorkspace()
    writeSpec(notJson, '{ nope')
    expect(() => readReviewRunnerOverride(notJson, 'pytest')).toThrow(/not valid JSON/)
  })

  it('executes with the workspace override and reports a malformed spec as a bounded value', async () => {
    const root = scratchWorkspace()
    writeSpec(root, JSON.stringify({ pytest: { interpreter: process.execPath, env: { PYTHONPATH: 'src' } } }))
    const { definition, specs } = await setup({ workspaceRoot: root })
    const value = await definition.execute({ runner: 'pytest' }, { agent: oracleChild }) as { command?: string }
    expect(value.command).toBe(`${process.execPath} -m pytest -q`)
    expect(specs[0]?.env).toEqual({ PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: 'src' })

    const broken = scratchWorkspace()
    writeSpec(broken, '{ nope')
    const second = await setup({ workspaceRoot: broken })
    const failed = await second.definition.execute({ runner: 'pytest' }, { agent: oracle }) as { error?: string }
    expect(failed.error).toMatch(/not valid JSON/)
    expect(second.specs).toHaveLength(0)
  })
})
