import { describe, expect, it } from 'vitest'
import { SearxngSearchProvider } from '@deepseek-ai/dsh-web-search-searxng'

/**
 * Real-instance smoke for the SearXNG search provider. Self-skips without
 * `$SEARXNG_BASE_URL` (CI has no instance), per the with-key e2e policy in
 * docs/testing.md; keyless instances need no credential.
 */
const baseURL = process.env.SEARXNG_BASE_URL
const maybe = baseURL !== undefined && baseURL.length > 0 ? describe : describe.skip

maybe('SearxngSearchProvider real instance', () => {
  it('returns sources for a live query', async () => {
    const provider = new SearxngSearchProvider(() => ({ baseURL: baseURL! }))
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 30_000)
})
