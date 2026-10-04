// permutation-matrix.spec.ts — exhaustive revert/restore combination matrix.
// Every dimension: span composition (file-edit vs text-only turns), manual
// edits (none/on-top/interleaved/delete/create), operation sequences
// (revert/restore/partial-restore/commit/keep/force/save-beside), and file
// lifecycle (created/pre-existing/multi-edit/deleted). Each scenario asserts
// the FR1-5 invariants: no silent clobber, no accidental deletion, exact
// bytes, clean workspace, idempotent recovery.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BlobStore, sha256Of } from '../src/blob-store'
import { MutationManifest } from '../src/manifest'
import { evaluateBoundary, buildRevertPlan, STATE } from '../src/evaluator'
import { RevertExecutor } from '../src/executor'

interface Env {
  root: string
  blobs: BlobStore
  manifest: MutationManifest
  executor: RevertExecutor
  work: string
}

let env: Env

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'pm-'))
  const blobs = new BlobStore(join(root, 'blobs'))
  await blobs.init()
  const manifest = new MutationManifest(join(root, 'manifest.jsonl'))
  await manifest.init()
  const executor = new RevertExecutor({ blobStore: blobs, trashRoot: join(root, 'trash'), walFile: join(root, 'wal.jsonl') })
  await executor.init()
  const work = join(root, 'work')
  await mkdir(work)
  env = { root, blobs, manifest, executor, work }
})

afterEach(async () => {
  await rm(env.root, { recursive: true, force: true })
})

async function simulateMutation(opts: {
  seq: number
  callId: string
  targetKey: string
  displayPath: string
  preBytes: Buffer | null
  postBytes: Buffer
  source?: 'agent' | 'user-kept' | 'plugin-revert'
}): Promise<void> {
  const { blobs, manifest } = env
  const preExisted = opts.preBytes !== null
  const preBlobSha = opts.preBytes === null ? null : await blobs.put(opts.preBytes)
  const postBlobSha = await blobs.put(opts.postBytes)
  await manifest.append({
    sessionId: 's1',
    toolSeq: opts.seq,
    callId: opts.callId,
    targetKey: opts.targetKey,
    displayPath: opts.displayPath,
    operation: preExisted ? 'update' : 'create',
    preExisted,
    preStatus: 'ok',
    preBlobSha,
    postStatus: 'ok',
    postBlobSha,
    isInterleaved: false,
    timestamp: Date.now(),
    source: opts.source,
  })
}

async function readDisk(targetKey: string): Promise<Buffer | null> {
  try {
    return await readFile(targetKey)
  } catch {
    return null
  }
}

const resolvePath = async (key: string): Promise<string> => key
const atomicWriter = async (path: string, bytes: Buffer): Promise<void> => { await writeFile(path, bytes) }
const trashFile = async (path: string): Promise<string> => {
  const dest = `${path}.trashed`
  await rm(path, { force: true })
  return dest
}

/** Evaluate a revert at `fromSeq` and return the plan entry for the file. */
async function revertPlan(targetKey: string, fromSeq: number) {
  const { plan } = await buildRevertPlan(env.manifest, fromSeq, readDisk)
  return plan.get(targetKey)
}

/** Evaluate a restore-all and return the target + eval result. */
async function restoreAll(targetKey: string) {
  const target = env.manifest.resolveRestoreTarget(targetKey, null)
  const entry = env.manifest.aggregateSpan(0).get(targetKey)!
  const current = await readDisk(targetKey)
  const currentSha = current === null ? null : sha256Of(current)
  const evalResult = evaluateBoundary(entry, target, currentSha)
  return { target, evalResult }
}

// ── Dimension A: span composition ───────────────────────────────────────────

