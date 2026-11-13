/** Operator context repair: detached planning, private backup receipts, and guarded apply. */

import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentRegistry, { type Agent, type AgentCancelCause, type CancelOptions, type InboxTarget } from '@deepseek-ai/dsh-agent'
import { createInboxStub, mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import SessionController from '../src/index.ts'
import { canonicalJson, defaultContextRepairBackupRoot, resolveContextRepairBackupRoot, sha256Bytes, sha256Hex } from '../src/context-repair.ts'
import type { ContextRepairFingerprint } from '../src/types.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'enpoi-keeper': {
      readonly kind: 'enpoi-keeper'
      readonly form?: 'snapshot'
      readonly sections?: readonly { readonly name: string; readonly text: string }[]
    }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'state/checkpoint': { readonly version: number }
  }
}

interface StoredSession {
  header: SessionHeader
  events: readonly SessionEvent[]
  readonly artifactPath: string
}

interface TestPersistence {
  readonly resolveCurrentLog?: (id: SessionId, signal?: AbortSignal) => Promise<string | undefined>
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

/** A fake live Agent whose maintenance fence has the real public semantics the capability relies on. */
class OperatorTestAgent implements Agent {
  readonly options = { provider: 'fixture', model: 'fixture-model' }
  readonly inbox = createInboxStub()
  status: 'idle' | 'running' = 'idle'
  private maintenance: Promise<undefined> | undefined

  constructor(readonly ctx: Context, readonly session: Session) {}

  get id(): SessionId {
    return this.session.id
  }

  cancel(_cause: AgentCancelCause, _options?: CancelOptions): void {}

  whenIdle(): Promise<undefined> {
    return this.maintenance ?? Promise.resolve(undefined)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.maintenance !== undefined) throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<undefined>()
    this.maintenance = done.promise
    return (async () => {
      try {
        return await job(new AbortController().signal)
      } finally {
        this.maintenance = undefined
        done.resolve(undefined)
      }
    })()
  }

  send(message: UserMessage, target: InboxTarget, _wakeup: boolean): void {
    this.inbox.append(target, message)
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }
}

interface Harness {
  readonly ctx: Context
  readonly controller: SessionController
  readonly session: Session
  readonly agent: OperatorTestAgent
  readonly store: StoredSession
  readonly persistence: TestPersistence & Record<string, unknown>
  readonly backupRoot: string
  readonly persistenceRoot: string
  flushCount(): number
  setFlushFailure(count: number | undefined): void
  setAfterFlush(callback: (() => void | Promise<void>) | undefined): void
  setResolveHook(callback: (() => void | Promise<void>) | undefined): void
  setArtifactOverride(path: string | undefined): void
  capture(session: Session): Promise<void>
}

interface HarnessOverrides {
  readonly backupRoot?: string
  readonly persistenceRoot?: string
  readonly maxArtifactBytes?: number
  readonly maxReplacementChars?: number
  readonly maxPreviewBytes?: number
}

