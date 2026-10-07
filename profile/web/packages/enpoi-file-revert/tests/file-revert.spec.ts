// file-revert.spec.ts — vitest suite for enpoi-file-revert core logic.
// Ports the sandbox spike tests (26/26) against the TypeScript modules.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BlobStore, sha256Of } from '../src/blob-store'
import { MutationManifest } from '../src/manifest'
import { evaluateFile, evaluateBoundary, buildRevertPlan, STATE } from '../src/evaluator'
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
  const root = await mkdtemp(join(tmpdir(), 'fr-'))
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
  preStatus?: 'ok' | 'too-large' | 'unreadable'
  postStatus?: 'ok' | 'too-large' | 'unreadable'
}): Promise<void> {
  const { blobs, manifest, work } = env
  const preExisted = opts.preBytes !== null
  const preStatus = opts.preStatus ?? 'ok'
  const postStatus = opts.postStatus ?? 'ok'
  const preBlobSha = opts.preBytes === null ? null : await blobs.put(opts.preBytes)
  const postBlobSha = postStatus === 'ok' ? await blobs.put(opts.postBytes) : null
  await manifest.append({
    sessionId: 's1',
    toolSeq: opts.seq,
    callId: opts.callId,
    targetKey: opts.targetKey,
    displayPath: opts.displayPath,
    operation: preExisted ? 'update' : 'create',
    preExisted,
    preStatus,
    preBlobSha,
    postStatus,
    postBlobSha,
    isInterleaved: false,
    timestamp: Date.now(),
  })
  await writeFile(join(work, opts.targetKey), opts.postBytes)
}

const readDisk = async (targetKey: string): Promise<Buffer | null> => {
  // Path-aware: the executor may pass a RESOLVED absolute path (beside
  // writes); join only relative keys onto the work dir.
  const p = targetKey.startsWith('/') ? targetKey : join(env.work, targetKey)
  try { return await readFile(p) } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err }
}
const resolvePath = async (targetKey: string): Promise<string> => join(env.work, targetKey)
const atomicWriter = async (p: string, b: Buffer): Promise<void> => env.executor.atomicWrite(p, b)
const trashFile = async (p: string): Promise<string> => env.executor.trash(p, 's1')

async function runPlan(plan: Map<string, { action: string; targetBlobSha: string | null; expectedDiskSha: string | null }>, revertSeq = 10) {
  return env.executor.execute({
    sessionId: 's1', revertSeq, plan,
    resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
  })
}

describe('evaluator state machine', () => {
  it('clean restore: edit then revert restores pre-agent content', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    const { plan, conflicts, clean } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(conflicts).toHaveLength(0)
    expect(clean).toHaveLength(1)
    expect(plan.get('a.txt')?.state).toBe(STATE.CLEAN_RESTORE)
    const { outcomes, sealed } = await runPlan(plan)
    expect(sealed).toBe(true)
    expect(outcomes['a.txt']?.status).toBe('restored')
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('original')
  })

  it('clean trash: created file reverts to trash, not deletion', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'new.txt', displayPath: 'new.txt', preBytes: null, postBytes: Buffer.from('created by agent') })
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get('new.txt')?.state).toBe(STATE.CLEAN_TRASH)
    const { outcomes } = await runPlan(plan)
    expect(outcomes['new.txt']?.status).toBe('trashed')
    await expect(readFile(join(env.work, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('already clean: disk at pre-state -> no-op', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await writeFile(join(env.work, 'a.txt'), 'original')
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get('a.txt')?.state).toBe(STATE.ALREADY_CLEAN)
    const { outcomes } = await runPlan(plan)
    expect(outcomes['a.txt']?.status).toBe('no_op')
  })

  it('conflict: user edit on top -> prompt, disk untouched', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    const { plan, conflicts } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get('a.txt')?.state).toBe(STATE.CONFLICT)
    expect(conflicts).toHaveLength(1)
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('user manual edit')
  })

  it('already absent: created file already deleted by user -> no-op', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'new.txt', displayPath: 'new.txt', preBytes: null, postBytes: Buffer.from('x') })
    await rm(join(env.work, 'new.txt'))
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get('new.txt')?.state).toBe(STATE.ALREADY_ABSENT)
  })

  it('missing: pre-existing file deleted on disk -> prompt with recreate option', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await rm(join(env.work, 'a.txt'))
    const { plan, conflicts } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get('a.txt')?.state).toBe(STATE.MISSING)
    expect(conflicts).toHaveLength(1)
    expect(plan.get('a.txt')?.targetBlobSha).not.toBeNull()
  })

  it('unavailable pre-state: >maxBytes file -> skip, never delete', async () => {
    await writeFile(join(env.work, 'big.bin'), Buffer.alloc(1024, 1))
    await simulateMutation({
      seq: 10, callId: 'c1', targetKey: 'big.bin', displayPath: 'big.bin',
      preBytes: Buffer.alloc(1024, 1), postBytes: Buffer.alloc(1024, 2), preStatus: 'too-large',
    })
    const { plan, conflicts } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get('big.bin')?.state).toBe(STATE.UNAVAILABLE)
    expect(conflicts).toHaveLength(1)
    const bytes = await readFile(join(env.work, 'big.bin'))
    expect(bytes[0]).toBe(2)
  })

  it('postStatus unreadable: null post-blob -> unavailable prompt', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({
      seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt',
      preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit'), postStatus: 'unreadable',
    })
    const { plan, conflicts } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get('a.txt')?.state).toBe(STATE.UNAVAILABLE)
    expect(conflicts).toHaveLength(1)
  })

  it('CRLF fidelity: raw bytes round-trip without line-ending mangling', async () => {
    const crlfPre = Buffer.from('line1\r\nline2\r\n', 'utf8')
    const crlfPost = Buffer.from('line1\r\nline2 CHANGED\r\n', 'utf8')
    await writeFile(join(env.work, 'win.txt'), crlfPre)
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'win.txt', displayPath: 'win.txt', preBytes: crlfPre, postBytes: crlfPost })
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get('win.txt')?.state).toBe(STATE.CLEAN_RESTORE)
    const { outcomes } = await runPlan(plan)
    expect(outcomes['win.txt']?.status).toBe('restored')
    expect(await readFile(join(env.work, 'win.txt'))).toEqual(crlfPre)
  })

  it('binary fidelity: non-UTF8 bytes round-trip exactly', async () => {
    const binPre = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x01])
    const binPost = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x02])
    await writeFile(join(env.work, 'bin.dat'), binPre)
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'bin.dat', displayPath: 'bin.dat', preBytes: binPre, postBytes: binPost })
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get('bin.dat')?.state).toBe(STATE.CLEAN_RESTORE)
    const { outcomes } = await runPlan(plan)
    expect(await readFile(join(env.work, 'bin.dat'))).toEqual(binPre)
  })

  it('multi-file batch: clean files revert, conflicted file prompts', async () => {
    await writeFile(join(env.work, 'clean.txt'), 'orig')
    await writeFile(join(env.work, 'dirty.txt'), 'orig2')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'clean.txt', displayPath: 'clean.txt', preBytes: Buffer.from('orig'), postBytes: Buffer.from('agent1') })
    await simulateMutation({ seq: 11, callId: 'c2', targetKey: 'dirty.txt', displayPath: 'dirty.txt', preBytes: Buffer.from('orig2'), postBytes: Buffer.from('agent2') })
    await writeFile(join(env.work, 'dirty.txt'), 'user edit')
    const { plan, conflicts, clean } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(clean).toHaveLength(1)
    expect(conflicts).toHaveLength(1)
    const { outcomes } = await runPlan(plan)
    expect(outcomes['clean.txt']?.status).toBe('restored')
    expect(outcomes['dirty.txt']?.status).toBe('pending_conflict')
    expect(await readFile(join(env.work, 'dirty.txt'), 'utf8')).toBe('user edit')
  })
})

