import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SYSTEM_CONTEXT, readSystemContext, readSystemContextOrDefault, writeSystemContext,
} from '../src/context-file.ts'
import { runSystemScan } from '../src/scan.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One fresh directory for a context document. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-first-run-'))
  roots.push(root)
  return join(root, 'system-context.md')
}

describe('system-context document', () => {
  it('returns null before any write and the documented default on read', () => {
    const path = scratch()
    expect(readSystemContext(path)).toBeNull()
    expect(readSystemContextOrDefault(path)).toBe(DEFAULT_SYSTEM_CONTEXT)
    expect(DEFAULT_SYSTEM_CONTEXT).not.toContain('—')
  })

  it('writes atomically, creates the directory, and reads the exact text back', () => {
    const path = join(scratch(), 'nested', 'system-context.md')
    expect(writeSystemContext('# System context\nfacts\n', path)).toBe(path)
    expect(readSystemContext(path)).toBe('# System context\nfacts')
    expect(readSystemContextOrDefault(path)).toBe('# System context\nfacts')
    expect(readFileSync(path, 'utf8')).toBe('# System context\nfacts\n')
  })

  it('treats an empty document as absent', () => {
    const path = scratch()
    writeFileSync(path, '   \n')
    expect(readSystemContext(path)).toBeNull()
    expect(readSystemContextOrDefault(path)).toBe(DEFAULT_SYSTEM_CONTEXT)
  })
})

describe('read-only system scan', () => {
  it('assembles every section and reports stages in order', async () => {
    const stages: string[] = []
    const result = await runSystemScan(stage => stages.push(stage))
    expect(stages).toEqual(['hardware', 'operating system', 'services', 'disk', 'GPU', 'writing context'])
    expect(result.summary.threads).toBeGreaterThan(0)
    expect(result.summary.memoryGiB).toBeGreaterThan(0)
    expect(result.markdown).toContain('# System context')
    expect(result.markdown).toContain('## Hardware')
    expect(result.markdown).toContain('## Operating system')
    expect(result.markdown).toContain('## Services')
    expect(result.markdown).toContain('## Disk')
    expect(result.markdown).toContain('Nothing was modified.')
  })
})