async function harness(
  sourceKind: 'compact-checkpoint' | 'enpoi-keeper' = 'enpoi-keeper',
  previewTtlMs?: number,
  overrides: HarnessOverrides = {},
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const persistenceRoot = overrides.persistenceRoot ?? await temporaryRoot('dsh-context-repair-persistence-')
  const backupRoot = overrides.backupRoot ?? await temporaryRoot('dsh-context-repair-backup-')
  const sessionId = SessionId(`context-repair-${sourceKind}`)
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    cwd: '/workspace',
    isSeeded: false,
  }
  const store: StoredSession = {
    header,
    events: [],
    artifactPath: join(persistenceRoot, `${sessionId}.jsonl`),
  }
  let artifactOverride: string | undefined
  let flushCount = 0
  let failFlushAt: number | undefined
  let afterFlush: (() => void | Promise<void>) | undefined
  let resolveHook: (() => void | Promise<void>) | undefined
  const persistence: TestPersistence & Record<string, unknown> = {
    ...testSessionPersistence(ctx, {
      list: () => Promise.resolve([store.header]),
      inspect: id => Promise.resolve(id === store.header.id ? { meta: store.header, events: store.events } : undefined),
    }),
    resolveCurrentLog: async (id: SessionId, signal?: AbortSignal) => {
      if (id !== store.header.id) return undefined
      signal?.throwIfAborted()
      await resolveHook?.()
      signal?.throwIfAborted()
      return artifactOverride ?? store.artifactPath
    },
  }
  ctx.provide('sessionPersistence', persistence as never)
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: '/tmp',
    contextRepairBackupRoot: backupRoot,
    ...(previewTtlMs === undefined ? {} : { contextRepairPreviewTtlMs: previewTtlMs }),
    ...(overrides.maxArtifactBytes === undefined ? {} : { contextRepairMaxArtifactBytes: overrides.maxArtifactBytes }),
    ...(overrides.maxReplacementChars === undefined
      ? {}
      : { contextRepairMaxReplacementChars: overrides.maxReplacementChars }),
    ...(overrides.maxPreviewBytes === undefined ? {} : { contextRepairMaxPreviewBytes: overrides.maxPreviewBytes }),
  })
  const session = ctx.sessions.create(sessionId, { meta: header })
  const text = sourceKind === 'enpoi-keeper'
    ? [
      '### State checkpoint',
      '',
      'Derived state snapshot — not an operator instruction.',
      '',
      '🎯 ACTIVE GOAL: keep the corrected line unique',
      'Stale line that needs one exact correction',
      '📚 DOCUMENTATION: preserved verbatim',
    ].join('\n')
    : [
      '<compacted-summary>',
      'Stale line that needs one exact correction',
      '</compacted-summary>',
    ].join('\n')
  const source = sourceKind === 'enpoi-keeper'
    ? { kind: 'enpoi-keeper' as const, form: 'snapshot' as const, sections: [{ name: 'state-checkpoint', text }] }
    : { kind: 'compact-checkpoint' as const, compactionId: CompactionId('compaction-fixture') }
  const message = createUserMessage({
    content: [{ type: 'text', text }, { type: 'text', text: 'second block stays untouched' }],
    source,
  })
  const appended = session.append('user/message', message, { surfaceOp: 'append' })
  if (sourceKind === 'compact-checkpoint') {
    const compactionId = CompactionId('compaction-fixture')
    session.append('turn/start', { turn: 1 })
    session.append('compaction/start', { compactionId, turn: 1 })
    session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'fixture summary' }],
      shadowedRange: { start: appended.seq, end: appended.seq },
      shadowedSeqs: [appended.seq],
      shadowedTokenCount: 1,
      provider: 'fixture',
      model: 'fixture',
    })
    session.append('user/message', createUserMessage({ content: message.content, source }), {
      surfaceOp: { op: 'replace', startSeq: appended.seq, endSeq: appended.seq },
      sourceEventSeqs: [appended.seq],
    })
    session.append('compaction/end', { compactionId, turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  const agent = new OperatorTestAgent(ctx, session)
  ctx.agents.register(agent)
  const capture = async (subject: Session): Promise<void> => {
    if (subject.id !== sessionId) return
    store.events = [...subject.snapshotEvents()]
    await writeFile(
      store.artifactPath,
      store.events.map(event => `${canonicalJson(event)}\n`).join(''),
      { mode: 0o600 },
    )
  }
  ctx.on('session/flush', async (subject) => {
    if (subject.id !== sessionId) return
    flushCount += 1
    if (failFlushAt === flushCount) throw new Error('simulated post-append durability failure')
    await capture(subject)
    await afterFlush?.()
  })
  store.events = [...session.snapshotEvents()]
  await writeFile(
    store.artifactPath,
    store.events.map(event => `${canonicalJson(event)}\n`).join(''),
    { mode: 0o600 },
  )
  return {
    ctx,
    controller,
    session,
    agent,
    store,
    persistence,
    backupRoot,
    persistenceRoot,
    flushCount: () => flushCount,
    setFlushFailure: (count) => { failFlushAt = count },
    setAfterFlush: (callback) => { afterFlush = callback },
    setResolveHook: (callback) => { resolveHook = callback },
    setArtifactOverride: (path) => { artifactOverride = path },
    capture,
  }
}

function targetOf(session: Session, blockIndex = 0, replacementLine = 'Corrected line with the exact neutral wording'): {
  readonly seq: SessionSeq
  readonly blockIndex: number
  readonly expectedBlockSha256: string
  readonly expectedOldLineSha256: string
  readonly replacementLine: string
} {
  const events = session.snapshotEvents()
  const event = session.surface.nodes
    .map(seq => events[seq])
    .find(candidate => candidate?.type === 'user/message')
  if (event?.type !== 'user/message') throw new Error('fixture has no user message')
  const block = event.data.content[blockIndex]
  if (block?.type !== 'text') throw new Error('fixture block is not text')
  const oldLine = 'Stale line that needs one exact correction'
  if (!block.text.includes(oldLine)) throw new Error('fixture line is missing')
  return {
    seq: event.seq,
    blockIndex,
    expectedBlockSha256: sha256Hex(block.text),
    expectedOldLineSha256: sha256Hex(oldLine),
    replacementLine,
  }
}

describe('contextRepairPreview', () => {
  it('previews a detached before/after projection without writing the Session or persistence', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const seqBefore = harnessed.session.seq
    let events = 0
    harnessed.ctx.on('session/event', () => { events += 1 })
    const expectedHead = harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target,
      expectedHeadSeq: seqBefore - 1,
      expectedHeadSha256: sha256Hex(canonicalJson({
        seq: seqBefore - 1,
        event: harnessed.session.snapshotEvents()[seqBefore - 1],
      })),
    })
    const preview = await expectedHead
    expect(preview.previewId.length).toBeGreaterThan(0)
    expect(preview.head.seq).toBe(seqBefore - 1)
    expect(preview.target.sourceKind).toBe('enpoi-keeper')
    expect(preview.diff.oldLine).toBe('Stale line that needs one exact correction')
    expect(preview.diff.replacementLine).toBe(target.replacementLine)
    expect(preview.before.sha256).not.toBe(preview.after.sha256)
    expect(preview.after.activeSeqs).toHaveLength(preview.before.activeSeqs.length)
    expect(preview.after.activeSeqs).toContain(seqBefore)
    expect(preview.after.activeSeqs).not.toContain(target.seq)
    expect(harnessed.session.seq).toBe(seqBefore)
    expect(events).toBe(0)
    expect(harnessed.flushCount()).toBe(0)
  })

  it('previews a cold persisted Session without activating an Agent', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const seq = harnessed.session.snapshotEvents()
    harnessed.ctx.sessions.dispose(harnessed.session.id)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.store.header.id, target })
    expect(preview.head.seq).toBe(seq.length - 1)
    expect(harnessed.ctx.agents.get(harnessed.store.header.id)).toBeDefined()
  })

  it('rejects a human source, a non-user event, and a non-active target', async () => {
    const harnessed = await harness()
    const human = harnessed.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'human text' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const humanTarget = {
      seq: human.seq,
      blockIndex: 0,
      expectedBlockSha256: sha256Hex('human text'),
      expectedOldLineSha256: sha256Hex('human text'),
      replacementLine: 'changed',
    }
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: humanTarget,
    })).rejects.toMatchObject({ code: 'session/context-repair-invalid', details: { reason: 'invalid-source' } })

    const turn = harnessed.session.append('turn/start', { turn: 1 })
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: { ...targetOf(harnessed.session), seq: turn.seq },
    })).rejects.toMatchObject({ code: 'session/context-repair-invalid', details: { reason: 'invalid-target' } })

    const target = targetOf(harnessed.session)
    harnessed.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement checkpoint' }],
      source: { kind: 'enpoi-keeper' },
    }), {
      surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
      sourceEventSeqs: [target.seq],
    })
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target,
    })).rejects.toMatchObject({ code: 'session/context-repair-invalid', details: { reason: 'target-not-active' } })

    const checkpoint = harnessed.session.append('state/checkpoint', { version: 0 }, { ignorable: true })
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: { ...target, seq: checkpoint.seq },
    })).rejects.toMatchObject({ code: 'session/context-repair-invalid', details: { reason: 'invalid-target' } })
  })

  it('rejects stale head, block hash, line hash, duplicate line, and multiline replacement', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target,
      expectedHeadSeq: 999,
      expectedHeadSha256: sha256Hex('wrong'),
    })).rejects.toMatchObject({ code: 'session/context-repair-stale' })
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: { ...target, expectedBlockSha256: sha256Hex('wrong') },
    })).rejects.toMatchObject({ details: { reason: 'block-hash-mismatch' } })
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: { ...target, expectedOldLineSha256: sha256Hex('wrong') },
    })).rejects.toMatchObject({ details: { reason: 'line-hash-mismatch' } })
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: { ...target, replacementLine: 'two\nlines' },
    })).rejects.toMatchObject({ details: { reason: 'invalid-replacement' } })
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: { ...target, replacementLine: 'Stale line that needs one exact correction' },
    })).rejects.toMatchObject({ details: { reason: 'no-change' } })

    const duplicate = harnessed.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'same line\nsame line' }],
      source: { kind: 'enpoi-keeper' },
    }), { surfaceOp: 'append' })
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: {
        seq: duplicate.seq,
        blockIndex: 0,
        expectedBlockSha256: sha256Hex('same line\nsame line'),
        expectedOldLineSha256: sha256Hex('same line'),
        replacementLine: 'other line',
      },
    })).rejects.toMatchObject({ details: { reason: 'line-not-unique' } })
  })
})

