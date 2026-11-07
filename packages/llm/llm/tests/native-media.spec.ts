/** Native-file policy descriptor admission for routed provider requests. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LlmRuntime, { LlmAdapter, llmNativeFileInputsEqual, validateLlmNativeFileInputs } from '../src/index.ts'
import type { GenerateOptions, LlmNativeFileInputs, LlmResolvedModelInfo, StreamChunk } from '../src/index.ts'

const VALID = {
  version: 1,
  encoders: {
    'application/pdf': 'anthropic-document',
    'audio/mpeg': 'openai-chat-input-audio',
  },
  perFileBytes: 10_000,
  totalBytes: 20_000,
  maxPayloadBytes: 30_000,
  tokenReserve: { perFile: 50, perByte: 0.25 },
}

describe('validateLlmNativeFileInputs', () => {
  it('accepts an explicit policy and returns a detached frozen value', () => {
    const inputs = structuredClone(VALID)
    const validated = validateLlmNativeFileInputs(inputs)
    expect(validated).toEqual(VALID)
    expect(validated.encoders).not.toBe(inputs.encoders)
    expect(validated.tokenReserve).not.toBe(inputs.tokenReserve)
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.encoders)).toBe(true)
    expect(Object.isFrozen(validated.tokenReserve)).toBe(true)
  })

  it('accepts a descriptor with no encoder mapping', () => {
    expect(validateLlmNativeFileInputs({ ...VALID, encoders: {} }).encoders).toEqual({})
  })

  it.each<[string, unknown, RegExp]>([
    ['non-object', null, /must be an object/],
    ['array', [], /must be an object/],
    ['unknown version', { ...VALID, version: 2 }, /version must be 1/],
    ['non-object encoders', { ...VALID, encoders: [] }, /encoders must be an object/],
    ['unknown MIME', { ...VALID, encoders: { 'text/plain': 'anthropic-document' } }, /unknown MIME type/],
    ['unknown encoder', { ...VALID, encoders: { 'application/pdf': 'guess' } }, /unknown encoder/],
    [
      'incompatible encoder',
      { ...VALID, encoders: { 'application/pdf': 'openai-chat-input-audio' } },
      /incompatible encoder/,
    ],
    ['zero perFileBytes', { ...VALID, perFileBytes: 0 }, /perFileBytes must be a positive safe integer/],
    ['fractional perFileBytes', { ...VALID, perFileBytes: 1.5 }, /perFileBytes must be a positive safe integer/],
    ['string totalBytes', { ...VALID, totalBytes: '10' }, /totalBytes must be a positive safe integer/],
    ['totalBytes below perFileBytes', { ...VALID, totalBytes: 1 }, /totalBytes must be at least perFileBytes/],
    ['invalid maxPayloadBytes', { ...VALID, maxPayloadBytes: -1 }, /maxPayloadBytes must be a positive safe integer/],
    ['non-object tokenReserve', { ...VALID, tokenReserve: null }, /tokenReserve must be an object/],
    ['negative perFile reserve', { ...VALID, tokenReserve: { perFile: -1, perByte: 0 } }, /perFile must be a non-negative/],
    ['non-finite perByte reserve', { ...VALID, tokenReserve: { perFile: 0, perByte: Number.POSITIVE_INFINITY } }, /perByte must be a non-negative/],
  ])('refuses %s', (_name, value, message) => {
    expect(() => validateLlmNativeFileInputs(value)).toThrow(message)
  })
})

describe('llmNativeFileInputsEqual', () => {
  it('compares every admission and pricing field', () => {
    const base = validateLlmNativeFileInputs(VALID)
    const variants: LlmNativeFileInputs[] = [
      { ...base, perFileBytes: base.perFileBytes + 1 },
      { ...base, totalBytes: base.totalBytes + 1 },
      { ...base, maxPayloadBytes: base.maxPayloadBytes + 1 },
      { ...base, tokenReserve: { ...base.tokenReserve, perFile: base.tokenReserve.perFile + 1 } },
      { ...base, tokenReserve: { ...base.tokenReserve, perByte: base.tokenReserve.perByte + 1 } },
      { ...base, encoders: { 'application/pdf': 'openai-chat-file' } },
      { ...base, encoders: {} },
    ]
    expect(llmNativeFileInputsEqual(undefined, undefined)).toBe(true)
    expect(llmNativeFileInputsEqual(base, base)).toBe(true)
    expect(llmNativeFileInputsEqual(base, structuredClone(base))).toBe(true)
    expect(llmNativeFileInputsEqual(base, undefined)).toBe(false)
    expect(llmNativeFileInputsEqual(undefined, base)).toBe(false)
    for (const variant of variants) expect(llmNativeFileInputsEqual(base, variant)).toBe(false)
  })
})

class NativeAdapter extends LlmAdapter {
  constructor(private readonly descriptor: unknown) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield * []
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.descriptor === undefined ? {} : { nativeFileInputs: this.descriptor as LlmNativeFileInputs },
    })
  }
}

describe('PreparedLlmCall native-file policy', () => {
  it('captures a detached frozen descriptor from the adapter generation', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    try {
      ctx.llm.registerAdapter(['route'], new NativeAdapter(structuredClone(VALID)))
      const prepared = await ctx.llm.prepareCall({ provider: 'route', model: 'model' })
      expect(prepared.nativeFileInputs).toEqual(VALID)
      expect(Object.isFrozen(prepared.nativeFileInputs)).toBe(true)
      expect(Object.isFrozen(prepared.nativeFileInputs?.encoders)).toBe(true)
      expect(Object.isFrozen(prepared.nativeFileInputs?.tokenReserve)).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits the descriptor for a route that declares no native media', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    try {
      ctx.llm.registerAdapter(['route'], new NativeAdapter(undefined))
      const prepared = await ctx.llm.prepareCall({ provider: 'route', model: 'model' })
      expect(prepared.nativeFileInputs).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses an invalid adapter descriptor before dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    try {
      ctx.llm.registerAdapter(['route'], new NativeAdapter({ ...VALID, version: 2 }))
      await expect(ctx.llm.prepareCall({ provider: 'route', model: 'model' }))
        .rejects.toMatchObject({ code: 'INVALID_MODEL_INFO' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