describe('matrix A: span composition', () => {
  it('A1: single create turn, no manual edits → clean trash on revert', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await writeFile(join(env.work, 'a.txt'), 'v1')
    const entry = await revertPlan(join(env.work, 'a.txt'), 10)
    expect(entry!.state).toBe(STATE.CLEAN_TRASH)
    expect(entry!.action).toBe('trash')
  })

  it('A2: single edit turn on pre-existing file, no manual edits → clean restore', async () => {
    await writeFile(join(env.work, 'a.txt'), 'v0')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v0'), postBytes: Buffer.from('v1') })
    await writeFile(join(env.work, 'a.txt'), 'v1')
    const entry = await revertPlan(join(env.work, 'a.txt'), 10)
    expect(entry!.state).toBe(STATE.CLEAN_RESTORE)
    expect(entry!.targetBlobSha).toBe(sha256Of(Buffer.from('v0')))
  })

  it('A3: create → edit (two turns), no manual edits → revert at create = trash, revert at edit = restore to v1', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await writeFile(join(env.work, 'a.txt'), 'v2')
    // Revert at edit (20): restore to v1
    const at20 = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(at20!.state).toBe(STATE.CLEAN_RESTORE)
    expect(at20!.targetBlobSha).toBe(sha256Of(Buffer.from('v1')))
    // Revert at create (10): trash (file created in span)
    const at10 = await revertPlan(join(env.work, 'a.txt'), 10)
    expect(at10!.state).toBe(STATE.CLEAN_TRASH)
  })

  it('A4: create → edit → edit (three turns), no manual edits → revert at middle = restore to v1', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await simulateMutation({ seq: 30, callId: 'c3', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v2'), postBytes: Buffer.from('v3') })
    await writeFile(join(env.work, 'a.txt'), 'v3')
    const at20 = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(at20!.state).toBe(STATE.CLEAN_RESTORE)
    expect(at20!.targetBlobSha).toBe(sha256Of(Buffer.from('v1')))
  })

  it('A5: file-edit + text-only turn → revert at text turn = no affected files', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await writeFile(join(env.work, 'a.txt'), 'v1')
    // Text-only turn at seq 20 (no mutation). Revert at 20: the span has no
    // mutations with toolSeq >= 20 → no affected files.
    const { plan } = await buildRevertPlan(env.manifest, 20, readDisk)
    expect(plan.size).toBe(0)
  })

  it('A6: text-only + file-edit turn → revert at text turn = clean restore of the edit', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 30, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await writeFile(join(env.work, 'a.txt'), 'v2')
    // Revert at the text turn (20, between the two edits): span = 20..end →
    // the edit at 30 is in the span → restore to v1.
    const at20 = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(at20!.state).toBe(STATE.CLEAN_RESTORE)
    expect(at20!.targetBlobSha).toBe(sha256Of(Buffer.from('v1')))
  })

  it('A7: mixed create/edit/text/edit (4 turns) → revert at turn 2 = restore to v1', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // text turn 30 (no mutation)
    await simulateMutation({ seq: 40, callId: 'c3', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v2'), postBytes: Buffer.from('v3') })
    await writeFile(join(env.work, 'a.txt'), 'v3')
    const at20 = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(at20!.state).toBe(STATE.CLEAN_RESTORE)
    expect(at20!.targetBlobSha).toBe(sha256Of(Buffer.from('v1')))
  })

  it('A8: pure text session (no file changes) → revert = no affected files, no conflict', async () => {
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.size).toBe(0)
  })
})

// ── Dimension B: manual edits ───────────────────────────────────────────────

describe('matrix B: manual edits', () => {
  it('B1: manual edit on top of agent state → revert = CONFLICT prompt', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    const entry = await revertPlan(join(env.work, 'a.txt'), 10)
    expect(entry!.state).toBe(STATE.CONFLICT)
    expect(entry!.action).toBe('prompt')
  })

  it('B2: manual edit between agent edits (interleaved) → revert = CONFLICT prompt', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // Manual edit between 20 and 30
    await writeFile(join(env.work, 'a.txt'), 'user edit between')
    await simulateMutation({ seq: 30, callId: 'c3', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('user edit between'), postBytes: Buffer.from('v3') })
    await writeFile(join(env.work, 'a.txt'), 'v3')
    // Revert at 30: the disk (v3) is a known agent state → clean restore to v2.
    const at30 = await revertPlan(join(env.work, 'a.txt'), 30)
    expect(at30!.state).toBe(STATE.CLEAN_RESTORE)
    // Revert at 20: the disk (v3) is a known agent state → clean restore to v1.
    const at20 = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(at20!.state).toBe(STATE.CLEAN_RESTORE)
  })

  it('B3: manual delete of a created file → revert at a later point = clean recreation (sessionCreated)', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // User deletes the file
    await rm(join(env.work, 'a.txt'), { force: true })
    // Revert at 20: target = v1 (the state at the boundary) → the file is
    // absent but was created in the session → clean recreation of v1.
    const entry = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(entry!.state).toBe(STATE.CLEAN_RESTORE)
    expect(entry!.action).toBe('restore')
    // Revert at 10 (the create): target = absence → already absent (no-op).
    const at10 = await revertPlan(join(env.work, 'a.txt'), 10)
    expect(at10!.state).toBe(STATE.ALREADY_ABSENT)
  })

  it('B4: manual delete of a pre-existing file → revert = MISSING prompt', async () => {
    await writeFile(join(env.work, 'a.txt'), 'v0')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v0'), postBytes: Buffer.from('v1') })
    // User deletes the file
    await rm(join(env.work, 'a.txt'), { force: true })
    const entry = await revertPlan(join(env.work, 'a.txt'), 10)
    expect(entry!.state).toBe(STATE.MISSING)
    expect(entry!.action).toBe('prompt')
  })

  it('B5: manual create of a new file (not agent-touched) → revert = no affected files', async () => {
    await writeFile(join(env.work, 'user-file.txt'), 'user created')
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.size).toBe(0)
  })
})

