import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SYSTEM_CONTEXT,
  SYSTEM_PROFILE_REFERENCE,
  systemProfileContextText,
  writeSystemProfile,
} from '../src/context-file.ts'
import * as contextPlugin from '../src/context.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('sysadmin system-profile plugin', () => {
  it('declares its name and prompt-registry dependency', () => {
    expect(contextPlugin.name).toBe('first-run-context')
    expect(contextPlugin.inject).toEqual(['systemPrompt'])
  })

  it('references the stored profile, or contributes the documented default before one ran', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-first-run-context-'))
    roots.push(root)
    const path = join(root, 'system-profile.md')
    const jsonPath = join(root, 'system-profile.json')
    expect(systemProfileContextText(path, jsonPath)).toBe(DEFAULT_SYSTEM_CONTEXT)
    expect(DEFAULT_SYSTEM_CONTEXT).toContain('no analysis is stored')
    expect(DEFAULT_SYSTEM_CONTEXT).not.toContain('—')
    writeSystemProfile('# System profile\n', path)
    expect(systemProfileContextText(path, jsonPath)).toBe(SYSTEM_PROFILE_REFERENCE)
    expect(SYSTEM_PROFILE_REFERENCE).toContain('Read $DSH_HOME/system-profile.md for this machine.')
  })
})
