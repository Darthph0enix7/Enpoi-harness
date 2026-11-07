/**
 * CLIProxyAPI registry-metadata specs.
 *
 * These pin the metadata layer's contract: exact-id resolution only with an
 * explicit owner/channel, disclosed fields only, unknown reasoning/effort when
 * upstream omits thinking, no substring/family guesses, no combined context
 * values, no effort levels invented from numeric budgets, sanitized snapshot
 * loading, and no prompt/description/network-policy leakage.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_REGISTRY_LICENSE,
  BUNDLED_REGISTRY_LICENSE_FILE,
  BUNDLED_REGISTRY_SOURCE_SHA256,
  BUNDLED_REGISTRY_SOURCE_URL,
  BUNDLED_REGISTRY_SOURCE_VERSION,
  CANONICAL_EFFORT_KEYS,
  OWNER_CHANNEL_ALIASES,
  REGISTRY_SNAPSHOT_FORMAT,
  createRegistryMetadataSnapshot,
  createRegistryMetadataSource,
  fetchRegistryDocument,
  loadBundledRegistryMetadataIndex,
  parseRegistryMetadataSnapshot,
  parseRegistryModelDocument,
  resolveRegistryModel,
  serializeRegistryMetadataSnapshot,
  type RegistryMetadataIndex,
  type RegistryModelLookup,
  type RegistryResolvedModel,
} from '../src/registry-metadata.ts'

const SOURCE_SHA256 = '1'.repeat(64)
const SOURCE = {
  sourceUrl: 'https://example.test/CLIProxyAPI/models.json',
  sourceVersion: 'v-test',
  sourceSha256: SOURCE_SHA256,
  fetchedAt: '2026-01-01T00:00:00.000Z',
}

/** One raw upstream `ModelInfo` record with fixture defaults. */
function raw(overrides: Record<string, unknown>): Record<string, unknown> {
  return { object: 'model', ...overrides }
}

