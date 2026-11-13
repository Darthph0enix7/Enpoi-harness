/**
 * The model-metadata planner: text projection, machine-code validation,
 * changed-leaf operations, manual-field provenance, and safe save-as.
 */
import { describe, expect, it } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelMetadataDraft } from '../src/client/model-metadata.ts'
import {
  MODEL_METADATA_FIELDS, ModelMetadataOpsError, buildModelMetadataOps,
  metadataDraftOf, metadataKindOf, validateMetadataDraft,
} from '../src/client/model-metadata.ts'

/** One fully blank draft with the requested overrides. */
function draftOf(overrides: Partial<ModelMetadataDraft> = {}): ModelMetadataDraft {
  return {
    id: 'model',
    name: '',
    contextWindow: '',
    maxInputTokens: '',
    maxTokens: '',
    input: [],
    tools: 'inherit',
    reasoning: 'inherit',
    reasoningEfforts: '',
    inputPrice: '',
    outputPrice: '',
    cacheReadPrice: '',
    cacheWritePrice: '',
    releaseDate: '',
    pricingTiers: [],
    ...overrides,
  }
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Apply one path op exactly like the settings service does for arrays/objects. */
function applyOp(node: unknown, path: readonly string[], op: SettingsPathOpView): unknown {
  if (path.length === 0) return op.op === 'set' ? op.value : undefined
  const [head, ...rest] = path
  if (head === undefined) return node
  if (Array.isArray(node)) {
    const copy: unknown[] = [...(node as unknown[])]
    const index = Number(head)
    if (rest.length === 0 && op.op === 'unset') {
      copy.splice(index, 1)
      return copy
    }
    copy[index] = applyOp(node[index], rest, op)
    return copy
  }
  const record = isRecord(node) ? { ...node } : {}
  const child = applyOp(record[head], rest, op)
  if (child === undefined) Reflect.deleteProperty(record, head)
  else record[head] = child
  return record
}

/** Apply a plan to a detached document. */
function applyOps(document: Record<string, unknown>, ops: readonly SettingsPathOpView[]): Record<string, unknown> {
  let root: unknown = structuredClone(document)
  for (const op of ops) root = applyOp(root, op.path, op)
  return root as Record<string, unknown>
}

/** Deep-freeze a fixture so a planner mutation throws in strict mode. */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) frozen(entry)
    Object.freeze(value)
  }
  return value
}

/** One stored pi-ai model row with every metadata shape. */
function fullPiRow(): Record<string, unknown> {
  return {
    id: 'target',
    name: 'Old',
    contextWindow: 1_000,
    maxInputTokens: 900,
    maxTokens: 100,
    input: ['text'],
    tools: true,
    reasoning: true,
    reasoningEfforts: { off: null, high: 'high' },
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2, custom: 'keep' },
    costTiers: [{ inputTokensAbove: 200_000, input: 4, output: 24, customTier: 'keep' }],
    releaseDate: '2026-01-01',
    compat: { chatTemplateKwargs: { keep: 1 } },
    nativeFileInputs: { version: 1 },
    unknown: 'keep',
    source: 'configured',
  }
}

describe('metadataKindOf', () => {
  it('distinguishes a pi-ai model list from catalog overrides', () => {
    expect(metadataKindOf('llm-pi-ai', { models: [{ id: 'm' }] })).toBe('pi-ai-models')
    expect(metadataKindOf('llm-pi-ai', { models: [] })).toBe('pi-ai-catalog')
    expect(metadataKindOf('llm-pi-ai', {})).toBe('pi-ai-catalog')
  })

  it('uses the root DeepSeek model array and refuses unknown namespaces', () => {
    for (const ns of ['llm-deepseek', 'llm-deepseek-api-key', 'llm-deepseek-account']) {
      expect(metadataKindOf(ns, { models: [{ id: 'm' }] })).toBe('deepseek')
      expect(metadataKindOf(ns, { models: [] })).toBeUndefined()
      expect(metadataKindOf(ns, {})).toBeUndefined()
    }
    expect(metadataKindOf('llm-pi-ai-extra', { models: [{ id: 'm' }] })).toBeUndefined()
  })
})

describe('metadataDraftOf', () => {
  it('projects a pi-ai row without inventing values', () => {
    const model = fullPiRow()
    model['input'] = ['text', 'image', 7]
    model['reasoningEfforts'] = { off: null, low: 'low', high: 'high', weird: 'ignored' }
    model['costTiers'] = [
      { inputTokensAbove: 200_000, input: 4, output: 24 },
      'bad',
      { inputTokensAbove: '1000' },
    ]
    expect(metadataDraftOf(model, 'pi-ai-models')).toEqual({
      id: 'target',
      name: 'Old',
      contextWindow: '1000',
      maxInputTokens: '900',
      maxTokens: '100',
      input: ['text', 'image'],
      tools: 'yes',
      reasoning: 'yes',
      reasoningEfforts: 'off=\nlow=low\nhigh=high',
      inputPrice: '1',
      outputPrice: '2',
      cacheReadPrice: '0.1',
      cacheWritePrice: '0.2',
      releaseDate: '2026-01-01',
      pricingTiers: [
        { inputTokensAbove: '200000', input: '4', output: '24' },
        { inputTokensAbove: '1000', input: '', output: '' },
      ],
    })
  })

  it('reads the DeepSeek input field and legacy camelCase cache keys', () => {
    const draft = metadataDraftOf({
      id: 'deep',
      inputModalities: ['text', 'image'],
      cost: { cacheRead: 0.3, cacheWrite: 0.4 },
      reasoningEfforts: false,
    }, 'deepseek')
    expect(draft.input).toEqual(['text', 'image'])
    expect(draft.cacheReadPrice).toBe('0.3')
    expect(draft.cacheWritePrice).toBe('0.4')
    expect(draft.reasoningEfforts).toBe('false')
  })

  it('falls back to the other input spelling and blanks missing fields', () => {
    expect(metadataDraftOf({ inputModalities: ['text'] }, 'pi-ai-models').input).toEqual(['text'])
    expect(metadataDraftOf({ input: ['image'] }, 'deepseek').input).toEqual(['image'])
    const blank = metadataDraftOf({}, 'pi-ai-catalog')
    expect(blank).toMatchObject({
      id: '',
      name: '',
      contextWindow: '',
      maxInputTokens: '',
      maxTokens: '',
      input: [],
      tools: 'inherit',
      reasoning: 'inherit',
      reasoningEfforts: '',
      inputPrice: '',
      outputPrice: '',
      cacheReadPrice: '',
      cacheWritePrice: '',
      releaseDate: '',
      pricingTiers: [],
    })
  })

  it('distinguishes false/missing tri-states and malformed efforts', () => {
    const draft = metadataDraftOf({
      tools: false,
      reasoning: false,
      reasoningEfforts: { unsupported: 'x' },
      costTiers: 'nope',
    }, 'pi-ai-models')
    expect(draft.tools).toBe('no')
    expect(draft.reasoning).toBe('no')
    expect(draft.reasoningEfforts).toBe('')
    expect(draft.pricingTiers).toEqual([])
  })
})

