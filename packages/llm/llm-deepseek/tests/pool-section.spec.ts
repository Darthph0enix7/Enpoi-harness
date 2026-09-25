/** The `llm-deepseek` settings entry accepts the profile's volatile pool section. */
import { isVolatile } from '@deepseek-ai/cosmokit'
import { expect, it } from 'vitest'
import { Config as ApiKeyConfig, plainOptions as apiKeyOptions, resolveAdapterOptions as apiKeyResolve } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { Config as ProtocolConfig } from '../src/index.ts'

/** The exact section shape the serverlocal profile stores under `llm-deepseek:`. */
const section = {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  maxTokens: 256_000,
  defaultContextWindow: 1_000_000,
  models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000, inputModalities: ['text'] as ('text' | 'image')[] }],
  pool: {
    strategy: 'priority-sticky' as const,
    identities: [
      { id: 'primary', credentialRef: 'DEEPSEEK_API_KEY', priority: 1, enabled: true },
    ],
  },
}

it('parses the profile pool section as a volatile field on the api-key entry', () => {
  const config = ApiKeyConfig(section)
  expect(isVolatile(config.pool)).toBe(true)
  expect(apiKeyOptions(config).pool).toEqual({
    strategy: 'priority-sticky',
    identities: [{ id: 'primary', credentialRef: 'DEEPSEEK_API_KEY', priority: 1, enabled: true }],
  })
})

it('parses the pool section on the account protocol config', () => {
  const config = ProtocolConfig(section)
  expect(config.pool).toBeDefined()
})

it('resolves protocol options with the pool section present', () => {
  expect(apiKeyResolve(apiKeyOptions(ApiKeyConfig(section)))).toMatchObject({
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  })
})
