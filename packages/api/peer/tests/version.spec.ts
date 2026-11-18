import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HARNESS_VERSION, manifestVersionOf, readHarnessVersion } from '../src/version.ts'

describe('peer harness version', () => {
  it('reports the running package manifest version', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string }
    expect(HARNESS_VERSION).toBe(manifest.version)
    expect(readHarnessVersion()).toBe(manifest.version)
  })

  it('accepts only a non-empty string version field', () => {
    expect(manifestVersionOf({ version: '0.1.7-test' })).toBe('0.1.7-test')
    expect(() => manifestVersionOf(undefined)).toThrow(/must be an object/u)
    expect(() => manifestVersionOf(null)).toThrow(/must be an object/u)
    expect(() => manifestVersionOf([])).toThrow(/must be an object/u)
    expect(() => manifestVersionOf({})).toThrow(/non-empty version/u)
    expect(() => manifestVersionOf({ version: 7 })).toThrow(/non-empty version/u)
    expect(() => manifestVersionOf({ version: '  ' })).toThrow(/non-empty version/u)
  })
})