describe('validateMetadataDraft', () => {
  it('accepts a fully populated valid draft', () => {
    expect(validateMetadataDraft(draftOf({
      id: 'vendor/model:7',
      name: 'Model',
      contextWindow: '1000',
      maxInputTokens: '900',
      maxTokens: '100',
      input: ['text', 'image'],
      tools: 'yes',
      reasoning: 'no',
      reasoningEfforts: 'off=\nlow=low\nhigh=high',
      inputPrice: '0',
      outputPrice: '.5',
      cacheReadPrice: '1e-3',
      cacheWritePrice: '2.5',
      releaseDate: '2026-02-28',
      pricingTiers: [
        { inputTokensAbove: '200000', input: '4', output: '24' },
        { inputTokensAbove: '1000000', input: '', output: '8' },
      ],
    }), 'pi-ai-models')).toEqual([])
  })

  it('reports a required or malformed id with a machine code', () => {
    expect(validateMetadataDraft(draftOf({ id: '   ' }), 'pi-ai-models'))
      .toEqual([{ field: 'id', code: 'required' }])
    expect(validateMetadataDraft(draftOf({ id: '__proto__' }), 'pi-ai-models'))
      .toEqual([{ field: 'id', code: 'invalidId' }])
    expect(validateMetadataDraft(draftOf({ id: 'a\u0000b' }), 'pi-ai-models'))
      .toEqual([{ field: 'id', code: 'invalidId' }])
  })

  it('requires positive safe-integer capacities and skips unsupported DeepSeek fields', () => {
    for (const value of ['0', '-1', '1.5', '9007199254740992', 'abc']) {
      expect(validateMetadataDraft(draftOf({ contextWindow: value }), 'pi-ai-models'))
        .toContainEqual({ field: 'contextWindow', code: 'positiveInteger' })
    }
    expect(validateMetadataDraft(draftOf({ maxInputTokens: 'nope' }), 'deepseek')).toEqual([])
  })

  it('accepts only the canonical hierarchy and refuses unusable ladders', () => {
    for (const value of ['low', 'low=', 'ultra=ultra', 'low=low\nlow=again', 'off=', ' , ']) {
      expect(validateMetadataDraft(draftOf({ reasoningEfforts: value }), 'pi-ai-models'))
        .toContainEqual({ field: 'reasoningEfforts', code: 'invalidEfforts' })
    }
    expect(validateMetadataDraft(draftOf({ reasoningEfforts: 'false' }), 'pi-ai-models')).toEqual([])
    expect(validateMetadataDraft(draftOf({ reasoningEfforts: 'low=low,high=high' }), 'pi-ai-models')).toEqual([])
    expect(validateMetadataDraft(draftOf({ reasoningEfforts: 'nope' }), 'deepseek')).toEqual([])
  })

  it('requires finite non-negative prices but accepts zero and blank', () => {
    for (const value of ['-1', 'abc', '1e999', '0x10']) {
      expect(validateMetadataDraft(draftOf({ inputPrice: value }), 'pi-ai-models'))
        .toContainEqual({ field: 'inputPrice', code: 'nonnegativeNumber' })
    }
    expect(validateMetadataDraft(draftOf({ inputPrice: '0', outputPrice: '' }), 'pi-ai-models')).toEqual([])
  })

  it('requires a real calendar day for a release date', () => {
    for (const value of ['2026-02-30', '2026/01/01', '0000-00-00']) {
      expect(validateMetadataDraft(draftOf({ releaseDate: value }), 'pi-ai-models'))
        .toEqual([{ field: 'releaseDate', code: 'invalidDate' }])
    }
    expect(validateMetadataDraft(draftOf({ releaseDate: '2026-02-28' }), 'pi-ai-models')).toEqual([])
  })

  it('validates thresholds, duplicate tiers, and tier prices', () => {
    const issues = validateMetadataDraft(draftOf({
      pricingTiers: [
        { inputTokensAbove: '', input: '1', output: '2' },
        { inputTokensAbove: '0', input: '1', output: '2' },
        { inputTokensAbove: '200000', input: '', output: '' },
        { inputTokensAbove: '200000', input: '-1', output: 'x' },
        { inputTokensAbove: '', input: '', output: '' },
      ],
    }), 'pi-ai-models')
    expect(issues).toContainEqual({ field: 'pricingTiers[0].inputTokensAbove', code: 'required' })
    expect(issues).toContainEqual({ field: 'pricingTiers[1].inputTokensAbove', code: 'positiveInteger' })
    // A threshold-only tier is valid: both prices are optional disclosures.
    expect(issues.some(issue => issue.field.startsWith('pricingTiers[2]'))).toBe(false)
    expect(issues).toContainEqual({ field: 'pricingTiers[3].inputTokensAbove', code: 'duplicateThreshold' })
    expect(issues).toContainEqual({ field: 'pricingTiers[3].input', code: 'nonnegativeNumber' })
    expect(issues).toContainEqual({ field: 'pricingTiers[3].output', code: 'nonnegativeNumber' })
    // The final all-blank tier is not a row and therefore has no issue.
    expect(issues.some(issue => issue.field.startsWith('pricingTiers[4]'))).toBe(false)
  })
})

