import { describe, expect, it } from 'vitest'
import { assertServiceable, Config, resolveProfiles, type Options } from '../src/config.ts'

/** Validate one hand-declared route, with the caller's fields layered onto it. */
const routeWith = (profile: Record<string, unknown>): (() => unknown) =>
  () => ({ providers: Config({
    providers: {
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        ...profile,
      },
    },
  }).providers.get() })

/** Validate that route with the caller's fields on its single model entry. */
const configWith = (model: Record<string, unknown>): (() => unknown) =>
  routeWith({ models: [{ id: 'm', ...model }] })

describe('reasoning schema boundary', () => {
  it('accepts an empty provider section and propagates unexpected catalog failures', () => {
    expect(() => { assertServiceable({}) }).not.toThrow()
    const failure = new TypeError('model metadata lookup failed')
    expect(() => resolveProfiles({ openrouter: { models: [{
      id: '111',
      get name(): string { throw failure },
    }], api: 'openai-completions' } }, 'deferred')).toThrow(failure)
  })

  it('rejects a level pi-ai does not know at the write that produced it', () => {
    expect(configWith({ reasoningEfforts: { ultra: 'x' } })).toThrow(/"off"/)
    expect(configWith({ reasoningEfforts: { high: 42 } })).toThrow()
  })

  it('keeps false distinguishable from an absent declaration', () => {
    type Materialized = { providers: Record<string, { models?: { reasoningEfforts?: unknown }[] }> }
    const withFalse = configWith({ reasoningEfforts: false })() as Materialized
    expect(withFalse.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBe(false)
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBeUndefined()
  })

  it('rejects a thinking format outside the offered set', () => {
    expect(configWith({ compat: { thinkingFormat: 'quantum' } })).toThrow(/expected/)
  })

  it('accepts Baseten template arguments and completion controls', () => {
    expect(configWith({
      compat: {
        supportsFinishReason: false,
        thinkingFormat: 'baseten',
        chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
        supportsThinkingTokenBudget: true,
      },
    })).not.toThrow()
  })
})

describe('route-level free-tier gate profile fields', () => {
  it('accepts the durable gate declaration and carries it into the resolved profile', () => {
    const validated = routeWith({ freeTierGated: true, freeTierGateReason: 'free tier is limited to Acme clients' })() as {
      providers: Record<string, { freeTierGated?: unknown; freeTierGateReason?: unknown }>
    }
    expect(validated.providers['acme-gateway']).toMatchObject({
      freeTierGated: true,
      freeTierGateReason: 'free tier is limited to Acme clients',
    })
    const resolved = resolveProfiles(validated.providers as Options['providers'])
    expect(resolved.get('acme-gateway')).toMatchObject({
      freeTierGated: true,
      freeTierGateReason: 'free tier is limited to Acme clients',
    })
    // The reason is optional; the flag alone is the gate.
    expect(routeWith({ freeTierGated: true })()).toMatchObject({
      providers: { 'acme-gateway': { freeTierGated: true } },
    })
  })

  it('rejects a non-boolean gate flag at the write boundary', () => {
    expect(routeWith({ freeTierGated: 'yes' })).toThrow()
  })
})

describe('modality schema boundary', () => {
  it('accepts the harness modality vocabulary at either level', () => {
    // models.dev publishes audio/video/pdf input; the stored entry keeps them
    // so the sync does not discard what the provider catalog disclosed.
    expect(configWith({ input: ['text', 'image', 'audio', 'video', 'pdf'] })).not.toThrow()
    expect(routeWith({ defaultInput: ['text', 'audio'] })).not.toThrow()
  })

  it('keeps existing text|image data valid and rejects a token outside the vocabulary', () => {
    expect(configWith({ input: ['text', 'image'] })).not.toThrow()
    expect(routeWith({ defaultInput: ['text', 'image'] })).not.toThrow()
    expect(configWith({ input: ['hologram'] })).toThrow(/expected/)
    expect(routeWith({ defaultInput: ['text', 'hologram'] })).toThrow(/expected/)
  })

  it('refuses a route whose models could accept nothing', () => {
    // The pair the settings seam runs: the schema accepts the empty list as
    // well-typed, and the namespace validator is what refuses it. Asserting
    // only the schema would report this route as writable.
    expect(routeWith({ defaultInput: [] })).not.toThrow()
    expect(() => { assertServiceable(routeWith({ defaultInput: [] })() as Options) })
      .toThrow(/defaultInput must name at least one modality/)
  })

  type Materialized = {
    providers: Record<string, { defaultInput?: unknown; models?: { input?: unknown }[] }>
  }

  it('materializes an absent entry list as empty and an absent route list as text', () => {
    // The empty-list inheritance rule exists because of exactly this: an entry
    // that declares nothing reaches resolution as `[]`, not as `undefined`.
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.input).toEqual([])
    expect(absent.providers['acme-gateway']?.defaultInput).toEqual(['text'])
  })
})

