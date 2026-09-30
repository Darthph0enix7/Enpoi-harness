/**
 * The editor's asynchronous operations, as pure functions over an injected
 * fsops face: one read (initial load / reload), one stat-poll step (the
 * external-change watcher), and one optimistic save.
 *
 * Keeping them out of the component is what makes the state machine testable
 * with a fake transport: every decision — swap, banner, missing — is the return
 * value of a plain function, and the store only records what the component
 * hands it. The keystroke-loss guard lives in {@link pollOnce}: the buffer
 * revision captured before the read is compared after the read settles, so a
 * keystroke landing during the await aborts the swap instead of being
 * overwritten.
 */
import type { EditorFsOps, FileSnapshot, FileStat, WriteAck } from './fsops.ts'
import { FsOpsError } from './fsops.ts'

/** What one read settled as. */
export type EditorLoadOutcome =
  | { readonly kind: 'loaded'; readonly snapshot: FileSnapshot }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }

/** What one stat-poll step settled as. */
export type EditorPollOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'banner' }
  | { readonly kind: 'swap'; readonly snapshot: FileSnapshot }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }

/** What one save settled as. */
export type EditorSaveOutcome =
  | { readonly kind: 'saved'; readonly sha256: string | undefined; readonly mtimeMs: number | undefined; readonly size: number | undefined }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }

/** The wire code of a failure, for a value that is not an FsOpsError. */
function codeOf(error: unknown): string {
  return error instanceof FsOpsError ? error.code : 'unknown'
}

/** The human message of a failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a failure means the file is gone. */
function isMissing(error: unknown): boolean {
  return error instanceof FsOpsError && error.notFound
}

/** Whether a failure means the file changed since it was read. */
function isConflict(error: unknown): boolean {
  return error instanceof FsOpsError && error.conflict
}

/**
 * Read one file, mapping `not-found` to its own outcome.
 * @param fsOps - the file operations.
 * @param sessionId - the session whose workspace resolves the path.
 * @param path - the address's path.
 * @param signal - aborts the read.
 * @returns the snapshot, the missing state, or the failure.
 */