describe('contextRepairApply', () => {
  it('appends one surface replacement, preserves source and sibling blocks, and reopens the corrected history', async () => {
    const harnessed = await harness()
    const before = harnessed.session.snapshotEvents()
    const target = targetOf(harnessed.session)
    const targetEvent = before[target.seq]
    if (targetEvent?.type !== 'user/message') throw new Error('fixture target missing')
    const originalSource = structuredClone(targetEvent.data.source)
    const originalSibling = structuredClone(targetEvent.data.content[1])
    const originalHistory = structuredClone(before)
    const artifactBefore = await readFile(harnessed.store.artifactPath)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    const applied = await harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })
    expect(applied.status).toBe('applied')
    expect(applied.receipt.appendedSeq).toBe(before.length)
    expect(applied.receipt.headBefore.seq).toBe(before.length - 1)
    expect(applied.receipt.headAfter.seq).toBe(before.length)
    expect(applied.receipt.artifactSha256).toBe(applied.receipt.backupSha256)
    expect(applied.next.sha256).toBe(preview.after.sha256)

    const after = harnessed.session.snapshotEvents()
    expect(after).toHaveLength(before.length + 1)
    const appended = after.at(-1)
    expect(appended?.type).toBe('user/message')
    expect(appended?.surfaceOp).toEqual({ op: 'replace', startSeq: target.seq, endSeq: target.seq })
    expect(appended?.sourceEventSeqs).toEqual([target.seq])
    if (appended?.type !== 'user/message') throw new Error('repair event missing')
    expect(appended.data.id).toBe(targetEvent.data.id)
    expect(appended.data.source).toEqual(originalSource)
    expect(appended.data.content[1]).toEqual(originalSibling)
    const repairedBlock = appended.data.content[0]
    expect(repairedBlock?.type === 'text' ? repairedBlock.text : '').toContain(target.replacementLine)
    expect(repairedBlock?.type === 'text' ? repairedBlock.text : '').not.toContain('Stale line that needs one exact correction')

    expect(after.slice(before.length).map(event => event.type)).toEqual(['user/message'])
    expect(after.some(event => event.type === 'state/checkpoint')).toBe(false)
    const derived = harnessed.session.deriveMessages().find(message => message.id === targetEvent.data.id)
    const derivedText = derived?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    expect(derivedText).toContain(target.replacementLine)
    expect(harnessed.session.snapshotEvents()[target.seq]).toEqual(originalHistory[target.seq])

    const prepared = JSON.parse(await readFile(applied.receipt.preparedPath, 'utf8')) as {
      status: string
      target: { oldLine: string; replacementLine: string; oldBlockText: string }
      artifact: { sha256: string }
      backup: { sha256: string }
    }
    expect(prepared.status).toBe('prepared')
    expect(prepared.target.oldLine).toBe('Stale line that needs one exact correction')
    expect(prepared.target.replacementLine).toBe(target.replacementLine)
    expect(prepared.target.oldBlockText).toContain('Stale line that needs one exact correction')
    expect(prepared.artifact.sha256).toBe(applied.receipt.artifactSha256)
    expect(prepared.backup.sha256).toBe(applied.receipt.backupSha256)
    const backupBytes = await readFile(applied.receipt.backupPath)
    expect(backupBytes.equals(artifactBefore)).toBe(true)
    expect(sha256Hex(backupBytes.toString('utf8'))).toBe(applied.receipt.backupSha256)
    if (process.platform !== 'win32') {
      expect((await stat(applied.receipt.directory)).mode & 0o077).toBe(0)
      expect((await stat(applied.receipt.backupPath)).mode & 0o077).toBe(0)
      expect((await stat(applied.receipt.preparedPath)).mode & 0o077).toBe(0)
    }

    const inspected = await harnessed.ctx.sessionQuery.observeSession(harnessed.session.id)
    using observation = inspected
    expect(observation.events).toHaveLength(before.length + 1)
    expect(observation.events[target.seq]).toEqual(originalHistory[target.seq])
    expect(observation.events.at(-1)?.type).toBe('user/message')
  })

  it('is idempotently fenced: the preview token is consumed before any retry can append twice', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    await harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })
    const seq = harnessed.session.seq
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-invalid' })
    expect(harnessed.session.seq).toBe(seq)
  })

  it('rejects a fingerprint mismatch and a stale head before any append', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const first = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: first.previewId,
      fingerprint: brandString<ContextRepairFingerprint>('not-the-fingerprint'),
    })).rejects.toMatchObject({ details: { reason: 'fingerprint-mismatch' } })

    const second = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    harnessed.session.append('turn/start', { turn: 1 })
    const seq = harnessed.session.seq
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: second.previewId,
      fingerprint: second.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-stale' })
    expect(harnessed.session.seq).toBe(seq)
  })

  it('rejects a running Agent, queued inbox work, and an active maintenance fence', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })

    harnessed.agent.status = 'running'
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-busy' })
    harnessed.agent.status = 'idle'

    const queued = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    harnessed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } }))
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: queued.previewId,
      fingerprint: queued.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-busy' })
    harnessed.agent.inbox.clear()

    harnessed.session.append('approval/asked', { id: ApprovalRequestId('approval-fixture'), toolName: 'fixture' })
    const approvalPreview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: approvalPreview.previewId,
      fingerprint: approvalPreview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-busy', details: { reason: 'pending-approval' } })

    const maintained = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    const seqBeforeMaintenance = harnessed.session.seq
    let release!: () => void
    const active = harnessed.agent.runMaintenance(async () => {
      await new Promise<void>((resolve) => { release = resolve })
    })
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: maintained.previewId,
      fingerprint: maintained.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-busy' })
    release()
    await active
    expect(harnessed.session.seq).toBe(seqBeforeMaintenance)
  })

  it('rechecks the head after the backup await and rejects an external append', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    harnessed.setResolveHook(() => {
      harnessed.session.append('turn/start', { turn: 1 })
    })
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-stale' })
    expect(harnessed.session.seq).toBe(2)
    expect(harnessed.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
    expect(harnessed.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
  })

  it('rejects a queued prompt that arrives while maintenance holds the Agent', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    harnessed.setAfterFlush(() => {
      harnessed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'arrived during backup' }], source: { kind: 'user' } }))
    })
    const seq = harnessed.session.seq
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-busy' })
    expect(harnessed.session.seq).toBe(seq)
    harnessed.agent.inbox.clear()
  })

  it('refuses a failed backup before any Session append', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    harnessed.setArtifactOverride('/tmp/dsh-context-repair-missing-artifact')
    const seq = harnessed.session.seq
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-backup-failed' })
    expect(harnessed.session.seq).toBe(seq)
  })

  it('fails loud when the persistence provider exposes no canonical artifact location', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    const persistence = harnessed.persistence as { resolveCurrentLog?: unknown }
    delete persistence.resolveCurrentLog
    const seq = harnessed.session.seq
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-unsupported-persistence' })
    expect(harnessed.session.seq).toBe(seq)
  })

  it('reports a guarded partial receipt when the post-append durability barrier fails, and supports explicit rollback', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    harnessed.setFlushFailure(2)
    const partial = await harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })
    expect(partial.status).toBe('partial')
    expect(partial.receipt.reason).toContain('simulated post-append durability failure')
    expect(partial.receipt.finalPath).toBeDefined()
    const repairEvent = harnessed.session.snapshotEvents()[partial.receipt.appendedSeq]
    expect(repairEvent?.type).toBe('user/message')
    expect(repairEvent?.surfaceOp).toEqual({ op: 'replace', startSeq: target.seq, endSeq: target.seq })
    const prepared = JSON.parse(await readFile(partial.receipt.preparedPath, 'utf8')) as {
      status: string
      target: { oldLine: string; oldBlockText: string; replacementLine: string }
    }
    expect(prepared.status).toBe('prepared')
    expect(prepared.target.oldLine).toBe('Stale line that needs one exact correction')

    const block = repairEvent?.type === 'user/message' ? repairEvent.data.content[target.blockIndex] : undefined
    if (block?.type !== 'text') throw new Error('repair block missing')
    const rollback = await harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: {
        seq: partial.receipt.appendedSeq,
        blockIndex: target.blockIndex,
        expectedBlockSha256: sha256Hex(block.text),
        expectedOldLineSha256: sha256Hex(target.replacementLine),
        replacementLine: prepared.target.oldLine,
      },
    })
    const rolledBack = await harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: rollback.previewId,
      fingerprint: rollback.fingerprint,
    })
    expect(rolledBack.status).toBe('applied')
    if (repairEvent?.type !== 'user/message') throw new Error('repair event missing after partial')
    const restored = harnessed.session.deriveMessages().find(message => message.id === repairEvent.data.id)
    const restoredText = restored?.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n') ?? ''
    expect(restoredText).toContain('Stale line that needs one exact correction')
  })

  it('refuses a subagent Session and an expired preview', async () => {
    const harnessed = await harness()
    const childSession = harnessed.ctx.sessions.create(SessionId('context-repair-child'), {
      meta: { cwd: '/workspace', parentSession: harnessed.session.id, origin: 'subagent' },
    })
    const childMessage = childSession.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'child checkpoint\nStale line that needs one exact correction' }],
      source: { kind: 'enpoi-keeper' },
    }), { surfaceOp: 'append' })
    await expect(harnessed.controller.contextRepairPreview({
      sessionId: childSession.id,
      target: {
        seq: childMessage.seq,
        blockIndex: 0,
        expectedBlockSha256: sha256Hex('child checkpoint\nStale line that needs one exact correction'),
        expectedOldLineSha256: sha256Hex('Stale line that needs one exact correction'),
        replacementLine: 'corrected child line',
      },
    })).rejects.toMatchObject({ code: 'session/context-repair-invalid', details: { reason: 'subagent-owned' } })

    const expiring = await harness('enpoi-keeper', 1)
    const expiringPreview = await expiring.controller.contextRepairPreview({
      sessionId: expiring.session.id,
      target: targetOf(expiring.session),
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    await expect(expiring.controller.contextRepairApply({
      sessionId: expiring.session.id,
      previewId: expiringPreview.previewId,
      fingerprint: expiringPreview.fingerprint,
    })).rejects.toMatchObject({ details: { reason: 'preview-expired' } })
  })
})