/** A channel map exercising every conflict/edge the resolver must handle. */
function fixture(): Record<string, unknown[]> {
  const claudeSonnet = raw({
    id: 'claude-sonnet-4-6',
    owned_by: 'anthropic',
    display_name: 'Claude 4.6 Sonnet',
    context_length: 200000,
    max_completion_tokens: 64000,
    thinking: { min: 1024, max: 128000, zero_allowed: true, levels: ['low', 'medium', 'high', 'max'] },
    supportedInputModalities: ['text', 'image'],
    supportedOutputModalities: ['text'],
  })
  const geminiPro = raw({
    id: 'gemini-3-pro-preview',
    owned_by: 'google',
    display_name: 'Gemini 3 Pro Preview',
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
    thinking: { min: 128, max: 32768, dynamic_allowed: true, levels: ['low', 'high'] },
    supportedInputModalities: ['text', 'image', 'audio', 'video'],
    supportedOutputModalities: ['text'],
  })
  const codexTerra = (context: number) =>
    raw({
      id: 'gpt-5.6-terra',
      owned_by: 'openai',
      display_name: 'GPT 5.6 Terra',
      context_length: context,
      max_completion_tokens: 128000,
      thinking: { levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      supportedInputModalities: ['text', 'image'],
      supportedOutputModalities: ['text'],
    })

  return {
    claude: [
      claudeSonnet,
      raw({
        id: 'claude-opus-4-6',
        owned_by: 'anthropic',
        display_name: 'Claude 4.6 Opus',
        context_length: 1000000,
        max_completion_tokens: 128000,
        thinking: { min: 1024, max: 128000, zero_allowed: true, levels: ['low', 'medium', 'high', 'max'] },
        supportedInputModalities: ['text', 'image'],
        supportedOutputModalities: ['text'],
      }),
      raw({
        id: 'claude-3-5-haiku-20241022',
        owned_by: 'anthropic',
        display_name: 'Claude 3.5 Haiku',
        context_length: 128000,
        max_completion_tokens: 8192,
      }),
      raw({
        id: 'explicit-nonreasoning',
        owned_by: 'anthropic',
        display_name: 'Explicit Nonreasoning',
        context_length: 128000,
        max_completion_tokens: 8192,
        thinking: false,
      }),
      raw({
        id: 'claude-opus-4-7',
        owned_by: 'anthropic',
        display_name: 'Claude Opus 4.7',
        context_length: 1000000,
        max_completion_tokens: 128000,
        thinking: {
          zero_allowed: true,
          dynamic_allowed: true,
          levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      }),
    ],
    antigravity: [
      raw({
        id: 'claude-sonnet-4-6',
        owned_by: 'antigravity',
        display_name: 'Claude Sonnet 4.6 (Thinking)',
        context_length: 200000,
        max_completion_tokens: 64000,
        thinking: { min: 1024, max: 64000, zero_allowed: true, dynamic_allowed: true },
      }),
    ],
    gemini: [
      geminiPro,
      raw({
        id: 'gemini-3.1-pro-preview',
        owned_by: 'google',
        display_name: 'Gemini 3.1 Pro Preview',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        thinking: { min: 128, max: 32768, levels: ['low', 'medium', 'high'] },
      }),
      raw({
        id: 'gemini-2.5-pro',
        owned_by: 'google',
        display_name: 'Gemini 2.5 Pro',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        thinking: { min: 128, max: 32768, dynamic_allowed: true },
      }),
    ],
    'gemini-cli': [geminiPro],
    aistudio: [
      raw({
        id: 'gemini-3-pro-preview',
        owned_by: 'google',
        display_name: 'Gemini 3 Pro Preview',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        thinking: { min: 128, max: 32768, dynamic_allowed: true },
      }),
    ],
    'codex-free': [codexTerra(372000)],
    'codex-pro': [codexTerra(921000)],
    xai: [
      raw({
        id: 'grok-4.3',
        owned_by: 'xai',
        display_name: 'Grok 4.3',
        context_length: 1000000,
        max_completion_tokens: 65536,
        thinking: { zero_allowed: true, levels: ['none', 'low', 'medium', 'high'] },
      }),
    ],
    vertex: [
      raw({
        id: 'imagen-4.0-generate-001',
        owned_by: 'google',
        display_name: 'Imagen 4.0 Generate',
        supportedInputModalities: ['text'],
        supportedOutputModalities: ['image'],
      }),
    ],
  }
}

function fixtureIndex(): RegistryMetadataIndex {
  return parseRegistryModelDocument(fixture(), SOURCE)
}

function resolved(result: RegistryModelLookup): RegistryResolvedModel {
  if (result.status !== 'resolved') {
    throw new Error(`expected resolved, got ${JSON.stringify(result.diagnostics)}`)
  }
  return result.metadata
}

function unknown(result: RegistryModelLookup) {
  if (result.status !== 'unknown') throw new Error(`expected unknown, got ${JSON.stringify(result.metadata)}`)
  return result.diagnostics
}

describe('registry metadata exact resolution', () => {
  it('requires an exact owner or channel and refuses id-only lookup', () => {
    const index = fixtureIndex()
    expect(unknown(resolveRegistryModel(index, 'claude-sonnet-4-6'))[0]?.code).toBe('invalid-query')
    expect(unknown(resolveRegistryModel(index, 'does-not-exist'))[0]?.code).toBe('invalid-query')
    expect(unknown(resolveRegistryModel(index, 'does-not-exist', { owner: 'anthropic' }))[0]?.code).toBe(
      'not-found',
    )
    expect(unknown(resolveRegistryModel(index, 'claude-sonnet-4-6', { owner: 'google' }))[0]?.code).toBe(
      'not-found',
    )
  })

  it('resolves exact Claude ids without name prefixes or substring fallbacks', () => {
    const index = fixtureIndex()
    const sonnet = resolved(resolveRegistryModel(index, 'claude-sonnet-4-6', { owner: 'anthropic' }))
    expect(sonnet.channel).toBe('claude')
    expect(sonnet.channels).toEqual(['claude'])
    expect(sonnet.owner).toBe('anthropic')
    expect(sonnet.name).toBe('Claude 4.6 Sonnet')
    expect(sonnet.contextWindow).toBe(200000)
    expect(sonnet.maxInputTokens).toBeNull()
    expect(sonnet.maxTokens).toBe(64000)
    expect(sonnet.inputModalities).toEqual(['text', 'image'])
    expect(sonnet.outputModalities).toEqual(['text'])
    expect(sonnet.reasoning).toBe(true)
    expect(sonnet.effort?.levels).toEqual(['low', 'medium', 'high', 'max'])
    expect(sonnet.effort?.supportedKeys).toEqual(['off', 'low', 'medium', 'high', 'max'])
    expect(sonnet.effort?.unsupportedLevels).toEqual([])
    expect(sonnet.effort?.budget).toEqual({ min: 1024, max: 128000 })
    expect(sonnet.source.sourceVersion).toBe('v-test')
    expect(sonnet.source.sourceSha256).toBe(SOURCE_SHA256)

    const opus = resolved(resolveRegistryModel(index, 'claude-opus-4-6', { owner: 'anthropic' }))
    expect(opus.contextWindow).toBe(1000000)
    expect(opus.maxTokens).toBe(128000)

    expect(unknown(resolveRegistryModel(index, 'claude-sonnet-4', { owner: 'anthropic' }))[0]?.code).toBe('not-found')
    expect(unknown(resolveRegistryModel(index, 'sonnet-4-6', { owner: 'anthropic' }))[0]?.code).toBe('not-found')
  })

  it('marks omitted thinking as unknown, not false, and keeps explicit false distinct', () => {
    const index = fixtureIndex()
    const haiku = resolved(resolveRegistryModel(index, 'claude-3-5-haiku-20241022', { owner: 'anthropic' }))
    expect(haiku.reasoning).toBeNull()
    expect(haiku.effort).toBeNull()

    const explicit = resolved(resolveRegistryModel(index, 'explicit-nonreasoning', { owner: 'anthropic' }))
    expect(explicit.reasoning).toBe(false)
    expect(explicit.effort).toBeNull()

    const adaptive = resolved(resolveRegistryModel(index, 'claude-opus-4-7', { owner: 'anthropic' }))
    expect(adaptive.reasoning).toBe(true)
    expect(adaptive.effort?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(adaptive.effort?.supportedKeys).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(adaptive.effort?.dynamicAllowed).toBe(true)
    expect(adaptive.effort?.budget).toBeNull()

    // A numeric thinking budget never becomes named levels.
    const budgetOnly = resolved(resolveRegistryModel(index, 'gemini-2.5-pro', { channel: 'gemini' }))
    expect(budgetOnly.reasoning).toBe(true)
    expect(budgetOnly.effort?.levels).toBeNull()
    expect(budgetOnly.effort?.supportedKeys).toEqual([])
    expect(budgetOnly.effort?.budget).toEqual({ min: 128, max: 32768 })
  })

  it('resolves same-id records in different owner namespaces by owner or exact channel', () => {
    const index = fixtureIndex()
    const anthropic = resolved(resolveRegistryModel(index, 'claude-sonnet-4-6', { owner: 'anthropic' }))
    const antigravity = resolved(resolveRegistryModel(index, 'claude-sonnet-4-6', { owner: 'antigravity' }))
    expect(anthropic.channel).toBe('claude')
    expect(anthropic.name).toBe('Claude 4.6 Sonnet')
    expect(anthropic.effort?.supportedKeys).toContain('max')
    expect(antigravity.channel).toBe('antigravity')
    expect(antigravity.owner).toBe('antigravity')
    expect(antigravity.name).toBe('Claude Sonnet 4.6 (Thinking)')
    expect(antigravity.effort?.levels).toBeNull()
    expect(antigravity.effort?.dynamicAllowed).toBe(true)

    const byChannel = resolved(resolveRegistryModel(index, 'claude-sonnet-4-6', { channel: 'antigravity' }))
    expect(byChannel.channel).toBe('antigravity')

    const mismatch = unknown(resolveRegistryModel(index, 'claude-sonnet-4-6', { channel: 'claude', owner: 'antigravity' }))
    expect(mismatch[0]?.code).toBe('not-found')
  })

  it('returns an ambiguity diagnostic instead of picking the first conflicting channel', () => {
    const index = fixtureIndex()
    expect(OWNER_CHANNEL_ALIASES.openai).toEqual(['codex-free', 'codex-team', 'codex-plus', 'codex-pro'])

    const ambiguous = unknown(resolveRegistryModel(index, 'gpt-5.6-terra', { owner: 'openai' }))
    expect(ambiguous[0]?.code).toBe('ambiguous')
    expect(ambiguous[0]?.channels).toEqual(['codex-free', 'codex-pro'])

    const pro = resolved(resolveRegistryModel(index, 'gpt-5.6-terra', { channel: 'codex-pro' }))
    expect(pro.channel).toBe('codex-pro')
    expect(pro.contextWindow).toBe(921000)
    const free = resolved(resolveRegistryModel(index, 'gpt-5.6-terra', { channel: 'codex-free' }))
    expect(free.contextWindow).toBe(372000)

    const missingChannel = unknown(resolveRegistryModel(index, 'gpt-5.6-terra', { channel: 'codex-team' }))
    expect(missingChannel[0]?.code).toBe('not-found')
  })

  it('keeps Gemini level ladders exact and never treats an input cap as combined context', () => {
    const index = fixtureIndex()
    const gemini3 = resolved(resolveRegistryModel(index, 'gemini-3-pro-preview', { channel: 'gemini' }))
    expect(gemini3.effort?.levels).toEqual(['low', 'high'])
    expect(gemini3.effort?.supportedKeys).toEqual(['low', 'high'])
    expect(gemini3.contextWindow).toBeNull()
    expect(gemini3.maxInputTokens).toBe(1048576)
    expect(gemini3.maxTokens).toBe(65536)
    expect(gemini3.contextWindow).not.toBe(1048576 + 65536)

    const gemini31 = resolved(resolveRegistryModel(index, 'gemini-3.1-pro-preview', { channel: 'gemini' }))
    expect(gemini31.effort?.levels).toEqual(['low', 'medium', 'high'])
    expect(gemini31.effort?.supportedKeys).toEqual(['low', 'medium', 'high'])

    const ambiguousOwner = unknown(resolveRegistryModel(index, 'gemini-3-pro-preview', { owner: 'google' }))
    expect(ambiguousOwner[0]?.code).toBe('ambiguous')
    expect(ambiguousOwner[0]?.channels).toEqual(['gemini', 'gemini-cli', 'aistudio'])
  })

  it('reports unsupported raw effort names without remapping or inventing max/ultra', () => {
    const index = fixtureIndex()
    const grok = resolved(resolveRegistryModel(index, 'grok-4.3', { channel: 'xai' }))
    expect(grok.effort?.levels).toEqual(['none', 'low', 'medium', 'high'])
    expect(grok.effort?.unsupportedLevels).toEqual(['none'])
    expect(grok.effort?.supportedKeys).toEqual(['off', 'low', 'medium', 'high'])
    expect(grok.effort?.supportedKeys).not.toContain('none')
    expect(grok.effort?.supportedKeys).not.toContain('ultra')
    expect(CANONICAL_EFFORT_KEYS).not.toContain('ultra')
    expect(grok.effort?.zeroAllowed).toBe(true)
  })

  it('leaves image-generation builtins without a reasoning disclosure and unknown models without invented values', () => {
    const index = fixtureIndex()
    const imagen = resolved(resolveRegistryModel(index, 'imagen-4.0-generate-001', { channel: 'vertex' }))
    expect(imagen.reasoning).toBeNull()
    expect(imagen.effort).toBeNull()
    expect(imagen.contextWindow).toBeNull()
    expect(imagen.maxInputTokens).toBeNull()
    expect(imagen.maxTokens).toBeNull()
    expect(imagen.inputModalities).toEqual(['text'])
    expect(imagen.outputModalities).toEqual(['image'])

    const absent = resolveRegistryModel(index, 'gpt-image-1', { owner: 'openai' })
    expect(absent.status).toBe('unknown')
    expect('metadata' in absent).toBe(false)
    expect(unknown(absent)[0]?.code).toBe('not-found')
  })

  it('skips malformed channels/records with diagnostics and rejects non-object documents', () => {
    const index = parseRegistryModelDocument(
      {
        claude: [null, { id: '' }, raw({ id: 'valid-model', owned_by: 'anthropic' })],
        broken: 'not-an-array',
      },
      SOURCE,
    )
    expect(resolved(resolveRegistryModel(index, 'valid-model', { owner: 'anthropic' })).reasoning).toBeNull()
    expect(index.diagnostics.map((diagnostic) => diagnostic.code)).toContain('invalid-record')
    expect(index.diagnostics.map((diagnostic) => diagnostic.code)).toContain('invalid-channel')
    expect(() => parseRegistryModelDocument([], SOURCE)).toThrow(/must be an object/)
    expect(() => parseRegistryMetadataSnapshot({ format: 'wrong' })).toThrow(/unsupported format/)
    expect(() =>
      parseRegistryMetadataSnapshot({ format: REGISTRY_SNAPSHOT_FORMAT, formatVersion: 1 }),
    ).toThrow(/unsupported formatVersion/)
  })
})

describe('registry metadata snapshots', () => {
  it('keeps only allowlisted capability fields and never emits prompts, descriptions, or network policy', () => {
    const snapshot = createRegistryMetadataSnapshot(
      {
        claude: [
          raw({
            id: 'secret-model',
            owned_by: 'anthropic',
            display_name: 'Secret Model',
            description: 'SECRET_DESCRIPTION',
            base_instructions: 'SECRET_BASE_INSTRUCTIONS',
            system_prompt: 'SECRET_SYSTEM_PROMPT',
            instructions: 'SECRET_INSTRUCTIONS',
            network_instructions: 'SECRET_NETWORK_INSTRUCTIONS',
            base_url: 'https://SECRET_BASE_URL.test',
            native_capabilities: { web_search: true },
            config: { prompt: 'SECRET_CONFIG_PROMPT' },
            context_length: 200000,
            max_completion_tokens: 64000,
            thinking: { zero_allowed: true, levels: ['low', 'max'] },
          }),
        ],
      },
      {
        sourceUrl: 'https://example.test/raw/models.json',
        sourceVersion: 'v9.9.9',
        sourceSha256: '2'.repeat(64),
        fetchedAt: '2026-02-02T00:00:00.000Z',
      },
    )
    const serialized = serializeRegistryMetadataSnapshot(snapshot)
    for (const secret of [
      'SECRET_DESCRIPTION',
      'SECRET_BASE_INSTRUCTIONS',
      'SECRET_SYSTEM_PROMPT',
      'SECRET_INSTRUCTIONS',
      'SECRET_NETWORK_INSTRUCTIONS',
      'SECRET_BASE_URL',
      'SECRET_CONFIG_PROMPT',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).not.toContain('description')
    expect(serialized).not.toContain('instructions')
    expect(serialized).not.toContain('base_url')
    expect(Object.keys(snapshot.channels.claude![0]!).sort()).toEqual(
      [
        'contextWindow',
        'effort',
        'id',
        'inputModalities',
        'maxInputTokens',
        'maxTokens',
        'name',
        'outputModalities',
        'owner',
        'reasoning',
      ].sort(),
    )
    expect(snapshot.source).toMatchObject({
      sourceUrl: 'https://example.test/raw/models.json',
      sourceVersion: 'v9.9.9',
      sourceSha256: '2'.repeat(64),
      fetchedAt: '2026-02-02T00:00:00.000Z',
      license: 'MIT',
    })
    expect(snapshot.source.attribution).toContain('CLIProxyAPI')

    const index = parseRegistryMetadataSnapshot(JSON.parse(serialized))
    const model = resolved(resolveRegistryModel(index, 'secret-model', { owner: 'anthropic' }))
    expect(JSON.stringify(model)).not.toContain('SECRET')
    expect(model.name).toBe('Secret Model')
    expect(model.effort?.supportedKeys).toEqual(['off', 'low', 'max'])

    expect(() =>
      createRegistryMetadataSnapshot({}, {
        sourceUrl: 'https://example.test/raw/models.json',
        sourceVersion: 'v9.9.9',
        sourceSha256: 'not-a-hash',
      }),
    ).toThrow(/sourceSha256/)

    const sanitized = createRegistryMetadataSnapshot({}, {
      sourceUrl: 'https://example.test/raw/models.json?token=SECRET#fragment',
      sourceVersion: 'v9.9.9',
      sourceSha256: '3'.repeat(64),
    })
    expect(sanitized.source.sourceUrl).toBe('https://example.test/raw/models.json')
    expect(JSON.stringify(sanitized)).not.toContain('SECRET')

    expect(() =>
      createRegistryMetadataSnapshot({}, {
        sourceUrl: 'https://admin:secret@example.test/raw/models.json',
        sourceVersion: 'v9.9.9',
      }),
    ).toThrow(/credentials/)
  })

  it('validates derived snapshot fields and returns the sanitized projection, not raw fields', () => {
    const snapshot = createRegistryMetadataSnapshot(
      {
        claude: [
          raw({
            id: 'model-a',
            owned_by: 'anthropic',
            display_name: 'Model A',
            context_length: 200000,
            max_completion_tokens: 64000,
            thinking: { zero_allowed: true, levels: ['low', 'high'] },
          }),
        ],
      },
      SOURCE,
    )
    const tampered = JSON.parse(serializeRegistryMetadataSnapshot(snapshot)) as Record<string, any>
    tampered.channels.claude[0].effort.supportedKeys = ['ultra']
    tampered.channels.claude[0].effort.unsupportedLevels = ['ultra']
    tampered.channels.claude[0].description = 'SECRET_TAMPERED_DESCRIPTION'

    const index = parseRegistryMetadataSnapshot(tampered)
    const model = resolved(resolveRegistryModel(index, 'model-a', { owner: 'anthropic' }))
    expect(model.effort?.supportedKeys).toEqual(['off', 'low', 'high'])
    expect(model.effort?.unsupportedLevels).toEqual([])
    expect(JSON.stringify(model)).not.toContain('SECRET_TAMPERED_DESCRIPTION')
    expect(index.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-record')).toBe(true)
  })

  it('replaces removed registry metadata instead of retaining it silently', () => {
    const oldSnapshot = createRegistryMetadataSnapshot(
      {
        claude: [
          raw({
            id: 'model-a',
            owned_by: 'anthropic',
            display_name: 'Model A',
            context_length: 200000,
            max_completion_tokens: 64000,
            thinking: { zero_allowed: true, levels: ['low', 'high'] },
          }),
          raw({ id: 'model-b', owned_by: 'anthropic', display_name: 'Model B' }),
        ],
        gemini: [raw({ id: 'model-c', owned_by: 'google', display_name: 'Model C' })],
      },
      { sourceUrl: 'https://example.test/old.json', sourceVersion: 'v-old' },
    )
    const oldIndex = parseRegistryMetadataSnapshot(oldSnapshot)
    expect(resolved(resolveRegistryModel(oldIndex, 'model-a', { owner: 'anthropic' })).effort?.levels).toEqual([
      'low',
      'high',
    ])
    expect(oldIndex.channels.has('gemini')).toBe(true)

    const newSnapshot = createRegistryMetadataSnapshot(
      { claude: [raw({ id: 'model-a', owned_by: 'anthropic', display_name: 'Model A' })] },
      { sourceUrl: 'https://example.test/new.json', sourceVersion: 'v-new' },
    )
    const newIndex = parseRegistryMetadataSnapshot(newSnapshot)
    const modelA = resolved(resolveRegistryModel(newIndex, 'model-a', { owner: 'anthropic' }))
    expect(modelA.reasoning).toBeNull()
    expect(modelA.effort).toBeNull()
    expect(modelA.contextWindow).toBeNull()
    expect(newIndex.channels.has('gemini')).toBe(false)
    expect(unknown(resolveRegistryModel(newIndex, 'model-b', { owner: 'anthropic' }))[0]?.code).toBe('not-found')
    expect(newIndex.source.sourceVersion).toBe('v-new')
  })

  it('ships the pinned v8.0.54 baseline with hash, license, and unknown-thinking records', () => {
    const index = loadBundledRegistryMetadataIndex()
    expect(index.source.sourceUrl).toBe(BUNDLED_REGISTRY_SOURCE_URL)
    expect(index.source.sourceUrl).toContain('/v8.0.54/')
    expect(index.source.sourceVersion).toBe(BUNDLED_REGISTRY_SOURCE_VERSION)
    expect(index.source.sourceSha256).toBe(BUNDLED_REGISTRY_SOURCE_SHA256)
    expect(index.source.license).toBe(BUNDLED_REGISTRY_LICENSE)
    expect(index.source.fetchedAt).toBeTruthy()

    const sonnet = resolved(resolveRegistryModel(index, 'claude-sonnet-4-6', { owner: 'anthropic' }))
    expect(sonnet.contextWindow).toBe(200000)
    expect(sonnet.maxTokens).toBe(64000)
    const opus = resolved(resolveRegistryModel(index, 'claude-opus-4-6', { owner: 'anthropic' }))
    expect(opus.contextWindow).toBe(1000000)

    const gemini = resolved(resolveRegistryModel(index, 'gemini-3-pro-preview', { channel: 'gemini' }))
    expect(gemini.effort?.levels).toEqual(['low', 'high'])
    expect(gemini.contextWindow).toBeNull()
    expect(gemini.maxInputTokens).toBe(1048576)

    const imagen = resolved(resolveRegistryModel(index, 'imagen-4.0-generate-001', { channel: 'vertex' }))
    expect(imagen.reasoning).toBeNull()
    expect(imagen.effort).toBeNull()

    // The upstream file omits thinking for this reasoning-capable id. That is
    // UNKNOWN, not an explicit false.
    const grok = resolved(resolveRegistryModel(index, 'grok-4.20-0309-reasoning', { channel: 'xai' }))
    expect(grok.reasoning).toBeNull()
    expect(grok.effort).toBeNull()
  })

  it('ships the exact upstream MIT license text with attribution', () => {
    const license = readFileSync(
      fileURLToPath(new URL(`../${BUNDLED_REGISTRY_LICENSE_FILE}`, import.meta.url)),
      'utf8',
    )
    expect(license).toContain('MIT License')
    expect(license).toContain('Copyright (c) 2025-2005.9 Luis Pater')
    expect(license).toContain('Copyright (c) 2025.9-present Router-For.ME')
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
    expect(license.endsWith('SOFTWARE.\n')).toBe(true)
    expect(license.endsWith('\n\n')).toBe(false)
  })

  it('pins the expected raw-source hash in the generator before writing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-cpa-metadata-'))
    try {
      const input = join(directory, 'models.json')
      const output = join(directory, 'snapshot.json')
      writeFileSync(input, JSON.stringify({ claude: [] }))
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../scripts/update-cliproxyapi-metadata.mjs', import.meta.url)),
          '--input',
          input,
          '--version',
          BUNDLED_REGISTRY_SOURCE_VERSION,
          '--output',
          output,
          '--fetched-at',
          '2026-01-01T00:00:00.000Z',
        ],
        { encoding: 'utf8' },
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('source hash mismatch')
      expect(existsSync(output)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('bounded metadata-only fetch', () => {
  const fakeFetch = (
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch

  it('fetches, parses, and hashes a bounded raw document', async () => {
    const body = JSON.stringify({ claude: [] })
    const result = await fetchRegistryDocument({
      url: 'https://example.test/models.json',
      fetchImpl: fakeFetch(() => new Response(body, { status: 200 })),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.diagnostic.message)
    expect(result.document).toEqual({ claude: [] })
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.sha256).toBe(createHash('sha256').update(body).digest('hex'))
  })

  it('refuses oversized bodies and non-http protocols without echoing the raw URL', async () => {
    const oversized = await fetchRegistryDocument({
      url: 'https://example.test/models.json',
      maxBytes: 16,
      fetchImpl: fakeFetch(
        () =>
          new Response('x'.repeat(64), {
            status: 200,
            headers: { 'content-length': '64' },
          }),
      ),
    })
    expect(oversized.ok).toBe(false)
    if (oversized.ok) throw new Error('expected an oversized failure')
    expect(oversized.diagnostic.code).toBe('response-too-large')
    expect(oversized.bytes).toBe(64)

    const file = await fetchRegistryDocument({
      url: 'file:///etc/passwd?token=SECRET#fragment',
      fetchImpl: fakeFetch(() => new Response('{}')),
    })
    expect(file.ok).toBe(false)
    expect(JSON.stringify(file)).not.toContain('SECRET')
    expect(JSON.stringify(file)).not.toContain('/etc/passwd')
  })

  it('does not leak credentials or raw URLs from invalid input and caught errors', async () => {
    let called = false
    const credentialed = await fetchRegistryDocument({
      url: 'https://admin:secret@example.test/models.json?token=SECRET#fragment',
      fetchImpl: fakeFetch(() => {
        called = true
        return new Response('{}')
      }),
    })
    expect(credentialed.ok).toBe(false)
    expect(called).toBe(false)
    expect(credentialed.url).toBe('')
    expect(JSON.stringify(credentialed)).not.toContain('admin')
    expect(JSON.stringify(credentialed)).not.toContain('secret')
    expect(JSON.stringify(credentialed)).not.toContain('token')
    expect(JSON.stringify(credentialed)).not.toContain('fragment')

    const invalid = await fetchRegistryDocument({
      url: 'not a url admin:secret@example.test?token=SECRET',
      fetchImpl: fakeFetch(() => new Response('{}')),
    })
    expect(invalid.ok).toBe(false)
    expect(invalid.url).toBe('')
    expect(JSON.stringify(invalid)).not.toContain('secret')

    const caught = await fetchRegistryDocument({
      url: 'https://example.test/models.json?token=SECRET#fragment',
      fetchImpl: fakeFetch(() => {
        throw new Error('boom https://admin:secret@example.test/path?token=SECRET#fragment')
      }),
    })
    expect(caught.ok).toBe(false)
    expect(caught.url).toBe('https://example.test/models.json')
    expect(JSON.stringify(caught)).not.toContain('secret')
    expect(JSON.stringify(caught)).not.toContain('token')
    expect(JSON.stringify(caught)).not.toContain('fragment')
  })

  it('allows loopback http but rejects non-loopback http', async () => {
    const local = await fetchRegistryDocument({
      url: 'http://127.0.0.1:8080/models.json',
      fetchImpl: fakeFetch(() => new Response('{"claude":[]}', { status: 200 })),
    })
    expect(local.ok).toBe(true)

    const remote = await fetchRegistryDocument({
      url: 'http://example.test/models.json',
      fetchImpl: fakeFetch(() => new Response('{"claude":[]}', { status: 200 })),
    })
    expect(remote.ok).toBe(false)
    expect(remote.url).toBe('')
  })

  it('validates every redirect hop and rejects credentials or HTTPS downgrades', async () => {
    const credentialRedirect = await fetchRegistryDocument({
      url: 'https://example.test/start.json',
      fetchImpl: fakeFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://admin:secret@other.test/models.json?token=SECRET#fragment' },
          }),
      ),
    })
    expect(credentialRedirect.ok).toBe(false)
    expect(credentialRedirect.url).toBe('https://example.test/start.json')
    expect(JSON.stringify(credentialRedirect)).not.toContain('secret')
    expect(JSON.stringify(credentialRedirect)).not.toContain('token')

    const downgrade = await fetchRegistryDocument({
      url: 'https://example.test/start.json',
      fetchImpl: fakeFetch(
        () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/models.json' } }),
      ),
    })
    expect(downgrade.ok).toBe(false)
    if (downgrade.ok) throw new Error('expected a downgrade failure')
    expect(downgrade.diagnostic.message).toMatch(/HTTPS to HTTP/)

    const relative = await fetchRegistryDocument({
      url: 'https://example.test/start.json',
      fetchImpl: (() => {
        let call = 0
        return fakeFetch(() => {
          call += 1
          return call === 1
            ? new Response(null, { status: 302, headers: { location: '/next.json' } })
            : new Response('{"claude":[]}', { status: 200 })
        })
      })(),
    })
    expect(relative.ok).toBe(true)
    if (!relative.ok) throw new Error(relative.diagnostic.message)
    expect(relative.url).toBe('https://example.test/next.json')
  })

  it('bounds redirect loops and cancels redirect/error bodies', async () => {
    let calls = 0
    const loop = await fetchRegistryDocument({
      url: 'https://example.test/loop.json',
      fetchImpl: fakeFetch(() => {
        calls += 1
        return new Response(null, { status: 302, headers: { location: 'https://example.test/loop.json' } })
      }),
    })
    expect(loop.ok).toBe(false)
    if (loop.ok) throw new Error('expected a redirect failure')
    expect(loop.diagnostic.message).toMatch(/redirect limit/)
    expect(calls).toBe(6)

    let redirectCanceled = false
    let errorCanceled = false
    const redirectBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('redirect body'))
      },
      cancel() {
        redirectCanceled = true
      },
    })
    const errorBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('error body'))
      },
      cancel() {
        errorCanceled = true
      },
    })
    let call = 0
    const result = await fetchRegistryDocument({
      url: 'https://example.test/start.json',
      fetchImpl: fakeFetch(() => {
        call += 1
        if (call === 1) return new Response(redirectBody, { status: 302, headers: { location: '/next.json' } })
        return new Response('{"claude":[]}', { status: 200 })
      }),
    })
    expect(result.ok).toBe(true)
    expect(redirectCanceled).toBe(true)

    const failed = await fetchRegistryDocument({
      url: 'https://example.test/error.json',
      fetchImpl: fakeFetch(() => new Response(errorBody, { status: 503 })),
    })
    expect(failed.ok).toBe(false)
    expect(errorCanceled).toBe(true)
  })

  it('returns the last-good snapshot with a stale diagnostic after a failed refresh', async () => {
    let calls = 0
    const source = createRegistryMetadataSource({
      url: 'https://example.test/models.json',
      sourceVersion: 'v-live',
      fetchImpl: fakeFetch(() => {
        calls += 1
        return calls === 1
          ? new Response(JSON.stringify(fixture()), { status: 200 })
          : new Response('upstream down', { status: 503 })
      }),
      now: () => new Date('2026-03-03T00:00:00.000Z'),
    })

    expect(source.current()).toBeNull()
    const first = await source.refresh()
    expect(first.stale).toBe(false)
    expect(first.snapshot).not.toBeNull()
    expect(first.snapshot?.source.fetchedAt).toBe('2026-03-03T00:00:00.000Z')
    expect(first.snapshot?.source.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(first.index).not.toBeNull()
    expect(source.current()?.stale).toBe(false)

    const second = await source.refresh()
    expect(second.stale).toBe(true)
    expect(second.snapshot).toBe(first.snapshot)
    expect(second.index).toBe(first.index)
    expect(second.diagnostics[0]?.code).toBe('stale-last-good')
    expect(second.diagnostics.some((diagnostic) => diagnostic.code === 'fetch-failed')).toBe(true)
    expect(source.current()?.snapshot).toBe(first.snapshot)
    expect(source.current()?.stale).toBe(true)
  })
})
