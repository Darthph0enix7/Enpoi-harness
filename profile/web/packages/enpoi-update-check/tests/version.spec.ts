import { describe, expect, it } from 'vitest'

import { catalogUrl, compareVersions } from '../src/catalog.js'

describe('compareVersions', () => {
  it('returns 0 for identical versions, with or without the leading v', () => {
    expect(compareVersions('0.1.7-enpoi.2.81', '0.1.7-enpoi.2.81')).toBe(0)
    expect(compareVersions('v0.1.7-enpoi.2.81', '0.1.7-enpoi.2.81')).toBe(0)
  })

  it('orders the trailing counter numerically, not lexically', () => {
    expect(compareVersions('0.1.7-enpoi.2.81', '0.1.7-enpoi.2.84')).toBe(-1)
    expect(compareVersions('0.1.7-enpoi.2.84', '0.1.7-enpoi.2.81')).toBe(1)
    expect(compareVersions('0.1.7-enpoi.2.9', '0.1.7-enpoi.2.10')).toBe(-1)
    expect(compareVersions('0.1.7-enpoi.2.10', '0.1.7-enpoi.2.9')).toBe(1)
  })

  it('treats a missing trailing segment as older', () => {
    expect(compareVersions('0.1.7-enpoi.2', '0.1.7-enpoi.2.81')).toBe(-1)
    expect(compareVersions('0.1.7-enpoi.2.81', '0.1.7-enpoi.2')).toBe(1)
  })

  it('orders the upstream base before the trailing counter', () => {
    expect(compareVersions('0.1.7-enpoi.2.99', '0.1.8-enpoi.2.1')).toBe(-1)
    expect(compareVersions('0.1.8-enpoi.2.1', '0.1.7-enpoi.2.99')).toBe(1)
  })

  it('returns null for malformed or incomparable inputs', () => {
    for (const malformed of ['', '   ', 'banana', 'v', '!!!', '0.1.7 enpoi.2.1', 'x'.repeat(200)]) {
      expect(compareVersions(malformed, '0.1.7-enpoi.2.81')).toBeNull()
      expect(compareVersions('0.1.7-enpoi.2.81', malformed)).toBeNull()
      expect(compareVersions(malformed, malformed)).toBeNull()
    }
    // A numeric segment facing a text segment cannot be ordered.
    expect(compareVersions('1.2.3', '1.2.x')).toBeNull()
  })
})

describe('catalogUrl', () => {
  it('pins the channel file on the catalog branch (harness-release.yml publishes it)', () => {
    expect(catalogUrl('stable')).toBe('https://raw.githubusercontent.com/Darthph0enix7/Enpoi-harness/catalog/stable.json')
    expect(catalogUrl('beta')).toBe('https://raw.githubusercontent.com/Darthph0enix7/Enpoi-harness/catalog/beta.json')
  })

  it('defaults any other channel value to stable', () => {
    expect(catalogUrl('gamma')).toBe(catalogUrl('stable'))
  })
})
