/**
 * Live probe (doc 82 item 8): Full access = applied parent judgement.
 *
 * Drives the REAL forwarder (`ChildApprovalForwarder.forward`) with the REAL
 * bounded root-side judgement (`requestRecommendation`) over a scripted model
 * stream, and quotes the applied resolution + audit line for:
 *   1. a judgement that allows / refuses,
 *   2. a forced judgement failure (stream throws) → derived fallback decisions.
 *
 * Run (no package build; probe bundle only):
 *   npx esbuild tests/full-access.probe.ts --bundle --format=esm --platform=node \
 *     --target=node22 --external:@deepseek-ai/* --outfile=tests/.full-access.probe.mjs \
 *     && node tests/.full-access.probe.mjs
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ChildApprovalForwarder, type ChildAgentLike, type ForwardingDeps, type RecommendationQuery, type RootHandle } from '../src/forwarding'
import { resolvePolicy } from '../src/policy'
import { requestRecommendation } from '../src/recommendation'

const ROOT: RootHandle = { id: 'root-live', agent: { fake: 'root' }, cwd: '/ws' }

function child(label: string): ChildAgentLike {
  return {
    session: {
      header: { id: 'child-live', parentSession: 'root-live', delegationDepth: 1, cwd: '/ws' },
      ownEvents: () => [{ type: 'subagent/descriptor', data: { label } }],
    },
  }
}

function askFor(command: string) {
  const decision = resolvePolicy({ toolName: 'bash', command, config: {} })
  if (decision.kind !== 'ask') throw new Error(`probe fixture did not ask: ${command}`)
  return decision
}

function scriptedStream(text: string): (options: GenerateOptions) => AsyncIterable<StreamChunk> {
  return async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function failedStream(): (options: GenerateOptions) => AsyncIterable<StreamChunk> {
  return async function* () {
    throw new Error('forced judgement failure (probe)')
  }
}

type Stream = (options: GenerateOptions) => AsyncIterable<StreamChunk>

function deps(stream: Stream, reports: string[], misses: string[]): ForwardingDeps {
  return {
    findRoot: () => ROOT,
    modeOf: () => 'full-access',
    parentAllowsRail: () => false,
    askRoot: () => Promise.reject(new Error('no card exists in Full access')),
    recommendation: (query: RecommendationQuery) => requestRecommendation(
      {
        toolName: query.toolName,
        ...query.args !== undefined ? { args: query.args } : {},
        origin: query.origin,
        workspaceRelation: query.workspaceRelation,
        ...query.rail !== undefined ? { rail: query.rail } : {},
        decision: query.decision,
        ...query.applied === true ? { applied: true } : {},
      },
      {
        stream,
        provider: 'probe',
        model: 'scripted',
        timeoutMs: 6000,
        onMiss: reason => misses.push(reason),
      },
    ),
    turnOf: () => 'probe-turn-1',
    report: line => reports.push(line),
    depthCap: () => 1,
  }
}

async function main(): Promise<void> {
  const command = 'rm plain'

  // 1a. Model judges ALLOW → applied as allowed-once.
  {
    const reports: string[] = []
    const misses: string[] = []
    const forwarder = new ChildApprovalForwarder(deps(
      scriptedStream('{"text":"Deletes one scratch file inside the workspace; safe once.","suggestion":"allow-once"}'),
      reports, misses,
    ))
    const result = await forwarder.forward({ agent: child('fixer: probe'), toolName: 'bash', args: { command }, decision: askFor(command), callId: 'call-allow' })
    console.log('[1a applied allow]', JSON.stringify(result))
    console.log('[1a audit]', reports.find(line => line.startsWith('audit:')))
    console.log('[1a final call recorded]', forwarder.resolvesFinalCall('child-live', 'call-allow', 'bash'))
  }

  // 1b. Model judges REJECT → corrective denial carrying the parent's reason.
  {
    const reports: string[] = []
    const forwarder = new ChildApprovalForwarder(deps(
      scriptedStream('{"text":"Deletes files without a restore point; refuse.","suggestion":"reject"}'),
      reports, [],
    ))
    const result = await forwarder.forward({ agent: child('fixer: probe'), toolName: 'bash', args: { command }, decision: askFor(command) })
    console.log('[1b applied reject]', JSON.stringify(result))
    console.log('[1b audit]', reports.find(line => line.startsWith('audit:')))
  }

  // 2a. Forced judgement failure on a risk-adjacent ask → derived fallback DENY.
  {
    const reports: string[] = []
    const misses: string[] = []
    const forwarder = new ChildApprovalForwarder(deps(failedStream(), reports, misses))
    const result = await forwarder.forward({ agent: child('fixer: probe'), toolName: 'bash', args: { command }, decision: askFor(command) })
    console.log('[2a miss]', JSON.stringify(misses))
    console.log('[2a derived fallback deny]', JSON.stringify(result))
    console.log('[2a audit]', reports.find(line => line.startsWith('audit:')))
  }

  // 2b. Forced judgement failure on a clean ask → derived fallback ALLOW.
  {
    const reports: string[] = []
    const misses: string[] = []
    const forwarder = new ChildApprovalForwarder(deps(failedStream(), reports, misses))
    const decision = resolvePolicy({ toolName: 'str_replace_editor', config: {} })
    if (decision.kind !== 'ask') throw new Error('probe fixture did not ask (editor)')
    const result = await forwarder.forward({ agent: child('fixer: probe'), toolName: 'str_replace_editor', args: {}, decision })
    console.log('[2b miss]', JSON.stringify(misses))
    console.log('[2b derived fallback allow]', JSON.stringify(result))
    console.log('[2b audit]', reports.find(line => line.startsWith('audit:')))
  }
}

await main()
