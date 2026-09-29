// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SystemAnalysisChip } from '../src/client/SystemAnalysisChip.tsx'
import type { SystemAnalysisState } from '../src/client/system-analysis.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** Mount the chip over a directly driven snapshot and record its actions. */
function mount(initial: Partial<SystemAnalysisState> = {}) {
  const store = createSnapshotStore<SystemAnalysisState>({
    phase: 'hidden',
    stage: '',
    stageIndex: 0,
    stageCount: 9,
    pct: 0,
    error: null,
    errorCode: null,
    open: false,
    text: null,
    busy: false,
    ...initial,
  })
  const actions = {
    open: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  const props = {
    actions,
    useAnalysis: bindSnapshotSelector(store),
    t: makeTranslate(en),
  } as Parameters<typeof SystemAnalysisChip>[0]
  return { ...render(<SystemAnalysisChip {...props} />), store, actions }
}

describe('SystemAnalysisChip', () => {
  it('renders nothing while hidden', () => {
    const { container } = mount()
    expect(container.firstChild).toBeNull()
  })

  it('shows the live phases, the current stage, and the percentage while running', () => {
    const { container } = mount({ phase: 'running', stage: 'tooling', stageIndex: 3, pct: 33 })
    expect(screen.getByText(en.sysAnalysisTitle)).toBeTruthy()
    expect(container.querySelector('[data-dsh-system-analysis-stage]')?.textContent).toBe(en.wizPhaseTooling)
    expect(screen.getByText('33%')).toBeTruthy()
    const phases = container.querySelectorAll('[data-dsh-system-analysis-phases] li')
    expect(phases).toHaveLength(9)
    expect(phases[2]?.getAttribute('data-state')).toBe('done')
    expect(phases[3]?.getAttribute('data-state')).toBe('active')
    expect(phases[4]?.getAttribute('data-state')).toBe('pending')
  })

  it('opens the results from the ready chip', () => {
    const { actions } = mount({ phase: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.sysAnalysisReady, 'u') }))
    expect(actions.open).toHaveBeenCalledTimes(1)
  })

  it('shows the failure reason with a retry', () => {
    const { actions } = mount({ phase: 'failed', error: 'the summariser route failed: quota exhausted' })
    expect(screen.getByText('the summariser route failed: quota exhausted')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.sysAnalysisRetry }))
    expect(actions.retry).toHaveBeenCalledTimes(1)
  })

  it('localizes a static failure kind and prefers a dynamic host reason', () => {
    const { unmount } = mount({ phase: 'failed', errorCode: 'service' })
    expect(screen.getByText(en.sysAnalysisErrorService)).toBeTruthy()
    unmount()
    mount({ phase: 'failed', errorCode: 'rejected', error: 'the summariser route failed: quota exhausted' })
    expect(screen.getByText('the summariser route failed: quota exhausted')).toBeTruthy()
  })

  it('renders the document with Accept and Reject, and dismisses on an outside click', () => {
    const { actions } = mount({ phase: 'ready', open: true, text: '# System profile\n\n## Capabilities\n- hosts containers' })
    expect(screen.getByText(/# System profile/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.sysAnalysisAccept }))
    expect(actions.accept).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.sysAnalysisReject }))
    expect(actions.reject).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(screen.getByText(/# System profile/u))
    expect(actions.dismiss).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(actions.dismiss).toHaveBeenCalledTimes(1)
  })
})
