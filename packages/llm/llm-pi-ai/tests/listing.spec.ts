import { describe, expect, it } from 'vitest'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import {
  listingCapabilities,
  readModelListing,
} from '../src/listing.ts'

const UNKNOWN_LEVELS = ['adaptive']

describe('readModelListing containers', () => {
  it('accepts a top-level array, the standard data array, and both models spellings', () => {
    for (const body of [
      [{ id: 'array-model' }],
      { data: [{ id: 'data-model' }] },
      { models: [{ id: 'models-array-model' }] },
      { models: { 'route-key': { id: 'canonical-id' } } },
    ]) {
      const result = readModelListing(body)
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.models).toHaveLength(1)
    }
  })

  it('separates a valid empty listing from an invalid body', () => {
    for (const body of [[], { data: [] }, { models: [] }, { models: {} }]) {
      expect(readModelListing(body)).toEqual({ ok: true, models: [] })
    }
    for (const body of [null, undefined, 'nope', 42, {}, { data: 'nope' }, { models: null }]) {
      expect(readModelListing(body)).toEqual({ ok: false, reason: 'not-a-listing' })
    }
  })

  it('does not treat a nonempty malformed listing as authoritative empty', () => {
    for (const body of [[null, { name: 'missing id' }], { data: [{ id: '' }] }, { models: { broken: null } }]) {
      expect(readModelListing(body)).toEqual({ ok: false, reason: 'no-usable-models' })
    }
  })

  it('prefers data over models and skips non-record rows without failing the rest', () => {
    expect(readModelListing({
      data: [{ id: 'data-model' }],
      models: [{ id: 'models-model' }],
    })).toEqual({
      ok: true,
      models: [{ id: 'data-model' }],
    })
    expect(readModelListing([
      null,
      'not a model',
      { id: 'kept' },
      { name: 'no id at all' },
      { id: '' },
    ])).toEqual({ ok: true, models: [{ id: 'kept' }] })
  })
})

describe('request ids and aliases', () => {
  it('keeps an actual id and retains slug as source metadata', () => {
    expect(readModelListing([
      { id: 'request-id', slug: 'canonical-slug', name: 'Model' },
    ])).toEqual({
      ok: true,
      models: [{ id: 'request-id', name: 'Model', sourceAlias: 'canonical-slug' }],
    })
  })

  it('accepts slug only when no id or map key exists, and marks it', () => {
    expect(readModelListing([{ slug: 'slug-only' }])).toEqual({
      ok: true,
      models: [{ id: 'slug-only', sourceAlias: 'slug-only' }],
    })
  })

  it('preserves a model-map request key and keeps owner-scoped lookup metadata', () => {
    expect(readModelListing({
      models: {
        'route-key': { id: 'canonical-id', slug: 'route-slug', name: 'Label', owned_by: 'anthropic' },
        '': { id: 'fallback-id', slug: 'fallback-slug' },
        'key-only': {},
      },
    })).toEqual({
      ok: true,
      models: [
        { id: 'route-key', name: 'Label', sourceAlias: 'route-slug', owner: 'anthropic' },
        { id: 'fallback-id', sourceAlias: 'fallback-slug' },
        { id: 'key-only' },
      ],
    })
  })
})

describe('capacities', () => {
  it('keeps max_input_tokens distinct from the combined context window', () => {
    const model = readModelListing([{
      id: 'anthropic-model',
      max_input_tokens: 200_000,
      max_tokens: 64_000,
    }])
    expect(model).toEqual({
      ok: true,
      models: [{ id: 'anthropic-model', maxInputTokens: 200_000, maxTokens: 64_000 }],
    })
  })

  it('reads context spellings and output aliases without prefix guesses', () => {
    const model = readModelListing([{
      id: 'aliases',
      context_length: 100_000,
      top_provider: { context_length: 200_000, max_completion_tokens: 8_000 },
      max_completion_tokens: 4_000,
      outputTokenLimit: 2_000,
    }])
    expect(model).toEqual({
      ok: true,
      models: [{
        id: 'aliases',
        contextWindow: 100_000,
        maxTokens: 4_000,
      }],
    })

    expect(readModelListing([{ id: 'top-only', top_provider: { max_completion_tokens: 8_000 } }])).toEqual({
      ok: true,
      models: [{ id: 'top-only', maxTokens: 8_000 }],
    })
    expect(readModelListing([{ id: 'google-output', outputTokenLimit: 2_000 }])).toEqual({
      ok: true,
      models: [{ id: 'google-output', maxTokens: 2_000 }],
    })
  })

  it('ignores zero and non-integer capacities', () => {
    expect(readModelListing([{
      id: 'zero',
      context_length: 0,
      max_input_tokens: -1,
      max_tokens: 1.5,
    }])).toEqual({ ok: true, models: [{ id: 'zero' }] })
  })
})

