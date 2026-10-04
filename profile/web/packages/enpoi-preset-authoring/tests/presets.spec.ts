// presets.spec.ts — pure preset-authoring model: clone, suffix-only edit,
// id validation, built-in classification, order assignment.

import { describe, it, expect } from 'vitest'
import {
  BUILT_IN_PRESET_IDS,
  hasSharedPersona,
  isPresetId,
  newPresetConfig,
  nextPresetOrder,
  personaSuffixOf,
  validatePresetInput,
  withPersonaSuffix,
} from '../src/presets.js'

const SHARED_PREFIX = 'You are an agent of the Enpoi Harness.\n\n## Tooling\n'
const BASE_PLUGINS = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: SHARED_PREFIX, suffix: 'Base doctrine.' } },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  {
    id: 'group',
    name: 'cordis:group',
    config: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: SHARED_PREFIX, suffix: 'Nested.' } },
    ],
  },
]

describe('preset id validation', () => {
  it('accepts kebab-case and rejects other shapes', () => {
    expect(isPresetId('my-agent')).toBe(true)
    expect(isPresetId('agent2')).toBe(true)
    for (const bad of ['', 'My-Agent', 'a_b', 'a/b', '../x', 'a b', '-lead']) {
      expect(isPresetId(bad), bad).toBe(false)
    }
  })
})

describe('withPersonaSuffix', () => {
  it('replaces only the top-level persona suffix and keeps the prefix byte-identical', () => {
    const plugins = withPersonaSuffix(BASE_PLUGINS, 'New doctrine.')
    const persona = plugins.find(row => row.id === 'persona')!
    expect(persona.config?.suffix).toBe('New doctrine.')
    expect(persona.config?.prefix).toBe(SHARED_PREFIX)
    // The base is untouched (detached copy).
    expect((BASE_PLUGINS[0]!.config as { suffix: string }).suffix).toBe('Base doctrine.')
    expect(personaSuffixOf({ plugins })).toBe('New doctrine.')
  })

  it('refuses a composition without a persona row or without a prefix', () => {
    expect(() => withPersonaSuffix([{ id: 'tool-bash' }], 'x')).toThrow('no persona row')
    expect(() => withPersonaSuffix([{ id: 'persona', config: {} }], 'x')).toThrow('no shared prefix')
  })
})

describe('newPresetConfig', () => {
  it('clones the base composition with a new identity and the next order', () => {
    const config = newPresetConfig(
      { id: 'orchestrator', plugins: BASE_PLUGINS },
      { id: 'sandbox-agent', name: 'Sandbox Agent', description: 'Proof agent', suffix: 'You are Sandbox.', order: 4 },
    )
    expect(config).toMatchObject({ id: 'sandbox-agent', name: 'Sandbox Agent', order: 4 })
    const plugins = config.plugins as typeof BASE_PLUGINS
    expect(plugins).toHaveLength(BASE_PLUGINS.length)
    expect(plugins[0]!.config?.prefix).toBe(SHARED_PREFIX)
    expect(plugins[0]!.config?.suffix).toBe('You are Sandbox.')
    // The nested group is copied, not shared.
    expect(plugins[2]).not.toBe(BASE_PLUGINS[2])
    expect(nextPresetOrder([{ order: 1 }, { order: 3 }, {}])).toBe(4)
  })
})

describe('validatePresetInput', () => {
  it('validates the id only on create', () => {
    expect(validatePresetInput({ id: 'ok-1', name: 'n', description: '', suffix: 's' }, true)).toBeUndefined()
    expect(validatePresetInput({ id: 'bad id', name: 'n', description: '', suffix: 's' }, true)).toContain('kebab-case')
    expect(validatePresetInput({ id: 'orchestrator', name: 'n', description: '', suffix: 's' }, true)).toContain('reserved')
    // Update carries no id and still validates the editable fields.
    expect(validatePresetInput({ name: 'n', description: '', suffix: 's' }, false)).toBeUndefined()
    expect(validatePresetInput({ name: '', description: '', suffix: 's' }, false)).toContain('"name"')
  })

  it('requires a persona suffix and bounds the fields', () => {
    expect(validatePresetInput({ name: 'n', description: '', suffix: '' }, false)).toContain('"suffix"')
    expect(validatePresetInput({ name: 'n'.repeat(65), description: '', suffix: 's' }, false)).toContain('name')
    expect(validatePresetInput({ name: 'n', description: 'd'.repeat(401), suffix: 's' }, false)).toContain('description')
    expect(validatePresetInput({ name: 'n', description: '', suffix: 'x'.repeat(32_769) }, false)).toContain('persona')
  })
})

describe('built-in classification and persona presence', () => {
  it('marks the shipped fleet and upstream ids', () => {
    for (const id of ['orchestrator', 'sysadmin', 'creator', 'standard', 'ptc', 'minimal', 'cordis']) {
      expect(BUILT_IN_PRESET_IDS.has(id), id).toBe(true)
    }
    expect(BUILT_IN_PRESET_IDS.has('sandbox-agent')).toBe(false)
  })

  it('reports a shared persona only with a non-empty prefix', () => {
    expect(hasSharedPersona({ plugins: BASE_PLUGINS })).toBe(true)
    expect(hasSharedPersona({ plugins: [{ id: 'persona', config: { prefix: '' } }] })).toBe(false)
    expect(hasSharedPersona({ plugins: [] })).toBe(false)
    expect(hasSharedPersona(undefined)).toBe(false)
  })
})