describe('partial restore & interleaving', () => {
  it('restoreSeq picks latest mutation at or before seq', async () => {
    await writeFile(join(env.work, 'a.txt'), 'v0')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v0'), postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    const t15 = env.manifest.resolveRestoreTarget('a.txt', 15)
    expect(t15.postBlobSha).toBe(env.manifest.records[0].postBlobSha)
    const t25 = env.manifest.resolveRestoreTarget('a.txt', 25)
    expect(t25.postBlobSha).toBe(env.manifest.records[1].postBlobSha)
    const t5 = env.manifest.resolveRestoreTarget('a.txt', 5)
    expect(t5.preBlobSha).toBe(env.manifest.records[0].preBlobSha)
    expect(t5.postBlobSha).toBeNull()
    const tNull = env.manifest.resolveRestoreTarget('a.txt', null)
    expect(tNull.postBlobSha).toBe(env.manifest.records[1].postBlobSha)
  })

  it('partial restore execution: mid-span restore writes the resolved state', async () => {
    await writeFile(join(env.work, 'a.txt'), 'v0')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v0'), postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    const target = env.manifest.resolveRestoreTarget('a.txt', 15)
    const plan = new Map([[ 'a.txt', {
      action: 'restore', targetBlobSha: target.postBlobSha, expectedDiskSha: sha256Of(Buffer.from('v2')),
    } ]])
    const { outcomes } = await runPlan(plan, 15)
    expect(outcomes['a.txt']?.status).toBe('restored')
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('v1')
  })

  it('interleaved chain: parallel same-file writes flagged; mid-span restore refused', async () => {
    await simulateMutation({ seq: 10, callId: 'cA', targetKey: 'f.txt', displayPath: 'f.txt', preBytes: Buffer.from('v0'), postBytes: Buffer.from('vB') })
    await simulateMutation({ seq: 11, callId: 'cB', targetKey: 'f.txt', displayPath: 'f.txt', preBytes: Buffer.from('v0'), postBytes: Buffer.from('vB') })
    expect(env.manifest.records[1].isInterleaved).toBe(true)
    expect(env.manifest.resolveRestoreTarget('f.txt', 10).isInterleaved).toBe(true)
    expect(env.manifest.resolveRestoreTarget('f.txt', 11).isInterleaved).toBe(true)
  })

  it('boundary evaluation: restore-all targets finalPost', async () => {
    await writeFile(join(env.work, 'a.txt'), 'v0')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v0'), postBytes: Buffer.from('v1') })
    // Disk at pre-state (v0), restore-all target = v1 (finalPost).
    await writeFile(join(env.work, 'a.txt'), 'v0')
    const entry = env.manifest.aggregateSpan(10).get('a.txt')!
    const target = env.manifest.resolveRestoreTarget('a.txt', null)
    const result = evaluateBoundary(entry, target, sha256Of(Buffer.from('v0')))
    expect(result.state).toBe(STATE.CLEAN_RESTORE)
    expect(result.targetBlobSha).toBe(entry.finalPost.postBlobSha)
  })

  it('composing revert: create -> edit -> revert edit (v1) -> revert create (trash) -> file ENOENT', async () => {
    // Realistic sequence numbering: user/message seq < tool/call seq.
    // Turn 1: userSeq 10 -> toolSeq 12 (create v1)
    await simulateMutation({ seq: 12, callId: 'c1', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: null, postBytes: Buffer.from('v1') })
    // Turn 2: userSeq 20 -> toolSeq 22 (edit v2)
    await simulateMutation({ seq: 22, callId: 'c2', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })

    // 3. Revert Turn 2 (fromSeq = userSeq 20): target = state at userSeq 20 = v1. Disk is v2.
    const entrySeq20 = env.manifest.aggregateSpan(20).get('doc.txt')!
    const targetSeq20 = env.manifest.resolveRestoreTarget('doc.txt', 20)
    expect(targetSeq20.postBlobSha).toBe(env.manifest.records[0].postBlobSha) // v1!
    const evalSeq20 = evaluateBoundary(entrySeq20, targetSeq20, sha256Of(Buffer.from('v2')))
    expect(evalSeq20.state).toBe(STATE.CLEAN_RESTORE)
    const planSeq20 = new Map([['doc.txt', { ...evalSeq20 }]])
    await runPlan(planSeq20, 20)
    expect(await readFile(join(env.work, 'doc.txt'), 'utf8')).toBe('v1')

    // 4. Revert Turn 1 (fromSeq = userSeq 10): target = state at userSeq 10 = absent. Disk is v1 (intermediate!).
    // R1 guard: must resolve as CLEAN_TRASH and expectedDiskSha must be v1 (not v2).
    const entrySeq10 = env.manifest.aggregateSpan(10).get('doc.txt')!
    const targetSeq10 = env.manifest.resolveRestoreTarget('doc.txt', 10)
    const evalSeq10 = evaluateBoundary(entrySeq10, targetSeq10, sha256Of(Buffer.from('v1')))
    expect(evalSeq10.state).toBe(STATE.CLEAN_TRASH)
    expect(evalSeq10.expectedDiskSha).toBe(sha256Of(Buffer.from('v1'))) // R1 check!
    const planSeq10 = new Map([['doc.txt', { ...evalSeq10 }]])
    const { outcomes } = await runPlan(planSeq10, 10)
    expect(outcomes['doc.txt']?.status).toBe('trashed')
    await expect(readFile(join(env.work, 'doc.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restore-all from intermediate: disk at v1, target v2 -> CLEAN_RESTORE -> disk v2', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // Disk at intermediate state v1.
    await writeFile(join(env.work, 'doc.txt'), 'v1')

    const entry = env.manifest.aggregateSpan(10).get('doc.txt')!
    const target = env.manifest.resolveRestoreTarget('doc.txt', null) // restore all -> v2
    const result = evaluateBoundary(entry, target, sha256Of(Buffer.from('v1')))
    expect(result.state).toBe(STATE.CLEAN_RESTORE)
    expect(result.targetBlobSha).toBe(entry.finalPost.postBlobSha)
    const plan = new Map([['doc.txt', { ...result }]])
    const { outcomes } = await runPlan(plan, null as unknown as number)
    expect(outcomes['doc.txt']?.status).toBe('restored')
    expect(await readFile(join(env.work, 'doc.txt'), 'utf8')).toBe('v2')
  })

  it('restore-all from absent disk (created file trashed by revert): CLEAN_RESTORE -> recreates v2', async () => {
    // 1. Create v1, Edit v2
    await simulateMutation({ seq: 12, callId: 'c1', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: null, postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 22, callId: 'c2', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })

    // 2. Revert creation -> trashes doc.txt -> disk is absent (null)
    const entrySeq10 = env.manifest.aggregateSpan(10).get('doc.txt')!
    const targetSeq10 = env.manifest.resolveRestoreTarget('doc.txt', 10)
    const evalTrash = evaluateBoundary(entrySeq10, targetSeq10, sha256Of(Buffer.from('v2')))
    await runPlan(new Map([['doc.txt', { ...evalTrash }]]), 10)
    await expect(readFile(join(env.work, 'doc.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

    // 3. Restore all: target is v2, disk is absent (null).
    // Must evaluate to CLEAN_RESTORE with expectedDiskSha: null (not MISSING prompt!).
    const targetRestoreAll = env.manifest.resolveRestoreTarget('doc.txt', null)
    const evalRestoreAll = evaluateBoundary(entrySeq10, targetRestoreAll, null)
    expect(evalRestoreAll.state).toBe(STATE.CLEAN_RESTORE)
    expect(evalRestoreAll.action).toBe('restore')
    expect(evalRestoreAll.targetBlobSha).toBe(entrySeq10.finalPost.postBlobSha)
    expect(evalRestoreAll.expectedDiskSha).toBeNull()

    // 4. Executor recreates file from blob store cleanly.
    const { outcomes } = await runPlan(new Map([['doc.txt', { ...evalRestoreAll }]]), null as unknown as number)
    expect(outcomes['doc.txt']?.status).toBe('restored')
    expect(await readFile(join(env.work, 'doc.txt'), 'utf8')).toBe('v2')
  })

  it('strict TOCTOU guard: expectedDiskSha null escalates when disk is unexpectedly present', async () => {
    await simulateMutation({ seq: 12, callId: 'c1', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: null, postBytes: Buffer.from('v1') })
    // User unexpectedly created doc.txt on disk before write execution
    await writeFile(join(env.work, 'doc.txt'), 'unexpected content')

    const plan = new Map([['doc.txt', {
      action: 'restore' as const,
      targetBlobSha: env.manifest.records[0].postBlobSha,
      expectedDiskSha: null, // plan asserted disk was absent!
      entry: env.manifest.aggregateSpan(10).get('doc.txt')!,
      state: STATE.CLEAN_RESTORE,
    }]])
    const { outcomes } = await env.executor.execute({
      sessionId: 's1', revertSeq: null as unknown as number, plan,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(outcomes['doc.txt']?.status).toBe('conflict_escalated')
    expect(await readFile(join(env.work, 'doc.txt'), 'utf8')).toBe('unexpected content') // untouched!
  })

  it('interleaved foreign-pre: record with foreign pre-state -> CONFLICT preserved (R2 guard)', async () => {
    // Record 1: created v1
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: null, postBytes: Buffer.from('v1') })
    // Interleaved Record 2: user wrote USER_CONTENT between c1 and c2
    await env.blobs.put(Buffer.from('USER_CONTENT'))
    const postSha2 = await env.blobs.put(Buffer.from('v2'))
    await env.manifest.append({
      sessionId: 's1', toolSeq: 20, callId: 'c2', targetKey: 'doc.txt', displayPath: 'doc.txt',
      operation: 'update', preExisted: true, preStatus: 'ok',
      preBlobSha: sha256Of(Buffer.from('USER_CONTENT')), // foreign pre-state!
      postStatus: 'ok', postBlobSha: postSha2,
      isInterleaved: true, // flagged!
      timestamp: Date.now(),
    })
    // Disk is currently at USER_CONTENT.
    await writeFile(join(env.work, 'doc.txt'), 'USER_CONTENT')

    const entry = env.manifest.aggregateSpan(10).get('doc.txt')!
    const target = env.manifest.resolveRestoreTarget('doc.txt', 10) // target = absent
    // R2 check: USER_CONTENT must NOT be treated as a known agent state. Must CONFLICT.
    const result = evaluateBoundary(entry, target, sha256Of(Buffer.from('USER_CONTENT')))
    expect(result.state).toBe(STATE.CONFLICT)
    expect(result.action).toBe('prompt')
    expect(await readFile(join(env.work, 'doc.txt'), 'utf8')).toBe('USER_CONTENT') // untouched!
  })

  it('un-captured intermediate: postStatus too-large -> CONFLICT', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: null, postBytes: Buffer.from('v1') })
    // Record 2 has postStatus 'too-large' (postBlobSha is null)
    await env.manifest.append({
      sessionId: 's1', toolSeq: 20, callId: 'c2', targetKey: 'doc.txt', displayPath: 'doc.txt',
      operation: 'update', preExisted: true, preStatus: 'ok',
      preBlobSha: sha256Of(Buffer.from('v1')),
      postStatus: 'too-large', postBlobSha: null,
      isInterleaved: false, timestamp: Date.now(),
    })
    // Disk is at uncaptured v2
    await writeFile(join(env.work, 'doc.txt'), 'v2-uncaptured')

    const entry = env.manifest.aggregateSpan(10).get('doc.txt')!
    const target = env.manifest.resolveRestoreTarget('doc.txt', 10)
    const result = evaluateBoundary(entry, target, sha256Of(Buffer.from('v2-uncaptured')))
    expect(result.state).toBe(STATE.UNAVAILABLE)
    expect(result.action).toBe('skip')
  })

  it('mid-span target through evaluateBoundary: restoreSeq=15 targets intermediate v1', async () => {
    await writeFile(join(env.work, 'doc.txt'), 'v0')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: Buffer.from('v0'), postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'doc.txt', displayPath: 'doc.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // Disk currently v2.
    const entry = env.manifest.aggregateSpan(10).get('doc.txt')!
    const target = env.manifest.resolveRestoreTarget('doc.txt', 15) // target is v1
    const result = evaluateBoundary(entry, target, sha256Of(Buffer.from('v2')))
    expect(result.state).toBe(STATE.CLEAN_RESTORE)
    expect(result.targetBlobSha).toBe(env.manifest.records[0].postBlobSha) // v1
    const plan = new Map([['doc.txt', { ...result }]])
    const { outcomes } = await runPlan(plan, 15)
    expect(outcomes['doc.txt']?.status).toBe('restored')
    expect(await readFile(join(env.work, 'doc.txt'), 'utf8')).toBe('v1')
  })
})

describe('WAL, crash recovery & durability', () => {
  it('crash recovery: unsealed intent replays recorded plan idempotently', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await env.executor.writeWal({
      kind: 'intent', sessionId: 's1', revertSeq: 10,
      plan: { 'a.txt': { action: 'restore', targetBlobSha: env.manifest.records[0].preBlobSha, expectedDiskSha: env.manifest.records[0].postBlobSha } },
      ts: Date.now(),
    })
    const executor2 = new RevertExecutor({ blobStore: env.blobs, trashRoot: join(env.root, 'trash'), walFile: join(env.root, 'wal.jsonl') })
    await new Promise(r => setTimeout(r, 20))
    const unsealed = await executor2.findUnsealedIntents()
    expect(unsealed).toHaveLength(1)
    const recordedPlan = new Map(Object.entries(unsealed[0].plan).map(([key, p]) => [key, p]))
    const { outcomes } = await executor2.execute({
      sessionId: 's1', revertSeq: 10, plan: recordedPlan,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(outcomes['a.txt']?.status).toBe('restored')
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('original')
    expect(await executor2.findUnsealedIntents()).toHaveLength(0)
  })

  it('no-seal-on-error: unexpected failure leaves intent unsealed', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    const { sealed } = await env.executor.execute({
      sessionId: 's1', revertSeq: 10, plan,
      resolvePath: async () => { throw new Error('boom') },
      readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(sealed).toBe(false)
    expect(await env.executor.findUnsealedIntents()).toHaveLength(1)
  })

  it('blob-missing degrades per-file, batch continues', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await writeFile(join(env.work, 'b.txt'), 'origB')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agentA') })
    await simulateMutation({ seq: 11, callId: 'c2', targetKey: 'b.txt', displayPath: 'b.txt', preBytes: Buffer.from('origB'), postBytes: Buffer.from('agentB') })
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    const missingSha = env.manifest.records[0].preBlobSha!
    await rm(join(env.root, 'blobs', missingSha))
    const { outcomes, sealed } = await runPlan(plan)
    expect(sealed).toBe(true)
    expect(outcomes['a.txt']?.status).toBe('conflict_escalated')
    expect(outcomes['b.txt']?.status).toBe('restored')
  })

  it('execute: failed pre-clobber backup escalates the file, never writes it, and the batch continues', async () => {
    await writeFile(join(env.work, 'a.txt'), 'origA')
    await writeFile(join(env.work, 'b.txt'), 'origB')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('origA'), postBytes: Buffer.from('agentA') })
    await simulateMutation({ seq: 11, callId: 'c2', targetKey: 'b.txt', displayPath: 'b.txt', preBytes: Buffer.from('origB'), postBytes: Buffer.from('agentB') })
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    // Sabotage the backup write for a.txt's disk state only: its uncommitted
    // content is the only copy and must never be clobbered.
    const brokenBlobs = {
      put: async (bytes: Buffer) => {
        if (bytes.toString() === 'agentA') throw new Error('disk full')
        return env.blobs.put(bytes)
      },
      get: async (sha: string) => env.blobs.get(sha),
    }
    const brokenExecutor = new RevertExecutor({ blobStore: brokenBlobs as unknown as BlobStore, trashRoot: join(env.root, 'trash2'), walFile: join(env.root, 'wal2.jsonl') })
    await brokenExecutor.init()
    const { outcomes, sealed } = await brokenExecutor.execute({
      sessionId: 's1', revertSeq: 10, plan,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(sealed).toBe(true)
    expect(outcomes['a.txt']?.status).toBe('conflict_escalated')
    expect(outcomes['a.txt']?.reason).toContain('pre-clobber backup failed')
    // a.txt was not overwritten; the healthy sibling still reverted.
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('agentA')
    expect(outcomes['b.txt']?.status).toBe('restored')
    expect(await readFile(join(env.work, 'b.txt'), 'utf8')).toBe('origB')
    // The sealed WAL result records the reason for recovery/audit.
    const result = brokenExecutor.wal.find(entry => entry.kind === 'result' && entry.revertSeq === 10)
    expect(result?.kind === 'result' ? result.outcomes['a.txt']?.reason : undefined).toContain('pre-clobber backup failed')
  })

  it('execute: failed pre-clobber backup escalates a trash action and never trashes the file', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'new.txt', displayPath: 'new.txt', preBytes: null, postBytes: Buffer.from('created by agent') })
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    expect(plan.get('new.txt')?.state).toBe(STATE.CLEAN_TRASH)
    const brokenBlobs = {
      put: async () => { throw new Error('disk full') },
      get: async (sha: string) => env.blobs.get(sha),
    }
    const brokenExecutor = new RevertExecutor({ blobStore: brokenBlobs as unknown as BlobStore, trashRoot: join(env.root, 'trash2'), walFile: join(env.root, 'wal2.jsonl') })
    await brokenExecutor.init()
    let trashed = false
    const { outcomes } = await brokenExecutor.execute({
      sessionId: 's1', revertSeq: 10, plan,
      resolvePath, readDisk, writeDisk: atomicWriter,
      trashFile: async (p: string) => { trashed = true; return env.executor.trash(p, 's1') },
    })
    expect(outcomes['new.txt']?.status).toBe('conflict_escalated')
    expect(outcomes['new.txt']?.reason).toContain('pre-clobber backup failed')
    expect(trashed).toBe(false)
    expect(await readFile(join(env.work, 'new.txt'), 'utf8')).toBe('created by agent')
  })

  it('TOCTOU: disk modified between evaluation and write escalates to conflict', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    await writeFile(join(env.work, 'a.txt'), 'user edit after eval')
    const { outcomes } = await runPlan(plan)
    expect(outcomes['a.txt']?.status).toBe('conflict_escalated')
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('user edit after eval')
  })

  it('composing reverts: already-reverted files yield no-ops on second revert', async () => {
    await writeFile(join(env.work, 'a.txt'), 'v0')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v0'), postBytes: Buffer.from('v1') })
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    const { plan: plan1 } = await buildRevertPlan(env.manifest, 10, readDisk)
    await runPlan(plan1)
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('v0')
    const { plan: plan2 } = await buildRevertPlan(env.manifest, 5, readDisk)
    expect(plan2.get('a.txt')?.state).toBe(STATE.ALREADY_CLEAN)
  })

  it('reachability GC: restart-safe; referenced blobs survive, orphans pruned', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    const orphanSha = await env.blobs.put(Buffer.from('orphan data'))
    await new Promise(r => setTimeout(r, 5)) // ensure mtime is older than the 0ms TTL
    const blobs2 = new BlobStore(join(env.root, 'blobs'))
    await blobs2.init()
    // Disk-derived liveness: read the manifest from disk (as runGc does), NOT
    // from the in-memory instance — a capture-only session untouched since
    // restart must still protect its snapshots.
    const raw = await readFile(join(env.root, 'manifest.jsonl'), 'utf8')
    const live = new Set<string>()
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      const rec = JSON.parse(line) as { preBlobSha?: string | null; postBlobSha?: string | null }
      if (rec.preBlobSha) live.add(rec.preBlobSha)
      if (rec.postBlobSha) live.add(rec.postBlobSha)
    }
    await blobs2.gc(live, 0)
    expect(await blobs2.get(env.manifest.records[0].preBlobSha)).not.toBeNull()
    expect(await blobs2.get(env.manifest.records[0].postBlobSha)).not.toBeNull()
    await expect(blobs2.get(orphanSha)).rejects.toThrow()
  })

  it('torn trailing line: manifest and WAL tolerate crash-mid-append', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await appendFile(join(env.root, 'manifest.jsonl'), '{"torn": tru')
    await appendFile(join(env.root, 'wal.jsonl'), '{"kind":"intent","revertSeq":99,"plan":{},"ts":1')
    const m2 = new MutationManifest(join(env.root, 'manifest.jsonl')); await new Promise(r => setTimeout(r, 20))
    expect(m2.records).toHaveLength(1)
    const e2 = new RevertExecutor({ blobStore: env.blobs, trashRoot: join(env.root, 'trash'), walFile: join(env.root, 'wal.jsonl') }); await new Promise(r => setTimeout(r, 20))
    expect(e2.wal).toHaveLength(0)
  })

  it('trash collision: same-basename files get unique destinations', async () => {
    await writeFile(join(env.work, 'x.txt'), 'one')
    await writeFile(join(env.work, 'y.txt'), 'two')
    const d1 = await env.executor.trash(join(env.work, 'x.txt'), 's1')
    const d2 = await env.executor.trash(join(env.work, 'y.txt'), 's1')
    expect(d1).not.toBe(d2)
    expect(await readFile(d1, 'utf8')).toBe('one')
    expect(await readFile(d2, 'utf8')).toBe('two')
  })

  it('crashed resolution replay: resolve:* intents replay through execute', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    // Crash: a resolution intent was written but never sealed.
    await env.executor.writeWal({
      kind: 'intent', sessionId: 's1', revertSeq: -1,
      plan: { 'a.txt': { action: 'resolve:restore', targetBlobSha: env.manifest.records[0].preBlobSha, expectedDiskSha: sha256Of(Buffer.from('user manual edit')) } },
      ts: Date.now(),
    })
    const executor2 = new RevertExecutor({ blobStore: env.blobs, trashRoot: join(env.root, 'trash'), walFile: join(env.root, 'wal.jsonl') })
    await new Promise(r => setTimeout(r, 20))
    const unsealed = await executor2.findUnsealedIntents()
    expect(unsealed).toHaveLength(1)
    // Recovery replays the resolve:restore intent through execute (normalized).
    const recordedPlan = new Map(Object.entries(unsealed[0].plan).map(([key, p]) => [key, p]))
    const { outcomes } = await executor2.execute({
      sessionId: 's1', revertSeq: -1, plan: recordedPlan,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(outcomes['a.txt']?.status).toBe('restored')
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('original')
  })
})

