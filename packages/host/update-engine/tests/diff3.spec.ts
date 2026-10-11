/**
 * Behavior pins for the embedded 3-way merge, including the GNU diff3
 * semantics for adjacent changes (a region is bounded only by lines unchanged
 * in BOTH sides) and the disjoint-change clean merge.
 */

import { describe, expect, it } from 'vitest'
import { merge3 } from '../src/diff3.ts'

describe('merge3', () => {
  it('merges changes in disjoint regions cleanly', () => {
    const result = merge3('a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'a\nb\nC\nd\n')
    expect(result.clean).toBe(true)
    expect(result.conflicts).toBe(0)
    expect(result.text).toBe('A\nb\nC\nd\n')
  })

  it('takes the changed side when the other side is unchanged', () => {
    expect(merge3('a\nb\n', 'a\nB\n', 'a\nb\n').text).toBe('a\nB\n')
    expect(merge3('a\nb\n', 'a\nb\n', 'a\nC\n').text).toBe('a\nC\n')
  })

  it('applies an identical change once when both sides changed the same way', () => {
    const result = merge3('a\nb\nc\n', 'A\nb\nc\n', 'A\nb\nc\n')
    expect(result.clean).toBe(true)
    expect(result.text).toBe('A\nb\nc\n')
  })

  it('conflicts on adjacent different-side changes like GNU diff3', () => {
    const result = merge3('a\nb\nc\n', 'A\nb\nc\n', 'a\nB\nc\n')
    expect(result.clean).toBe(false)
    expect(result.conflicts).toBe(1)
    expect(result.text).toBe([
      '<<<<<<< local',
      'A',
      'b',
      '||||||| baseline',
      'a',
      'b',
      '=======',
      'a',
      'B',
      '>>>>>>> shipped',
      'c',
      '',
    ].join('\n'))
  })

  it('conflicts on an insertion that overlaps a replacement of the same line', () => {
    const result = merge3('a\nb\nc\n', 'a\nX\nb\nc\n', 'a\nB\nc\n')
    expect(result.clean).toBe(false)
    expect(result.conflicts).toBe(1)
  })

  it('merges identical insertions at the same point', () => {
    const result = merge3('a\nb\n', 'a\nX\nb\n', 'a\nX\nb\n')
    expect(result.clean).toBe(true)
    expect(result.text).toBe('a\nX\nb\n')
  })

  it('conflicts on different insertions at the same point', () => {
    const result = merge3('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n')
    expect(result.clean).toBe(false)
    expect(result.conflicts).toBe(1)
  })

  it('merges a deletion on one side with an unchanged other side', () => {
    const result = merge3('a\nb\nc\n', 'a\nc\n', 'a\nb\nc\n')
    expect(result.clean).toBe(true)
    expect(result.text).toBe('a\nc\n')
  })

  it('merges two insertions at different points cleanly', () => {
    const result = merge3('a\nb\nc\n', 'a\nX\nb\nc\n', 'a\nb\nc\nY\n')
    expect(result.clean).toBe(true)
    expect(result.text).toBe('a\nX\nb\nc\nY\n')
  })

  it('handles an empty base with both sides inserting the same text', () => {
    const result = merge3('', 'hello\n', 'hello\n')
    expect(result.clean).toBe(true)
    expect(result.text).toBe('hello\n')
  })

  it('distinguishes a missing trailing newline from a present one', () => {
    const result = merge3('a\nb\n', 'a\nb\n', 'a\nb')
    expect(result.clean).toBe(true)
    expect(result.text).toBe('a\nb')
  })

  it('supports custom conflict labels', () => {
    const result = merge3('a\n', 'X\n', 'Y\n', { ours: 'mine', base: 'old', theirs: 'new' })
    expect(result.text).toContain('<<<<<<< mine')
    expect(result.text).toContain('||||||| old')
    expect(result.text).toContain('>>>>>>> new')
  })
})
