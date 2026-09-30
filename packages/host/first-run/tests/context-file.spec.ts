import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SYSTEM_CONTEXT,
  essentialsLine,
  readSystemProfile,
  readSystemProfileDecision,
  readSystemProfileEssentials,
  readSystemProfileOrDefault,
  removeSystemProfile,
  SYSTEM_PROFILE_REFERENCE,
  systemProfileContextText,
  writeSystemProfile,
  writeSystemProfileDecision,
  writeSystemProfileJson,
} from '../src/context-file.ts'

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

  it('keeps the structured JSON beside the document and removes both on rejection', () => {
    const path = scratch()
    const jsonPath = join(path, '..', 'system-profile.json')
    writeSystemProfile('# System profile\n', path)
    writeSystemProfileJson('{"hostKind":"server"}', jsonPath)
    expect(readFileSync(jsonPath, 'utf8')).toBe('{"hostKind":"server"}')
    removeSystemProfile(path, jsonPath)
    expect(readSystemProfile(path)).toBeNull()
    expect(() => readFileSync(jsonPath, 'utf8')).toThrow()
    // Rejection is idempotent.
    removeSystemProfile(path, jsonPath)
  })

  it('records and reads the operator decision', () => {
    const path = join(scratch(), '..', 'system-profile.decision')
    expect(readSystemProfileDecision(path)).toBeNull()
    writeSystemProfileDecision('rejected', path)
    expect(readSystemProfileDecision(path)).toBe('rejected')
    writeSystemProfileDecision('accepted', path)
    expect(readSystemProfileDecision(path)).toBe('accepted')
    writeSystemProfileDecision('seen', path)
    expect(readSystemProfileDecision(path)).toBe('seen')
    writeFileSync(path, 'maybe\n')
    expect(readSystemProfileDecision(path)).toBeNull()
  })
})

describe('profile essentials', () => {
  it('reads the present essentials from the structured profile and ignores malformed input', () => {
    const jsonPath = join(scratch(), '..', 'system-profile.json')
    expect(readSystemProfileEssentials(jsonPath)).toEqual({})
    writeFileSync(jsonPath, 'not json')
    expect(readSystemProfileEssentials(jsonPath)).toEqual({})
    writeSystemProfileJson(JSON.stringify({
      hostKind: 'server',
      purpose: 'self-hosted services and software projects',
      hardware: { cpu: 'server-class x86-64, 28 threads', memory: '64 GiB class', gpu: 'discrete NVIDIA accelerator, 24 GB class', disk: 'SSD storage, moderate headroom' },
      usage: { development: true },
    }), jsonPath)
    expect(readSystemProfileEssentials(jsonPath)).toEqual({
      hostKind: 'server',
      cpu: 'server-class x86-64, 28 threads',
      memory: '64 GiB class',
      gpu: 'discrete NVIDIA accelerator, 24 GB class',
      disk: 'SSD storage, moderate headroom',
    })
    expect(essentialsLine(readSystemProfileEssentials(jsonPath)))
      .toBe('System profile essentials: server; CPU server-class x86-64, 28 threads; memory 64 GiB class; GPU discrete NVIDIA accelerator, 24 GB class; disk SSD storage, moderate headroom.')
    expect(essentialsLine({})).toBeNull()
  })

  it('bounds one verbose essentials field instead of flooding the prompt', () => {
    const long = 'x'.repeat(400)
    const line = essentialsLine({ hostKind: 'server', cpu: long })
    expect(line).toBe(`System profile essentials: server; CPU ${'x'.repeat(119)}….`)
  })

  it('contributes essentials plus the reference once stored, and the default before that', () => {
    const path = join(scratch(), '..', 'system-profile.md')
    const jsonPath = join(path, '..', 'system-profile.json')
    expect(systemProfileContextText(path, jsonPath)).toBe(DEFAULT_SYSTEM_CONTEXT)
    writeSystemProfile('# System profile\n', path)
    expect(systemProfileContextText(path, jsonPath)).toBe(SYSTEM_PROFILE_REFERENCE)
    writeSystemProfileJson('{"hostKind":"server","hardware":{"gpu":"discrete NVIDIA accelerator, 24 GB class"}}', jsonPath)
    expect(systemProfileContextText(path, jsonPath)).toBe(
      `System profile essentials: server; GPU discrete NVIDIA accelerator, 24 GB class.\n${SYSTEM_PROFILE_REFERENCE}`,
    )
  })
})
