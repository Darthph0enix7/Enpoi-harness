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
    expect(document.querySelector('[data-dsh-system-analysis]')).toBeNull()
  })

  it('portals the running bar onto the document body and expands its phases upward', () => {
    const { container } = mount({ phase: 'running', stage: 'tooling', stageIndex: 3, pct: 33 })
    // The shell frame caps every in-frame layer below the first-run modal, so
    // the chip lives on the body instead of inside the frame's overlay layer.
    expect(container.firstChild).toBeNull()
    expect(document.querySelector('[data-dsh-system-analysis]')?.parentElement).toBe(document.body)
    expect(screen.getByText(en.sysAnalysisTitle)).toBeTruthy()
    expect(document.querySelector('[data-dsh-system-analysis-stage]')?.textContent).toBe(en.wizPhaseTooling)
    expect(screen.getByText('33%')).toBeTruthy()
    expect(document.querySelector('[data-dsh-system-analysis-fill]')?.getAttribute('style')).toContain('width: 33%')

    // Collapsed: the compact bar is the whole surface, with no phase rail.
    expect(document.querySelector('[data-dsh-system-analysis-phases]')).toBeNull()
    fireEvent.click(document.querySelector('[data-dsh-system-analysis-toggle]')!)
    const phases = document.querySelectorAll('[data-dsh-system-analysis-phases] li')
    expect(phases).toHaveLength(9)
    expect(phases[2]?.getAttribute('data-state')).toBe('done')
    expect(phases[3]?.getAttribute('data-state')).toBe('active')
    expect(phases[4]?.getAttribute('data-state')).toBe('pending')
    fireEvent.click(document.querySelector('[data-dsh-system-analysis-toggle]')!)
    expect(document.querySelector('[data-dsh-system-analysis-phases]')).toBeNull()
  })

  it('clamps a reported percentage into the 0 to 100 the bar renders', () => {
    mount({ phase: 'running', stage: 'tooling', stageIndex: 3, pct: 150 })
    expect(screen.getByText('100%')).toBeTruthy()
    expect(document.querySelector('[data-dsh-system-analysis-fill]')?.getAttribute('style')).toContain('width: 100%')
    cleanup()
    mount({ phase: 'running', stage: 'hardware', stageIndex: 0, pct: -20 })
    expect(screen.getByText('0%')).toBeTruthy()
    expect(document.querySelector('[data-dsh-system-analysis-fill]')?.getAttribute('style')).toContain('width: 0%')
  })

  it('opens the results from the whole ready bar', () => {
    const { actions } = mount({ phase: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.sysAnalysisReady, 'u') }))
    expect(actions.open).toHaveBeenCalledTimes(1)
  })

  it('renders an unknown host stage verbatim', () => {
    mount({ phase: 'running', stage: 'poolside warming', stageIndex: 0, pct: 5 })
    expect(document.querySelector('[data-dsh-system-analysis-stage]')?.textContent).toBe('poolside warming')
  })

  it('keeps the panel actions disabled while a decision is in flight', () => {
    mount({ phase: 'ready', open: true, busy: true, text: '# System profile' })
    expect(screen.getByRole('button', { name: en.sysAnalysisAccept }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.sysAnalysisReject }).hasAttribute('disabled')).toBe(true)
  })

  it('renders an empty document when no profile text was read', () => {
    mount({ phase: 'ready', open: true, text: null })
    expect(document.querySelector('[data-dsh-system-analysis-document]')?.textContent).toBe('')
  })

  it('shows the localized failure label when the host reported no reason', () => {
    mount({ phase: 'failed', error: null, errorCode: null })
    expect(screen.getByText(en.sysAnalysisFailed)).toBeTruthy()
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