describe('buildModelMetadataOps — pi-ai models', () => {
  it('writes only changed leaves and pins their manual fields', () => {
    const profile = frozen({
      models: [
        { id: 'keep', name: 'Keep' },
        fullPiRow(),
      ],
    })
    const baseline = metadataDraftOf(fullPiRow(), 'pi-ai-models')
    const draft = frozen({
      ...baseline,
      name: 'New',
      contextWindow: '2000',
      maxInputTokens: '1800',
      maxTokens: '200',
      input: ['text', 'image'],
      tools: 'no' as const,
      reasoning: 'no' as const,
      reasoningEfforts: 'off=none\nlow=low\nhigh=high\nmax=ultra',
      inputPrice: '3',
      cacheReadPrice: '0.3',
      releaseDate: '2026-02-02',
      pricingTiers: [
        { inputTokensAbove: '100000', input: '2', output: '3' },
        { inputTokensAbove: '200000', input: '4', output: '24' },
      ],
    })
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target', profile, draft,
    })
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]).toEqual({ id: 'keep', name: 'Keep' })
    const next = models[1]
    expect(next).toMatchObject({
      id: 'target',
      name: 'New',
      contextWindow: 2000,
      maxInputTokens: 1800,
      maxTokens: 200,
      input: ['text', 'image'],
      tools: false,
      reasoning: false,
      reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'ultra' },
      cost: { input: 3, output: 2, cache_read: 0.3, cache_write: 0.2, custom: 'keep' },
      costTiers: [
        { inputTokensAbove: 100000, input: 2, output: 3 },
        { inputTokensAbove: 200000, input: 4, output: 24, customTier: 'keep' },
      ],
      releaseDate: '2026-02-02',
      compat: { chatTemplateKwargs: { keep: 1 } },
      nativeFileInputs: { version: 1 },
      unknown: 'keep',
      source: 'manual',
      manualFields: [
        'name', 'contextWindow', 'maxInputTokens', 'maxTokens', 'input',
        'tools', 'reasoning', 'reasoningEfforts', 'cost', 'costTiers', 'releaseDate',
      ],
    })
    expect(ops.every(op => op.path[0] === 'providers' && op.path[1] === 'p')).toBe(true)
    expect(ops.some(op => op.path.includes('keep'))).toBe(false)
    expect(ops.some(op => op.path.some(segment => segment === '0' || segment === '1'))).toBe(true)
  })

  it('does not write a field whose text did not move', () => {
    const profile = { models: [fullPiRow()] }
    const baseline = metadataDraftOf(fullPiRow(), 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target', profile,
      draft: { ...baseline, name: 'Renamed' },
    })
    expect(ops).toEqual([
      { op: 'set', path: ['providers', 'p', 'models', '0', 'name'], value: 'Renamed' },
      { op: 'set', path: ['providers', 'p', 'models', '0', 'source'], value: 'manual' },
      { op: 'set', path: ['providers', 'p', 'models', '0', 'manualFields'], value: ['name'] },
    ])
  })

  it('unions changed fields with an existing manual marker', () => {
    const row = { id: 'm', name: 'Old', contextWindow: 1_000, source: 'manual', manualFields: ['contextWindow'] }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baseline, name: 'New', tools: 'yes' },
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'p', 'models', '0', 'manualFields'],
      value: ['name', 'contextWindow', 'tools'],
    })
    expect(ops.some(op => op.path.at(-1) === 'source')).toBe(false)
  })

  it('finds the row in the fresh profile rather than reusing an old index', () => {
    const profile = { models: [{ id: 'm', name: 'Old' }] }
    const baseline = metadataDraftOf({ id: 'm', name: 'Old' }, 'pi-ai-models')
    const moved = { models: [{ id: 'first' }, { id: 'm', name: 'Old' }] }
    const input = {
      kind: 'pi-ai-models' as const,
      providerId: 'p',
      modelId: 'm',
      draft: { ...baseline, name: 'New' },
      profile,
    }
    const first = buildModelMetadataOps(input)
    const second = buildModelMetadataOps({ ...input, profile: moved })
    expect(first.find(op => op.op === 'set' && op.path.at(-1) === 'name')?.path)
      .toEqual(['providers', 'p', 'models', '0', 'name'])
    expect(second.find(op => op.op === 'set' && op.path.at(-1) === 'name')?.path)
      .toEqual(['providers', 'p', 'models', '1', 'name'])
  })

  it('refuses a missing row, duplicate ids, and an invalid draft', () => {
    const baseline = metadataDraftOf(fullPiRow(), 'pi-ai-models')
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'gone', profile: { models: [fullPiRow()] },
      draft: baseline,
    })).toThrow(ModelMetadataOpsError)
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target',
      profile: { models: [{ id: 'target' }, { id: 'target' }] },
      draft: baseline,
    })).toThrow(expect.objectContaining({ code: 'duplicate-id' }))
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target', profile: { models: [fullPiRow()] },
      draft: { ...baseline, contextWindow: '0' },
    })).toThrow(expect.objectContaining({ code: 'invalid-draft' }))
  })

  it('treats a non-array model list as a missing row', () => {
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile: {},
      draft: draftOf({ id: 'm' }),
    })).toThrow(expect.objectContaining({ code: 'model-not-found' }))
  })
})

describe('buildModelMetadataOps — safe save-as', () => {
  it('appends a full manual clone and leaves the old row alone', () => {
    const profile = frozen({ models: [fullPiRow()] })
    const baseline = metadataDraftOf(fullPiRow(), 'pi-ai-models')
    const draft = frozen({ ...baseline, id: 'vendor/new:model', name: 'Clone' })
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target', profile, draft,
    })
    expect(ops).toHaveLength(1)
    expect(ops[0]?.path).toEqual(['providers', 'p', 'models', '1'])
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]?.['id']).toBe('target')
    expect(models[0]?.['manualFields']).toBeUndefined()
    expect(models[1]).toMatchObject({
      id: 'vendor/new:model',
      name: 'Clone',
      contextWindow: 1000,
      compat: { chatTemplateKwargs: { keep: 1 } },
      nativeFileInputs: { version: 1 },
      unknown: 'keep',
      source: 'manual',
      manualFields: [
        'name', 'contextWindow', 'maxInputTokens', 'maxTokens', 'input',
        'tools', 'reasoning', 'reasoningEfforts', 'cost', 'costTiers', 'releaseDate',
      ],
    })
  })

  it('rejects a collision but treats ids case-sensitively', () => {
    const baseline = metadataDraftOf(fullPiRow(), 'pi-ai-models')
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target',
      profile: { models: [fullPiRow(), { id: 'keep' }] },
      draft: { ...baseline, id: 'keep' },
    })).toThrow(expect.objectContaining({ code: 'duplicate-id' }))
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target',
      profile: { models: [fullPiRow()] },
      draft: { ...baseline, id: 'Target' },
    })).not.toThrow()
  })

  it('omits reset fields from the clone and its manual marker', () => {
    const profile = { models: [fullPiRow()] }
    const baseline = metadataDraftOf(fullPiRow(), 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target', profile,
      draft: { ...baseline, id: 'new' },
      resetFields: ['name', 'costTiers'],
    })
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[1]).not.toHaveProperty('name')
    expect(models[1]).not.toHaveProperty('costTiers')
    expect(models[1]?.['manualFields']).not.toContain('name')
    expect(models[1]?.['manualFields']).not.toContain('costTiers')
  })
})

describe('buildModelMetadataOps — pi-ai catalog overrides', () => {
  it('edits one override leaf, never the model list or an id', () => {
    const profile = { models: [], modelOverrides: { m: { name: 'Pinned', contextWindow: 1_000 } } }
    const baseline = metadataDraftOf({ id: 'm', name: 'Pinned', contextWindow: 1_000 }, 'pi-ai-catalog')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'm', profile,
      draft: { ...baseline, contextWindow: '2000' },
    })
    expect(ops).toEqual([{
      op: 'set',
      path: ['providers', 'p', 'modelOverrides', 'm', 'contextWindow'],
      value: 2000,
    }])
    expect(ops.some(op => op.path.includes('id') || op.path.includes('models'))).toBe(false)
  })

  it('unsets a cleared override field and a reset field', () => {
    const profile = {
      models: [],
      modelOverrides: { m: { name: 'Pinned', input: ['text'], cost: { input: 1, output: 2 } } },
    }
    const baseline = metadataDraftOf(
      { id: 'm', name: 'Pinned', input: ['text'], cost: { input: 1, output: 2 } },
      'pi-ai-catalog',
    )
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'm', profile,
      draft: { ...baseline, name: '' },
      resetFields: ['input'],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'modelOverrides', 'm', 'name'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'modelOverrides', 'm', 'input'] })
    expect(ops.some(op => op.path.at(-1) === 'manualFields' || op.path.at(-1) === 'source')).toBe(false)
  })

  it('creates a new override from a blank baseline', () => {
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'fresh', profile: { models: [] },
      draft: draftOf({ id: 'fresh', name: 'Fresh', contextWindow: '1000' }),
    })
    expect(ops).toEqual([
      { op: 'set', path: ['providers', 'p', 'modelOverrides', 'fresh', 'name'], value: 'Fresh' },
      { op: 'set', path: ['providers', 'p', 'modelOverrides', 'fresh', 'contextWindow'], value: 1000 },
    ])
  })

  it('refuses an id change and duplicate override keys', () => {
    const profile = { models: [], modelOverrides: { m: { name: 'Pinned' } } }
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'm', profile,
      draft: draftOf({ id: 'other' }),
    })).toThrow(expect.objectContaining({ code: 'id-change-not-allowed' }))
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'm',
      profile: { models: [], modelOverrides: { m: {}, 'm ': {} } },
      draft: draftOf({ id: 'm' }),
    })).toThrow(expect.objectContaining({ code: 'duplicate-id' }))
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: ' ', profile: { models: [] },
      draft: draftOf({ id: 'm' }),
    })).toThrow(expect.objectContaining({ code: 'model-not-found' }))
  })
})