describe('context repair durability and bounds', () => {
  it('refuses when the provider-decoded head does not match the preview', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    harnessed.setAfterFlush(() => {
      harnessed.store.events = harnessed.store.events.slice(0, -1)
    })
    const seq = harnessed.session.seq
    await expect(harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-stale' })
    expect(harnessed.session.seq).toBe(seq)
  })

  it('refuses symlinked, non-private, and Session-tree backup roots', async () => {
    const targetRoot = await temporaryRoot('dsh-context-repair-symlink-target-')
    const linkParent = await temporaryRoot('dsh-context-repair-symlink-parent-')
    const link = join(linkParent, 'backup-link')
    await symlink(targetRoot, link)
    const symlinked = await harness('enpoi-keeper', undefined, { backupRoot: link })
    const symlinkTarget = targetOf(symlinked.session)
    const symlinkPreview = await symlinked.controller.contextRepairPreview({
      sessionId: symlinked.session.id,
      target: symlinkTarget,
    })
    await expect(symlinked.controller.contextRepairApply({
      sessionId: symlinked.session.id,
      previewId: symlinkPreview.previewId,
      fingerprint: symlinkPreview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-backup-failed' })

    const insecure = await temporaryRoot('dsh-context-repair-insecure-')
    if (process.platform !== 'win32') await chmod(insecure, 0o755)
    const insecureHarness = await harness('enpoi-keeper', undefined, { backupRoot: insecure })
    const insecureTarget = targetOf(insecureHarness.session)
    const insecurePreview = await insecureHarness.controller.contextRepairPreview({
      sessionId: insecureHarness.session.id,
      target: insecureTarget,
    })
    await expect(insecureHarness.controller.contextRepairApply({
      sessionId: insecureHarness.session.id,
      previewId: insecurePreview.previewId,
      fingerprint: insecurePreview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-backup-failed' })

    const insideRoot = await temporaryRoot('dsh-context-repair-inside-')
    const insideHarness = await harness('enpoi-keeper', undefined, {
      persistenceRoot: insideRoot,
      backupRoot: join(insideRoot, 'backups'),
    })
    const insideTarget = targetOf(insideHarness.session)
    const insidePreview = await insideHarness.controller.contextRepairPreview({
      sessionId: insideHarness.session.id,
      target: insideTarget,
    })
    await expect(insideHarness.controller.contextRepairApply({
      sessionId: insideHarness.session.id,
      previewId: insidePreview.previewId,
      fingerprint: insidePreview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-backup-failed' })
  })

  it('returns an applied receipt with a warning when only the final receipt write fails', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    let backupDirectory: string | undefined
    harnessed.setAfterFlush(async () => {
      if (harnessed.flushCount() !== 2) return
      const entries = await readdir(harnessed.backupRoot)
      const directory = entries.find(entry => entry.startsWith('context-repair-'))
      if (directory === undefined) throw new Error('backup directory was not created')
      backupDirectory = join(harnessed.backupRoot, directory)
      if (process.platform !== 'win32') await chmod(backupDirectory, 0o500)
    })
    try {
      const applied = await harnessed.controller.contextRepairApply({
        sessionId: harnessed.session.id,
        previewId: preview.previewId,
        fingerprint: preview.fingerprint,
      })
      expect(applied.status).toBe('applied')
      expect(applied.receipt.finalPath).toBeUndefined()
      expect(applied.receipt.warning).toContain('applied receipt write failed after commit')
      expect(applied.receipt.preparedPath.length).toBeGreaterThan(0)
      expect(harnessed.session.seq).toBe(applied.receipt.appendedSeq + 1)
    } finally {
      if (backupDirectory !== undefined && process.platform !== 'win32') await chmod(backupDirectory, 0o700)
    }
  })

  it('keeps the returned projection paired with the append head when an external event lands during the post-flush await', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    harnessed.setAfterFlush(() => {
      if (harnessed.flushCount() === 2) harnessed.session.append('turn/start', { turn: 1 })
    })
    const applied = await harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })
    expect(applied.status).toBe('applied')
    expect(applied.receipt.headAfter.seq).toBe(applied.receipt.appendedSeq)
    expect(applied.next.headSeq).toBe(applied.receipt.appendedSeq)
    expect(harnessed.session.seq).toBe(applied.receipt.appendedSeq + 2)
    expect(harnessed.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true)
  })

  it('exposes the committed process-local hook for keeper cache/state reconciliation', async () => {
    const harnessed = await harness()
    const target = targetOf(harnessed.session)
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    const committed: Array<{ appendedSeq: number; replacementLine: string }> = []
    harnessed.ctx.on('session/context-repair/committed', (event) => {
      committed.push({ appendedSeq: event.appendedSeq, replacementLine: event.replacementLine })
      harnessed.session.append('state/checkpoint', { version: 1 }, { ignorable: true })
    })
    const applied = await harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })
    expect(applied.status).toBe('applied')
    expect(committed).toEqual([{ appendedSeq: applied.receipt.appendedSeq, replacementLine: target.replacementLine }])
    expect(harnessed.session.snapshotEvents().some(event => event.type === 'state/checkpoint')).toBe(true)
    expect(applied.next.headSeq).toBe(applied.receipt.appendedSeq)
  })

  it('preserves the previous checkpoint citations across two sequential repairs', async () => {
    const harnessed = await harness('compact-checkpoint')
    const first = targetOf(harnessed.session)
    const firstEvent = harnessed.session.snapshotEvents()[first.seq]
    const secondText = 'second checkpoint\nStale line that needs one exact correction'
    const second = harnessed.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: secondText }],
      source: { kind: 'compact-checkpoint', compactionId: CompactionId('compaction-fixture') },
    }), {
      surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq },
      sourceEventSeqs: [first.seq],
    })
    const firstPreview = await harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: {
        seq: second.seq,
        blockIndex: 0,
        expectedBlockSha256: sha256Hex(secondText),
        expectedOldLineSha256: sha256Hex('Stale line that needs one exact correction'),
        replacementLine: 'first corrected line',
      },
    })
    const firstApply = await harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: firstPreview.previewId,
      fingerprint: firstPreview.fingerprint,
    })
    const firstRepair = harnessed.session.snapshotEvents()[firstApply.receipt.appendedSeq]
    if (firstRepair?.type !== 'user/message') throw new Error('first repair event missing')
    expect(firstRepair.sourceEventSeqs).toEqual([second.seq, first.seq])

    const firstBlock = firstRepair.data.content[0]
    if (firstBlock?.type !== 'text') throw new Error('first repair block missing')
    const secondPreview = await harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: {
        seq: firstApply.receipt.appendedSeq,
        blockIndex: 0,
        expectedBlockSha256: sha256Hex(firstBlock.text),
        expectedOldLineSha256: sha256Hex('first corrected line'),
        replacementLine: 'Stale line that needs one exact correction',
      },
    })
    const secondApply = await harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: secondPreview.previewId,
      fingerprint: secondPreview.fingerprint,
    })
    const secondRepair = harnessed.session.snapshotEvents()[secondApply.receipt.appendedSeq]
    if (secondRepair?.type !== 'user/message') throw new Error('second repair event missing')
    expect(secondRepair.sourceEventSeqs).toEqual([firstApply.receipt.appendedSeq, second.seq, first.seq])
    expect(harnessed.session.snapshotEvents()[first.seq]).toEqual(firstEvent)
    expect(harnessed.session.snapshotEvents()[second.seq]).toEqual(second)
  })

  it('enforces replacement, preview, and artifact byte budgets loudly', async () => {
    const replacement = await harness('enpoi-keeper', undefined, { maxReplacementChars: 5 })
    await expect(replacement.controller.contextRepairPreview({
      sessionId: replacement.session.id,
      target: targetOf(replacement.session),
    })).rejects.toMatchObject({ details: { reason: 'replacement-too-large' } })

    const preview = await harness('enpoi-keeper', undefined, { maxPreviewBytes: 10 })
    await expect(preview.controller.contextRepairPreview({
      sessionId: preview.session.id,
      target: targetOf(preview.session),
    })).rejects.toMatchObject({ details: { reason: 'preview-too-large' } })

    const artifact = await harness('enpoi-keeper', undefined, { maxArtifactBytes: 1 })
    const target = targetOf(artifact.session)
    const artifactPreview = await artifact.controller.contextRepairPreview({
      sessionId: artifact.session.id,
      target,
    })
    const seq = artifact.session.seq
    await expect(artifact.controller.contextRepairApply({
      sessionId: artifact.session.id,
      previewId: artifactPreview.previewId,
      fingerprint: artifactPreview.fingerprint,
    })).rejects.toMatchObject({ code: 'session/context-repair-backup-failed' })
    expect(artifact.session.seq).toBe(seq)
  })
})

