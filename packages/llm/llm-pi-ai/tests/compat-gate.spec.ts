/**
 * The compat vocabulary other packages validate against: `offeredCompatFields`
 * is what the heavy-provider manifest table reads instead of restating pi-ai's
 * field names, so the drift gate must expose the same answer `catalog.ts`
 * uses internally.
 */
import { expect, it } from 'vitest'
import { allOfferedCompatFields, compatProtocols, declaredCompatField, offeredCompatFields } from '../src/compat.ts'

it('offers the configurable fields of one protocol, keyed by its compat type', () => {
  const anthropic = offeredCompatFields('anthropic-messages')
  expect(anthropic).toContain('forceAdaptiveThinking')
  expect(anthropic).toContain('supportsTemperature')
  // A field pi-ai's installed catalog decides for the vendors that need it is
  // withheld: it is declared upstream but never configurable.
  expect(anthropic).not.toContain('allowedFallbackModels')
  expect(declaredCompatField('allowedFallbackModels')).toBe(true)
  // The three Responses protocols share one compat type.
  expect(offeredCompatFields('azure-openai-responses')).toEqual(offeredCompatFields('openai-responses'))
  // A protocol pi-ai gives no compat type takes no switches at all.
  expect(offeredCompatFields('commandcode/alpha-generate')).toEqual([])
  expect(declaredCompatField('notACompatField')).toBe(false)
})

it('answers which protocols take one field', () => {
  expect(compatProtocols('forceAdaptiveThinking')).toEqual(['anthropic-messages'])
  expect(compatProtocols('supportsStrictMode')).toEqual([
    'openai-completions',
    'openai-responses',
    'azure-openai-responses',
    'openai-codex-responses',
    'bedrock-converse-stream',
  ])
  expect(compatProtocols('notACompatField')).toEqual([])
})

it('lists every offered field once, across every protocol', () => {
  const all = allOfferedCompatFields()
  expect(new Set(all).size).toBe(all.length)
  expect(all).toContain('forceAdaptiveThinking')
  expect(all).toContain('supportsStore')
  expect(all).not.toContain('allowedFallbackModels')
})