describe('buildModelMetadataOps — DeepSeek root models', () => {
  it('edits inputModalities and ignores providerId and unsupported pi-ai fields', () => {
    const row = {
      id: 'deep',
      name: 'Deep',
      description: 'keep',
      contextWindow: 1_000,
      maxTokens: 100,
      inputModalities: ['text'],
      imagePixelBudget: 'low',
      imageMaxBytes: 10,
      source: 'configured',
    }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'deepseek')
    const ops = buildModelMetadataOps({
      kind: 'deepseek', providerId: 'ignored', modelId: 'deep', profile,
      draft: {
        ...baseline,
        name: 'Renamed',
        input: ['text', 'image'],
        maxInputTokens: 'nope',
        tools: 'no',
        reasoning: 'no',
        reasoningEfforts: 'low=low',
      },
    })
    expect(ops.every(op => op.path[0] === 'models')).toBe(true)
    expect(ops.some(op => op.path.includes('provider') || op.path.includes('ignored'))).toBe(false)
    expect(ops.some(op => op.path.at(-1) === 'maxInputTokens' || op.path.at(-1) === 'tools')).toBe(false)
    const document = applyOps(profile, ops)
    const models = (document['models'] as Array<Record<string, unknown>>)
    expect(models[0]).toMatchObject({
      name: 'Renamed',
      inputModalities: ['text', 'image'],
      description: 'keep',
      imagePixelBudget: 'low',
      imageMaxBytes: 10,
      source: 'manual',
      manualFields: ['name', 'input'],
    })
  })

  it('appends a DeepSeek clone with its image fields intact', () => {
    const profile = { models: [{ id: 'deep', name: 'Deep', inputModalities: ['text', 'image'], imagePixelBudget: 'low' }] }
    const baseline = metadataDraftOf(profile.models[0] ?? {}, 'deepseek')
    const ops = buildModelMetadataOps({
      kind: 'deepseek', providerId: 'ignored', modelId: 'deep', profile,
      draft: { ...baseline, id: 'deep/new:2' },
    })
    expect(ops[0]?.path).toEqual(['models', '1'])
    const document = applyOps(profile, ops)
    const models = document['models'] as Array<Record<string, unknown>>
    expect(models[0]?.['id']).toBe('deep')
    expect(models[1]).toMatchObject({
      id: 'deep/new:2',
      name: 'Deep',
      inputModalities: ['text', 'image'],
      imagePixelBudget: 'low',
      source: 'manual',
      manualFields: ['name', 'input'],
    })
  })
})

describe('buildModelMetadataOps — clearing and reset', () => {
  it('clears a manual field and removes only its marker', () => {
    const row = {
      id: 'm',
      name: 'Old',
      contextWindow: 1_000,
      source: 'manual',
      manualFields: ['name', 'contextWindow'],
    }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baseline, name: '' },
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'name'] })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'p', 'models', '0', 'manualFields'],
      value: ['contextWindow'],
    })
  })

  it('restores automation when the last manual field is cleared', () => {
    const row = { id: 'm', name: 'Old', source: 'manual', manualFields: ['name'] }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baseline, name: '' },
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'name'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'source'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'manualFields'] })
  })

  it('materializes the legacy frozen fields before applying a new edit', () => {
    const row = {
      id: 'm',
      name: 'Legacy',
      contextWindow: 1_000,
      maxInputTokens: 900,
      maxTokens: 100,
      input: ['text'],
      reasoning: true,
      reasoningEfforts: { high: 'high' },
      source: 'manual',
    }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baseline, name: 'Legacy 2' },
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'p', 'models', '0', 'manualFields'],
      value: ['name', 'contextWindow', 'maxInputTokens', 'maxTokens', 'input', 'reasoning', 'reasoningEfforts'],
    })
    expect(ops.some(op => op.path.at(-1) === 'source')).toBe(false)
  })

  it('leaves a fieldless legacy manual row alone when nothing changed', () => {
    const profile = { models: [{ id: 'm', source: 'manual' }] }
    const baseline = metadataDraftOf({ id: 'm', source: 'manual' }, 'pi-ai-models')
    expect(buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile, draft: baseline,
    })).toEqual([])
  })

  it('resets one price column while preserving the other cost keys', () => {
    const row = {
      id: 'm',
      cost: { input: 1, output: 2, cache_read: 0.1, custom: 'keep' },
      source: 'manual',
      manualFields: ['cost'],
    }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: baseline, resetFields: ['inputPrice'],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost', 'input'] })
    expect(ops.some(op => op.path.at(-1) === 'output' || op.path.at(-1) === 'custom')).toBe(false)
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]?.['cost']).toEqual({ output: 2, cache_read: 0.1, custom: 'keep' })
  })

  it('unsets a legacy camelCase cache alias and the whole cost when it empties', () => {
    const row = { id: 'm', cost: { cacheRead: 0.1 }, source: 'manual', manualFields: ['cost'] }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: metadataDraftOf(row, 'pi-ai-models'),
      resetFields: ['cacheReadPrice'],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost'] })
    expect(ops.some(op => op.path.at(-1) === 'cacheRead')).toBe(false)
  })

  it('resets cost, tiers, and every manual marker in one plan', () => {
    const row = {
      id: 'm',
      name: 'Old',
      contextWindow: 1_000,
      input: ['text'],
      cost: { input: 1, output: 2 },
      costTiers: [{ inputTokensAbove: 200_000, input: 4, output: 24 }],
      releaseDate: '2026-01-01',
      source: 'manual',
      manualFields: ['name', 'contextWindow', 'input', 'cost', 'costTiers', 'releaseDate'],
    }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: metadataDraftOf(row, 'pi-ai-models'),
      resetFields: [...MODEL_METADATA_FIELDS],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'costTiers'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'source'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'manualFields'] })
  })

  it('does not pin a non-manual row when the operator only clears a field', () => {
    const row = { id: 'm', name: 'Old', source: 'configured' }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...metadataDraftOf(row, 'pi-ai-models'), name: '' },
    })
    expect(ops).toEqual([{ op: 'unset', path: ['providers', 'p', 'models', '0', 'name'] }])
  })

  it('keeps unknown future manual markers and unknown cost keys', () => {
    const row = {
      id: 'm',
      name: 'Old',
      cost: { input: 1, future: 'keep' },
      source: 'manual',
      manualFields: ['futureB', 'name', 'futureA'],
    }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baseline, inputPrice: '2' },
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'p', 'models', '0', 'manualFields'],
      value: ['name', 'cost', 'futureB', 'futureA'],
    })
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]?.['cost']).toEqual({ input: 2, future: 'keep' })
  })

  it('accepts canonical and draft reset aliases', () => {
    const row = {
      id: 'm',
      input: ['text'],
      cost: { input: 1, cache_read: 0.1 },
      source: 'manual',
      manualFields: ['input', 'cost'],
    }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: metadataDraftOf(row, 'pi-ai-models'),
      resetFields: ['inputModalities', 'cost.cache_read', 'output', 'unknown', ' '],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'input'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost', 'cache_read'] })
  })
})

