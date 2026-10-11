/**
 * Pin and tombstone list loading (§3.5, §3.2).
 *
 * `$DSH_HOME/update/pins.yaml` is accepted as either a JSON array of strings
 * or a simple YAML list (`pins:` followed by `- pattern` rows). Tombstone
 * files accept the same two forms. Patterns are relative paths or globs
 * handled by {@link matchGlob}.
 */

import { readFile } from 'node:fs/promises'

/**
 * Parse a JSON array or YAML/newline list of path patterns.
 * @param text - File content.
 * @returns Trimmed, de-duplicated entries in first-seen order.
 */
export function parsePathList(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new Error(`invalid JSON path list: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
      throw new Error('JSON path list must be an array of strings')
    }
    return dedupe(parsed.map(item => (item as string).trim()).filter(item => item !== ''))
  }
  const entries: string[] = []
  for (const rawLine of text.split('\n')) {
    const withoutComment = rawLine.split('#', 1)[0] ?? ''
    let line = withoutComment.trim()
    if (line === '') continue
    if (/^[A-Za-z0-9_-]+:\s*$/u.test(line)) continue
    if (line.startsWith('- ')) line = line.slice(2).trim()
    else if (line === '-') continue
    line = stripQuotes(line)
    if (line === '') continue
    entries.push(line)
  }
  return dedupe(entries)
}

/**
 * Load a pin list; a missing file yields an empty list.
 * @param path - pins.yaml path.
 * @returns Pin patterns in file order.
 */
export async function loadPins(path: string): Promise<string[]> {
  return loadPathList(path)
}

/**
 * Load a tombstone list; a missing file yields an empty list.
 * @param path - tombstones file path.
 * @returns Tombstone patterns in file order.
 */
export async function loadTombstones(path: string): Promise<string[]> {
  return loadPathList(path)
}

async function loadPathList(path: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return parsePathList(text)
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}
