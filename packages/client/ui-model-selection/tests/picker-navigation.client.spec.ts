// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  movePickerFocus, nextTypeAheadTarget, pickerNavTargets, typeAheadQuery, TYPE_AHEAD_RESET_MS,
} from '../src/client/picker-navigation.ts'

/** Build one navigation landmark with its type-ahead name. */
function nav(name: string, disabled = false): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.modelNav = ''
  button.dataset.modelName = name.toLowerCase()
  if (disabled) button.disabled = true
  return button
}

let root: HTMLDivElement

beforeEach(() => {
  document.body.replaceChildren()
  root = document.createElement('div')
  document.body.append(root)
})

describe('picker keyboard navigation', () => {
  it('reads no targets before the list mounts', () => {
    expect(pickerNavTargets(null)).toEqual([])
    expect(movePickerFocus(null, 'next')).toBeNull()
  })

  it('lists only enabled landmarks in document order', () => {
    const first = nav('Alpha')
    const disabled = nav('Blocked', true)
    const last = nav('Zulu')
    root.append(first, disabled, last)
    expect(pickerNavTargets(root)).toEqual([first, last])
  })

  it('moves first, last, next, and previous through the visible set', () => {
    const first = nav('Alpha')
    const second = nav('Beta')
    const third = nav('Gamma')
    root.append(first, second, third)
    expect(movePickerFocus(root, 'first')).toBe(first)
    expect(document.activeElement).toBe(first)
    expect(movePickerFocus(root, 'last')).toBe(third)
    expect(document.activeElement).toBe(third)
    expect(movePickerFocus(root, 'next')).toBe(first)
    expect(movePickerFocus(root, 'previous')).toBe(third)
    expect(movePickerFocus(root, 'previous')).toBe(second)
    expect(movePickerFocus(root, 'next')).toBe(third)
  })

  it('wraps when focus sits on a non-row control', () => {
    const first = nav('Alpha')
    const last = nav('Zulu')
    root.append(first, last)
    const outside = document.createElement('input')
    document.body.append(outside)
    outside.focus()
    expect(movePickerFocus(root, 'next')).toBe(first)
    outside.focus()
    expect(movePickerFocus(root, 'previous')).toBe(last)
  })

  it('treats a non-element active target as no current row', () => {
    const first = nav('Alpha')
    root.append(first)
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.createTextNode('x') as never)
    try {
      expect(movePickerFocus(root, 'next')).toBe(first)
    } finally {
      active.mockRestore()
    }
  })

  it('starts a buffer, appends, and resets after the idle window', () => {
    expect(typeAheadQuery({ buffer: '', at: 0 }, 'A', 100)).toEqual({ buffer: 'a', at: 100 })
    expect(typeAheadQuery({ buffer: 'a', at: 100 }, 'B', 200)).toEqual({ buffer: 'ab', at: 200 })
    expect(typeAheadQuery({ buffer: 'ab', at: 100 }, 'C', 100 + TYPE_AHEAD_RESET_MS + 1))
      .toEqual({ buffer: 'c', at: 100 + TYPE_AHEAD_RESET_MS + 1 })
    expect(typeAheadQuery({ buffer: 'ab', at: 100 }, 'C', 100 + TYPE_AHEAD_RESET_MS))
      .toEqual({ buffer: 'abc', at: 100 + TYPE_AHEAD_RESET_MS })
  })

  it('finds the next matching name, wrapping once', () => {
    const first = nav('Alpha')
    const beta = nav('Beta')
    const another = nav('Bravo')
    root.append(first, beta, another)
    const targets = pickerNavTargets(root)
    expect(nextTypeAheadTarget(targets, '', first)).toBeNull()
    expect(nextTypeAheadTarget(targets, 'b', first)).toBe(beta)
    expect(nextTypeAheadTarget(targets, 'b', another)).toBe(beta)
    expect(nextTypeAheadTarget(targets, 'z', first)).toBeNull()
    expect(nextTypeAheadTarget([], 'a', null)).toBeNull()
    expect(nextTypeAheadTarget(targets, 'a', null)).toBe(first)
    const pro = nav('DeepSeek-V4-Pro')
    expect(nextTypeAheadTarget([pro], 'p', null)).toBe(pro)
    // A row without a name dataset is skipped rather than matching every query.
    const unnamed = document.createElement('button')
    unnamed.dataset.modelNav = ''
    expect(nextTypeAheadTarget([unnamed, first], 'a', null)).toBe(first)
  })
})
