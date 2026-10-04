/**
 * Two-seam mutation capture: tools/pre-execute captures exact pre-bytes in
 * memory keyed by callId; tools/post-execute pairs with it, captures exact
 * post-bytes, and persists ONE record atomically only when the tool succeeded.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'
import { sha256Of } from './blob-store'
import type { BlobStore } from './blob-store'
import type { MutationManifest } from './manifest'

export interface PendingCapture {
  targetKey: string
  displayPath: string
  preExisted: boolean
  preStatus: 'ok' | 'too-large' | 'unreadable'
  preBlobSha: string | null
  preBytes: Buffer | null
}

const MUTATION_TOOLS = new Set(['edit', 'write'])

/**
 * Pre-execute capture: resolve the target, read raw pre-bytes, stage in memory.
 * Runs ahead of approval/guards — a denied or failed call leaves an orphaned
 * pre-capture that post-execute reconciles by callId.
 */
export async function capturePre(
  ctx: Context,
  exec: ToolExecution,
  pendingCaptures: Map<string, PendingCapture>,
  maxSnapshotBytes: number,
): Promise<void> {
  if (!MUTATION_TOOLS.has(exec.name)) return
  const args = exec.arguments as { file_path?: string }
  const filePath = args.file_path
  if (typeof filePath !== 'string' || filePath.length === 0) return

  const fs = ctx.get('fs') as { resolve?: (path: string, opts?: { cwd?: string }) => Promise<{ targetKey: string; displayPath: string }> } | undefined
  if (fs?.resolve === undefined) return
  const cwd = exec.agent?.session.header.cwd
  const target = await fs.resolve(filePath, cwd !== undefined ? { cwd } : undefined)

  let preExisted = false
  let preStatus: 'ok' | 'too-large' | 'unreadable' = 'ok'
  let preBlobSha: string | null = null
  let preBytes: Buffer | null = null
  try {
    const bytes = await readFile(target.targetKey)
    preExisted = true
    if (bytes.length > maxSnapshotBytes) {
      preStatus = 'too-large'
    } else {
      preBlobSha = sha256Of(bytes)
      preBytes = bytes
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      preExisted = false
    } else {
      preStatus = 'unreadable'
    }
  }

  pendingCaptures.set(exec.callId, {
    targetKey: target.targetKey,
    displayPath: target.displayPath,
    preExisted,
    preStatus,
    preBlobSha,
    preBytes,
  })
}

/**
 * Post-execute capture: pair with the pre-capture, read exact post-bytes,
 * persist blobs + one record only when the tool succeeded (isError === false).
 * A mutation with no durable record is invisible to revert — the correct
 * failure direction (never revert from a half-captured record).
 */
export async function capturePost(
  ctx: Context,
  exec: ToolExecution,
  result: ToolExecutionResult,
  pendingCaptures: Map<string, PendingCapture>,
  manifestFor: (sessionId: string) => MutationManifest,
  blobStore: BlobStore,
): Promise<void> {
  if (!MUTATION_TOOLS.has(exec.name)) return
  const pre = pendingCaptures.get(exec.callId)
  pendingCaptures.delete(exec.callId)
  if (pre === undefined) return
  if (result.isError) return // failed tool: no durable record (documented gap)

  const sessionId = exec.agent?.session.id
  if (sessionId === undefined) return
  const session = exec.agent?.session
  if (session === undefined) return

  // Persist pre-bytes (if captured) and post-bytes to the blob store.
  if (pre.preBytes !== null && pre.preBlobSha !== null) {
    await blobStore.put(pre.preBytes)
  }
  let postStatus: 'ok' | 'too-large' | 'unreadable' = 'ok'
  let postBlobSha: string | null = null
  try {
    const bytes = await readFile(pre.targetKey)
    postBlobSha = sha256Of(bytes)
    await blobStore.put(bytes)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      postStatus = 'unreadable' // file vanished right after write
    } else {
      postStatus = 'unreadable'
    }
  }

  // Look up the tool/call event seq from the session log (never mint our own).
  let toolSeq = -1
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'tool/call' && (e.data as { callId?: string }).callId === exec.callId) {
      toolSeq = e.seq
      break
    }
  }
  if (toolSeq === -1) return // event not yet logged — skip (documented gap)

  await manifestFor(sessionId).append({
    sessionId,
    toolSeq,
    callId: exec.callId,
    targetKey: pre.targetKey,
    displayPath: pre.displayPath,
    operation: pre.preExisted ? 'update' : 'create',
    preExisted: pre.preExisted,
    preStatus: pre.preStatus,
    preBlobSha: pre.preBlobSha,
    postStatus,
    postBlobSha,
    isInterleaved: false,
    timestamp: Date.now(),
  })
}