describe('model-metadata merge and projection edges', () => {
  it('serializes a named off wire and drops non-string wire values', () => {
    expect(metadataDraftOf({
      reasoningEfforts: { off: 'none', low: 'low', high: 7, unknown: 'ignored' },
    }, 'pi-ai-models').reasoningEfforts).toBe('off=none\nlow=low')
  })

  it('deduplicates repeated modalities without inventing an input edit', () => {
    const row = { id: 'deep', inputModalities: ['text'], source: 'configured' }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'deepseek')
    const ops = buildModelMetadataOps({
      kind: 'deepseek', providerId: 'ignored', modelId: 'deep', profile,
      draft: { ...baseline, input: ['text', 'text'] },
    })
    expect(ops.some(op => op.path.at(-1) === 'inputModalities')).toBe(false)
    expect(ops).toContainEqual({ op: 'set', path: ['models', '0', 'source'], value: 'manual' })
    expect(ops).toContainEqual({ op: 'set', path: ['models', '0', 'manualFields'], value: ['input'] })
  })

  it('clears capacities, a price, and a release date from blank text', () => {
    const profile = { models: [fullPiRow()] }
    const baseline = metadataDraftOf(fullPiRow(), 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target', profile,
      draft: { ...baseline, maxTokens: '', inputPrice: '', releaseDate: '' },
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'maxTokens'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'releaseDate'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost', 'input'] })
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]?.['cost']).toEqual({ output: 2, cache_read: 0.1, cache_write: 0.2, custom: 'keep' })
    expect(models[0]).not.toHaveProperty('maxTokens')
    expect(models[0]).not.toHaveProperty('releaseDate')
  })

  it('sets a first price on a row without cost and resets it back to nothing', () => {
    const row = { id: 'm', name: 'No cost' }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'pi-ai-models')
    const setOps = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baseline, inputPrice: '2.5' },
    })
    expect(setOps).toContainEqual({
      op: 'set', path: ['providers', 'p', 'models', '0', 'cost', 'input'], value: 2.5,
    })
    expect(buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: baseline, resetFields: ['inputPrice'],
    })).toEqual([])
  })

  it('removes every tier when the draft list empties', () => {
    const profile = { models: [fullPiRow()] }
    const baseline = metadataDraftOf(fullPiRow(), 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target', profile,
      draft: { ...baseline, pricingTiers: [] },
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'costTiers'] })
  })

  it('rebuilds tiers over malformed stored rows and keeps unknown tier fields', () => {
    const row = {
      id: 'm',
      costTiers: [
        'bad',
        { inputTokensAbove: 'nope', input: 1 },
        { inputTokensAbove: 200_000, input: 4, output: 24, customTier: 'keep' },
      ],
    }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: {
        ...baseline,
        pricingTiers: [
          { inputTokensAbove: '100000', input: '2', output: '3' },
          { inputTokensAbove: '200000', input: '5', output: '24' },
        ],
      },
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'p', 'models', '0', 'costTiers'],
      value: [
        { inputTokensAbove: 100000, input: 2, output: 3 },
        { inputTokensAbove: 200000, input: 5, output: 24, customTier: 'keep' },
      ],
    })
  })

  it('unsets a camelCase cache alias while the rest of cost survives', () => {
    const row = { id: 'm', cost: { cacheRead: 0.1, output: 2 }, source: 'manual', manualFields: ['cost'] }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: metadataDraftOf(row, 'pi-ai-models'),
      resetFields: ['cacheReadPrice'],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost', 'cacheRead'] })
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]?.['cost']).toEqual({ output: 2 })
  })

  it('normalizes manual marker aliases and drops malformed entries', () => {
    const row = {
      id: 'm',
      name: 'Old',
      input: ['text'],
      costTiers: [{ inputTokensAbove: 200_000, input: 4 }],
      source: 'manual',
      manualFields: ['pricingTiers', '', 7, 'name', 'inputModalities', 'name', 'future'],
    }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baseline, name: 'New' },
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'p', 'models', '0', 'manualFields'],
      value: ['name', 'input', 'costTiers', 'future'],
    })
  })

  it('seeds a DeepSeek legacy marker from its inputModalities field', () => {
    const row = {
      id: 'deep',
      name: 'Deep',
      contextWindow: 1_000,
      maxInputTokens: 900,
      maxTokens: 100,
      inputModalities: ['text', 'image'],
      reasoning: true,
      reasoningEfforts: { high: 'high' },
      source: 'manual',
    }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'deepseek')
    const ops = buildModelMetadataOps({
      kind: 'deepseek', providerId: 'ignored', modelId: 'deep', profile,
      draft: { ...baseline, name: 'Deep 2' },
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['models', '0', 'manualFields'],
      value: ['name', 'contextWindow', 'maxTokens', 'input'],
    })
  })

  it('leaves existing tiers alone when the optional draft field is omitted', () => {
    const row = fullPiRow()
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'pi-ai-models')
    const withoutTiers: Partial<ModelMetadataDraft> = { ...baseline }
    delete withoutTiers.pricingTiers
    expect(buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target', profile,
      draft: withoutTiers as ModelMetadataDraft,
    })).toEqual([])
  })

  it('skips non-matching override keys and reads a malformed entry as blank', () => {
    const matching = buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'm',
      profile: { models: [], modelOverrides: { other: { name: 'Other' }, m: { name: 'Old' } } },
      draft: draftOf({ id: 'm', name: 'New' }),
    })
    expect(matching).toEqual([{
      op: 'set', path: ['providers', 'p', 'modelOverrides', 'm', 'name'], value: 'New',
    }])
    const malformed = buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'm',
      profile: { models: [], modelOverrides: { m: 'bad' } },
      draft: draftOf({ id: 'm', name: 'New' }),
    })
    expect(malformed).toEqual([{
      op: 'set', path: ['providers', 'p', 'modelOverrides', 'm', 'name'], value: 'New',
    }])
  })

  it('reports a missing DeepSeek model list as a missing row', () => {
    expect(() => buildModelMetadataOps({
      kind: 'deepseek', providerId: 'ignored', modelId: 'm', profile: {},
      draft: draftOf({ id: 'm' }),
    })).toThrow(expect.objectContaining({ code: 'model-not-found' }))
  })
})

describe('model-metadata reset spellings', () => {
  it('accepts output and cache-write price reset spellings', () => {
    const row = { id: 'm', cost: { input: 1, output: 2, cache_write: 0.2 } }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: metadataDraftOf(row, 'pi-ai-models'),
      resetFields: ['outputPrice', 'cost.cache_write'],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost', 'output'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost', 'cache_write'] })
  })
})

describe('model-metadata untouched numeric text', () => {
  it('creates tiers when the row carried none', () => {
    const row = { id: 'm' }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...metadataDraftOf(row, 'pi-ai-models'), pricingTiers: [
        { inputTokensAbove: '100000', input: '2', output: '3' },
      ] },
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'p', 'models', '0', 'costTiers'],
      value: [{ inputTokensAbove: 100000, input: 2, output: 3 }],
    })
  })

  it('does not rewrite a price whose edited spelling parses to the stored number', () => {
    const row = { id: 'm', cost: { input: 1 } }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...metadataDraftOf(row, 'pi-ai-models'), inputPrice: '1.0' },
    })
    expect(ops.some(op => op.path.at(-1) === 'input')).toBe(false)
  })
})

