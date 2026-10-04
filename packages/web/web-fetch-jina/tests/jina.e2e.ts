import { describe, expect, it } from 'vitest'
import { JINA_DEFAULT_BASE_URL, JinaFetchProvider } from '@deepseek-ai/dsh-web-fetch-jina'

/**
 * Real-API smoke for the Jina Reader fetch provider. Self-skips without
 * `$JINA_API_KEY` (CI has no secrets), per the with-key e2e policy in
 * docs/testing.md; the unit suite covers the keyless request path.
 */
const apiKey = process.env.JINA_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('JinaFetchProvider real API', () => {
  it('returns the converted page for a live target', async () => {
    const provider = new JinaFetchProvider(() => ({
      apiKey: apiKey!,
      baseURL: process.env.JINA_BASE_URL ?? JINA_DEFAULT_BASE_URL,
    }))
    const result = await provider.fetch({ url: 'https://example.com' })
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    expect(result.body.content.length).toBeGreaterThan(0)
  }, 30_000)
})
