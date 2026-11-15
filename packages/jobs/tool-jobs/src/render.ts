/**
 * Model-facing rendering of registry reads: the consuming delta as the
 * shell tools have always shown it (stdout, then one marked stderr section),
 * the `[status: …]` line, and the public job projection the tool schemas
 * expose.
 * @module @deepseek-ai/dsh-tool-jobs/render
 */

import type { JobChunk, JobView } from '@deepseek-ai/dsh-jobs/view'

/** Job state safe for model-authored programs; ownership and offsets are omitted. */
export interface PublicJobSnapshot {
  id: string
  kind: string
  label: string
  status: JobView['status']
  /** The live progress line while running, the terminal reason once settled. */
  detail?: string
  startedAt: number
  finishedAt?: number
}

/**
 * The one-line qualifier the model reads beside a status: live progress while
 * the job runs, the terminal reason once it settled.
 * @param job - the job projection.
 * @returns the qualifier, or undefined when the job carries neither.
 */
export function jobDetail(job: Pick<JobView, 'progress' | 'detail'>): string | undefined {
  return job.progress ?? job.detail
}

/**
 * Remove ownership, offsets, and limits from a registry projection.
 * @param job - the registry projection.
 * @returns the model-safe projection.
 */
export function publicJob(job: JobView): PublicJobSnapshot {
  const detail = jobDetail(job)
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...detail !== undefined ? { detail } : {},
    startedAt: job.startedAt,
    ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
  }
}

/**
 * Render generic status with optional detail.
 * @param snapshot - job state to render.
 * @returns a bracketed status line.
 */
export function statusLine(snapshot: Pick<PublicJobSnapshot, 'status' | 'detail'>): string {
  return snapshot.detail !== undefined
    ? `[status: ${snapshot.status}, ${snapshot.detail}]`
    : `[status: ${snapshot.status}]`
}

/**
 * Host-owned label that frames a retained stderr excerpt as untrusted job
 * output: it is verbatim retained text, never a diagnosis or an instruction.
 */
export const STDERR_EXCERPT_LABEL = 'stderr excerpt (retained output; verbatim, not a diagnosis)'

/** Opening of the single-line excerpt metadata; a fitted read keeps this head beside its status footer. */
export const STDERR_EXCERPT_PREFIX = `[${STDERR_EXCERPT_LABEL}: `

/**
 * Escape one code point so the excerpt stays on its metadata line and cannot
 * forge additional model-visible lines.
 * @param char - one code point of job output.
 * @returns the printable form: the character itself, a named escape, or a `\\uXXXX` escape.
 */
function escapeMetadataCharacter(char: string): string {
  switch (char) {
    case '\\': return '\\\\'
    case '\n': return '\\n'
    case '\r': return '\\r'
    case '\t': return '\\t'
    case '\u2028': return '\\u2028'
    case '\u2029': return '\\u2029'
    default: {
      // Control ranges are BMP-only, so the first UTF-16 unit classifies them;
      // astral code points are above C1 and stay verbatim.
      const code = char.charCodeAt(0)
      return code < 0x20 || (code >= 0x7f && code <= 0x9f)
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : char
    }
  }
}

/**
 * Clip escaped job output to a whole-code-point character budget.
 * @param text - retained job output.
 * @param maxChars - maximum displayed characters.
 * @returns the escaped prefix that fits, never splitting a surrogate pair or escape.
 */
function clipMetadata(text: string, maxChars: number): string {
  let out = ''
  let used = 0
  for (const char of text) {
    const piece = escapeMetadataCharacter(char)
    const width = piece === char ? 1 : piece.length
    if (used + width > maxChars) break
    out += piece
    used += width
  }
  return out
}

/**
 * Render the first retained stderr chunk of a read as one bounded metadata
 * line. Retention may already have dropped earlier stderr, so the label says
 * "retained output" rather than claiming the job's first error.
 * @param chunks - chunks this read already returned; `log` narration is ignored.
 * @param maxChars - maximum displayed characters of the excerpt text.
 * @returns the bracketed line, or undefined when the read returned no stderr text.
 */
export function retainedStderrExcerpt(chunks: readonly JobChunk[], maxChars: number): string | undefined {
  const first = chunks.find(chunk => chunk.channel === 'stderr' && /\S/u.test(chunk.text))
  if (first === undefined) return undefined
  const text = clipMetadata(first.text, maxChars)
  return text.length > 0 ? `${STDERR_EXCERPT_PREFIX}${text}]` : undefined
}

/**
 * Render one consuming read for the model: stdout and unlabeled chunks in
 * order, then every stderr chunk in one `[stderr]` section, exactly as the
 * shell tools render a foreground result. `log` chunks are producer
 * narration for observers and never reach the model. Lost bytes — the cursor
 * fell behind the ring's retention, or a model-visible chunk carries a
 * producer-side gap — end the read with the shell tools' dropped-output
 * notice, naming the spill files the job's sources keep.
 * @param chunks - the chunks since the model cursor, in offset order.
 * @param lossy - whether bytes before `chunks` were evicted unread.
 * @param spillPaths - the complete-stream files the job currently advertises (`JobView.output.spillPaths`).
 * @returns the delta text, possibly empty.
 */
export function renderModelDelta(chunks: readonly JobChunk[], lossy: boolean, spillPaths: readonly string[]): string {
  const visible = chunks.filter(chunk => chunk.channel !== 'log')
  const out = visible.filter(chunk => chunk.channel !== 'stderr').map(chunk => chunk.text).join('')
  const err = visible.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  const body = out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
  if (!lossy && !visible.some(chunk => chunk.gapBefore === true)) return body
  const notice = `[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`
  return `${body}${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}${notice}`
}
