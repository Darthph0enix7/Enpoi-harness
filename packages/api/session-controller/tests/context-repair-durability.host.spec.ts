/** Context-repair backup ancestor-directory durability coverage. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentCancelCause, type CancelOptions, type InboxTarget } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  canonicalJson,
  createContextRepairBackupDirectory,
  sha256Hex,
} from '../src/context-repair.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const fsSpy = vi.hoisted(() => ({
  recording: false,
  syncedPaths: [] as string[],
  events: [] as Array<{ readonly kind: 'sync' | 'append'; readonly path?: string }>,
  failSyncPath: undefined as string | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      const handle = await actual.open(...args)
      const openedPath = resolve(String(args[0]))
      if (!fsSpy.recording || args[1] !== 'r') return handle
      const originalSync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (fsSpy.failSyncPath !== undefined && openedPath === resolve(fsSpy.failSyncPath)) {
          throw Object.assign(new Error(`simulated sync failure on ${openedPath}`), { code: 'EIO' })
        }
        fsSpy.syncedPaths.push(openedPath)
        fsSpy.events.push({ kind: 'sync', path: openedPath })
        await originalSync()
      }
      return handle
    },
  }
})

const temporaryRoots: string[] = []

afterEach(async () => {
  fsSpy.recording = false
  fsSpy.syncedPaths.length = 0
  fsSpy.events.length = 0
  fsSpy.failSyncPath = undefined
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

class RepairTestAgent implements Agent {
  readonly options = { provider: 'fixture', model: 'fixture-model' }
  readonly inbox = createInboxStub()
  status: 'idle' | 'running' = 'idle'

  constructor(readonly ctx: Context, readonly session: Session) {}

  get id(): SessionId {
    return this.session.id
  }

  cancel(_cause: AgentCancelCause, _options?: CancelOptions): void {}
  whenIdle(): Promise<undefined> { return Promise.resolve(undefined) }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return job(new AbortController().signal)
  }

  send(message: UserMessage, target: InboxTarget, _wakeup: boolean): void {
    this.inbox.append(target, message)
  }

  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  inject(message: UserMessage): void { this.send(message, 'next-step', false) }
}

describe('context repair backup ancestor durability', () => {
  it.skipIf(process.platform === 'win32')('fsyncs every newly created ancestor directory entry up to the existing root', async () => {
    const existingBase = await temporaryRoot('dsh-context-repair-ancestors-')
    const nestedBackupRoot = join(existingBase, 'level-1', 'level-2', 'context-repair')

    fsSpy.recording = true
    const createdDir = await createContextRepairBackupDirectory(nestedBackupRoot)

    expect(fsSpy.syncedPaths).toEqual([
      resolve(existingBase),
      resolve(join(existingBase, 'level-1')),
      resolve(join(existingBase, 'level-1', 'level-2')),
      resolve(nestedBackupRoot),
    ])
    expect(dirname(createdDir)).toBe(resolve(nestedBackupRoot))
  })

  it.skipIf(process.platform === 'win32')('fsyncs all created backup ancestors before session.append commits during contextRepairApply', async () => {
    const persistenceRoot = await temporaryRoot('dsh-context-repair-durability-persist-')
    const existingBase = await temporaryRoot('dsh-context-repair-durability-base-')
    const nestedBackupRoot = join(existingBase, 'tier-1', 'tier-2', 'context-repair')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('context-repair-durability')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    const store: { header: SessionHeader; events: readonly SessionEvent[]; artifactPath: string } = {
      header,
      events: [],
      artifactPath: join(persistenceRoot, `${sessionId}.jsonl`),
    }
    ctx.provide('sessionPersistence', {
      ...testSessionPersistence(ctx, {
        list: () => Promise.resolve([store.header]),
        inspect: id => Promise.resolve(id === store.header.id ? { meta: store.header, events: store.events } : undefined),
      }),
      resolveCurrentLog: async (id: SessionId) => (id === store.header.id ? store.artifactPath : undefined),
    } as never)

    const controller = createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: '/tmp',
      contextRepairBackupRoot: nestedBackupRoot,
    })
    const session = ctx.sessions.create(sessionId, { meta: header })
    const checkpointText = '### State checkpoint\nStale line that needs durable backup\nkept'
    const checkpoint = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: checkpointText }],
      source: { kind: 'enpoi-keeper' },
    }), { surfaceOp: 'append' })
    const agent = new RepairTestAgent(ctx, session)
    await ctx.agents.register(agent)

    const writeArtifact = async (): Promise<void> => {
      store.events = [...session.snapshotEvents()]
      await writeFile(
        store.artifactPath,
        store.events.map(event => `${canonicalJson(event)}\n`).join(''),
        { mode: 0o600 },
      )
    }
    await writeArtifact()
    ctx.on('session/flush', async (subject) => {
      if (subject.id === sessionId) await writeArtifact()
    })

    const preview = await controller.contextRepairPreview({
      sessionId,
      target: {
        seq: checkpoint.seq,
        blockIndex: 0,
        expectedBlockSha256: sha256Hex(checkpointText),
        expectedOldLineSha256: sha256Hex('Stale line that needs durable backup'),
        replacementLine: 'Repaired line after durable ancestor sync',
      },
    })

    const originalAppend = session.append.bind(session)
    const appendSpy = vi.spyOn(session, 'append').mockImplementation(((...args: unknown[]) => {
      fsSpy.events.push({ kind: 'append' })
      return Reflect.apply(originalAppend, session, args)
    }) as Session['append'])

    fsSpy.recording = true
    const applied = await controller.contextRepairApply({
      sessionId,
      previewId: preview.previewId,
      fingerprint: preview.fingerprint,
    })
    fsSpy.recording = false

    expect(applied.status).toBe('applied')
    expect(appendSpy).toHaveBeenCalledOnce()

    const appendIndex = fsSpy.events.findIndex(entry => entry.kind === 'append')
    expect(appendIndex).toBeGreaterThan(0)
    const syncedBeforeAppend = fsSpy.events
      .slice(0, appendIndex)
      .filter(entry => entry.kind === 'sync')
      .map(entry => entry.path)

    for (const expectedAncestor of [
      resolve(existingBase),
      resolve(join(existingBase, 'tier-1')),
      resolve(join(existingBase, 'tier-1', 'tier-2')),
      resolve(nestedBackupRoot),
      resolve(applied.receipt.directory),
    ]) {
      expect(syncedBeforeAppend).toContain(expectedAncestor)
    }

    // Also verify a sync failure on a newly created ancestor aborts before append.
    const failBase = await temporaryRoot('dsh-context-repair-fail-base-')
    const failRoot = join(failBase, 'fail-1', 'fail-2')
    await mkdir(failBase, { recursive: true })
    fsSpy.failSyncPath = join(failBase, 'fail-1')
    fsSpy.recording = true
    await expect(createContextRepairBackupDirectory(failRoot)).rejects.toThrow(/simulated sync failure/)

    await ctx.fiber.dispose()
  })
})