describe('real AgentLoop composition', () => {
  it('applies through the production Agent maintenance fence and backs up a compressed artifact', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const persistenceRoot = await temporaryRoot('dsh-context-repair-real-persistence-')
    const backupRoot = await temporaryRoot('dsh-context-repair-real-backup-')
    await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'zstd' })
    const controller = createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: '/tmp',
      contextRepairBackupRoot: backupRoot,
    })
    const loop = await mountAgentLoopTestHarness(ctx)
    const sessionId = SessionId('context-repair-real-agent')
    const agent = await loop.create(sessionId, { provider: 'fixture', model: 'fixture-model' }, { cwd: '/workspace' })
    const text = '### State checkpoint\n\nStale line that needs one exact correction\n\nkept'
    const checkpoint = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'enpoi-keeper' },
    }), { surfaceOp: 'append' })
    await ctx.sessions.flush(agent.session)
    interface ResolvedJsonlProvider extends SessionPersistence {
      resolveCurrentLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
    }
    const provider = ctx.sessionPersistence as ResolvedJsonlProvider
    const artifactPath = await provider.resolveCurrentLog(sessionId)
    if (artifactPath === undefined) throw new Error('real JSONL artifact was not materialized')
    const artifactBefore = await readFile(artifactPath)
    const target = {
      seq: checkpoint.seq,
      blockIndex: 0,
      expectedBlockSha256: sha256Hex(text),
      expectedOldLineSha256: sha256Hex('Stale line that needs one exact correction'),
      replacementLine: 'Corrected line through a real maintenance fence',
    }
    const preview = await controller.contextRepairPreview({ sessionId, target })
    const applied = await controller.contextRepairApply({
      sessionId,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })
    expect(applied.status).toBe('applied')
    expect(applied.receipt.artifactSizeBytes).toBe(artifactBefore.byteLength)
    const backupBytes = await readFile(applied.receipt.backupPath)
    expect(backupBytes.equals(artifactBefore)).toBe(true)
    expect(sha256Bytes(backupBytes)).toBe(applied.receipt.backupSha256)
    expect(applied.receipt.logicalHead.seq).toBe(checkpoint.seq)
    expect(applied.receipt.logicalHead.sha256).toBe(preview.head.sha256)
    expect(agent.status).toBe('idle')
    expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message' || event.type === 'turn/start')).toBe(false)
    const derived = agent.session.deriveMessages().find(message => message.id === checkpoint.data.id)
    const derivedText = derived?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    expect(derivedText).toContain('Corrected line through a real maintenance fence')
    expect(agent.session.snapshotEvents()[checkpoint.seq]).toEqual(checkpoint)
    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const stored = await handle.read()
      expect(stored.events[checkpoint.seq]).toEqual(checkpoint)
      expect(stored.events.at(-1)?.type).toBe('user/message')
    } finally {
      await handle.close()
    }
  })
})

