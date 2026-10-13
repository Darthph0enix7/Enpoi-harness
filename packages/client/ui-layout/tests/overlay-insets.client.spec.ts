/**
 * The overlay-inset contract the frames publish on the document root: every
 * rail value Body-portalled chips read, the covered marker, and the cleanup
 * that removes each on unmount.
 */
import { describe, expect, it } from 'vitest'
import {
  MOBILE_SHELL_ATTR,
  markMobileShell,
  publishShellInsets,
  SHELL_COVERED_ATTR,
  SHELL_INSET_BOTTOM_VAR,
  SHELL_INSET_LEFT_VAR,
  SHELL_INSET_RIGHT_VAR,
} from '../src/client/overlay-insets.ts'

/** A minimal element double recording inline properties, attributes, and removals. */
function fakeRoot(): {
  element: HTMLElement
  values: Map<string, string>
  attrs: Set<string>
  removed: string[]
} {
  const values = new Map<string, string>()
  const attrs = new Set<string>()
  const removed: string[] = []
  const element = {
    style: {
      setProperty: (name: string, value: string) => { values.set(name, value) },
      removeProperty: (name: string) => { removed.push(name); values.delete(name) },
    },
    setAttribute: (name: string) => { attrs.add(name) },
    removeAttribute: (name: string) => { attrs.delete(name) },
    toggleAttribute: (name: string, force?: boolean) => { if (force === true) attrs.add(name); else attrs.delete(name) },
    hasAttribute: (name: string) => attrs.has(name),
  } as unknown as HTMLElement
  return { element, values, attrs, removed }
}

describe('publishShellInsets', () => {
  it('publishes the left/right/bottom insets and the covered marker', () => {
    const root = fakeRoot()
    publishShellInsets(root.element, { left: 56, right: 0, bottom: '0px', covered: false })
    expect(root.values.get(SHELL_INSET_LEFT_VAR)).toBe('56px')
    expect(root.values.get(SHELL_INSET_RIGHT_VAR)).toBe('0px')
    expect(root.values.get(SHELL_INSET_BOTTOM_VAR)).toBe('0px')
    expect(root.attrs.has(SHELL_COVERED_ATTR)).toBe(false)
  })

  it('marks the root covered while a fullscreen panel owns the frame', () => {
    const root = fakeRoot()
    publishShellInsets(root.element, { left: 0, right: 1440, bottom: '0px', covered: true })
    expect(root.attrs.has(SHELL_COVERED_ATTR)).toBe(true)
    expect(root.values.get(SHELL_INSET_RIGHT_VAR)).toBe('1440px')
  })

  it('leaves the bottom inset to the stylesheet when none is given', () => {
    const root = fakeRoot()
    publishShellInsets(root.element, { left: 0, right: 0, covered: false })
    expect(root.values.has(SHELL_INSET_BOTTOM_VAR)).toBe(false)
  })

  it('removes every published value on cleanup', () => {
    const root = fakeRoot()
    const cleanup = publishShellInsets(root.element, { left: 56, right: 380, bottom: '0px', covered: true })
    cleanup()
    expect([...root.values.keys()]).toEqual([])
    expect(root.attrs.size).toBe(0)
    expect(root.removed).toEqual([SHELL_INSET_LEFT_VAR, SHELL_INSET_RIGHT_VAR, SHELL_INSET_BOTTOM_VAR])
  })
})

describe('markMobileShell', () => {
  it('marks the root and removes the marker on cleanup', () => {
    const root = fakeRoot()
    const cleanup = markMobileShell(root.element)
    expect(root.attrs.has(MOBILE_SHELL_ATTR)).toBe(true)
    cleanup()
    expect(root.attrs.has(MOBILE_SHELL_ATTR)).toBe(false)
  })
})