describe('synced display tags', () => {
  it('passes models.dev release dates and price tiers through the entry schema', () => {
    type Materialized = { providers: Record<string, { models?: Record<string, unknown>[] }> }
    const materialized = configWith({
      releaseDate: '2026-05-21',
      costTiers: [{ inputTokensAbove: 200_000, input: 4, output: 24 }],
    })() as Materialized
    // The sync writes these beside the request-relevant fields; the schema
    // must keep them, because the Models page renders its markers from them.
    expect(materialized.providers['acme-gateway']?.models?.[0]).toMatchObject({
      releaseDate: '2026-05-21',
      costTiers: [{ inputTokensAbove: 200_000, input: 4, output: 24 }],
    })
  })
})

describe('catalog authority and input-only capacity', () => {
  it('carries the authority sentinel and an input cap distinct from the combined window', () => {
    type Materialized = {
      providers: Record<string, {
        catalogAuthority?: unknown
        models?: Record<string, unknown>[]
      }>
    }
    const materialized = routeWith({
      catalogAuthority: 'endpoint',
      models: [{ id: 'm', contextWindow: 200_000, maxInputTokens: 128_000, maxTokens: 8192 }],
    })() as Materialized
    expect(materialized.providers['acme-gateway']).toMatchObject({
      catalogAuthority: 'endpoint',
      models: [{ id: 'm', contextWindow: 200_000, maxInputTokens: 128_000, maxTokens: 8192 }],
    })
    // The cap is stored on its own field; it must not overwrite either
    // combined-context or output capacity.
    const model = materialized.providers['acme-gateway']?.models?.[0]
    expect(model?.contextWindow).toBe(200_000)
    expect(model?.maxTokens).toBe(8192)
  })

  it('resolves the authority and cap into the configured profile', () => {
    const validated = routeWith({
      catalogAuthority: 'catalog',
      models: [{ id: 'm', contextWindow: 200_000, maxInputTokens: 128_000 }],
    })() as { providers: Options['providers'] }
    const resolved = resolveProfiles(validated.providers).get('acme-gateway')
    expect(resolved?.catalogAuthority).toBe('catalog')
    expect(resolved?.piProvider?.getModels()[0]).toMatchObject({
      id: 'm',
      contextWindow: 200_000,
    })
    // pi-ai's Model has no input-only field; the cap stays in configuration
    // and enters resolution facts instead of being mistaken for maxTokens.
    expect(resolved?.piProvider?.getModels()[0]).not.toHaveProperty('maxInputTokens')
    expect(resolved?.catalogFacts.get('m')).toEqual({
      contextWindow: 'configured',
      maxTokens: 'default',
      input: 'default',
      inputModalities: ['text'],
      maxInputTokens: 128_000,
      maxInputTokensSource: 'configured',
    })
  })

  it('carries installed-catalog facts on the resolved profile', () => {
    const installed = resolveProfiles({ deepseek: {} }).get('deepseek')
    const first = installed?.piProvider?.getModels()[0]
    if (first === undefined) throw new Error('the installed catalog ships no deepseek model')
    expect(installed?.catalogFacts.get(first.id)).toMatchObject({
      contextWindow: 'installed',
      maxTokens: 'installed',
      input: 'installed',
      inputModalities: first.input,
    })
  })

  it('rejects an authority outside the two sources and a non-positive input cap', () => {
    expect(routeWith({ catalogAuthority: 'fallback' })).toThrow(/expected/)
    expect(configWith({ maxInputTokens: 0 })).toThrow(/expected/)
    expect(configWith({ maxInputTokens: 1.5 })).toThrow(/expected/)
  })
})

