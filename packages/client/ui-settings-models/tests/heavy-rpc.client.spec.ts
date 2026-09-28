/**
 * The wire boundary for `enpoiHeavy.manifests`: the host payload is
 * structurally validated before it can replace the labelled local table, so a
 * malformed host entry renders the labelled local copy instead of being
 * trusted.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { fallbackHeavyManifest } from '../src/client/heavy-providers.ts'
import { heavyApi, sanitizeHeavyManifests } from '../src/client/heavy-rpc.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('accepts complete entries and the platform', () => {
  const host = { ...fallbackHeavyManifest('commandcode')!, summary: 'HOST TRUTH' }
  const table = sanitizeHeavyManifests({ items: [host], problems: ['host note'], platform: 'linux' })
  expect(table.items).toHaveLength(1)
  expect(table.items[0]?.summary).toBe('HOST TRUTH')
  expect(table.problems).toEqual(['host note'])
  expect(table.platform).toBe('linux')
})

it('replaces a malformed known entry with the labelled local copy and names it', () => {
  const malformed = { ...fallbackHeavyManifest('freellmapi')!, label: '' }
  const table = sanitizeHeavyManifests({ items: [malformed], problems: [] })
  expect(table.items[0]).toEqual(fallbackHeavyManifest('freellmapi'))
  expect(table.items[0]?.label).toBe('FreeLLMAPI')
  expect(table.problems.join('\n')).toContain('manifest "freellmapi": host copy rejected')
  expect(table.problems.join('\n')).toContain('using the labelled local copy')
})

it('drops a malformed entry with no local copy', () => {
  const table = sanitizeHeavyManifests({ items: [{ id: 'mystery', label: 'M' }], problems: [] })
  expect(table.items).toEqual([])
  expect(table.problems.join('\n')).toContain('manifest "mystery": host copy rejected')
  expect(table.problems.join('\n')).toContain('dropped')
})

it('a non-object payload falls back to the whole labelled local copy', () => {
  const table = sanitizeHeavyManifests('not a table')
  expect(table.items).toEqual([fallbackHeavyManifest('freellmapi'), fallbackHeavyManifest('antigravity'), fallbackHeavyManifest('commandcode')])
  expect(table.problems.join('\n')).toContain('rendering the labelled local copy')
})

it('heavyApi.manifests validates the gateway reply end to end', async () => {
  const host = { ...fallbackHeavyManifest('commandcode')!, summary: 'FROM GATEWAY' }
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      result: {
        ok: true,
        value: { items: [host, { id: 'freellmapi', label: '' }], problems: [], platform: 'linux' },
      },
    }),
  } as unknown as Response)))
  const result = await heavyApi.manifests()
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.items[0]?.summary).toBe('FROM GATEWAY')
  expect(result.value.items[1]).toEqual(fallbackHeavyManifest('freellmapi'))
  expect(result.value.problems.join('\n')).toContain('manifest "freellmapi": host copy rejected')
  console.info(`[heavy-wire] accepted gateway table, rejected entry: ${result.value.problems.join(' | ')}`)
})