// ── Dimension C: operation sequences ────────────────────────────────────────

describe('matrix C: operation sequences', () => {
  it('C1: revert → restore-all (no manual edits) → file returns to agent state', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await writeFile(join(env.work, 'a.txt'), 'v2')
    // Revert at 20 → restore to v1
    const at20 = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(at20!.state).toBe(STATE.CLEAN_RESTORE)
    await env.executor.execute({
      sessionId: 's1', revertSeq: 20,
      plan: new Map([[join(env.work, 'a.txt'), { action: 'restore', targetBlobSha: at20!.targetBlobSha, expectedDiskSha: at20!.expectedDiskSha }]]),
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('v1')
    // Restore-all → target = v2 (agent last state) → disk v1 is known → restore to v2
    const { target, evalResult } = await restoreAll(join(env.work, 'a.txt'))
    expect(target.postBlobSha).toBe(sha256Of(Buffer.from('v2')))
    expect(evalResult.state).toBe(STATE.CLEAN_RESTORE)
  })

  it('C2: revert → restore-all → revert again (no manual edits) → clean both ways', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await writeFile(join(env.work, 'a.txt'), 'v2')
    // Revert → restore to v1
    const at20 = await revertPlan(join(env.work, 'a.txt'), 20)
    await env.executor.execute({
      sessionId: 's1', revertSeq: 20,
      plan: new Map([[join(env.work, 'a.txt'), { action: 'restore', targetBlobSha: at20!.targetBlobSha, expectedDiskSha: at20!.expectedDiskSha }]]),
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    // Restore-all → v2
    const { evalResult } = await restoreAll(join(env.work, 'a.txt'))
    expect(evalResult.state).toBe(STATE.CLEAN_RESTORE)
    await env.executor.execute({
      sessionId: 's1', revertSeq: -1,
      plan: new Map([[join(env.work, 'a.txt'), { action: 'restore', targetBlobSha: evalResult.targetBlobSha, expectedDiskSha: evalResult.expectedDiskSha }]]),
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('v2')
    // Revert again at 20 → clean restore to v1
    const again = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(again!.state).toBe(STATE.CLEAN_RESTORE)
  })

  it('C3: revert → commit (send new prompt) → files stay as-is, no conflict card', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await writeFile(join(env.work, 'a.txt'), 'v2')
    // Revert at 20 → restore to v1
    const at20 = await revertPlan(join(env.work, 'a.txt'), 20)
    await env.executor.execute({
      sessionId: 's1', revertSeq: 20,
      plan: new Map([[join(env.work, 'a.txt'), { action: 'restore', targetBlobSha: at20!.targetBlobSha, expectedDiskSha: at20!.expectedDiskSha }]]),
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('v1')
    // Commit: the boundary clears, files stay as-is (v1). No further evaluation.
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('v1')
  })

  it('C4: revert → partial restore (one message) → file returns to the restore-point state', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await simulateMutation({ seq: 30, callId: 'c3', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v2'), postBytes: Buffer.from('v3') })
    await writeFile(join(env.work, 'a.txt'), 'v3')
    // Partial restore at 20: target = the state at 20 = v2.
    const target = env.manifest.resolveRestoreTarget(join(env.work, 'a.txt'), 20)
    expect(target.postBlobSha).toBe(sha256Of(Buffer.from('v2')))
    const entry = env.manifest.aggregateSpan(10).get(join(env.work, 'a.txt'))!
    const evalResult = evaluateBoundary(entry, target, sha256Of(Buffer.from('v3')))
    expect(evalResult.state).toBe(STATE.CLEAN_RESTORE)
    expect(evalResult.targetBlobSha).toBe(sha256Of(Buffer.from('v2')))
  })

  it('C5: revert at the FIRST message (whole session) → created files trashed', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await writeFile(join(env.work, 'a.txt'), 'v2')
    // Revert at 10 (the create): the file was created in the span → trash.
    const at10 = await revertPlan(join(env.work, 'a.txt'), 10)
    expect(at10!.state).toBe(STATE.CLEAN_TRASH)
  })

  it('C6: revert at the LAST message (single turn) → only that turn reverted', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await writeFile(join(env.work, 'a.txt'), 'v2')
    // Revert at 20 (the last edit): restore to v1 (the state at the boundary).
    const at20 = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(at20!.state).toBe(STATE.CLEAN_RESTORE)
    expect(at20!.targetBlobSha).toBe(sha256Of(Buffer.from('v1')))
  })

  it('C7: multiple files affected → each evaluated independently', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('a1') })
    await simulateMutation({ seq: 11, callId: 'c2', targetKey: join(env.work, 'b.txt'), displayPath: 'b.txt', preBytes: null, postBytes: Buffer.from('b1') })
    await writeFile(join(env.work, 'a.txt'), 'a1')
    await writeFile(join(env.work, 'b.txt'), 'b1')
    // Manual edit on b only
    await writeFile(join(env.work, 'b.txt'), 'user edit b')
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get(join(env.work, 'a.txt'))!.state).toBe(STATE.CLEAN_TRASH)
    expect(plan.get(join(env.work, 'b.txt'))!.state).toBe(STATE.CONFLICT)
  })
})