describe('request image policy bounds', () => {
  it.each([
    ['requestImagePixelBudget', 0, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImagePixelBudget', Number.MAX_SAFE_INTEGER + 1, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImageMaxBytes', 0, /requestImageMaxBytes must be a positive safe integer/],
    ['requestImageMaxBytes', 1.5, /requestImageMaxBytes must be a positive safe integer/],
  ] as const)('rejects %s=%s at service resolution', (field, value, message) => {
    const programmatic = {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm' }],
          [field]: value,
        },
      },
    } as Options
    expect(() => {
      assertServiceable(programmatic)
    }).toThrow(message)
  })
})

describe('native-file declaration boundary', () => {
  const valid = {
    version: 1,
    encoder: 'openai-chat-file',
    mime: ['application/pdf'],
    perFileBytes: 1_000,
    totalBytes: 2_000,
    maxPayloadBytes: 4_000,
    tokenReserve: { perFile: 10, perByte: 0.5 },
  }

  function resolvedWith(model: Record<string, unknown>, api = 'openai-completions') {
    const providers = {
      'acme-gateway': {
        api,
        baseURL: 'https://acme.test',
        models: [{ id: 'm', ...model }],
      },
    } as NonNullable<Options['providers']>
    assertServiceable({ providers })
    return resolveProfiles(providers).get('acme-gateway')
  }

  it('keeps native media off when no model declares it', () => {
    const resolved = resolvedWith({})
    expect(resolved?.catalogFacts.get('m')?.nativeFileInputs).toBeUndefined()
  })

  it('materializes the validated descriptor for the exact model that declared it', () => {
    const resolved = resolvedWith({ nativeFileInputs: valid })
    expect(resolved?.catalogFacts.get('m')?.nativeFileInputs).toEqual({
      version: 1,
      encoders: { 'application/pdf': 'openai-chat-file' },
      perFileBytes: 1_000,
      totalBytes: 2_000,
      maxPayloadBytes: 4_000,
      tokenReserve: { perFile: 10, perByte: 0.5 },
    })
  })

  it('accepts an Anthropic PDF declaration on an anthropic-messages model', () => {
    const resolved = resolvedWith({
      nativeFileInputs: { ...valid, encoder: 'anthropic-document' },
    }, 'anthropic-messages')
    expect(resolved?.catalogFacts.get('m')?.nativeFileInputs?.encoders).toEqual({
      'application/pdf': 'anthropic-document',
    })
  })

  it('rejects an undeclared encoder, partial declaration, and unsupported protocol', () => {
    expect(() => resolvedWith({ nativeFileInputs: { ...valid, encoder: 'acme-parts' } })).toThrow(/must be one of/)
    expect(() => resolvedWith({ nativeFileInputs: { encoder: 'openai-chat-file' } }))
      .toThrow(/mime must list at least one MIME type/)
    expect(() => resolvedWith({ nativeFileInputs: { ...valid, version: 2 } })).toThrow(/version must be 1/)
    expect(() => resolvedWith({
      nativeFileInputs: { ...valid, encoder: 'anthropic-document' },
    })).toThrow(/valid only on api anthropic-messages/)
    expect(() => resolvedWith({
      nativeFileInputs: { ...valid, encoder: 'openai-chat-input-audio', mime: ['application/pdf'] },
    })).toThrow(/cannot carry it/)
  })

  it('rejects a misspelled field instead of silently disabling media', () => {
    expect(() => resolvedWith({ nativeFileInputs: { ...valid, encder: 'openai-chat-file' } }))
      .toThrow(/unknown field "encder"/)
  })
})
