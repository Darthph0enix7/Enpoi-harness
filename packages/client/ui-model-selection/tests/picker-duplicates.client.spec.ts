// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ambiguousModelKeys, modelRowKey } from '../src/client/picker-duplicates.ts'

describe('picker duplicate identity', () => {
  it('keys provider/model pairs without parsing', () => {
    expect(modelRowKey('provider', 'model')).toBe('provider/model')
    expect(modelRowKey('a/b', 'c/d')).toBe('a/b/c/d')
  })

  it('returns no collisions for an empty or unique catalogue', () => {
    expect(ambiguousModelKeys([])).toEqual(new Set())
    expect(ambiguousModelKeys([
      { id: 'deepseek', models: [{ id: 'a', name: 'Alpha' }] },
      { id: 'openrouter', models: [{ id: 'b', name: 'Beta' }] },
    ])).toEqual(new Set())
  })

  it('marks both providers when a display name collides', () => {
    expect(ambiguousModelKeys([
      { id: 'deepseek', models: [{ id: 'a', name: 'Shared Model' }] },
      { id: 'openrouter', models: [{ id: 'b', name: 'Shared Model' }] },
    ])).toEqual(new Set(['deepseek/a', 'openrouter/b']))
  })

  it('marks both providers when both the name and the id collide', () => {
    expect(ambiguousModelKeys([
      { id: 'deepseek', models: [{ id: 'shared', name: 'Shared Model' }] },
      { id: 'openrouter', models: [{ id: 'shared', name: 'Shared Model' }] },
    ])).toEqual(new Set(['deepseek/shared', 'openrouter/shared']))
  })

  it('marks both providers when a model id collides under different names', () => {
    expect(ambiguousModelKeys([
      { id: 'deepseek', models: [{ id: 'shared', name: 'DeepSeek Shared' }] },
      { id: 'openrouter', models: [{ id: 'shared', name: 'OpenRouter Shared' }] },
    ])).toEqual(new Set(['deepseek/shared', 'openrouter/shared']))
  })

  it('compares trimmed, case-insensitive names and ids', () => {
    expect(ambiguousModelKeys([
      { id: 'one', models: [{ id: 'A', name: ' Shared Model ' }] },
      { id: 'two', models: [{ id: ' a ', name: 'shared model' }] },
    ])).toEqual(new Set(['one/A', 'two/ a ']))
  })

  it('does not tag duplicates offered by one provider', () => {
    expect(ambiguousModelKeys([
      { id: 'only', models: [{ id: 'a', name: 'Same Name' }, { id: 'b', name: 'Same Name' }] },
    ])).toEqual(new Set())
  })

  it('does not let a repeated provider group fake a cross-provider collision', () => {
    expect(ambiguousModelKeys([
      { id: 'same', models: [{ id: 'a', name: 'Alpha' }] },
      { id: 'same', models: [{ id: 'a', name: 'Alpha' }] },
    ])).toEqual(new Set())
  })
})