describe('model-metadata unsupported-field edits', () => {
  it('does not retire an empty manual marker when only an unsupported field changed', () => {
    const row = { id: 'deep', maxInputTokens: 100, source: 'manual', manualFields: [] }
    const profile = { models: [row] }
    const baseline = metadataDraftOf(row, 'deepseek')
    expect(buildModelMetadataOps({
      kind: 'deepseek', providerId: 'ignored', modelId: 'deep', profile,
      draft: { ...baseline, maxInputTokens: '200', tools: 'yes' },
    })).toEqual([])
  })
})

describe('model-metadata baseline-aware planning', () => {
  const initial = {
    id: 'm',
    name: 'Old',
    contextWindow: 1_000,
    maxTokens: 100,
    input: ['text'],
    reasoning: true,
    reasoningEfforts: { off: null, low: 'low' },
    cost: { input: 1, output: 2, cache_read: 0.1 },
    costTiers: [{ inputTokensAbove: 200_000, input: 4, output: 24 }],
    releaseDate: '2026-01-01',
  }

  it('applies only the edited name and keeps a smaller fresh context', () => {
    const baselineDraft = metadataDraftOf(initial, 'pi-ai-models')
    const fresh = {
      ...initial,
      contextWindow: 500,
      maxTokens: 50,
      input: ['text', 'image'],
      cost: { input: 1, output: 9, cache_read: 0.5 },
      source: 'manual',
      manualFields: ['contextWindow', 'cost'],
      unknown: 'keep',
    }
    const profile = { models: [fresh] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baselineDraft, name: 'Renamed' },
      baselineDraft,
    })
    expect(ops.some(op => op.path.at(-1) === 'contextWindow')).toBe(false)
    expect(ops.some(op => op.path.at(-1) === 'maxTokens')).toBe(false)
    expect(ops.some(op => op.path.at(-1) === 'input')).toBe(false)
    expect(ops).toContainEqual({
      op: 'set', path: ['providers', 'p', 'models', '0', 'name'], value: 'Renamed',
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'p', 'models', '0', 'manualFields'],
      value: ['name', 'contextWindow', 'cost'],
    })
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]).toMatchObject({
      name: 'Renamed',
      contextWindow: 500,
      maxTokens: 50,
      input: ['text', 'image'],
      cost: { input: 1, output: 9, cache_read: 0.5 },
      unknown: 'keep',
    })
  })

  it('merges one edited price into the fresh cost and keeps concurrent prices', () => {
    const baselineDraft = metadataDraftOf(initial, 'pi-ai-models')
    const fresh = {
      ...initial,
      cost: { input: 1, output: 9, cache_read: 0.5, cache_write: 0.7 },
      source: 'manual',
      manualFields: ['cost'],
    }
    const profile = { models: [fresh] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baselineDraft, inputPrice: '3' },
      baselineDraft,
    })
    expect(ops).toContainEqual({
      op: 'set', path: ['providers', 'p', 'models', '0', 'cost', 'input'], value: 3,
    })
    expect(ops.some(op => op.path.some(segment => segment === 'output' || segment === 'cache_read' || segment === 'cache_write'))).toBe(false)
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]?.['cost']).toEqual({ input: 3, output: 9, cache_read: 0.5, cache_write: 0.7 })
  })

  it('does not drop unrelated manual markers when one field is reset', () => {
    const baselineDraft = metadataDraftOf(initial, 'pi-ai-models')
    const fresh = {
      ...initial,
      name: 'Fresh',
      contextWindow: 500,
      cost: { input: 1, output: 9 },
      source: 'manual',
      manualFields: ['name', 'contextWindow', 'cost'],
    }
    const profile = { models: [fresh] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baselineDraft, inputPrice: '' },
      baselineDraft,
      resetFields: ['inputPrice'],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost', 'input'] })
    expect(ops.some(op => op.path.at(-1) === 'manualFields')).toBe(false)
    expect(ops.some(op => op.path.at(-1) === 'name' || op.path.at(-1) === 'contextWindow')).toBe(false)
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]).toMatchObject({
      name: 'Fresh',
      contextWindow: 500,
      cost: { output: 9 },
      manualFields: ['name', 'contextWindow', 'cost'],
    })
  })

  it('clones the fresh source row on a baseline id change and blocks collisions', () => {
    const baselineDraft = metadataDraftOf(initial, 'pi-ai-models')
    const fresh = {
      ...initial,
      name: 'Fresh',
      contextWindow: 500,
      compat: { chatTemplateKwargs: { keep: 1 } },
      unknown: 'keep',
    }
    const profile = { models: [fresh, { id: 'taken' }] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baselineDraft, id: 'new', name: 'Clone' },
      baselineDraft,
    })
    expect(ops).toHaveLength(1)
    expect(ops[0]?.path).toEqual(['providers', 'p', 'models', '2'])
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]).toEqual(fresh)
    expect(models[2]).toMatchObject({
      id: 'new',
      name: 'Clone',
      contextWindow: 500,
      compat: { chatTemplateKwargs: { keep: 1 } },
      unknown: 'keep',
      source: 'manual',
    })
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baselineDraft, id: 'taken' },
      baselineDraft,
    })).toThrow(expect.objectContaining({ code: 'duplicate-id' }))
  })

  it('ignores formatting-only differences from the baseline', () => {
    const baselineDraft = metadataDraftOf({
      ...initial,
      contextWindow: 1_000,
      cost: { input: 1 },
      costTiers: [{ inputTokensAbove: 200_000, input: 4, output: 24 }],
    }, 'pi-ai-models')
    const profile = { models: [{ ...initial, cost: { input: 1 }, costTiers: [{ inputTokensAbove: 200_000, input: 4, output: 24 }] }] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: {
        ...baselineDraft,
        contextWindow: '01000',
        inputPrice: '1.0',
        reasoningEfforts: 'off=\nlow = low',
        pricingTiers: [{ inputTokensAbove: '0200000', input: '4.0', output: '24.0' }],
      },
      baselineDraft,
    })
    expect(ops).toEqual([])
  })

  it('does not throw on a malformed inherited baseline price', () => {
    const row = { id: 'm', name: 'Old' }
    const profile = { models: [row] }
    const baselineDraft = {
      ...metadataDraftOf(row, 'pi-ai-models'),
      inputPrice: 'not-a-price',
    }
    expect(buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: metadataDraftOf(row, 'pi-ai-models'),
      baselineDraft,
    })).toEqual([])
  })

  it('detects a draft tier list when the baseline omitted the optional field', () => {
    const row = { id: 'm' }
    const baselineDraft: Partial<ModelMetadataDraft> = { ...metadataDraftOf(row, 'pi-ai-models') }
    delete baselineDraft.pricingTiers
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile: { models: [row] },
      draft: {
        ...metadataDraftOf(row, 'pi-ai-models'),
        pricingTiers: [{ inputTokensAbove: '1000', input: '1', output: '2' }],
      },
      baselineDraft: baselineDraft as ModelMetadataDraft,
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'p', 'models', '0', 'costTiers'],
      value: [{ inputTokensAbove: 1000, input: 1, output: 2 }],
    })
  })

  it('refuses an id change on a catalog override with a baseline', () => {
    const baselineDraft = metadataDraftOf({ id: 'm', name: 'Old' }, 'pi-ai-catalog')
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'm',
      profile: { models: [], modelOverrides: { m: { name: 'Old' } } },
      draft: { ...baselineDraft, id: 'other' },
      baselineDraft,
    })).toThrow(expect.objectContaining({ code: 'id-change-not-allowed' }))
  })
})

