import { describe, expect, it } from 'vitest'
import {
  clampWidth, computeColumns, defaultRightbarWidth, resolveRightbarWidth,
  RIGHTBAR_DEFAULT_MAX, RIGHTBAR_MIN, SIDEBAR_DEFAULT,
} from '../src/client/columns.ts'

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('defaultRightbarWidth', () => {
  it.each([1280, 1920, 2560])('is slim, wider than the left sidebar, and above the floor at %ipx', (viewport) => {
    const width = defaultRightbarWidth(viewport)
    expect(width).toBeGreaterThanOrEqual(RIGHTBAR_MIN)
    expect(width).toBeGreaterThan(SIDEBAR_DEFAULT)
    expect(width).toBeLessThanOrEqual(RIGHTBAR_DEFAULT_MAX)
    // The old 35% split-screen default must never come back.
    expect(width).toBeLessThan(viewport * 0.35)
  })

  it('keeps the sidebar gap on a narrow frame and caps on a wide monitor', () => {
    expect(defaultRightbarWidth(1280)).toBe(376)
    expect(defaultRightbarWidth(1920)).toBe(420)
    expect(defaultRightbarWidth(2560)).toBe(420)
    expect(defaultRightbarWidth(1024)).toBe(376)
    expect(defaultRightbarWidth(320)).toBe(376)
  })
})

describe('resolveRightbarWidth', () => {
  it('uses the shipped default while no preference is stored', () => {
    expect(resolveRightbarWidth(null, 1920)).toBe(420)
    expect(resolveRightbarWidth(null, 320)).toBe(300)
  })

  it('keeps a dragged px on its own frame and scales it on another', () => {
    const preference = { px: 700, ratio: 700 / 1920 }
    expect(resolveRightbarWidth(preference, 1920)).toBe(700)
    expect(resolveRightbarWidth(preference, 960)).toBe(350)
    expect(resolveRightbarWidth(preference, 2560)).toBe(933)
    // Returning to the dragged frame restores the exact px.
    expect(resolveRightbarWidth(preference, 1920)).toBe(700)
  })

  it('bounds a scaled preference by the drag range', () => {
    expect(resolveRightbarWidth({ px: 300, ratio: 300 / 2560 }, 640)).toBe(300)
    expect(resolveRightbarWidth({ px: 1200, ratio: 1200 / 1920 }, 1920)).toBe(1200)
  })
})

describe('computeColumns', () => {
  it('gives each edge column its preference when the center has enough room', () => {
    expect(computeColumns(1920, 280, 864)).toEqual({ sidebar: 280, center: 776, rightbar: 864 })
  })

  it('keeps only the left rail when both panels are closed', () => {
    expect(computeColumns(1920, 0, 0)).toEqual({ sidebar: 56, center: 1864, rightbar: 0 })
  })

  it('clamps sidebar preferences and limits the right panel to 70% of the frame', () => {
    expect(computeColumns(3000, 9999, 9999)).toEqual({ sidebar: 420, center: 480, rightbar: 2100 })
    expect(computeColumns(1920, 1, 1)).toEqual({ sidebar: 264, center: 1356, rightbar: 300 })
  })

  it.each([
    [1300, 280, 620, 400],
    [1100, 280, 420, 400],
    [1120, 420, 300, 400],
    [1119, 420, 0, 699],
    [1024, 420, 0, 604],
    [756, 0, 300, 400],
    [755, 0, 0, 699],
    [455, 0, 0, 399],
    [20, 0, 0, 0],
  ])('solves frame %i and sidebar %i to right %i and center %i', (viewport, sidebar, rightbar, center) => {
    expect(computeColumns(viewport, sidebar, 864)).toEqual({ sidebar: sidebar || 56, center, rightbar })
  })

  it('does not reduce the wide sidebar to keep a normal right panel open', () => {
    expect(computeColumns(1024, 420, 500)).toEqual({ sidebar: 420, center: 604, rightbar: 0 })
  })

  it('restores a still-open preference when the frame widens', () => {
    expect(computeColumns(1100, 280, 864).rightbar).toBe(420)
    expect(computeColumns(1920, 280, 864).rightbar).toBe(864)
  })

  it('leaves a closed right track closed when the frame widens', () => {
    expect(computeColumns(755, 0, 0).rightbar).toBe(0)
    expect(computeColumns(1920, 0, 0).rightbar).toBe(0)
  })
})
