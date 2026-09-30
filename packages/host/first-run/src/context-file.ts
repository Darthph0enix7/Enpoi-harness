/**
 * Durable locations, essentials reader, and documented defaults of the system
 * profile.
 *
 * The system analysis writes one general Markdown document under the harness
 * home, the structured JSON profile beside it, and a decision marker recording
 * whether the operator accepted, rejected, or merely saw the document once. A
 * sysadmin-mounted prompt context contributes only the essentials read from
 * that JSON plus a reference to the Markdown document, so the full record stays
 * in one place;
 * before any analysis ran — or after a rejection — it contributes the default
 * below instead.
 * @module @deepseek-ai/dsh-host-first-run/context-file
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Profile document name under the harness home. */
export const SYSTEM_PROFILE_FILENAME = 'system-profile.md'

/** Structured profile JSON name under the harness home, beside the document. */
export const SYSTEM_PROFILE_JSON_FILENAME = 'system-profile.json'

/** Decision marker name under the harness home. */
export const SYSTEM_PROFILE_DECISION_FILENAME = 'system-profile.decision'

/**
 * What the operator settled on for a stored profile: an explicit accept or
 * reject, or `seen` when the profile was displayed once without a decision.
 * A `seen` profile is settled like an accepted one: the files stay and the
 * review is never offered again.
 */
export type SystemProfileDecision = 'accepted' | 'rejected' | 'seen'

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
 * Markdown document instead of inlining it: the file is the living, full
 * record, and a reference stays true as the machine changes.
 */
export const SYSTEM_PROFILE_REFERENCE = [
  'Read $DSH_HOME/system-profile.md for this machine.',
  'It is the living, full record of this host; the structured profile sits beside it as system-profile.json.',
  'Confirm anything the document does not state with read-only commands.',
].join('\n')

/** Absolute path of the profile document. */
export function systemProfilePath(): string {
  return dshHomePath(SYSTEM_PROFILE_FILENAME)
}

/** Absolute path of the structured profile JSON. */
export function systemProfileJsonPath(): string {
  return dshHomePath(SYSTEM_PROFILE_JSON_FILENAME)
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

/** The compact capability facts the sysadmin context contributes. */
export interface SystemProfileEssentials {
  /** What kind of machine this is (`server`, `desktop`, `laptop`, `vm`, `other`). */
  readonly hostKind?: string
  /** CPU class and thread count. */
  readonly cpu?: string
  /** Memory size class. */
  readonly memory?: string
  /** GPU class, or an explicit absence. */
  readonly gpu?: string
  /** Disk type and rough headroom. */
  readonly disk?: string
}

/** Read one optional string member of a parsed record. */
function member(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = (value as Record<string, unknown>)[key]
  return typeof entry === 'string' && entry.trim() !== '' ? entry.trim() : undefined
}

/**
 * Read the essentials the prompt contribution carries from the stored
 * structured profile. A missing or malformed JSON file degrades to the
 * reference alone; it never invents machine facts.
 * @param path - JSON path; defaults to {@link systemProfileJsonPath}.
 * @returns the present essentials, each absent when the profile does not state it.
 */
export function readSystemProfileEssentials(path: string = systemProfileJsonPath()): SystemProfileEssentials {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const hardware = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['hardware']
      : undefined
    const hostKind = member(parsed, 'hostKind')
    const cpu = member(hardware, 'cpu')
    const memory = member(hardware, 'memory')
    const gpu = member(hardware, 'gpu')
    const disk = member(hardware, 'disk')
    return {
      ...hostKind === undefined ? {} : { hostKind },
      ...cpu === undefined ? {} : { cpu },
      ...memory === undefined ? {} : { memory },
      ...gpu === undefined ? {} : { gpu },
      ...disk === undefined ? {} : { disk },
    }
  } catch (_absentOrUnparsable) {
    return {}
  }
}

/** Cap on one essentials field, so a verbose profile cannot flood the prompt. */
const ESSENTIALS_FIELD_MAX = 120

/** Bound one field with an explicit ellipsis when the profile stated more. */
function boundField(value: string): string {
  return value.length <= ESSENTIALS_FIELD_MAX ? value : `${value.slice(0, ESSENTIALS_FIELD_MAX - 1)}…`
}

/**
 * Render the essentials into one bounded line, or null when the profile states
 * none. Absence is stated by the document, not guessed here.
 * @param essentials - the present essentials.
 * @returns one `System profile essentials: ...` line, or null.
 */
export function essentialsLine(essentials: SystemProfileEssentials): string | null {
  const parts = [
    essentials.hostKind === undefined ? undefined : boundField(essentials.hostKind),
    essentials.cpu === undefined ? undefined : `CPU ${boundField(essentials.cpu)}`,
    essentials.memory === undefined ? undefined : `memory ${boundField(essentials.memory)}`,
    essentials.gpu === undefined ? undefined : `GPU ${boundField(essentials.gpu)}`,
    essentials.disk === undefined ? undefined : `disk ${boundField(essentials.disk)}`,
  ].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? null : `System profile essentials: ${parts.join('; ')}.`
}

/**
 * The prompt contribution for one profile: a bounded essentials line read from
 * the structured profile plus a reference to the full document, or the
 * documented default when no profile is stored.
 * @param path - document path; defaults to {@link systemProfilePath}.
 * @param jsonPath - structured profile path; defaults to {@link systemProfileJsonPath}.
 * @returns the essentials-plus-reference text, or the default.
 */
export function systemProfileContextText(
  path: string = systemProfilePath(),
  jsonPath: string = systemProfileJsonPath(),
): string {
  if (readSystemProfile(path) === null) return DEFAULT_SYSTEM_CONTEXT
  const essentials = essentialsLine(readSystemProfileEssentials(jsonPath))
  return essentials === null ? SYSTEM_PROFILE_REFERENCE : `${essentials}\n${SYSTEM_PROFILE_REFERENCE}`
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
 * Write the structured profile JSON atomically.
 * @param json - serialized structured profile.
 * @param path - JSON path; defaults to {@link systemProfileJsonPath}.
 * @returns the absolute path written.
 */
export function writeSystemProfileJson(json: string, path: string = systemProfileJsonPath()): string {
  return writeAtomic(path, json)
}

/**
 * Remove the profile document and its structured JSON. Missing files are fine:
 * rejection is idempotent.
 * @param path - document path; defaults to {@link systemProfilePath}.
 * @param jsonPath - JSON path; defaults to {@link systemProfileJsonPath}.
 */
export function removeSystemProfile(
  path: string = systemProfilePath(),
  jsonPath: string = systemProfileJsonPath(),
): void {
  for (const target of [path, jsonPath]) {
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
    return text === 'accepted' || text === 'rejected' || text === 'seen' ? text : null
  } catch (_absentOrUnreadable) {
    return null
  }
}

/**
 * Record the operator's decision about the stored profile, or the one-time
 * `seen` marker that retires the review without touching the files.
 * @param decision - the decision or marker to persist.
 * @param path - marker path; defaults to {@link systemProfileDecisionPath}.
 * @returns the absolute path written.
 */
export function writeSystemProfileDecision(
  decision: SystemProfileDecision,
  path: string = systemProfileDecisionPath(),
): string {
  return writeAtomic(path, `${decision}\n`)
}

/**
 * Remove the decision marker so a newly published profile starts undecided.
 * @param path - marker path; defaults to {@link systemProfileDecisionPath}.
 * @returns true when a marker was removed, false when none existed.
 */
export function removeSystemProfileDecision(path: string = systemProfileDecisionPath()): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (_absent) {
    return false
  }
}
