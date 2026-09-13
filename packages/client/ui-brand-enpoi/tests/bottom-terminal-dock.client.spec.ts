// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { dockBoxFromRect } from '../src/client/terminal/BottomTerminalDock.tsx'

describe('dockBoxFromRect', () => {
  it('returns the border-box rect unchanged when the column has no horizontal padding', () => {
    expect(dockBoxFromRect({ left: 120, width: 640 }, 0, 0)).toEqual({ left: 120, width: 640 })
  })

  it('moves the left edge and shrinks the width by the column padding', () => {
    expect(dockBoxFromRect({ left: 100, width: 700 }, 8, 44)).toEqual({ left: 108, width: 648 })
  })

  it('clamps a column narrower than its padding to zero width', () => {
    expect(dockBoxFromRect({ left: 30, width: 20 }, 8, 44)).toEqual({ left: 38, width: 0 })
  })

  it('keeps the zero-width pre-measure rect at zero width', () => {
    expect(dockBoxFromRect({ left: 0, width: 0 }, 0, 44)).toEqual({ left: 0, width: 0 })
  })
})
