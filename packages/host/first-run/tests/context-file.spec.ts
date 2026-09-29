import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SYSTEM_CONTEXT,
  readSystemProfile,
  readSystemProfileDecision,
  readSystemProfileOrDefault,
  removeSystemProfile,
  SYSTEM_PROFILE_REFERENCE,
  writeSystemProfile,
  writeSystemProfileDecision,
  writeSystemProfileScan,
} from '../src/context-file.ts'
import { runSystemScan } from '../src/scan.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One fresh directory for a profile document. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-first-run-'))
  roots.push(root)
  return join(root, 'system-profile.md')
}

describe('system-profile document', () => {
  it('returns null before any write and the documented default on read', () => {
    const path = scratch()
    expect(readSystemProfile(path)).toBeNull()
    expect(readSystemProfileOrDefault(path)).toBe(DEFAULT_SYSTEM_CONTEXT)
    expect(DEFAULT_SYSTEM_CONTEXT).not.toContain('—')
    expect(SYSTEM_PROFILE_REFERENCE).toContain('$DSH_HOME/system-profile.md')
  })

  it('writes atomically, creates the directory, and reads the exact text back', () => {
    const path = join(scratch(), 'nested', 'system-profile.md')
    expect(writeSystemProfile('# System profile\nfacts\n', path)).toBe(path)
    expect(readSystemProfile(path)).toBe('# System profile\nfacts')
    expect(readSystemProfileOrDefault(path)).toBe('# System profile\nfacts')
    expect(readFileSync(path, 'utf8')).toBe('# System profile\nfacts\n')
  })

  it('treats an empty document as absent', () => {
    const path = scratch()
    writeFileSync(path, '   \n')
    expect(readSystemProfile(path)).toBeNull()
    expect(readSystemProfileOrDefault(path)).toBe(DEFAULT_SYSTEM_CONTEXT)
  })

  it('keeps the raw scan JSON beside the document and removes both on rejection', () => {
    const path = scratch()
    const scanPath = join(path, '..', 'system-profile.scan.json')
    writeSystemProfile('# System profile\n', path)
    writeSystemProfileScan('{"threads":8}', scanPath)
    expect(readFileSync(scanPath, 'utf8')).toBe('{"threads":8}')
    removeSystemProfile(path, scanPath)
    expect(readSystemProfile(path)).toBeNull()
    expect(() => readFileSync(scanPath, 'utf8')).toThrow()
    // Rejection is idempotent.
    removeSystemProfile(path, scanPath)
  })

  it('records and reads the operator decision', () => {
    const path = join(scratch(), '..', 'system-profile.decision')
    expect(readSystemProfileDecision(path)).toBeNull()
    writeSystemProfileDecision('rejected', path)
    expect(readSystemProfileDecision(path)).toBe('rejected')
    writeSystemProfileDecision('accepted', path)
    expect(readSystemProfileDecision(path)).toBe('accepted')
    writeFileSync(path, 'maybe\n')
    expect(readSystemProfileDecision(path)).toBeNull()
  })
})

describe('read-only system scan', () => {
  it('assembles every section and reports stages in order', async () => {
    const stages: string[] = []
    const result = await runSystemScan(stage => stages.push(stage))
    expect(stages).toEqual(['hardware', 'operating system', 'services', 'tooling', 'hosting', 'disk', 'GPU'])
    expect(result.summary.threads).toBeGreaterThan(0)
    expect(result.summary.memoryGiB).toBeGreaterThan(0)
    expect(result.facts.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    expect(result.facts.hardware.threads).toBe(result.summary.threads)
    expect(result.facts.os.platform).toBe(process.platform)
    expect(result.facts.tooling.map(tool => tool.name)).toEqual([
      'docker', 'node', 'npm', 'python', 'cuda', 'git', 'pnpm', 'tailscale',
    ])
    expect(result.facts.disk.length).toBe(2)
    expect(Array.isArray(result.facts.hosting.containerNames)).toBe(true)
  })
})