describe('input modalities', () => {
  it.each([
    ['supportedInputModalities', { supportedInputModalities: ['text', 'image'] }],
    ['input_modalities', { input_modalities: ['text', 'image'] }],
    ['modalities.input', { modalities: { input: ['text', 'image'] } }],
    ['architecture.input_modalities', { architecture: { input_modalities: ['text', 'image'] } }],
  ])('reads %s', (_name, fields) => {
    expect(readModelListing([{ id: 'model', ...fields }])).toEqual({
      ok: true,
      models: [{ id: 'model', inputModalities: ['text', 'image'] }],
    })
  })

  it('keeps an explicit text-only array explicit instead of treating it as undisclosed', () => {
    expect(readModelListing([{ id: 'text-only', input_modalities: ['text'] }])).toEqual({
      ok: true,
      models: [{ id: 'text-only', inputModalities: ['text'] }],
    })
  })

  it('unions capability booleans with an explicit array and implies text only when starting from booleans', () => {
    expect(readModelListing([{
      id: 'capabilities',
      capabilities: {
        image_input: { supported: true },
        pdf_input: { supported: true },
      },
    }])).toEqual({
      ok: true,
      models: [{ id: 'capabilities', inputModalities: ['text', 'image', 'pdf'] }],
    })

    expect(readModelListing([{
      id: 'explicit-and-capability',
      input_modalities: ['text'],
      capabilities: { image_input: { supported: true } },
    }])).toEqual({
      ok: true,
      models: [{ id: 'explicit-and-capability', inputModalities: ['text', 'image'] }],
    })
  })

  it('maps the vision alias and drops unknown or file tokens', () => {
    expect(readModelListing([{ id: 'vision', input_modalities: ['vision'] }])).toEqual({
      ok: true,
      models: [{ id: 'vision', inputModalities: ['image'] }],
    })
    expect(readModelListing([{ id: 'files', input_modalities: ['file'] }])).toEqual({
      ok: true,
      models: [{ id: 'files' }],
    })
  })
})

describe('tools and reasoning claims', () => {
  it('reports booleans only when stated, preserving false', () => {
    expect(readModelListing([{ id: 'stated', tools: false, reasoning: true }])).toEqual({
      ok: true,
      models: [{ id: 'stated', tools: false, reasoning: true }],
    })
    expect(readModelListing([{ id: 'absent' }])).toEqual({
      ok: true,
      models: [{ id: 'absent' }],
    })
    expect(readModelListing([{
      id: 'capability-block',
      capabilities: {
        tools: { supported: false },
        reasoning: { supported: true },
      },
    }])).toEqual({
      ok: true,
      models: [{ id: 'capability-block', tools: false, reasoning: true }],
    })
  })

  it('reads the raw registry tool_call and supported_parameters spellings', () => {
    expect(readModelListing([{
      id: 'registry',
      tool_call: true,
      supported_parameters: ['tools', 'reasoning'],
    }])).toEqual({
      ok: true,
      models: [{ id: 'registry', tools: true, reasoning: true }],
    })
  })

  it('never invents a ladder from reasoning:true or a numeric budget', () => {
    expect(listingCapabilities({ reasoning: true })).toEqual({ reasoning: true })
    expect(listingCapabilities({ thinking: { budget_tokens: 2048 } })).toEqual({})
    expect(listingCapabilities({ thinking: { levels: ['low'], budgets: { high: 2048 } } })).toEqual({
      reasoningEfforts: { low: 'low' },
    })
  })
})

