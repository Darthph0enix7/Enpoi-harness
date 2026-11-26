/**
 * Canonical JSON hashing and fail-closed durable audit storage (`0600` bounded
 * per-session JSONL files).
 *
 * @module dsh-enpoi-job-guard/audit
 */

import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { JobGuardAuditRecord, JobGuardBudgetStopRecord } from './types.ts'

/**
 * Serialize JSON with object keys ordered by UTF-16 code units, including numeric-looking keys.
 * @param value - JSON-compatible value.
 * @returns deterministic JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().flatMap(key => {
      const entry = record[key]
      return entry === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(entry)}`]
    }).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Compute lowercase hex SHA-256 of UTF-8 text.
 * @param text - input string.
 * @returns 64-character hex digest.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Compute the canonical argument SHA-256 digest without retaining raw arguments.
 * @param args - parsed tool arguments.
 * @returns 64-character hex digest.
 */
export function hashArguments(args: unknown): string {
  return sha256Hex(canonicalJson(args))
}

/**
 * Injectively encode a session id into a single traversal-safe filename segment.
 * @param raw - session id string.
 * @returns encoded path segment.
 */
export function encodeAuditSegment(raw: string): string {
  if (raw.length === 0) return '~empty'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

/**
 * Ensure `dir` exists as a real, non-symlink directory with mode `0o700`.
 */
async function ensurePrivateAuditDir(dir: string): Promise<void> {
  const resolved = resolve(dir)
  try {
    const info = await lstat(resolved)
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) {
      throw new Error('audit directory is not a regular directory')
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 })
  const created = await lstat(resolved)
  /* v8 ignore next 3 -- mkdir created this directory immediately above */
  if (!created.isDirectory() || (created.mode & 0o777) !== 0o700) {
    throw new Error('audit directory could not be verified')
  }
}

/**
 * Append one JSONL line to a bounded `0o600` regular file under `auditDir`.
 * Rejects symlinks, non-regular files, and writes that would exceed `maxBytes`.
 */
async function appendBoundedPrivateFile(
  auditDir: string,
  sessionKey: string,
  record: object,
  maxBytes: number,
): Promise<void> {
  await ensurePrivateAuditDir(auditDir)
  const filePath = join(resolve(auditDir), `${encodeAuditSegment(sessionKey)}.jsonl`)
  try {
    const existing = await lstat(filePath)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('audit file path is not a regular file')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const line = `${JSON.stringify(record)}\n`
  const lineBytes = Buffer.byteLength(line, 'utf8')
  /* v8 ignore next -- O_NOFOLLOW fallback only runs on platforms lacking the flag */
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0)
  const handle = await open(filePath, flags, 0o600)
  try {
    const info = await handle.stat()
    /* v8 ignore next 3 -- defensive check against FIFO/device race after lstat */
    if (!info.isFile()) {
      throw new Error('audit handle is not a regular file')
    }
    if ((info.mode & 0o777) !== 0o600 || info.nlink !== 1) throw new Error('audit file is not private')
    if (info.size + lineBytes > maxBytes) {
      throw new Error('session audit file byte limit exceeded')
    }
    await handle.writeFile(line, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Write a sanitized audit record to the bounded `0600` audit file.
 * @param options - audit directory, byte ceiling, and session key.
 * @param record - sanitized record (must contain no raw arguments or secrets).
 */
export async function writeDurableAudit(
  options: {
    auditDir: string
    auditMaxBytes: number
    sessionKey: string
  },
  record: JobGuardAuditRecord | JobGuardBudgetStopRecord,
): Promise<void> {
  await appendBoundedPrivateFile(options.auditDir, options.sessionKey, record, options.auditMaxBytes)
}
