/**
 * A delegated child whose bash command outlives the executor timeout must be
 * able to collect the promoted job's output. The base composition promotes
 * foreground commands (`promoteOnTimeout`), and the bash contract names
 * `job_output`; the child tool floor must therefore keep the job controls,
 * which are fenced to the owning session by the job registry.
 *
 * Real composition: the shipping subagent tool + in-process spawn provider,
 * the real bash tool + local job registry, and a scripted child model that
 * runs one long command, collects it through `job_output`, and reports.
 * @module dsh-tool-subagent/tests/child-job-collection
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal
const contexts = new Set<Context>()
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('child promoted bash jobs are collectable', () => {
  it('a child command over the timeout settles once, in order, with its output', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-child-jobs-'))
    roots.push(root)
    const spillDir = path.join(root, 'spill')
    const marker = path.join(root, 'runs.txt')
    const executorTimeoutMs = 200

    // Child turns: run the long command → collect the promoted job → report
    // whether the job's output reached the transcript. A denied `job_output`
    // call leaves the marker at one run but the report without the output.
    const adapter = new MockAdapter([
      toolCallResponse('bash-call', 'bash', {
        command: `printf x >> ${marker}; sleep 1; echo CHILD-JOB-OK`,
        description: 'Run the long probe command',
      }, 'running the probe'),
      toolCallResponse('collect-call', 'job_output', { job_id: 'bash-1', wait: true }),
      options => textResponse(
        JSON.stringify(options.messages).includes('CHILD-JOB-OK') ? 'COLLECTED-OK' : 'COLLECT-MISSING',
      ),
    ])

    const ctx = new Context()
    contexts.add(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs)
    await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: executorTimeoutMs, graceMs: 200 })
    await ctx.plugin(ToolBash)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(tool, { provider: 'spawn', backgroundMode: 'continuable' })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('dispatch-1'),
      name: 'subagent',
      // Explorer is deny-only, so the shared floor (which keeps the job
      // controls) is exactly what this collection test observes.
      arguments: { role: 'explorer', description: 'long command child', prompt: 'run and collect the long probe', run_in_background: false },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    // The report exists only if job_output returned the promoted job's output.
    expect(text(result)).toBe('COLLECTED-OK')
    // The command ran exactly once: promotion kept it alive instead of the
    // child re-running it after the tool result came back truncated.
    expect(readFileSync(marker, 'utf8')).toBe('x')
  })
})
