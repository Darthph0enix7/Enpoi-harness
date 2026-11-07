/** The shared reasoning-ladder adoption both Add and Refresh persist. */
import { describe, expect, it } from 'vitest'
import {
  normalizeReasoningEfforts, withAdoptedReasoningEfforts,
} from '../src/client/reasoning-efforts.ts'

/** The pi-ai settings schema as this boundary consumes it. */
type HostConfigSchema = (input: unknown) => { providers: { get(): unknown } }

/**
 * Load the real host settings schema for the acceptance assertion. The
 * specifier is built at runtime so the client typecheck program does not
 * follow the import into the Host adapter's project (the browser package has
 * no dependency on it); the schema remains the authority at test runtime.
 */
async function hostConfigSchema(): Promise<HostConfigSchema> {
  const specifier = ['@deepseek-ai', 'dsh-llm-pi-ai'].join('/')
  const module = await import(/* @vite-ignore */ specifier) as { Config: HostConfigSchema }
  return module.Config
}

describe('normalizeReasoningEfforts', () => {
  it('leaves an undisclosed ladder unstated', () => {
    expect(normalizeReasoningEfforts(undefined)).toEqual({ declared: false })
  })

  it('preserves an explicit false as an answer', () => {
    expect(normalizeReasoningEfforts(false)).toEqual({ declared: true, value: false })
  })

  it('omits an explicit empty ladder without turning it into reasoning:false', () => {
    expect(normalizeReasoningEfforts({})).toEqual({ declared: true })
  })

  it('preserves a populated ladder and normalizes the off meaning', () => {
    expect(normalizeReasoningEfforts({ low: 'low', high: 'high', off: '' }))
      .toEqual({ declared: true, value: { off: null, low: 'low', high: 'high' } })
    // A gateway that spells its own "off" wire value keeps it verbatim.
    expect(normalizeReasoningEfforts({ off: 'none', high: 'high' }))
      .toEqual({ declared: true, value: { off: 'none', high: 'high' } })
  })

  it('drops unusable levels and an off-only ladder the schema cannot serve', () => {
    expect(normalizeReasoningEfforts({ high: '', medium: 42 })).toEqual({ declared: true })
    expect(normalizeReasoningEfforts({ off: null })).toEqual({ declared: true })
    expect(normalizeReasoningEfforts({ ultra: 'ultra' })).toEqual({ declared: true })
    // A non-string `off` value is not a wire spelling and contributes nothing.
    expect(normalizeReasoningEfforts({ off: 42, high: 'high' }))
      .toEqual({ declared: true, value: { high: 'high' } })
  })

  it('treats a non-dictionary disclosure as stated but unusable', () => {
    expect(normalizeReasoningEfforts(null)).toEqual({ declared: true })
    expect(normalizeReasoningEfforts(true)).toEqual({ declared: true })
    expect(normalizeReasoningEfforts(['high'])).toEqual({ declared: true })
  })
})

describe('withAdoptedReasoningEfforts', () => {
  it('leaves an absent ladder untouched', () => {
    const row = { id: 'm', reasoningEfforts: undefined }
    expect(withAdoptedReasoningEfforts(row)).toBe(row)
  })

  it('clears a stale ladder the source explicitly retracted', () => {
    const row = withAdoptedReasoningEfforts({ id: 'm', reasoningEfforts: { high: 'high' } })
    // Same as the empty answer: `{}` is a retraction, not an absence.
    const retracted = withAdoptedReasoningEfforts({ ...row, reasoningEfforts: {} })
    expect(Object.hasOwn(retracted, 'reasoningEfforts')).toBe(false)
  })

  it('replaces a ladder and preserves false', () => {
    expect(withAdoptedReasoningEfforts({ id: 'm', reasoningEfforts: { high: 'high' } }))
      .toEqual({ id: 'm', reasoningEfforts: { high: 'high' } })
    expect(withAdoptedReasoningEfforts({ id: 'm', reasoningEfforts: { off: '' } }))
      .toEqual({ id: 'm' })
    expect(withAdoptedReasoningEfforts({ id: 'm', reasoningEfforts: false }))
      .toEqual({ id: 'm', reasoningEfforts: false })
  })
})

describe('llm-pi-ai config schema boundary', () => {
  /** Materialize one route of adopted model rows through the real settings schema. */
  async function materialize(models: Array<Record<string, unknown>>): Promise<unknown> {
    const Config = await hostConfigSchema()
    return Config({
      providers: {
        gateway: {
          api: 'openai-completions',
          baseURL: 'https://gateway.test/v1',
          models,
        },
      },
    }).providers.get()
  }

  it('accepts every persisted adoption shape and keeps false distinguishable from absence', async () => {
    const materialized = await materialize([
      withAdoptedReasoningEfforts({ id: 'empty', reasoning: true, reasoningEfforts: {} }),
      withAdoptedReasoningEfforts({ id: 'off-only', reasoning: true, reasoningEfforts: { off: '' } }),
      withAdoptedReasoningEfforts({ id: 'plain', reasoning: false, reasoningEfforts: false }),
      withAdoptedReasoningEfforts({ id: 'ladder', reasoning: true, reasoningEfforts: { low: 'low', high: 'high', off: '' } }),
      withAdoptedReasoningEfforts({ id: 'off-wire', reasoning: true, reasoningEfforts: { off: 'none', high: 'high' } }),
    ]) as Record<string, { models?: Array<Record<string, unknown>> }>
    const models = materialized['gateway']?.models ?? []
    expect(models).toHaveLength(5)
    // The schema materializes an omitted dict as `undefined`, not `{}`; the
    // empty and off-only ladders never reach it as a dictionary.
    expect(models[0]?.reasoningEfforts).toBeUndefined()
    expect(models[1]?.reasoningEfforts).toBeUndefined()
    expect(models[2]?.reasoningEfforts).toBe(false)
    expect(models[3]?.reasoningEfforts).toEqual({ off: null, low: 'low', high: 'high' })
    // A gateway's own non-empty "off" wire spelling is accepted verbatim.
    expect(models[4]?.reasoningEfforts).toEqual({ off: 'none', high: 'high' })
    // The disclosed reasoning flag rides beside the omitted ladder.
    expect(models[0]?.reasoning).toBe(true)
    expect(models[1]?.reasoning).toBe(true)
  })
})
