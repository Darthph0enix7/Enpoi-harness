/**
 * Desktop geometry contract: the three-column solver is the desktop layout's
 * authority and the mobile lanes must not alter it. The fixture matrix pins
 * the exact serialized output for a spread of viewports, sidebar preferences,
 * right-panel requests, and collapsed-rail widths; any change to
 * `computeColumns` (or its constants) fails here.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computeColumns } from '../src/client/columns.ts'

const GOLDEN = new URL('./fixtures/columns-contract.golden.txt', import.meta.url)

const VIEWPORTS = [320, 390, 430, 768, 820, 1024, 1280, 1440, 2560]
const SIDEBARS = [0, 280, 420]
const RIGHTBARS = [0, 300, 700]
const COLLAPSED_WIDTHS = [0, 56]

describe('computeColumns contract', () => {
  it('keeps byte-identical output for the fixture matrix', () => {
    const lines: string[] = []
    for (const viewport of VIEWPORTS) {
      for (const sidebar of SIDEBARS) {
        for (const rightbar of RIGHTBARS) {
          for (const collapsedWidth of COLLAPSED_WIDTHS) {
            const columns = computeColumns(viewport, sidebar, rightbar, collapsedWidth)
            lines.push(`${viewport}|${sidebar}|${rightbar}|${collapsedWidth}=>${JSON.stringify(columns)}`)
          }
        }
      }
    }
    expect(`${lines.join('\n')}\n`).toBe(readFileSync(GOLDEN, 'utf8'))
  })
})