describe('backup root policy', () => {
  it('defaults under DSH_HOME and refuses relative or unsupported tilde roots', () => {
    const previous = process.env.DSH_HOME
    const home = join(tmpdir(), 'dsh-context-repair-home-policy')
    process.env.DSH_HOME = home
    try {
      expect(defaultContextRepairBackupRoot()).toBe(join(home, 'backups', 'context-repair'))
      expect(() => resolveContextRepairBackupRoot('relative/root')).toThrow(/absolute/)
      expect(() => resolveContextRepairBackupRoot('~someone/root')).toThrow(/home prefixes/)
      expect(resolveContextRepairBackupRoot('~/private')).toBe(join(process.env.HOME ?? '', 'private'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('context repair limits', () => {
  it('keeps the failure shape stable through remoteErrorOf', async () => {
    const harnessed = await harness()
    const failure = await harnessed.controller.contextRepairPreview({
      sessionId: harnessed.session.id,
      target: { ...targetOf(harnessed.session), expectedBlockSha256: sha256Hex('wrong') },
    }).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'session/context-repair-invalid',
      details: { sessionId: harnessed.session.id, reason: 'block-hash-mismatch' },
    })
    expect(harnessed.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(true)
  })

  it('preserves a compaction checkpoint source and appends no checkpoint or compaction bracket', async () => {
    const harnessed = await harness('compact-checkpoint')
    const target = targetOf(harnessed.session)
    const before = harnessed.session.snapshotEvents()
    const preview = await harnessed.controller.contextRepairPreview({ sessionId: harnessed.session.id, target })
    const applied = await harnessed.controller.contextRepairApply({
      sessionId: harnessed.session.id,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })
    expect(applied.status).toBe('applied')
    const after = harnessed.session.snapshotEvents()
    const appended = after.find(event => event.seq === applied.receipt.appendedSeq)
    if (appended?.type !== 'user/message') throw new Error('compaction repair event missing')
    expect(appended.data.source).toEqual({ kind: 'compact-checkpoint', compactionId: 'compaction-fixture' })
    expect(after.slice(before.length).map(event => event.type)).toEqual(['user/message'])
    expect(after.slice(before.length).some(event => event.type === 'compaction/start' || event.type === 'compaction/end')).toBe(false)
    expect(after.some(event => event.type === 'state/checkpoint')).toBe(false)
  })
})
