/**
 * Idle-parent approval park-and-replay — sandbox proof.
 *
 * This is the end-to-end seam proof, not a mocked unit test: it mounts the
 * REAL `@deepseek-ai/dsh-user-approval` service in a cordis Context, wires the
 * forwarder's `askRoot` to `ctx.approval.request`, and derives the idle probe
 * from the harness's own exported `hasOpenTurn`. A child ask is forwarded
 * while the root session sits between turns; the ask must park, then resolve
 * at the root's next `turn/start` (operator card, or the Full-access parent
 * judgement with no card), expire with the named denial when the root never
 * returns, survive a restart by expiring restored records, and replay two
 * parked asks in FIFO order. Set `APPROVAL_PARK_EVIDENCE_DIR` to write the
 * machine-readable transcript for `~/dsh-migration/evidence/approval-park/`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ApprovalService, { hasOpenTurn } from '@deepseek-ai/dsh-user-approval'
import { ChildApprovalForwarder, type ForwardingDeps, type RootAskQuery, type RootHandle } from '../src/forwarding'
import { resolvePolicy, type PermissionPolicyConfig } from '../src/policy'
import { createApprovalParkJournal } from '../src/approval-parks'

interface FakeEvent {
  type: string
  data?: Record<string, unknown>
}

/** The structural slice of a live session the service and forwarder read. */
function fakeSession(seed: FakeEvent[] = []) {
  const events: FakeEvent[] = [...seed]
  return {
    get seq() { return events.length },
    eventAt: (index: number) => events[index],
    append: (type: string, data: Record<string, unknown>) => {
      const event: FakeEvent = { type, data }
      events.push(event)
      return event
    },
    types: () => events.map(event => event.type),
    decided: () => events.filter(event => event.type === 'approval/decided').map(event => event.data?.['outcome']),
  }
}

function childAgent(id = 'child-1', label = 'fixer: repair') {
  return {
    session: {
      header: { id, parentSession: 'root-1', delegationDepth: 1, origin: 'subagent', cwd: '/ws' },
      ownEvents: () => [{ type: 'subagent/descriptor', data: { label } }],
    },
  }
}

function askOf(toolName: string, config: PermissionPolicyConfig = {}) {
  const decision = resolvePolicy({ toolName, config })
  if (decision.kind !== 'ask') throw new Error(`fixture ${toolName} did not ask (${decision.kind})`)
  return decision
}

function bashAsk(command: string) {
  const decision = resolvePolicy({ toolName: 'bash', command, config: {} })
  if (decision.kind !== 'ask') throw new Error(`fixture command did not ask: ${command} (${decision.kind})`)
  return decision
}

interface Sandbox {
  root: ReturnType<typeof fakeSession>
  reports: string[]
  askQueries: RootAskQuery[]
  forwarder: ChildApprovalForwarder
  turnStart: () => void
  stop: () => void
}

async function sandbox(options: {
  mode: 'interactive' | 'full-access' | 'unattended'
  outcomes?: string[]
  recommendation?: ForwardingDeps['recommendation']
  parkTtlMs?: number
  parkJournal?: ForwardingDeps['parkJournal']
  rootSeed?: FakeEvent[]
}): Promise<Sandbox> {
  const ctx = new Context()
  await ctx.plugin(ApprovalService, { answerTimeoutMs: 30_000 })
  const root = fakeSession(options.rootSeed ?? [])
  const rootAgent = { id: 'root-1', session: root }
  const outcomes = [...options.outcomes ?? []]
  const reports: string[] = []
  const askQueries: RootAskQuery[] = []
  ctx.on('approval/request', () => Promise.resolve((outcomes.shift() ?? 'rejected') as never))
  const rootHandle: RootHandle = { id: 'root-1', agent: rootAgent, cwd: '/ws' }
  const forwarder = new ChildApprovalForwarder({
    findRoot: () => rootHandle,
    modeOf: () => options.mode,
    parentAllowsRail: () => false,
    askRoot: (query) => {
      askQueries.push(query)
      return ctx.approval.request({
        agent: rootAgent as never,
        toolName: query.toolName,
        reason: query.reason,
        displayReason: query.displayReason,
        ...query.recommendation !== undefined ? { recommendation: query.recommendation } : {},
      })
    },
    ...options.recommendation !== undefined ? { recommendation: options.recommendation } : {},
    // The idle probe is the harness's own exported fold, not a test double.
    isRootIdle: (candidate) => !hasOpenTurn((candidate.agent as { session: never }).session),
    ...options.parkTtlMs !== undefined ? { parkTtlMs: () => options.parkTtlMs! } : {},
    ...options.parkJournal !== undefined ? { parkJournal: options.parkJournal } : {},
    report: (line) => { reports.push(line) },
    depthCap: () => 1,
  })
  return {
    root,
    reports,
    askQueries,
    forwarder,
    turnStart: () => { root.append('turn/start', { turn: 1 }) },
    stop: () => { forwarder.dispose() },
  }
}

const EVIDENCE_DIR = process.env['APPROVAL_PARK_EVIDENCE_DIR']
const transcript: unknown[] = []
function record(name: string, detail: Record<string, unknown>): void {
  transcript.push({ scenario: name, ...detail })
}

