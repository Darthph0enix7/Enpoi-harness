/**
 * Source-build version stamps: the `+g<sha>` detection and the locale-owned
 * qualifier, in both dictionaries.
 */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en, zh } from '../src/client/locales.ts'
import { formatVersion, isSourceBuildVersion, SOURCE_BUILD_STAMP } from '../src/client/version.ts'

describe('isSourceBuildVersion', () => {
  it('recognizes the engine’s +g<sha> stamp, case-insensitively', () => {
    expect(isSourceBuildVersion('0.1.7-enpoi.2+gbb12abc')).toBe(true)
    expect(isSourceBuildVersion('0.1.7-enpoi.2+gBB12ABC64C0')).toBe(true)
    expect(isSourceBuildVersion('v0.1.7-enpoi.2+gbb12abc')).toBe(true)
    expect(SOURCE_BUILD_STAMP.test('0.1.7-enpoi.2+gbb12abc')).toBe(true)
  })

  it('rejects plain versions, short shas, and other build metadata', () => {
    expect(isSourceBuildVersion('0.1.7-enpoi.2')).toBe(false)
    expect(isSourceBuildVersion('0.1.7-enpoi.2.88')).toBe(false)
    expect(isSourceBuildVersion('0.1.7-enpoi.2+gbb12')).toBe(false)
    expect(isSourceBuildVersion('0.1.7-enpoi.2+build.7')).toBe(false)
    expect(isSourceBuildVersion('')).toBe(false)
  })
})

describe('formatVersion', () => {
  it('qualifies a source build with locale-owned copy and leaves plain versions untouched', () => {
    const tEn = makeTranslate(en)
    const tZh = makeTranslate(zh)
    expect(formatVersion('0.1.7-enpoi.2+gbb12abc', tEn)).toBe('0.1.7-enpoi.2+gbb12abc (source build)')
    expect(formatVersion('0.1.7-enpoi.2+gbb12abc', tZh)).toBe('0.1.7-enpoi.2+gbb12abc（源码构建）')
    expect(formatVersion('0.1.7-enpoi.2.88', tEn)).toBe('0.1.7-enpoi.2.88')
    expect(formatVersion('0.1.7-enpoi.2.88', tZh)).toBe('0.1.7-enpoi.2.88')
  })
})
