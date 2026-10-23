// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn, zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import { ContextMeter, type ContextMeterProps } from '../src/client/skeleton/ContextMeter.tsx'
import { contextOccupancy } from '../src/client/context-occupancy.ts'
import css from '../src/client/skeleton/ContextMeter.module.css'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as ContextMeterProps['t']
const tEn = makeTranslate(en, commonEn) as ContextMeterProps['t']

const BREAKDOWN = { systemTokens: 120, toolsTokens: 21_500, messageTokens: 477_000 }

const COMPACTIONS = {
  count: 2,
  mechanicalCount: 1,
  failedCount: 1,
  last: {
    endSeq: 42,
    at: 1_700_000_000_000,
    shadowedNodes: 4,
    shadowedTokens: 1_200,
    manual: false,
    mechanical: false,
  },
}

const segmentClass = css.segment
if (segmentClass === undefined) throw new Error('segment class missing from ContextMeter.module.css')

function projections(values: Record<string, unknown>): ContextMeterProps['useProjection'] {
  return (key: string) => values[key]
}

function meter(values: Record<string, unknown>, translate: ContextMeterProps['t'] = t) {
  return render(<ContextMeter useProjection={projections(values)} t={translate} />)
}

describe('ContextMeter', () => {
  it('computes occupancy only when both a numerator and capacity are known', () => {
    expect(contextOccupancy({ pressureTokens: 32_000, projectedTokens: 6_000, contextWindow: 128_000 }))
      .toEqual({ percent: 5, usedTokens: 6_000, contextWindow: 128_000 })
    expect(contextOccupancy({ pressureTokens: 32_000, contextWindow: 128_000 }))
      .toEqual({ percent: 25, usedTokens: 32_000, contextWindow: 128_000 })
    expect(contextOccupancy({ pressureTokens: 32_000 })).toBeNull()
    expect(contextOccupancy({ contextWindow: 128_000 })).toBeNull()
    expect(contextOccupancy(undefined)).toBeNull()
    expect(contextOccupancy({ pressureTokens: 300_000, contextWindow: 128_000 })?.percent).toBe(100)
  })

  it('renders nothing until both pressure and capacity are known', () => {
    expect(meter({}).container.textContent).toBe('')
    expect(meter({ contextPressure: { pressureTokens: 32_000 } }).container.textContent).toBe('')
    expect(meter({ contextPressure: { contextWindow: 128_000 } }).container.textContent).toBe('')
  })

  it('shows the occupancy ring and opens the breakdown panel on click', () => {
    const view = meter({
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    const trigger = view.getByRole('button', { name: '上下文已用 25%' })
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    const panel = view.queryByRole('dialog')!
    expect(panel.textContent).toContain('~32K / 128K')
    expect(panel.textContent).toContain('25%')
    expect(panel.textContent).toContain('上下文已用')
    expect(panel.textContent).toContain('系统提示词~120')
    expect(panel.textContent).toContain('工具定义~21.5K')
    expect(panel.textContent).toContain('对话消息~477K')
    // The occupancy bar splits into one colored segment per composition row.
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(3)
    // Clicking the trigger again toggles the panel shut.
    fireEvent.click(trigger)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('lets each locale own the headline word order around the reading', () => {
    const values = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    }
    const zhView = meter(values)
    fireEvent.click(zhView.getByRole('button', { name: '上下文已用 25%' }))
    // The reading follows the label in Chinese and leads it in English; both
    // headers read as one sentence rather than a concatenated fragment.
    expect(zhView.queryByRole('dialog')!.textContent)
      .toMatch(/^上下文已用25%/)
    const enView = meter(values, tEn)
    fireEvent.click(enView.getByRole('button', { name: '25% of context used' }))
    expect(enView.queryByRole('dialog', { name: 'of context used' })!.textContent)
      .toMatch(/^25%of context used/)
  })

  it('draws no bar segment at zero occupancy', () => {
    const view = meter({
      contextPressure: { pressureTokens: 0, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 0%' }))
    const panel = view.queryByRole('dialog')!
    // `.segment` carries a min-width, so a zero-width part would still paint a
    // filled sliver over an empty context.
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(0)
    expect(panel.textContent).toContain('~0 / 128K')
  })

  it('reads the ring from the projected figure so a compaction shows at once', () => {
    // Same provider sample, a surface a compaction just shrank: the ring must
    // follow the projection rather than the sample it is anchored to.
    const view = meter({
      contextPressure: { pressureTokens: 32_000, projectedTokens: 3_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    const trigger = view.getByRole('button', { name: '上下文已用 2%' })
    fireEvent.click(trigger)
    expect(view.queryByRole('dialog')!.textContent).toContain('~3K / 128K')
  })

  it('omits the composition rows while the contextBreakdown projection is absent', () => {
    const view = meter({ contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 } })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    const panel = view.queryByRole('dialog')!
    expect(panel.textContent).toContain('~32K / 128K')
    expect(panel.textContent).not.toContain('系统提示词')
    expect(panel.textContent).not.toContain('对话消息')
    // Without composition shares, the bar falls back to one plain segment.
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(1)
  })

  it('closes when capacity disappears and stays closed when it returns', () => {
    let values: Record<string, unknown> = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    }
    const view = render(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    expect(view.queryByRole('dialog')).not.toBeNull()

    values = { contextPressure: { pressureTokens: 32_000 }, contextBreakdown: BREAKDOWN }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.container.textContent).toBe('')

    values = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.getByRole('button', { name: '上下文已用 25%' }).getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('closes on outside pointerdown and Escape — but not inside clicks', () => {
    const view = meter({
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    const trigger = view.getByRole('button', { name: '上下文已用 25%' })
    const openPanel = () => {
      fireEvent.click(trigger)
      return view.queryByRole('dialog')!
    }
    // A pointerdown inside the panel keeps it open; outside closes it.
    const again = openPanel()
    fireEvent.pointerDown(again)
    expect(view.queryByRole('dialog')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
    // Escape.
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('shows the newest compaction as a panel row', () => {
    const view = meter({
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextCompactions: COMPACTIONS,
    })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    const text = view.queryByRole('dialog')!.textContent
    expect(text).toContain('已压缩 2 次')
    expect(text).toContain('最近 4 条消息')
    expect(text).toContain('检查点')
    expect(text).toContain('约 1.2K tokens 已凝结')
  })

  it('omits the compaction row until a compaction commits', () => {
    const view = meter({
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextCompactions: { count: 0, mechanicalCount: 0, failedCount: 0 },
    })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    expect(view.queryByRole('dialog')!.textContent).not.toContain('已压缩')
  })

  it('omits the compaction row when only a bare count is published', () => {
    const view = meter({
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextCompactions: { count: 1, mechanicalCount: 0, failedCount: 0 },
    })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    expect(view.queryByRole('dialog')!.textContent).not.toContain('已压缩')
  })

  it('appends the compaction count to the ring tooltip', () => {
    const view = meter({
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextCompactions: COMPACTIONS,
    })
    fireEvent.focus(view.getByRole('button', { name: '上下文已用 25%' }))
    expect(view.getByRole('tooltip').textContent).toBe('上下文已用 25%· 已压缩 2 次')
  })

  it('announces only increments after the first compaction value', () => {
    let values: Record<string, unknown> = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextCompactions: { ...COMPACTIONS, count: 3, mechanicalCount: 0, failedCount: 0 },
    }
    const view = render(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    // The first defined value is the baseline: an already-compacted session
    // must not announce a compaction the reader never saw happen.
    expect(view.queryByRole('status')).toBeNull()

    values = {
      ...values,
      contextCompactions: { ...COMPACTIONS, count: 4, mechanicalCount: 0, failedCount: 0 },
    }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.getByRole('status').getAttribute('aria-live')).toBe('polite')
    expect(view.getByRole('status').textContent).toBe('上下文已压缩，较早的消息已替换为检查点')
  })

  it('uses the mechanical copy when the committed compaction was a stub', () => {
    let values: Record<string, unknown> = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextCompactions: { ...COMPACTIONS, count: 1, mechanicalCount: 0, failedCount: 0 },
    }
    const view = render(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    values = {
      ...values,
      contextCompactions: { ...COMPACTIONS, count: 2, mechanicalCount: 1, failedCount: 0 },
    }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.getByRole('status').textContent)
      .toBe('上下文已压缩，摘要不可用；消息已移入会话日志')
  })

  it('ignores republishes that do not increment a counter and re-baselines after absence', () => {
    let values: Record<string, unknown> = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextCompactions: { ...COMPACTIONS, count: 2, mechanicalCount: 0, failedCount: 0 },
    }
    const view = render(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    // A fresh projection object with the same counters announces nothing.
    values = {
      ...values,
      contextCompactions: { ...COMPACTIONS, count: 2, mechanicalCount: 0, failedCount: 0 },
    }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.queryByRole('status')).toBeNull()

    // An absent value forgets the baseline, so the next defined value is a
    // baseline again rather than a live increment.
    values = { ...values, contextCompactions: undefined }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    values = {
      ...values,
      contextCompactions: { ...COMPACTIONS, count: 3, mechanicalCount: 0, failedCount: 0 },
    }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.queryByRole('status')).toBeNull()
  })

  it('restarts the six-second window on a later increment', () => {
    vi.useFakeTimers()
    try {
      let values: Record<string, unknown> = {
        contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
        contextCompactions: { ...COMPACTIONS, count: 1, mechanicalCount: 0, failedCount: 0 },
      }
      const view = render(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
      values = {
        ...values,
        contextCompactions: { ...COMPACTIONS, count: 2, mechanicalCount: 0, failedCount: 0 },
      }
      view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
      expect(view.getByRole('status')).toBeTruthy()
      act(() => { vi.advanceTimersByTime(5_000) })
      values = {
        ...values,
        contextCompactions: { ...COMPACTIONS, count: 3, mechanicalCount: 0, failedCount: 0 },
      }
      view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
      act(() => { vi.advanceTimersByTime(5_000) })
      expect(view.getByRole('status')).toBeTruthy()
      act(() => { vi.advanceTimersByTime(1_000) })
      expect(view.queryByRole('status')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports failures and hides the notice after six seconds', () => {
    vi.useFakeTimers()
    try {
      let values: Record<string, unknown> = {
        contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
        contextCompactions: { ...COMPACTIONS, count: 2, mechanicalCount: 0, failedCount: 0 },
      }
      const view = render(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
      values = {
        ...values,
        contextCompactions: { ...COMPACTIONS, count: 2, mechanicalCount: 0, failedCount: 1 },
      }
      view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
      expect(view.getByRole('status').textContent).toBe('压缩失败，上下文未改变')
      act(() => { vi.advanceTimersByTime(6_000) })
      expect(view.queryByRole('status')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
