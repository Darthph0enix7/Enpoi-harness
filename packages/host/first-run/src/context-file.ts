/**
 * Durable locations and documented defaults of the system profile.
 *
 * The system analysis writes one capability-level Markdown document under the
 * harness home, the raw scan JSON beside it, and a decision marker recording
 * whether the operator accepted or rejected the document. A sysadmin-mounted
 * prompt context references the document, so every sysadmin session reads the
 * facts of this machine instead of a default text; before any analysis ran —
 * or after a rejection — it contributes the default below instead.
 * @module @deepseek-ai/dsh-host-first-run/context-file
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Profile document name under the harness home. */
export const SYSTEM_PROFILE_FILENAME = 'system-profile.md'

/** Raw scan JSON name under the harness home, beside the profile document. */
export const SYSTEM_PROFILE_SCAN_FILENAME = 'system-profile.scan.json'

/** Decision marker name under the harness home. */
export const SYSTEM_PROFILE_DECISION_FILENAME = 'system-profile.decision'

/** What the operator decided about a stored profile. */
export type SystemProfileDecision = 'accepted' | 'rejected'

/**
 * Context a sysadmin session reads before the analysis has ever run, or after
 * the operator rejected the document. It states only the fact that nothing is
 * stored, so an agent confirms machine facts with read-only commands instead
 * of trusting invented ones.
 */
export const DEFAULT_SYSTEM_CONTEXT = [
  'System profile: no analysis is stored for this machine yet.',
  'Hardware, operating system, service and hosting facts are unknown here.',
  'Confirm them with read-only commands before acting, or run the system analysis.',
].join('\n')

/**
 * Context a sysadmin session reads once a profile is stored. It references the
 * document instead of inlining it: the file is the living record, and a
 * reference stays true as the machine changes.
 */
export const SYSTEM_PROFILE_REFERENCE = [
  'Read $DSH_HOME/system-profile.md for this machine.',
  'It is the living, capability-level record of this host; confirm anything it does not state with read-only commands.',
].join('\n')

/** Absolute path of the profile document. */
export function systemProfilePath(): string {
  return dshHomePath(SYSTEM_PROFILE_FILENAME)
}

/** Absolute path of the raw scan JSON. */
export function systemProfileScanPath(): string {
  return dshHomePath(SYSTEM_PROFILE_SCAN_FILENAME)
}

/** Absolute path of the decision marker. */
export function systemProfileDecisionPath(): string {
  return dshHomePath(SYSTEM_PROFILE_DECISION_FILENAME)
}

/**
 * Read the stored system profile.
 * @param path - document path; defaults to {@link systemProfilePath}.
 * @returns the stored text, or null when the document is absent or empty.
 */
export function readSystemProfile(path: string = systemProfilePath()): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text === '' ? null : text
  } catch (_absentOrUnreadable) {
    return null
  }
}

/**
 * Read the stored system profile, falling back to {@link DEFAULT_SYSTEM_CONTEXT}.
 * @param path - document path; defaults to {@link systemProfilePath}.
 * @returns the stored or default text.
 */
export function readSystemProfileOrDefault(path: string = systemProfilePath()): string {
  return readSystemProfile(path) ?? DEFAULT_SYSTEM_CONTEXT
}

/**
 * The prompt contribution for one profile document: a reference once a profile
 * is stored, the documented default otherwise.
 * @param path - document path; defaults to {@link systemProfilePath}.
 * @returns the reference or default text.
 */
export function systemProfileContextText(path: string = systemProfilePath()): string {
  return readSystemProfile(path) === null ? DEFAULT_SYSTEM_CONTEXT : SYSTEM_PROFILE_REFERENCE
}

/**
 * Write one file atomically, creating its directory when absent.
 * @param path - destination path.
 * @param content - file content.
 * @returns the absolute path written.
 */
function writeAtomic(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  try {
    writeFileSync(temporary, content)
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch (_missingTemporary) {
      // The temporary file was never created or already moved; nothing to clean.
    }
    throw error
  }
  return path
}

/**
 * Write the system profile atomically.
 * @param markdown - document content.
 * @param path - document path; defaults to {@link systemProfilePath}.
 * @returns the absolute path written.
 */
export function writeSystemProfile(markdown: string, path: string = systemProfilePath()): string {
  return writeAtomic(path, markdown)
}

/**
 * Write the raw scan JSON atomically.
 * @param json - serialized scan facts.
 * @param path - JSON path; defaults to {@link systemProfileScanPath}.
 * @returns the absolute path written.
 */
export function writeSystemProfileScan(json: string, path: string = systemProfileScanPath()): string {
  return writeAtomic(path, json)
}

/**
 * Remove the profile document and its raw scan JSON. Missing files are fine:
 * rejection is idempotent.
 * @param path - document path; defaults to {@link systemProfilePath}.
 * @param scanPath - JSON path; defaults to {@link systemProfileScanPath}.
 */
export function removeSystemProfile(
  path: string = systemProfilePath(),
  scanPath: string = systemProfileScanPath(),
): void {
  for (const target of [path, scanPath]) {
    try {
      unlinkSync(target)
    } catch (_absent) {
      // Already gone; rejection stays idempotent.
    }
  }
}

/**
 * Read the operator's decision about the stored profile.
 * @param path - marker path; defaults to {@link systemProfileDecisionPath}.
 * @returns the recorded decision, or null when none was recorded.
 */
export function readSystemProfileDecision(path: string = systemProfileDecisionPath()): SystemProfileDecision | null {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text === 'accepted' || text === 'rejected' ? text : null
  } catch (_absentOrUnreadable) {
    return null
  }
}

/**
 * Record the operator's decision about the stored profile.
 * @param decision - the decision to persist.
 * @param path - marker path; defaults to {@link systemProfileDecisionPath}.
 * @returns the absolute path written.
 */
export function writeSystemProfileDecision(
  decision: SystemProfileDecision,
  path: string = systemProfileDecisionPath(),
): string {
  return writeAtomic(path, `${decision}\n`)
}