describe('model-metadata kind and modality validation', () => {
  it('disables catalog editing under endpoint authority without models', () => {
    expect(metadataKindOf('llm-pi-ai', { models: [], catalogAuthority: 'endpoint' })).toBeUndefined()
    expect(metadataKindOf('llm-pi-ai', { catalogAuthority: 'endpoint' })).toBeUndefined()
    expect(metadataKindOf('llm-pi-ai', { models: [{ id: 'm' }], catalogAuthority: 'endpoint' })).toBe('pi-ai-models')
    expect(metadataKindOf('llm-pi-ai', { models: [], catalogAuthority: 'catalog' })).toBe('pi-ai-catalog')
  })

  it('rejects modalities the host layout does not accept', () => {
    expect(validateMetadataDraft(draftOf({ input: ['audio'] }), 'deepseek'))
      .toEqual([{ field: 'input', code: 'invalidModality' }])
    expect(validateMetadataDraft(draftOf({ input: ['text', 'files'] }), 'pi-ai-models'))
      .toEqual([{ field: 'input', code: 'invalidModality' }])
    expect(validateMetadataDraft(draftOf({ input: ['text', 'image', 'audio', 'video', 'pdf'] }), 'pi-ai-models'))
      .toEqual([])
    expect(validateMetadataDraft(draftOf({ input: ['text', 'text'] }), 'deepseek')).toEqual([])
    expect(() => buildModelMetadataOps({
      kind: 'deepseek', providerId: 'ignored', modelId: 'deep',
      profile: { models: [{ id: 'deep', inputModalities: ['text'] }] },
      draft: draftOf({ id: 'deep', input: ['audio'] }),
    })).toThrow(expect.objectContaining({ code: 'invalid-draft' }))
  })
})

describe('model-metadata baseline comparison coverage', () => {
  const initial = {
    id: 'm',
    name: 'Old',
    contextWindow: 1_000,
    maxTokens: 100,
    input: ['text'],
    reasoning: true,
    reasoningEfforts: { off: null, low: 'low' },
    releaseDate: '2026-01-01',
  }

  it('applies every changed scalar onto fresh values and keeps fresh untouched fields', () => {
    const baselineDraft = metadataDraftOf(initial, 'pi-ai-models')
    const fresh = {
      ...initial,
      name: 'Fresh',
      contextWindow: 500,
      maxTokens: 50,
      input: ['text', 'audio'],
      tools: true,
      reasoning: true,
      reasoningEfforts: { low: 'low', max: 'max' },
      releaseDate: '2025-01-01',
      unknown: 'keep',
    }
    const profile = { models: [fresh] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: {
        ...baselineDraft,
        name: 'Edited',
        contextWindow: '2000',
        maxTokens: '200',
        input: ['text', 'image'],
        tools: 'no',
        reasoning: 'no',
        reasoningEfforts: 'low=low\nhigh=high',
        releaseDate: '2026-02-02',
      },
      baselineDraft,
    })
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]).toMatchObject({
      name: 'Edited',
      contextWindow: 2000,
      maxTokens: 200,
      input: ['text', 'image'],
      tools: false,
      reasoning: false,
      reasoningEfforts: { low: 'low', high: 'high' },
      releaseDate: '2026-02-02',
      unknown: 'keep',
    })
  })

  it('treats a malformed inherited baseline capacity and date as absent', () => {
    const row = { id: 'm' }
    const baselineDraft = {
      ...metadataDraftOf(row, 'pi-ai-models'),
      contextWindow: 'bad',
      releaseDate: 'soon',
      inputPrice: 'not-a-price',
    }
    expect(buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm',
      profile: { models: [row] },
      draft: metadataDraftOf(row, 'pi-ai-models'),
      baselineDraft,
    })).toEqual([])
  })

  it('leaves tiers untouched when the baseline draft omitted the optional list', () => {
    const row = {
      id: 'm',
      costTiers: [{ inputTokensAbove: 200_000, input: 4, output: 24 }],
    }
    const partialBaseline: Partial<ModelMetadataDraft> = { ...metadataDraftOf(row, 'pi-ai-models') }
    delete partialBaseline.pricingTiers
    const baselineDraft = partialBaseline as ModelMetadataDraft
    expect(buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm',
      profile: { models: [row] },
      draft: baselineDraft,
      baselineDraft,
    })).toEqual([])
  })

  it('ignores unsupported DeepSeek comparisons and edits input from the baseline', () => {
    const row = {
      id: 'deep',
      name: 'Deep',
      inputModalities: ['text', 'image'],
      maxInputTokens: 100,
      tools: true,
      reasoning: true,
      reasoningEfforts: { high: 'high' },
      source: 'manual',
      manualFields: ['input', 'name'],
    }
    const baselineDraft = metadataDraftOf(row, 'deepseek')
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'deepseek', providerId: 'ignored', modelId: 'deep', profile,
      draft: {
        ...baselineDraft,
        name: 'Edited',
        input: [],
        maxInputTokens: '200',
        tools: 'no',
        reasoning: 'no',
        reasoningEfforts: 'low=low',
      },
      baselineDraft,
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['models', '0', 'inputModalities'] })
    expect(ops).toContainEqual({
      op: 'set', path: ['models', '0', 'manualFields'], value: ['name'],
    })
    expect(ops.some(op => op.path.at(-1) === 'maxInputTokens' || op.path.at(-1) === 'tools')).toBe(false)
  })

  it('applies the documented catalog override-entry baseline and inherits absent fields', () => {
    const overrideEntry = { name: 'Pinned' }
    const baselineDraft = { ...metadataDraftOf(overrideEntry, 'pi-ai-catalog'), id: 'm' }
    const profile = { models: [], modelOverrides: { m: { name: 'Fresh' } } }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'm', profile,
      draft: { ...baselineDraft, name: 'Edited' },
      baselineDraft,
    })
    expect(ops).toEqual([{
      op: 'set', path: ['providers', 'p', 'modelOverrides', 'm', 'name'], value: 'Edited',
    }])
    expect(ops.some(op => op.path.includes('contextWindow'))).toBe(false)
  })

  it('creates a new override from the documented blank-entry baseline', () => {
    const baselineDraft = { ...metadataDraftOf({}, 'pi-ai-catalog'), id: 'fresh' }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'fresh',
      profile: { models: [] },
      draft: { ...baselineDraft, name: 'Fresh' },
      baselineDraft,
    })
    expect(ops).toEqual([{
      op: 'set', path: ['providers', 'p', 'modelOverrides', 'fresh', 'name'], value: 'Fresh',
    }])
  })

  it('refuses a stale baseline id even when the draft matches the override key', () => {
    const baselineDraft = metadataDraftOf({ id: 'other', name: 'Old' }, 'pi-ai-catalog')
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-catalog', providerId: 'p', modelId: 'm',
      profile: { models: [], modelOverrides: { m: { name: 'Old' } } },
      draft: { ...baselineDraft, id: 'm' },
      baselineDraft,
    })).toThrow(expect.objectContaining({
      code: 'invalid-draft',
      issues: [{ field: 'id', code: 'invalidId' }],
    }))
  })
})

