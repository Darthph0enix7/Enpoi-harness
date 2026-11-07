/**
 * Model catalog projection of effective native-file input kinds: only the
 * exact model that declared a descriptor gains the kind; an advertised-only
 * modality stays advertised.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmNativeFileInputs,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { buildModelCatalog } from '../src/catalog.ts'

const NATIVE_INPUTS: LlmNativeFileInputs = {
  version: 1,
  encoders: { 'application/pdf': 'anthropic-document' },
  perFileBytes: 1_000,
  totalBytes: 2_000,
  maxPayloadBytes: 4_000,
  tokenReserve: { perFile: 10, perByte: 0.5 },
}

class CatalogAdapter extends LlmAdapter {
  constructor(private readonly models: readonly LlmModelInfo[]) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Native Catalog' }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
      advertisedInputModalities: ['text', 'image', 'pdf'],
      ...model === 'native-pdf' ? { nativeFileInputs: NATIVE_INPUTS } : {},
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The catalog projection never streams.
  }
}

async function catalogOf() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['native-gw'], new CatalogAdapter([
    { provider: 'native-gw', id: 'native-pdf', name: 'Native PDF' },
    { provider: 'native-gw', id: 'plain', name: 'Plain' },
  ]))
  const catalog = await buildModelCatalog(ctx, { provider: 'native-gw', model: 'native-pdf' })
  await ctx.fiber.dispose()
  return catalog.groups.find(group => group.id === 'native-gw')?.models ?? []
}

describe('model catalog native-file projection', () => {
  it('adds the admitted native kind to the exact opted-in model only', async () => {
    const models = await catalogOf()
    expect(models[0]).toMatchObject({
      id: 'native-pdf',
      inputModalities: ['text', 'image', 'pdf'],
      advertisedInputModalities: ['text', 'image', 'pdf'],
    })
  })

  it('keeps an advertised-only modality advertised on a model without a descriptor', async () => {
    const models = await catalogOf()
    expect(models[1]).toMatchObject({
      id: 'plain',
      inputModalities: ['text', 'image'],
      advertisedInputModalities: ['text', 'image', 'pdf'],
    })
  })
})

describe('model catalog unverified projection', () => {
  it('marks only the rows whose settings record carries the unverified marker', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['sync-gw'], new CatalogAdapter([
      { provider: 'sync-gw', id: 'hinted', name: 'Hinted' },
      { provider: 'sync-gw', id: 'verified', name: 'Verified' },
    ]))
    ctx.llm.registerConfigurableProviders([{
      provider: 'sync-gw',
      displayName: 'Sync Gateway',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'sync-gw'],
    }])
    // Provider-sync writes `unverified: true` onto a row whose capacities or
    // capabilities rest on labeled hints or on no disclosure at all.
    ctx.provide('settings', {
      describe: () => [{
        ns: 'llm-pi-ai',
        value: {
          providers: {
            'sync-gw': {
              models: [
                { id: 'hinted', unverified: true },
                { id: 'verified' },
                // A marker for a model the route no longer advertises must
                // not leak onto another row.
                { id: 'retired', unverified: true },
              ],
            },
          },
        },
      }],
    } as never)

    const catalog = await buildModelCatalog(ctx, { provider: 'sync-gw', model: 'hinted' })
    await ctx.fiber.dispose()
    const models = catalog.groups.find(group => group.id === 'sync-gw')?.models ?? []
    expect(models[0]).toMatchObject({ id: 'hinted', unverified: true })
    expect(models[1]?.unverified).toBeUndefined()
  })

  it('leaves every row verified when no settings service is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['plain-gw'], new CatalogAdapter([
      { provider: 'plain-gw', id: 'plain', name: 'Plain' },
    ]))
    const catalog = await buildModelCatalog(ctx, { provider: 'plain-gw', model: 'plain' })
    await ctx.fiber.dispose()
    expect(catalog.groups[0]?.models[0]?.unverified).toBeUndefined()
  })
})