export async function loadOnce(
  fsOps: EditorFsOps,
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<EditorLoadOutcome> {
  try {
    return { kind: 'loaded', snapshot: await fsOps.read(sessionId, path, signal) }
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing' }
    return { kind: 'failed', code: codeOf(error), message: messageOf(error) }
  }
}

/** One stat-poll step's inputs. */
export interface PollInput {
  /** The file operations. */
  readonly fs: EditorFsOps
  /** The session whose workspace resolves the path. */
  readonly sessionId: string
  /** The address's path. */
  readonly path: string
  /** The stat last observed; absent until the first load or stat. */
  readonly baseline: FileStat | undefined
  /** Whether the buffer holds unsaved edits. */
  readonly dirty: boolean
  /** Whether the buffer is a truncated prefix (never swapped under a reader). */
  readonly truncated: boolean
  /** The buffer revision captured before this step began. */
  readonly revision: number
  /** Reads the buffer revision now; a change means a keystroke landed during the await. */
  readonly currentRevision: () => number
  /** Aborts the step. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Run one external-change poll step.
 *
 * An unchanged stat is cheap. A changed stat while the buffer is dirty (or
 * truncated) becomes the banner without a read, so the buffer is never
 * clobbered. Otherwise the file is re-read and swapped only when the buffer
 * revision is still the one captured before the read — typed during the await
 * means banner, never a silent replacement.
 * @param input - the poll inputs.
 * @returns the step's decision.
 */
export async function pollOnce(input: PollInput): Promise<EditorPollOutcome> {
  let stat: FileStat
  try {
    stat = await input.fs.stat(input.sessionId, input.path, input.signal)
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing' }
    return { kind: 'failed', code: codeOf(error), message: messageOf(error) }
  }
  const baseline = input.baseline
  if (baseline !== undefined && baseline.mtimeMs === stat.mtimeMs && baseline.size === stat.size) {
    return { kind: 'unchanged' }
  }
  if (input.dirty || input.truncated) return { kind: 'banner' }
  let snapshot: FileSnapshot
  try {
    snapshot = await input.fs.read(input.sessionId, input.path, input.signal)
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing' }
    return { kind: 'failed', code: codeOf(error), message: messageOf(error) }
  }
  // Keystroke-loss guard: a user edit after the read began outranks the swap.
  if (input.currentRevision() !== input.revision) return { kind: 'banner' }
  return { kind: 'swap', snapshot }
}

/** One save's inputs. */
export interface SaveInput {
  /** The file operations. */
  readonly fs: EditorFsOps
  /** The session whose workspace contains the file. */
  readonly sessionId: string
  /** The address's path. */
  readonly path: string
  /** The buffer to write. */
  readonly content: string
  /** The digest last read from disk, or `undefined` when there is no baseline. */
  readonly expectedSha: string | undefined
  /** Force the write past the digest check (the conflict banner's Overwrite). */
  readonly force: boolean
  /** Aborts the write. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Write the buffer with the optimistic digest check.
 * @param input - the save inputs.
 * @returns the ack, the conflict, or the failure.
 */
export async function saveOnce(input: SaveInput): Promise<EditorSaveOutcome> {
  try {
    const ack = await input.fs.write(
      input.sessionId,
      input.path,
      input.content,
      input.force ? undefined : input.expectedSha,
      input.force,
      input.signal,
    )
    return { kind: 'saved', sha256: ack.sha256, mtimeMs: ack.mtimeMs, size: ack.size }
  } catch (error) {
    if (isConflict(error)) return { kind: 'conflict' }
    return { kind: 'failed', code: codeOf(error), message: messageOf(error) }
  }
}

/** What one beside-write settled as. */
export type EditorSaveBesideOutcome =
  | { readonly kind: 'saved'; readonly path: string; readonly sha256: string | undefined }
  | { readonly kind: 'exists'; readonly path: string }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }

/** One beside-write's inputs. */
export interface SaveBesideInput {
  /** The file operations. */
  readonly fs: EditorFsOps
  /** The session whose workspace contains the file. */
  readonly sessionId: string
  /** The addressed file's path; the copy is its sibling. */
  readonly path: string
  /** The buffer to preserve. */
  readonly content: string
  /** Aborts the write. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Write the buffer to `<file>.mine-<timestamp>` as a create-only write, the
 * conflict flow's no-data-loss exit: the copy cannot clobber anything, and the
 * original file is left exactly as the disk holds it.
 * @param input - the beside-write inputs.
 * @returns the copy's path, the taken name, or the failure.
 */
export async function saveBesideOnce(input: SaveBesideInput): Promise<EditorSaveBesideOutcome> {
  const path = `${input.path}.mine-${Date.now()}`
  try {
    const ack = await input.fs.write(input.sessionId, path, input.content, null, false, input.signal)
    return { kind: 'saved', path, sha256: ack.sha256 }
  } catch (error) {
    if (isConflict(error)) return { kind: 'exists', path }
    return { kind: 'failed', code: codeOf(error), message: messageOf(error) }
  }
}

/** The baseline a successful save leaves behind. */
export interface SaveBaseline {
  /** Digest of the bytes now on disk, when it could be derived. */
  readonly sha256: string | undefined
  /** Post-write modification time, when it could be derived. */
  readonly mtimeMs: number | undefined
  /** Post-write size in bytes, when it could be derived. */
  readonly size: number | undefined
}

/**
 * SHA-256 of one string as lowercase hex.
 * @param text - the text to digest.
 * @returns the lowercase hex digest, or `undefined` where WebCrypto is unavailable.
 */
export async function sha256Hex(text: string): Promise<string | undefined> {
  // A page served over plain HTTP can lack WebCrypto entirely; the declared
  // lib type always has it, so the optional read is restated here.
  const webCrypto = globalThis.crypto as { subtle?: SubtleCrypto } | undefined
  const subtle = webCrypto?.subtle
  if (subtle === undefined) return undefined
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    // WebCrypto can only reject the digest itself; degraded saves still work,
    // they just re-read the file to recover the baseline instead.
    return undefined
  }
}

/**
 * Fill in the baseline fields a write ack omitted, so the next save still has a
 * digest to check: compute the written digest locally, then stat for the rest.
 * A route that reports nothing leaves `undefined` fields, which the store keeps
 * as the previous baseline.
 * @param fsOps - the file operations.
 * @param sessionId - the session whose workspace contains the file.
 * @param path - the address's path.
 * @param content - the bytes just written.
 * @param ack - the write ack to complete.
 * @param signal - aborts the recovery.
 * @returns the baseline to record.
 */
export async function completeSave(
  fsOps: EditorFsOps,
  sessionId: string,
  path: string,
  content: string,
  ack: WriteAck,
  signal?: AbortSignal,
): Promise<SaveBaseline> {
  const sha256 = ack.sha256 ?? await sha256Hex(content)
  let mtimeMs = ack.mtimeMs
  let size = ack.size
  if (mtimeMs === undefined || size === undefined) {
    try {
      const stat = await fsOps.stat(sessionId, path, signal)
      mtimeMs = stat.mtimeMs
      size = stat.size
    } catch {
      // The write itself succeeded; a failed follow-up stat only degrades the
      // next conflict check, and the save must still read as saved.
    }
  }
  return { sha256, mtimeMs, size }
}