describe('model-metadata zero-price baseline comparison', () => {
  it('does not treat zero or blank text formatting as a price edit', () => {
    const row = { id: 'm', cost: { input: 0, output: 0 } }
    const baselineDraft = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm',
      profile: { models: [row] },
      draft: { ...baselineDraft, inputPrice: '0.0', outputPrice: '00' },
      baselineDraft,
    })
    expect(ops).toEqual([])
  })
})

describe('model-metadata input spelling aliases', () => {
  it('resets both spellings when only the fallback carries the value', () => {
    const row = { id: 'm', inputModalities: ['text'] }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: metadataDraftOf(row, 'pi-ai-models'),
      resetFields: ['input'],
    })
    expect(ops).toContainEqual({
      op: 'unset', path: ['providers', 'p', 'models', '0', 'inputModalities'],
    })
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]).not.toHaveProperty('input')
    expect(models[0]).not.toHaveProperty('inputModalities')
  })

  it('resets both spellings when the row carries both', () => {
    const row = { id: 'm', input: ['text'], inputModalities: ['image'] }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: metadataDraftOf(row, 'pi-ai-models'),
      resetFields: ['input'],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'input'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'inputModalities'] })
  })

  it('writes the canonical spelling and removes the alias on an edit', () => {
    const row = { id: 'm', inputModalities: ['text'] }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...metadataDraftOf(row, 'pi-ai-models'), input: ['text', 'image'] },
    })
    expect(ops).toContainEqual({
      op: 'set', path: ['providers', 'p', 'models', '0', 'input'], value: ['text', 'image'],
    })
    expect(ops).toContainEqual({
      op: 'unset', path: ['providers', 'p', 'models', '0', 'inputModalities'],
    })
  })

  it('leaves an unmodified alias untouched', () => {
    const row = { id: 'm', name: 'Old', inputModalities: ['text'] }
    const profile = { models: [row] }
    const baselineDraft = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: { ...baselineDraft, name: 'New' },
      baselineDraft,
    })
    expect(ops.some(op => op.path.at(-1) === 'input' || op.path.at(-1) === 'inputModalities')).toBe(false)
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]?.['inputModalities']).toEqual(['text'])
  })

  it('seeds and clones manual input markers from either spelling', () => {
    const legacy = { id: 'm', name: 'Old', inputModalities: ['text'], source: 'manual' }
    const legacyOps = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm',
      profile: { models: [legacy] },
      draft: { ...metadataDraftOf(legacy, 'pi-ai-models'), name: 'New' },
    })
    expect(legacyOps).toContainEqual({
      op: 'set', path: ['providers', 'p', 'models', '0', 'manualFields'], value: ['name', 'input'],
    })
    const cloneOps = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm',
      profile: { models: [legacy] },
      draft: { ...metadataDraftOf(legacy, 'pi-ai-models'), id: 'new' },
    })
    const document = applyOps({ providers: { p: { models: [legacy] } } }, cloneOps)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[1]?.['manualFields']).toContain('input')
  })

  it('cleans both DeepSeek spellings through the same canonical field', () => {
    const row = { id: 'deep', inputModalities: ['text'], input: ['image'] }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'deepseek', providerId: 'ignored', modelId: 'deep', profile,
      draft: metadataDraftOf(row, 'deepseek'),
      resetFields: ['inputModalities'],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['models', '0', 'inputModalities'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['models', '0', 'input'] })
  })
})

describe('model-metadata threshold-only price tiers', () => {
  it('accepts and preserves a threshold-only tier', () => {
    const row = { id: 'm', name: 'Old', costTiers: [{ inputTokensAbove: 200_000 }] }
    const draft = metadataDraftOf(row, 'pi-ai-models')
    expect(draft.pricingTiers).toEqual([{ inputTokensAbove: '200000', input: '', output: '' }])
    expect(validateMetadataDraft(draft, 'pi-ai-models')).toEqual([])
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm',
      profile: { models: [row] },
      draft: { ...draft, name: 'New' },
      baselineDraft: draft,
    })
    expect(ops).toContainEqual({
      op: 'set', path: ['providers', 'p', 'models', '0', 'name'], value: 'New',
    })
    expect(ops.some(op => op.path.at(-1) === 'costTiers')).toBe(false)
  })

  it('emits a threshold-only tier when touched', () => {
    const row = { id: 'm' }
    const baselineDraft = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm',
      profile: { models: [row] },
      draft: {
        ...baselineDraft,
        pricingTiers: [{ inputTokensAbove: '200000', input: '', output: '' }],
      },
      baselineDraft,
    })
    expect(ops).toContainEqual({
      op: 'set',
      path: ['providers', 'p', 'models', '0', 'costTiers'],
      value: [{ inputTokensAbove: 200000 }],
    })
  })
})

describe('model-metadata bare cache reset aliases', () => {
  it('accepts bare canonical cache keys without dropping other cost columns', () => {
    const row = { id: 'm', cost: { input: 1, cache_read: 0.1, cache_write: 0.2 } }
    const profile = { models: [row] }
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'm', profile,
      draft: metadataDraftOf(row, 'pi-ai-models'),
      resetFields: ['cache_read', 'cache_write'],
    })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost', 'cache_read'] })
    expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'p', 'models', '0', 'cost', 'cache_write'] })
    const document = applyOps({ providers: { p: profile } }, ops)
    const models = (document['providers'] as Record<string, { models: Array<Record<string, unknown>> }>)['p']?.models ?? []
    expect(models[0]?.['cost']).toEqual({ input: 1 })
  })
})

describe('model-metadata baseline identity precondition', () => {
  it('refuses a stale baseline id instead of appending a duplicate target', () => {
    const row = { id: 'target', name: 'Fresh' }
    const baselineDraft = { ...metadataDraftOf(row, 'pi-ai-models'), id: 'stale' }
    expect(() => buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target',
      profile: { models: [row] },
      draft: { ...baselineDraft, id: 'target', name: 'Edited' },
      baselineDraft,
    })).toThrow(expect.objectContaining({
      code: 'invalid-draft',
      issues: [{ field: 'id', code: 'invalidId' }],
    }))
  })

  it('never save-as when the draft id equals the fresh stored id', () => {
    const row = { id: 'target', name: 'Fresh' }
    const baselineDraft = metadataDraftOf(row, 'pi-ai-models')
    const ops = buildModelMetadataOps({
      kind: 'pi-ai-models', providerId: 'p', modelId: 'target',
      profile: { models: [row] },
      draft: { ...baselineDraft, name: 'Edited' },
      baselineDraft,
    })
    expect(ops.some(op => op.path[3] === '1')).toBe(false)
    expect(ops).toContainEqual({
      op: 'set', path: ['providers', 'p', 'models', '0', 'name'], value: 'Edited',
    })
  })
})
