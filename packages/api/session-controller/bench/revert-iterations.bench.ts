/**
 * Phase 3 M5 benchmark: `revertIterations` list cost on a ~10^6-event session.
 *
 * Run from the repository root:
 *   node --max-old-space-size=4096 --import tsx/esm packages/api/session-controller/bench/revert-iterations.bench.ts
 *
 * The first call pays the one-time command-index fold over the durable log.
 * Every later call must list from the folded index plus one pass over the live
 * surface nodes, independent of the log length.
 */

import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionController from '../src/index.ts'
import { createSessionTestController } from '../tests/test-remote.ts'

const EVENT_COUNT = 1_000_000
const GROUP_COUNT = 100
const CALLS = 50

const defaults = {
  defaultModelSelection: () => ({ fixture: true, provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

/** ~10^6 durable events: an inert log prefix, then committed iteration groups. */
function syntheticLog(): SessionEvent[] {
  const inert = (seq: number): SessionEvent => ({
    type: 'revert/state', seq: SessionSeq(seq), time: seq, data: { fromSeq: null, cause: 'commit' },
  })
  const events: SessionEvent[] = []
  const groupsStart = EVENT_COUNT - GROUP_COUNT * 3
  for (let seq = 0; seq < groupsStart; seq += 1) events.push(inert(seq))
  for (let group = 0; group < GROUP_COUNT; group += 1) {
    const v1 = events.length
    events.push({
      type: 'user/message',
      seq: SessionSeq(v1),
      time: v1,
      data: createUserMessage({ content: [{ type: 'text', text: `variant ${String(group)} one` }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    })
    const v2 = events.length
    events.push({
      type: 'user/message',
      seq: SessionSeq(v2),
      time: v2,
      data: createUserMessage({ content: [{ type: 'text', text: `variant ${String(group)} two` }], source: { kind: 'user' } }),
      surfaceOp: { op: 'replace', startSeq: SessionSeq(v1), endSeq: SessionSeq(v1) },
      sourceEventSeqs: [SessionSeq(v1)],
    })
    const markerSeq = events.length
    events.push({
      type: 'revert/iteration',
      seq: SessionSeq(markerSeq),
      time: markerSeq,
      data: { groupAnchor: v1, previousSeq: v1, variantSeq: v2, startSeq: v1, endSeq: v1, cause: 'commit' },
      ignorable: true,
    })
  }
  for (let seq = events.length; seq < EVENT_COUNT; seq += 1) events.push(inert(seq))
  return events
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const controller: SessionController = createSessionTestController(ctx, defaults)
  const sessionId = SessionId('revert-iterations-bench')
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/tmp',
  }

  const startBuild = performance.now()
  const events = syntheticLog()
  const session = ctx.sessions.create(sessionId, { meta: header, seed: events })
  const buildMs = performance.now() - startBuild

  const startFirst = performance.now()
  const first = await controller.revertIterations({ sessionId })
  const firstMs = performance.now() - startFirst

  const calls: number[] = []
  let listedGroups = 0
  for (let call = 0; call < CALLS; call += 1) {
    const start = performance.now()
    const value = await controller.revertIterations({ sessionId })
    calls.push(performance.now() - start)
    listedGroups = value.groups.length
  }

  const mean = calls.reduce((total, value) => total + value, 0) / calls.length
  process.stdout.write([
    `BENCH events=${String(EVENT_COUNT)} groups=${String(GROUP_COUNT)} calls=${String(CALLS)}`,
    `BENCH buildMs=${buildMs.toFixed(1)} firstCallMs=${firstMs.toFixed(1)} firstGroups=${String(first.groups.length)}`,
    `BENCH listMeanMs=${mean.toFixed(3)} listMinMs=${Math.min(...calls).toFixed(3)} listP95Ms=${percentile(calls, 0.95).toFixed(3)}`,
    `BENCH surfaceNodes=${String(session.surface.nodes.length)} listedGroups=${String(listedGroups)}`,
    `BENCH heapUsedMb=${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}`,
  ].join('\n') + '\n')
  await ctx.fiber.dispose()
}

await main()
