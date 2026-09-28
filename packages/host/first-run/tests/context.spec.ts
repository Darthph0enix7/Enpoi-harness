import { describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_CONTEXT, readSystemContext, readSystemContextOrDefault, writeSystemContext } from '../src/context-file.ts'
import * as contextPlugin from '../src/context.ts'

describe('sysadmin system-context plugin', () => {
  it('declares its name and prompt-registry dependency', () => {
    expect(contextPlugin.name).toBe('first-run-context')
    expect(contextPlugin.inject).toEqual(['systemPrompt'])
  })

  it('contributes the stored scan, or the documented default before one ran', () => {
    expect(DEFAULT_SYSTEM_CONTEXT).toContain('no analysis is stored')
    expect(DEFAULT_SYSTEM_CONTEXT).not.toContain('—')
    // The contribution's text provider reads the harness-home document
    // through this same pair; the default is what a skipped analysis leaves.
    expect(typeof readSystemContext).toBe('function')
    expect(typeof readSystemContextOrDefault).toBe('function')
    expect(typeof writeSystemContext).toBe('function')
  })
})
