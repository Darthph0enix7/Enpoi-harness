/**
 * Shared capability-hint table tests.
 *
 * The single authored source is the package's `model-capability-hints.json`;
 * the browser mirror under `packages/client/ui-settings-models` is generated
 * from it. These specs pin the client mirror fixture to the shipped table,
 * cover the owner override shape, and prove the claim resolver: a hint is
 * claimed only for a capability no disclosure covered, and an owner override
 * wins over the shipped operands.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HINT_FAMILIES,
  claimCapabilityHints,
  capabilityHintsPath,
  loadCapabilityHints,
  parseCapabilityHints,
  parseCapabilityHintsOverride,
} from '../src/capability-hints.ts'
import {
  capabilityHintsOverridePath,
  loadCapabilityHintsOverride,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** The committed client-mirror fixture both halves pin to. */
const clientFixture = join(here, '../../../../../packages/client/ui-settings-models/tests/expected/model-capability-hints.json')

const directories: string[] = []

afterEach(() => {
  Reflect.deleteProperty(process.env, 'DSH_CAPABILITY_HINTS')
  Reflect.deleteProperty(process.env, 'DSH_CAPABILITY_HINTS_OVERRIDE')
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Write one throwaway JSON file and return its path. */
function tempFile(content: string, name = 'hints.json'): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-hints-'))
  directories.push(directory)
  const path = join(directory, name)
  writeFileSync(path, content, 'utf8')
  return path
}

describe('shipped capability hints', () => {
  it('loads the bundled table with deduplicated operands on every family', () => {
    const hints = loadCapabilityHints()
    expect(capabilityHintsPath()).toMatch(/model-capability-hints\.json$/)
    for (const family of HINT_FAMILIES) {
      expect(Array.isArray(hints[family]), family).toBe(true)
      expect(hints[family]!.length, family).toBeGreaterThan(0)
      expect(new Set(hints[family]).size, family).toBe(hints[family].length)
    }
    expect(hints.reasoning).toContain('think')
    expect(hints.image).toContain('vision')
    expect(hints.audio).toContain('whisper')
    expect(hints.video).toContain('space-bunny')
    expect(hints.files).toContain('pdf')
    expect(hints.toolsExclude).toContain('embed')
  })

  it('honors the DSH_CAPABILITY_HINTS path override and refuses malformed tables loudly', () => {
    const path = tempFile(JSON.stringify({ reasoning: ['custom-think'], image: [], audio: [], video: [], files: [], toolsExclude: [] }))
    process.env.DSH_CAPABILITY_HINTS = path
    expect(loadCapabilityHints()).toMatchObject({ reasoning: ['custom-think'], image: [] })
    expect(() => loadCapabilityHints(tempFile('{"reasoning":"think"}'))).toThrow(/must be a list/)
    expect(() => parseCapabilityHints([], '/x/hints.json')).toThrow(/document must be an object/)
  })

  it('the committed client mirror equals the shipped table projection', () => {
    const fixture = JSON.parse(readFileSync(clientFixture, 'utf8')) as Record<string, unknown>
    const hints = loadCapabilityHints()
    expect(fixture).toEqual({
      version: 1,
      ...Object.fromEntries(HINT_FAMILIES.map(family => [family, hints[family]])),
    })
  })
})

describe('owner capability-hints override', () => {
  it('parses route replacements and per-model pins', () => {
    const path = tempFile(JSON.stringify({
      version: 1,
      routes: {
        kilo: {
          hints: { image: ['custom-vlm'] },
          models: { 'zzz-model': { input: ['text', 'image'], reasoning: true } },
        },
      },
    }))
    const document = loadCapabilityHintsOverride(path)
    expect(document.routes?.['kilo']?.hints?.image).toEqual(['custom-vlm'])
    expect(document.routes?.['kilo']?.models?.['zzz-model']).toEqual({ input: ['text', 'image'], reasoning: true })
  })

  it('reads no override from an absent file and resolves the $DSH_HOME default', () => {
    expect(loadCapabilityHintsOverride(join(tmpdir(), 'dsh-no-such-hints.json'))).toEqual({})
    expect(capabilityHintsOverridePath({ DSH_HOME: '/srv/dsh' }, 'linux')).toBe('/srv/dsh/model-capability-hints.json')
    expect(capabilityHintsOverridePath({ HOME: '/users/jo' }, 'linux')).toBe(join('/users/jo', '.dsh', 'model-capability-hints.json'))
    expect(capabilityHintsOverridePath({ DSH_CAPABILITY_HINTS_OVERRIDE: '/tmp/custom.json', DSH_HOME: '/srv/dsh' }, 'linux'))
      .toBe('/tmp/custom.json')
  })

  it('refuses malformed documents loudly, naming the file', () => {
    expect(() => parseCapabilityHintsOverride([], '/x/hints.json')).toThrow(/document must be an object/)
    expect(() => parseCapabilityHintsOverride({ routes: { kilo: { hints: { toolsExclude: ['x'] } } } }, '/x/hints.json'))
      .toThrow(/non-overridable hint family/)
    expect(() => parseCapabilityHintsOverride({ routes: { kilo: { hints: { vision: ['x'] } } } }, '/x/hints.json'))
      .toThrow(/unknown or non-overridable hint family/)
    expect(() => parseCapabilityHintsOverride({ routes: { kilo: { models: { m: { input: ['hologram'] } } } } }, '/x/hints.json'))
      .toThrow(/unknown input modality/)
    expect(() => parseCapabilityHintsOverride({ routes: { kilo: { models: { m: { reasoning: 'yes' } } } } }, '/x/hints.json'))
      .toThrow(/non-boolean "reasoning"/)
    expect(() => loadCapabilityHintsOverride(tempFile('[]'))).toThrow(/document must be an object/)
  })
})

describe('hint claims', () => {
  const table = loadCapabilityHints()

  it('claims shipped hints for a matching id and nothing for an unmatched one', () => {
    expect(claimCapabilityHints('kilo', 'zzz-gpt-5-mini-alias', table)).toEqual({
      input: ['image', 'pdf'],
      reasoning: true,
      source: 'shipped-hints',
    })
    expect(claimCapabilityHints('kilo', 'zzz-mystery-endpoint-model-77', table)).toBeUndefined()
  })

  it('lets a per-model owner pin win outright', () => {
    const override = { routes: { kilo: { models: { 'zzz-gpt-5-mini-alias': { input: ['audio'], reasoning: false } } } } }
    expect(claimCapabilityHints('kilo', 'zzz-gpt-5-mini-alias', table, override)).toEqual({
      input: ['audio'],
      reasoning: false,
      source: 'owner-override',
    })
  })

  it('lets a route family replacement win over the shipped list', () => {
    const override = { routes: { kilo: { hints: { audio: [] } } } }
    expect(claimCapabilityHints('kilo', 'zzz-whisper-clone', table)).toMatchObject({ input: ['audio'], source: 'shipped-hints' })
    expect(claimCapabilityHints('kilo', 'zzz-whisper-clone', table, override)).toEqual({
      input: [],
      reasoning: false,
      source: 'owner-override',
    })
  })

  it('returns an empty labeled claim for a route the override names but does not match', () => {
    const override = { routes: { kilo: { hints: { image: ['custom-vlm'] } } } }
    expect(claimCapabilityHints('kilo', 'zzz-mystery-endpoint-model-77', table, override)).toEqual({
      input: [],
      reasoning: false,
      source: 'owner-override',
    })
    expect(claimCapabilityHints('deepseek', 'zzz-mystery-endpoint-model-77', table, override)).toBeUndefined()
  })
})