describe('idle-parent park-and-replay sandbox (real ApprovalService)', () => {
  it('normal mode: parks while the root is idle, then resolves as the operator card at the next turn', async () => {
    const box = await sandbox({ mode: 'interactive', outcomes: ['allowed-once'] })
    const waiting = box.forwarder.forward({
      agent: childAgent(), toolName: 'bash', args: { command: 'rm plain' }, decision: bashAsk('rm plain'),
    })
    expect(box.root.types()).toEqual([])
    expect(box.askQueries).toHaveLength(0)
    expect(box.reports.some(line => line.startsWith('park:'))).toBe(true)

    box.turnStart()
    box.forwarder.replayParked('root-1')
    const result = await waiting
    expect(result).toMatchObject({ kind: 'allow' })
    expect(box.root.types()).toEqual(['turn/start', 'approval/asked', 'approval/decided'])
    expect(box.root.decided()).toEqual(['allowed-once'])
    record('normal-card', { result, rootEvents: box.root.types(), outcomes: box.root.decided() })
    box.stop()
  })

  it('full access: parks while idle, then applies the parent judgement with an audit line and no card', async () => {
    const box = await sandbox({
      mode: 'full-access',
      recommendation: () => Promise.resolve({ text: 'clean edit inside the workspace', suggestion: 'allow-once' }),
    })
    const waiting = box.forwarder.forward({
      agent: childAgent(), toolName: 'str_replace_editor', args: { file_path: '/ws/a.txt' }, decision: askOf('str_replace_editor'),
    })
    expect(box.root.types()).toEqual([])
    expect(box.askQueries).toHaveLength(0)

    box.turnStart()
    box.forwarder.replayParked('root-1')
    const result = await waiting
    expect(result).toMatchObject({ kind: 'allow' })
    // No card and no audit pair in the root log: the mode is the consent.
    expect(box.root.types()).toEqual(['turn/start'])
    expect(box.askQueries).toHaveLength(0)
    expect(box.reports.some(line => line.includes('audit: parent approved') && line.includes('Full access'))).toBe(true)
    expect(box.reports.some(line => line.startsWith('resolve:') && line.includes('Full access, no card'))).toBe(true)
    record('full-access-yolo', { result, rootEvents: box.root.types(), reports: box.reports.filter(line => line.startsWith('resolve:')) })
    box.stop()
  })

  it('TTL: a root that never returns expires the park and the child gets the named denial', async () => {
    const box = await sandbox({ mode: 'interactive', parkTtlMs: 25 })
    const waiting = box.forwarder.forward({
      agent: childAgent(), toolName: 'bash', args: { command: 'rm plain' }, decision: bashAsk('rm plain'),
    })
    const result = await waiting
    expect(result.kind).toBe('deny')
    expect(result.kind === 'deny' && result.reason).toContain('approval was not resolved in time')
    expect(box.root.types()).toEqual([])
    expect(box.reports.some(line => line.startsWith('expire:'))).toBe(true)
    record('ttl-expiry', { result, rootEvents: box.root.types() })
    box.stop()
  })

  it('two parked asks resolve in FIFO order at one turn start', async () => {
    const box = await sandbox({ mode: 'interactive', outcomes: ['allowed-once', 'allowed-once'] })
    const first = box.forwarder.forward({
      agent: childAgent(), toolName: 'str_replace_editor', args: { file_path: '/ws/a.txt' }, decision: askOf('str_replace_editor'),
    })
    const second = box.forwarder.forward({
      agent: childAgent(), toolName: 'bash', args: { command: 'rm plain' }, decision: bashAsk('rm plain'),
    })
    expect(box.askQueries).toHaveLength(0)

    box.turnStart()
    box.forwarder.replayParked('root-1')
    expect(await first).toMatchObject({ kind: 'allow' })
    expect(await second).toMatchObject({ kind: 'allow' })
    expect(box.askQueries.map(query => query.toolName)).toEqual(['str_replace_editor', 'bash'])
    expect(box.root.types()).toEqual(['turn/start', 'approval/asked', 'approval/decided', 'approval/asked', 'approval/decided'])
    record('fifo-order', { order: box.askQueries.map(query => query.toolName), rootEvents: box.root.types() })
    box.stop()
  })

  it('restart mid-park: the durable journal round-trips and a new process expires the orphaned park', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-park-sandbox-'))
    try {
      const journalPath = join(dir, 'approval-parks.json')
      const first = await sandbox({ mode: 'interactive', parkJournal: createApprovalParkJournal(journalPath) })
      void first.forwarder.forward({
        agent: childAgent(), toolName: 'bash', args: { command: 'rm plain' }, decision: bashAsk('rm plain'),
      })
      const parkedDocument = JSON.parse((await import('node:fs')).readFileSync(journalPath, 'utf8')) as {
        records: Array<{ state: string; settledVia?: string }>
      }
      expect(parkedDocument.records[0]).toMatchObject({ state: 'parked' })

      // A new process: fresh journal reader and forwarder over the same file.
      const second = await sandbox({ mode: 'interactive', parkJournal: createApprovalParkJournal(journalPath) })
      const restored = JSON.parse((await import('node:fs')).readFileSync(journalPath, 'utf8')) as {
        records: Array<{ state: string; settledVia?: string; settledWith?: string }>
      }
      expect(restored.records[0]).toMatchObject({ state: 'expired', settledVia: 'restart', settledWith: 'deny' })
      second.turnStart()
      second.forwarder.replayParked('root-1')
      expect(second.askQueries).toHaveLength(0)
      expect(second.root.types().filter(type => type.startsWith('approval/'))).toEqual([])
      record('restart', { restored: restored.records, replayDispatched: second.askQueries.length })
      first.stop()
      second.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes the sandbox transcript for the evidence bundle when asked', () => {
    if (EVIDENCE_DIR !== undefined && EVIDENCE_DIR !== '') {
      writeFileSync(join(EVIDENCE_DIR, 'sandbox-transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`)
    }
    expect(transcript.length).toBeGreaterThanOrEqual(5)
  })
})