describe('applyResolution', () => {
  it('restore: force-revert overwrites user edit', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    const conflict = plan.get('a.txt')!
    expect(conflict.state).toBe(STATE.CONFLICT)
    const outcome = await env.executor.applyResolution({
      sessionId: 's1', revertSeq: 10, targetKey: 'a.txt',
      resolution: 'restore', targetBlobSha: conflict.targetBlobSha, expectedDiskSha: conflict.expectedDiskSha,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(outcome.status).toBe('restored')
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('original')
  })

  it('keep: user keeps their version, disk untouched', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    const conflict = plan.get('a.txt')!
    const outcome = await env.executor.applyResolution({
      sessionId: 's1', revertSeq: 10, targetKey: 'a.txt',
      resolution: 'keep', targetBlobSha: null, expectedDiskSha: conflict.expectedDiskSha,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(outcome.status).toBe('kept')
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('user manual edit')
  })

  it('keep then restore-all: kept state becomes the target — restore no-ops, no conflict reappears', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    const manualSha = sha256Of(Buffer.from('user manual edit'))

    // Keep: record the kept state as a known mutation with the highest toolSeq
    // (mirrors applyConflictResolution's keep branch).
    await env.manifest.append({
      sessionId: 's1', toolSeq: Number.MAX_SAFE_INTEGER - 1, callId: 'keep-c1',
      targetKey: 'a.txt', displayPath: 'a.txt', operation: 'update',
      preExisted: true, preStatus: 'ok', preBlobSha: manualSha,
      postStatus: 'ok', postBlobSha: manualSha, isInterleaved: false, timestamp: Date.now(),
    })

    // Restore-all: the kept record is the latest → target = kept state →
    // currentSha === targetSha → ALREADY_CLEAN (no-op), no conflict.
    const target = env.manifest.resolveRestoreTarget('a.txt', null)
    const entry = env.manifest.aggregateSpan(10).get('a.txt')!
    const evalResult = evaluateBoundary(entry, target, sha256Of(Buffer.from('user manual edit')))
    expect(evalResult.state).toBe(STATE.ALREADY_CLEAN)
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('user manual edit')
  })

  it('recreate: missing file recreated from pre-agent snapshot', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await rm(join(env.work, 'a.txt'))
    const { plan } = await buildRevertPlan(env.manifest, 10, readDisk)
    const missing = plan.get('a.txt')!
    expect(missing.state).toBe(STATE.MISSING)
    const outcome = await env.executor.applyResolution({
      sessionId: 's1', revertSeq: 10, targetKey: 'a.txt',
      resolution: 'recreate', targetBlobSha: missing.targetBlobSha, expectedDiskSha: null,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(outcome.status).toBe('restored')
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('original')
  })

  it('pre-clobber staging: unknown manual edits on disk are staged to blobStore before overwrite or trash', async () => {
    await writeFile(join(env.work, 'a.txt'), 'original')
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    const manualBytes = Buffer.from('precious manual human edit that must not be lost')
    await writeFile(join(env.work, 'a.txt'), manualBytes)
    const manualSha = sha256Of(manualBytes)

    // Apply resolution restore (force overwrite)
    await env.executor.applyResolution({
      sessionId: 's1', revertSeq: 10, targetKey: 'a.txt',
      resolution: 'restore', targetBlobSha: env.manifest.records[0].preBlobSha, expectedDiskSha: manualSha,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })

    // Verify disk was reverted to 'original'
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('original')
    // Verify the manual edit was staged into blobStore (zero data loss!)
    const recoveredBytes = await env.blobs.get(manualSha)
    expect(recoveredBytes).not.toBeNull()
    expect(recoveredBytes?.toString()).toBe('precious manual human edit that must not be lost')
  })
})

describe('matrix: 3-turn combination with creation, edit, text-only turn, and conflict resolution', () => {
  it('Operator incident combination: Turn 1 create + Turn 2 edit + Turn 3 text', async () => {
    // Turn 1: Write file (creates file)
    // Turn 1: User message at seq 5 -> tool mutation at seq 10 (creates file)
    await simulateMutation({
      seq: 10, callId: 'c1', targetKey: 'test_file.txt', displayPath: 'test_file.txt',
      preBytes: null, postBytes: Buffer.from('V1: created'),
    })
    // Turn 2: User message at seq 15 -> tool mutation at seq 20 (edits file)
    await simulateMutation({
      seq: 20, callId: 'c2', targetKey: 'test_file.txt', displayPath: 'test_file.txt',
      preBytes: Buffer.from('V1: created'), postBytes: Buffer.from('V2: edited'),
    })
    // Turn 3: User message at seq 25 ("tell me a joke", no file mutations)

    // User makes a manual edit on disk
    await writeFile(join(env.work, 'test_file.txt'), 'V2: edited + manual test test')
    const manualSha = sha256Of(Buffer.from('V2: edited + manual test test'))

    // 1. Revert Turn 3 (fromSeq: 25) -> span records with toolSeq >= 25 is EMPTY
    const span25 = env.manifest.aggregateSpan(25)
    expect(span25.size).toBe(0)

    // 2. Restore Turn 3 / Restore All with oldBoundary = 25 -> span is records >= 25 (EMPTY!)
    // When oldBoundary was 25, files modified only in Turn 1/2 are NOT in the span, so disk stays untouched!
    expect(await readFile(join(env.work, 'test_file.txt'), 'utf8')).toBe('V2: edited + manual test test')

    // 3. Revert Turn 2 (fromSeq: 15) -> span records >= 15 contains Turn 2 (seq 20)
    const span15 = env.manifest.aggregateSpan(15)
    expect(span15.size).toBe(1)
    const entry15 = span15.get('test_file.txt')!
    // Target state at seq 15 is Turn 1's post-state (V1: created)
    const target15 = env.manifest.resolveRestoreTarget('test_file.txt', 15)
    expect(target15.postBlobSha).toBe(sha256Of(Buffer.from('V1: created')))
    const eval15 = evaluateBoundary(entry15, target15, manualSha)
    // Manual edit on disk produces CONFLICT with targetBlobSha = V1: created
    expect(eval15.state).toBe(STATE.CONFLICT)
    expect(eval15.targetBlobSha).toBe(sha256Of(Buffer.from('V1: created')))
    expect(eval15.targetAbsent).toBe(false)

    // Force revert on Turn 2 overwrites manual edit with V1
    await env.executor.applyResolution({
      sessionId: 's1', revertSeq: 15, targetKey: 'test_file.txt',
      resolution: 'restore', targetBlobSha: eval15.targetBlobSha, expectedDiskSha: manualSha,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(await readFile(join(env.work, 'test_file.txt'), 'utf8')).toBe('V1: created')

    // 4. Restore Turn 2 / Restore All (target = finalPost = V2)
    const targetRestore = env.manifest.resolveRestoreTarget('test_file.txt', null)
    expect(targetRestore.postBlobSha).toBe(sha256Of(Buffer.from('V2: edited')))
    expect(targetRestore.sessionCreated).toBe(true)
    const evalRestore = evaluateBoundary(entry15, targetRestore, sha256Of(Buffer.from('V1: created')))
    expect(evalRestore.state).toBe(STATE.CLEAN_RESTORE)
    expect(evalRestore.action).toBe('restore')
    expect(evalRestore.targetBlobSha).toBe(sha256Of(Buffer.from('V2: edited')))

    await env.executor.execute({
      sessionId: 's1', revertSeq: -1,
      plan: new Map([['test_file.txt', { action: 'restore', targetBlobSha: evalRestore.targetBlobSha, expectedDiskSha: sha256Of(Buffer.from('V1: created')) }]]),
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(await readFile(join(env.work, 'test_file.txt'), 'utf8')).toBe('V2: edited')

    // 5. Revert Turn 1 (fromSeq: 5) -> created file reverted past creation (target is initialPre = absence)
    const span5 = env.manifest.aggregateSpan(5)
    const entry5 = span5.get('test_file.txt')!
    const target5 = env.manifest.resolveRestoreTarget('test_file.txt', 5)
    expect(target5.postBlobSha).toBe(null) // target is initialPre = absence
    const eval5 = evaluateBoundary(entry5, target5, sha256Of(Buffer.from('V2: edited')))
    expect(eval5.state).toBe(STATE.CLEAN_TRASH)
    expect(eval5.action).toBe('trash')

    await env.executor.execute({
      sessionId: 's1', revertSeq: 5,
      plan: new Map([['test_file.txt', { action: 'trash', targetBlobSha: null, expectedDiskSha: sha256Of(Buffer.from('V2: edited')) }]]),
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    // File is safely moved to trash
    expect(await readDisk('test_file.txt')).toBeNull()

    // 6. Restore Turn 1 / Restore All from absence -> clean recreation!
    const evalRecreate = evaluateBoundary(entry5, targetRestore, null)
    expect(evalRecreate.state).toBe(STATE.CLEAN_RESTORE)
    expect(evalRecreate.action).toBe('restore')
    expect(evalRecreate.targetBlobSha).toBe(sha256Of(Buffer.from('V2: edited')))

    await env.executor.execute({
      sessionId: 's1', revertSeq: -1,
      plan: new Map([['test_file.txt', { action: 'restore', targetBlobSha: evalRecreate.targetBlobSha, expectedDiskSha: null }]]),
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(await readFile(join(env.work, 'test_file.txt'), 'utf8')).toBe('V2: edited')
  })
})

describe('Oracle B-fixes: applyResolution hardening', () => {
  it('strict TOCTOU: file reappearing after MISSING conflict escalates, never overwrites', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    // File absent at conflict time (MISSING card, expectedDiskSha = null)
    await rm(join(env.work, 'a.txt'))
    // User recreates the file with precious content before resolving
    await writeFile(join(env.work, 'a.txt'), 'user recreated precious content')
    const outcome = await env.executor.applyResolution({
      sessionId: 's1', revertSeq: -1, targetKey: 'a.txt',
      resolution: 'restore', targetBlobSha: env.manifest.records[0].preBlobSha, expectedDiskSha: null,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(outcome.status).toBe('conflict_escalated')
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('user recreated precious content')
  })

  it('pre-clobber backup failure escalates instead of destroying the only copy', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    const manualSha = sha256Of(Buffer.from('user manual edit'))
    // Sabotage the blob store: put() throws
    const brokenBlobs = {
      put: async () => { throw new Error('disk full') },
      get: async (sha: string) => env.blobs.get(sha),
    }
    const brokenExecutor = new RevertExecutor({ blobStore: brokenBlobs as unknown as BlobStore, trashRoot: join(env.root, 'trash2'), walFile: join(env.root, 'wal2.jsonl') })
    await brokenExecutor.init()
    const outcome = await brokenExecutor.applyResolution({
      sessionId: 's1', revertSeq: -1, targetKey: 'a.txt',
      resolution: 'restore', targetBlobSha: env.manifest.records[0].preBlobSha, expectedDiskSha: manualSha,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(outcome.status).toBe('conflict_escalated')
    expect(outcome.reason).toContain('pre-clobber backup failed')
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('user manual edit')
  })

  it('unique WAL seq per resolution: resolution result never seals an interrupted batch intent', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    const manualSha = sha256Of(Buffer.from('user manual edit'))
    // Interrupted batch: intent written, never sealed (revertSeq = 10)
    await env.executor.writeWal({
      kind: 'intent', sessionId: 's1', revertSeq: 10,
      plan: { 'a.txt': { action: 'restore', targetBlobSha: env.manifest.records[0].preBlobSha, expectedDiskSha: manualSha } },
      ts: Date.now(),
    })
    // Resolution completes with its own unique seq
    const outcome = await env.executor.applyResolution({
      sessionId: 's1', revertSeq: 10, targetKey: 'a.txt',
      resolution: 'restore', targetBlobSha: env.manifest.records[0].preBlobSha, expectedDiskSha: manualSha,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(outcome.status).toBe('restored')
    // The batch intent (seq 10) must still be unsealed
    const unsealed = await env.executor.findUnsealedIntents()
    expect(unsealed.some(i => i.revertSeq === 10)).toBe(true)
  })

  it('save beside: recreate writes the pre-agent snapshot to a NEW path, user version untouched', async () => {
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('original'), postBytes: Buffer.from('agent edit') })
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    const manualSha = sha256Of(Buffer.from('user manual edit'))
    // Beside resolution: resolvePath returns a NEW path for recreate.
    const besidePath = join(env.work, 'a.txt.pre-revert.1234')
    const outcome = await env.executor.applyResolution({
      sessionId: 's1', targetKey: 'a.txt',
      resolution: 'recreate', targetBlobSha: env.manifest.records[0].preBlobSha, expectedDiskSha: manualSha,
      beside: true,
      resolvePath: async (key: string) => (key === 'a.txt' ? besidePath : key),
      readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(outcome.status).toBe('saved_beside')
    expect(outcome.dest).toBe(besidePath)
    // User version untouched at the original path
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('user manual edit')
    // Pre-agent snapshot written beside
    expect(await readFile(besidePath, 'utf8')).toBe('original')
  })

  it('revert-then-edit chain: plugin restore recorded in manifest so next agent edit is NOT interleaved', async () => {
    // Turn 1: agent creates a.txt with 'v1'
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    // Turn 2: agent edits to 'v2'
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // User reverts turn 2 → plugin restores disk to 'v1' (the boundary state)
    await writeFile(join(env.work, 'a.txt'), 'v1')
    // recordOutcomes mirrors the restore: pre=v2, post=v1, source=plugin-revert
    await env.manifest.append({
      sessionId: 's1', toolSeq: Number.MAX_SAFE_INTEGER - 1, callId: 'revert-1',
      targetKey: 'a.txt', displayPath: 'a.txt', operation: 'update',
      preExisted: true, preStatus: 'ok', preBlobSha: sha256Of(Buffer.from('v2')),
      postStatus: 'ok', postBlobSha: sha256Of(Buffer.from('v1')), isInterleaved: false, timestamp: Date.now(),
      source: 'plugin-revert',
    })
    // Turn 3: agent edits 'v1' → 'v3'. Without the restore record this would be
    // flagged interleaved (prior post=v2 ≠ pre=v1). With it, the chain matches.
    await simulateMutation({ seq: 30, callId: 'c3', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v3') })
    await writeFile(join(env.work, 'a.txt'), 'v3')
    // Revert turn 3 → clean restore to 'v1', NOT a spurious conflict.
    const { plan } = await buildRevertPlan(env.manifest, 30, readDisk)
    const entry = plan.get('a.txt')!
    expect(entry.state).toBe(STATE.CLEAN_RESTORE)
    expect(entry.action).toBe('restore')
  })

  it('revert then restore-all: restore returns to the AGENT state, not the plugin write', async () => {
    // Turn 1: agent creates a.txt with 'v1'
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    // Turn 2: agent edits to 'v2'
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // User reverts turn 2 → plugin restores disk to 'v1' (the boundary state)
    await writeFile(join(env.work, 'a.txt'), 'v1')
    // recordOutcomes mirrors the restore: pre=v2, post=v1, source=plugin-revert
    await env.manifest.append({
      sessionId: 's1', toolSeq: Number.MAX_SAFE_INTEGER - 1, callId: 'revert-1',
      targetKey: 'a.txt', displayPath: 'a.txt', operation: 'update',
      preExisted: true, preStatus: 'ok', preBlobSha: sha256Of(Buffer.from('v2')),
      postStatus: 'ok', postBlobSha: sha256Of(Buffer.from('v1')), isInterleaved: false, timestamp: Date.now(),
      source: 'plugin-revert',
    })
    // Restore-all: target must be the AGENT's last state (v2), NOT the
    // plugin-revert record (v1). The evaluator sees disk=v1 ≠ target=v2 and
    // v1 is a known span state → CLEAN_RESTORE back to v2.
    const target = env.manifest.resolveRestoreTarget('a.txt', null)
    expect(target.postBlobSha).toBe(sha256Of(Buffer.from('v2')))
    const entry = env.manifest.aggregateSpan(10).get('a.txt')!
    const evalResult = evaluateBoundary(entry, target, sha256Of(Buffer.from('v1')))
    expect(evalResult.state).toBe(STATE.CLEAN_RESTORE)
    expect(evalResult.targetBlobSha).toBe(sha256Of(Buffer.from('v2')))
  })

  it('restore-all with stale interleaved flag elsewhere in chain: clean target is NOT degraded', async () => {
    // Turn 1: agent creates a.txt with 'v1'
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    // Turn 2: agent edits to 'v2' — flagged interleaved by a stale pre-recordOutcomes write
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // Manually mark the turn-2 record interleaved (simulates an existing session
    // whose manifest carries a false flag from a pre-fix plugin write).
    env.manifest.records[1].isInterleaved = true
    await writeFile(join(env.work, 'a.txt'), 'v2')
    // Manifest healing recomputes interleaving from the chain itself, so the
    // planted stale flag cannot degrade a target whose pre/post chain is
    // consistent: the target resolves clean and, with the disk already at the
    // boundary state, no write is attempted (no spurious conflict prompt).
    const target = env.manifest.resolveRestoreTarget('a.txt', null)
    expect(target.postBlobSha).toBe(sha256Of(Buffer.from('v2')))
    expect(target.isInterleaved).toBe(false)
    const entry = env.manifest.aggregateSpan(10).get('a.txt')!
    const evalResult = evaluateBoundary(entry, target, sha256Of(Buffer.from('v2')))
    expect(evalResult.state).toBe(STATE.ALREADY_CLEAN)
  })

  it('manifest init heals null/null records and recomputes stale interleaved flags', async () => {
    // Write a manifest with a null/null record (pre-fix trash outcome) that
    // corrupts the chain, plus a stale interleaved flag on a later record.
    const v1 = sha256Of(Buffer.from('v1'))
    const v2 = sha256Of(Buffer.from('v2'))
    const lines = [
      JSON.stringify({ sessionId: 's1', toolSeq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', operation: 'create', preExisted: false, preStatus: 'ok', preBlobSha: null, postStatus: 'ok', postBlobSha: v1, isInterleaved: false, timestamp: 1 }),
      JSON.stringify({ sessionId: 's1', toolSeq: 20, callId: 'c2', targetKey: 'a.txt', displayPath: 'a.txt', operation: 'update', preExisted: true, preStatus: 'ok', preBlobSha: v1, postStatus: 'ok', postBlobSha: v2, isInterleaved: false, timestamp: 2 }),
      // Corrupt null/null record (pre-fix trash outcome)
      JSON.stringify({ sessionId: 's1', toolSeq: Number.MAX_SAFE_INTEGER - 1, callId: 'revert-x', targetKey: 'a.txt', displayPath: 'a.txt', operation: 'update', preExisted: true, preStatus: 'ok', preBlobSha: null, postStatus: 'ok', postBlobSha: null, isInterleaved: true, timestamp: 3, source: 'plugin-revert' }),
      // Later agent edit whose pre (v2) matches the pre-null chain — its stale
      // interleaved flag (computed against the null record) must be recomputed
      // to false.
      JSON.stringify({ sessionId: 's1', toolSeq: 30, callId: 'c3', targetKey: 'a.txt', displayPath: 'a.txt', operation: 'update', preExisted: true, preStatus: 'ok', preBlobSha: v2, postStatus: 'ok', postBlobSha: v1, isInterleaved: true, timestamp: 4 }),
    ]
    await writeFile(join(env.root, 'manifest.jsonl'), lines.join('\n') + '\n')
    const healed = new MutationManifest(join(env.root, 'manifest.jsonl'))
    await healed.ready // constructor already runs init()
    expect(healed.records.length).toBe(3) // null/null dropped
    expect(healed.records[2].isInterleaved).toBe(false) // recomputed clean
    // Restore-all target = the latest record (post=v1), not interleaved.
    const target = healed.resolveRestoreTarget('a.txt', null)
    expect(target.isInterleaved).toBe(false)
    expect(target.postBlobSha).toBe(v1)
  })

  it('permutation: manual edit → revert → Keep → restore-all → revert again must PROMPT (never auto-restore over kept state)', async () => {
    // Turn 1: agent creates a.txt with 'v1'
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    // Turn 2: agent edits to 'v2'
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // User manually edits to 'U'
    const uSha = sha256Of(Buffer.from('user manual edit'))
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    // Revert turn 2 → conflict (U unknown)
    const { plan } = await buildRevertPlan(env.manifest, 20, readDisk)
    expect(plan.get('a.txt')!.state).toBe(STATE.CONFLICT)
    // Keep: record the kept state (source user-kept)
    await env.manifest.append({
      sessionId: 's1', toolSeq: Number.MAX_SAFE_INTEGER - 1, callId: 'keep-c1',
      targetKey: 'a.txt', displayPath: 'a.txt', operation: 'update',
      preExisted: true, preStatus: 'ok', preBlobSha: uSha,
      postStatus: 'ok', postBlobSha: uSha, isInterleaved: false, timestamp: Date.now(),
      source: 'user-kept',
    })
    // Restore-all: target = the kept state (user-kept) → ALREADY_CLEAN no-op,
    // NOT degraded to UNAVAILABLE.
    const restoreTarget = env.manifest.resolveRestoreTarget('a.txt', null)
    expect(restoreTarget.targetSource).toBe('user-kept')
    expect(restoreTarget.postBlobSha).toBe(uSha)
    const spanEntry = env.manifest.aggregateSpan(10).get('a.txt')!
    const restoreEval = evaluateBoundary(spanEntry, restoreTarget, uSha)
    expect(restoreEval.state).toBe(STATE.ALREADY_CLEAN)
    // Revert again (turn 2): the kept state U must NOT be a known span state —
    // the evaluator must return CONFLICT (prompt), never auto-restore over U.
    const { plan: plan2 } = await buildRevertPlan(env.manifest, 20, readDisk)
    expect(plan2.get('a.txt')!.state).toBe(STATE.CONFLICT)
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('user manual edit')
  })

  it('permutation: manual edit → revert → Force Revert → restore-all → revert stays clean (user chose overwrite)', async () => {
    // Turn 1: agent creates a.txt with 'v1'
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    // Turn 2: agent edits to 'v2'
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // User manually edits to 'U'
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    // Force Revert (restore): overwrite U with the boundary state v1
    const { plan } = await buildRevertPlan(env.manifest, 20, readDisk)
    const conflict = plan.get('a.txt')!
    await env.executor.applyResolution({
      sessionId: 's1', revertSeq: 20, targetKey: 'a.txt',
      resolution: 'restore', targetBlobSha: conflict.targetBlobSha, expectedDiskSha: conflict.expectedDiskSha,
      resolvePath, readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('v1')
    // recordOutcomes mirrors the restore (source plugin-revert)
    await env.manifest.append({
      sessionId: 's1', toolSeq: Number.MAX_SAFE_INTEGER - 1, callId: 'revert-1',
      targetKey: 'a.txt', displayPath: 'a.txt', operation: 'update',
      preExisted: true, preStatus: 'ok', preBlobSha: sha256Of(Buffer.from('user manual edit')),
      postStatus: 'ok', postBlobSha: sha256Of(Buffer.from('v1')), isInterleaved: false, timestamp: Date.now(),
      source: 'plugin-revert',
    })
    // Restore-all: target = the agent's last state (v2) → disk v1 is known →
    // CLEAN_RESTORE back to v2.
    const restoreTarget = env.manifest.resolveRestoreTarget('a.txt', null)
    expect(restoreTarget.postBlobSha).toBe(sha256Of(Buffer.from('v2')))
    // Revert again: the disk (v1 after Force Revert) is either already at the
    // target (ALREADY_CLEAN) or a known agent state (CLEAN_RESTORE) — never a
    // conflict, because the user explicitly chose to overwrite their edit.
    const { plan: plan2 } = await buildRevertPlan(env.manifest, 20, readDisk)
    const state2 = plan2.get('a.txt')!.state
    expect([STATE.ALREADY_CLEAN, STATE.CLEAN_RESTORE]).toContain(state2)
  })

  it('permutation: manual edit → revert → Save Beside → restore-all → revert must PROMPT (user file untouched)', async () => {
    // Turn 1: agent creates a.txt with 'v1'
    await simulateMutation({ seq: 10, callId: 'c1', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: null, postBytes: Buffer.from('v1') })
    // Turn 2: agent edits to 'v2'
    await simulateMutation({ seq: 20, callId: 'c2', targetKey: 'a.txt', displayPath: 'a.txt', preBytes: Buffer.from('v1'), postBytes: Buffer.from('v2') })
    // User manually edits to 'U'
    await writeFile(join(env.work, 'a.txt'), 'user manual edit')
    // Save Beside: user file stays at U, snapshot written beside
    const besidePath = join(env.work, 'a.txt.pre-revert.1234')
    const { plan } = await buildRevertPlan(env.manifest, 20, readDisk)
    const conflict = plan.get('a.txt')!
    await env.executor.applyResolution({
      sessionId: 's1', targetKey: 'a.txt',
      resolution: 'recreate', targetBlobSha: conflict.targetBlobSha, expectedDiskSha: conflict.expectedDiskSha,
      beside: true,
      resolvePath: async (key: string) => (key === 'a.txt' ? besidePath : key),
      readDisk, writeDisk: atomicWriter, trashFile,
    })
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('user manual edit')
    // Revert again: disk U is unknown (no record for it) → CONFLICT prompt.
    const { plan: plan2 } = await buildRevertPlan(env.manifest, 20, readDisk)
    expect(plan2.get('a.txt')!.state).toBe(STATE.CONFLICT)
    expect(await readFile(join(env.work, 'a.txt'), 'utf8')).toBe('user manual edit')
  })
})