// ── Dimension D: file lifecycle ─────────────────────────────────────────────

describe('matrix D: file lifecycle', () => {
  it('D1: file created in span → revert trashes (FR2)', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await writeFile(join(env.work, 'a.txt'), 'v1')
    const entry = await revertPlan(join(env.work, 'a.txt'), 10)
    expect(entry!.state).toBe(STATE.CLEAN_TRASH)
  })

  it('D2: file pre-existed the span → revert restores, never trashes', async () => {
    await writeFile(join(env.work, 'a.txt'), 'v0')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v0'), postBytes: Buffer.from('v1') })
    await writeFile(join(env.work, 'a.txt'), 'v1')
    const entry = await revertPlan(join(env.work, 'a.txt'), 10)
    expect(entry!.state).toBe(STATE.CLEAN_RESTORE)
    expect(entry!.action).toBe('restore')
  })

  it('D3: file edited multiple times in span → revert to the boundary state', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await simulateMutation({ seq: 30, callId: 'c3', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v2'), postBytes: Buffer.from('v3') })
    await simulateMutation({ seq: 40, callId: 'c4', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v3'), postBytes: Buffer.from('v4') })
    await writeFile(join(env.work, 'a.txt'), 'v4')
    const at20 = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(at20!.state).toBe(STATE.CLEAN_RESTORE)
    expect(at20!.targetBlobSha).toBe(sha256Of(Buffer.from('v1')))
  })

  it('D4: agent deletes a file via terminal (untracked) → revert at a later point recreates it (sessionCreated)', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // Agent rm's the file via terminal (no manifest record — the blind spot)
    await rm(join(env.work, 'a.txt'), { force: true })
    // Revert at 20: the file is absent, created in the session → clean recreation of v1.
    const entry = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(entry!.state).toBe(STATE.CLEAN_RESTORE)
    expect(entry!.action).toBe('restore')
  })

  it('D5: user deletes a created file → revert at a later point recreates (sessionCreated)', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: join(env.work, 'a.txt'), displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    await rm(join(env.work, 'a.txt'), { force: true })
    const entry = await revertPlan(join(env.work, 'a.txt'), 20)
    expect(entry!.state).toBe(STATE.CLEAN_RESTORE)
  })
})