describe('reasoning ladders', () => {
  it('reads the capability effort map and skips unsupported entries and the status marker', () => {
    expect(listingCapabilities({
      capabilities: {
        effort: {
          low: { supported: true },
          high: { supported: true },
          minimal: { supported: false },
          supported: true,
        },
      },
    })).toEqual({
      reasoningEfforts: { low: 'low', high: 'high' },
    })
  })

  it('reads supported_reasoning_levels objects and strings with exact wire values', () => {
    expect(listingCapabilities({
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'high', value: 'turbo' },
        'max',
      ],
    })).toEqual({
      reasoningEfforts: { low: 'low', high: 'turbo', max: 'max' },
    })
  })

  it('reads raw thinking.levels and adds off only when zero_allowed is explicitly true', () => {
    expect(listingCapabilities({
      thinking: { levels: ['low', 'high'], zero_allowed: true },
    })).toEqual({
      reasoningEfforts: { low: 'low', high: 'high', off: '' },
    })
    expect(listingCapabilities({ thinking: { levels: ['low', 'high'] } })).toEqual({
      reasoningEfforts: { low: 'low', high: 'high' },
    })
    expect(listingCapabilities({ thinking: { levels: ['low'], zero_allowed: false } })).toEqual({
      reasoningEfforts: { low: 'low' },
    })
  })

  it('keeps unknown effort identifiers as parser metadata instead of coercing them', () => {
    expect(listingCapabilities({
      supported_reasoning_levels: [
        { effort: 'max', value: 'ultra' },
        { effort: 'adaptive' },
      ],
    })).toEqual({
      reasoningEfforts: { max: 'ultra' },
      unsupportedReasoningEfforts: UNKNOWN_LEVELS,
    })
  })

  it('preserves an explicit empty ladder as distinct from an undisclosed one', () => {
    expect(listingCapabilities({ supported_reasoning_levels: [] })).toEqual({ reasoningEfforts: {} })
    expect(listingCapabilities({ thinking: { levels: [] } })).toEqual({ reasoningEfforts: {} })
    expect(listingCapabilities({ capabilities: { effort: {} } })).toEqual({ reasoningEfforts: {} })
    expect(listingCapabilities({})).toEqual({})
  })

  it('reads a bare reasoning map but treats metadata-shaped reasoning objects as claims only', () => {
    expect(listingCapabilities({ reasoning: { low: 'low', high: 'high' } })).toEqual({
      reasoningEfforts: { low: 'low', high: 'high' },
    })
    expect(listingCapabilities({
      reasoning: {
        mandatory: true,
        supported_efforts: ['low', 'high'],
        default_effort: 'high',
      },
    })).toEqual({})
  })

  it('keeps Gemini low/high and Claude max as exact separate ladders', () => {
    expect(listingCapabilities({
      thinking: { levels: ['low', 'high'], zero_allowed: true },
    })).toEqual({ reasoningEfforts: { low: 'low', high: 'high', off: '' } })
    expect(listingCapabilities({
      capabilities: { effort: { max: { supported: true } } },
      reasoning: true,
    })).toEqual({ reasoning: true, reasoningEfforts: { max: 'max' } })
  })
})

describe('listingCapabilities compatibility', () => {
  it('does not treat a description or base_instructions field as prompt content or a name', () => {
    expect(listingCapabilities({
      id: 'described',
      description: 'A long prose description',
      base_instructions: 'You are a helpful model',
    })).toEqual({})
  })

  it('publishes the same reader helpers from the package root', () => {
    expect(LlmPiAi.readModelListing).toBe(readModelListing)
    expect(LlmPiAi.listingCapabilities).toBe(listingCapabilities)
    expect(LlmPiAi.offeredCompatFields('openai-completions')).toContain('thinkingFormat')
  })
})
