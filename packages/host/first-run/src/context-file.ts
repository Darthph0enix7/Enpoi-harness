/**
 * Durable location and documented default of the sysadmin system context.
 *
 * The first-run analysis writes one Markdown document under the harness home;
 * a sysadmin-mounted prompt context reads it, so every sysadmin session sees
 * the facts of this machine instead of the default text below.
 * @module @deepseek-ai/dsh-host-first-run/context-file
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Document name under the harness home. */
export const SYSTEM_CONTEXT_FILENAME = 'system-context.md'

/**
 * Context a sysadmin session reads before the analysis has ever run. It states
 * only the fact that nothing is stored, so an agent confirms machine facts
 * with read-only commands instead of trusting invented ones.
 */
export const DEFAULT_SYSTEM_CONTEXT = [
  'System context: no analysis is stored for this machine yet.',
  'Hardware, operating system, service and disk facts are unknown here.',
  'Confirm them with read-only commands before acting, or run the first-run system analysis.',
].join('\n')

/** Absolute path of the system-context document. */
export function systemContextPath(): string {
  return dshHomePath(SYSTEM_CONTEXT_FILENAME)
}

/**
 * Read the stored system context.
 * @param path - document path; defaults to {@link systemContextPath}.
 * @returns the stored text, or null when the document is absent or empty.
 */
export function readSystemContext(path: string = systemContextPath()): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text === '' ? null : text
  } catch (_absentOrUnreadable) {
    return null
  }
}

/**
 * Read the stored system context, falling back to {@link DEFAULT_SYSTEM_CONTEXT}.
 * @param path - document path; defaults to {@link systemContextPath}.
 * @returns the stored or default text.
 */
export function readSystemContextOrDefault(path: string = systemContextPath()): string {
  return readSystemContext(path) ?? DEFAULT_SYSTEM_CONTEXT
}

/**
 * Write the system context atomically, creating its directory when absent.
 * @param markdown - document content.
 * @param path - document path; defaults to {@link systemContextPath}.
 * @returns the absolute path written.
 */
export function writeSystemContext(markdown: string, path: string = systemContextPath()): string {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  try {
    writeFileSync(temporary, markdown)
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
