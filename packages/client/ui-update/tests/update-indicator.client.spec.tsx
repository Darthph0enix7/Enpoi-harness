// @vitest-environment jsdom
/**
 * UpdateIndicator: pill visibility per state (available, executing,
 * prepared, landed), dialog content (versions, channel, notes), the offer /
 * restart / retry actions, the prepare and apply progress panels, the
 * failure surface, and the one-time toast.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { UpdateIndicator } from '../src/client/UpdateIndicator.tsx'
import type { UpdateUiState } from '../src/client/controller.ts'
import type { UpdateRunWire } from '../src/client/rpc.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function run(overrides: Partial<UpdateRunWire> = {}): UpdateRunWire {
  return {
    runId: 'run1',
    target: '0.1.7-enpoi.2.84',
    channel: 'stable',
    mode: 'prepare',
    phase: 'preparing',
    step: 0,
    steps: 9,
    lastLine: '',
    startedAt: '2026-10-13T12:00:00.000Z',
    pid: 4242,
    logPath: '/home/dsh/update-check/run.log',
    result: null,
    rung: 'setsid',
    staged: false,
    logTail: [],
    ...overrides,
  }
}

function mount(initial: Partial<UpdateUiState> = {}) {
  const store = createSnapshotStore<UpdateUiState>({
    status: null,
    run: null,
    dialogOpen: false,
    busy: false,
    actionError: null,
    toastVersion: null,
    ...initial,
  })
  const actions = {
    open: vi.fn(),
    close: vi.fn(),
    start: vi.fn(),
    apply: vi.fn(),
    retry: vi.fn(),
    skip: vi.fn(),
    toastDone: vi.fn(),
  }
  const props = {
    actions,
    useUpdate: bindSnapshotSelector(store),
    t: makeTranslate(en),
  } as unknown as Parameters<typeof UpdateIndicator>[0]
  return { ...render(<UpdateIndicator {...props} />), store, actions }
}

const availableStatus = {
  state: 'available' as const,
  current: { version: '0.1.7-enpoi.2.81', commit: 'abc1234', channel: 'stable' },
  latest: {
    version: '0.1.7-enpoi.2.84',
    commit: 'def5678',
    releasedAt: '2026-10-13T12:00:00.000Z',
    notes: ['feat(update): in-app updates', 'fix(web): reconnect'],
  },
}

describe('UpdateIndicator pill', () => {
  const invisibleStates: [string, UpdateUiState['status']][] = [
    ['unknown', null],
    ['current', { ...availableStatus, state: 'current' }],
    ['dismissed', { ...availableStatus, state: 'dismissed' }],
  ]
  it.each(invisibleStates)('renders no pill while %s', (_state, status) => {
    mount({ status })
    expect(document.querySelector('[data-dsh-update-indicator]')).toBeNull()
  })

  it('renders the available pill with the newest version and opens the dialog', () => {
    const { actions } = mount({ status: availableStatus })
    const pill = document.querySelector('[data-dsh-update-indicator]')
    expect(pill?.getAttribute('data-dsh-update-indicator')).toBe('available')
    expect(pill?.textContent).toBe('0.1.7-enpoi.2.84 ↑')
    expect(pill?.getAttribute('aria-label')).toBe('Update 0.1.7-enpoi.2.84 available — click for details')
    fireEvent.click(pill!)
    expect(actions.open).toHaveBeenCalledTimes(1)
  })

  it('renders the executing pill while preparing or applying', () => {
    const preparing = mount({ status: availableStatus, run: run({ step: 3, phase: 'preparing' }) })
    const pill = document.querySelector('[data-dsh-update-indicator]')
    expect(pill?.getAttribute('data-dsh-update-indicator')).toBe('updating')
    expect(pill?.textContent).toContain(en['indicator.updating'])
    expect(pill?.getAttribute('aria-label')).toBe('Updating: step 3/9')
    preparing.unmount()
    mount({ status: availableStatus, run: run({ mode: 'apply', phase: 'applying', step: 8 }) })
    expect(document.querySelector('[data-dsh-update-indicator]')?.getAttribute('data-dsh-update-indicator')).toBe('updating')
  })

  it('renders the distinct prepared pill (Restart to update) with the target version', () => {
    const { actions } = mount({ status: availableStatus, run: run({ phase: 'prepared', step: 7, staged: true }) })
    const pill = document.querySelector('[data-dsh-update-indicator]')
    expect(pill?.getAttribute('data-dsh-update-indicator')).toBe('prepared')
    expect(pill?.textContent).toContain(en['indicator.prepared'])
    expect(pill?.getAttribute('aria-label')).toBe('Update 0.1.7-enpoi.2.84 is ready — restart to finish')
    fireEvent.click(pill!)
    expect(actions.open).toHaveBeenCalledTimes(1)
  })

  it('hides the pill once a run landed and keeps it after a failure (retry path)', () => {
    const landed = mount({ status: availableStatus, run: run({ result: 'success', phase: 'success', step: 9, mode: 'apply' }) })
    expect(document.querySelector('[data-dsh-update-indicator]')).toBeNull()
    landed.unmount()
    mount({ status: availableStatus, run: run({ result: 'failed', phase: 'failed' }) })
    expect(document.querySelector('[data-dsh-update-indicator]')).not.toBeNull()
  })
})

describe('UpdateIndicator dialog', () => {
  it('renders versions, channel, notes, and the three offer actions', () => {
    const { actions } = mount({ status: availableStatus, dialogOpen: true })
    expect(document.querySelector('[data-dsh-update-versions]')?.textContent)
      .toBe('0.1.7-enpoi.2.81 → 0.1.7-enpoi.2.84')
    expect(screen.getByText('Channel: stable')).toBeTruthy()
    const notes = document.querySelectorAll('[data-dsh-update-notes] li')
    expect(notes).toHaveLength(2)
    expect(notes[0]?.textContent).toBe('feat(update): in-app updates')

    fireEvent.click(screen.getByRole('button', { name: en['action.updateNow'] }))
    expect(actions.start).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en['action.later'] }))
    expect(actions.close).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en['action.skip'] }))
    expect(actions.skip).toHaveBeenCalledTimes(1)
  })

  it('renders a generously scrollable notes list for a long changelog', () => {
    const notes = Array.from({ length: 40 }, (_, index) => `fix(surface): a fairly long commit subject number ${String(index)}`)
    mount({ status: { ...availableStatus, latest: { ...availableStatus.latest, notes } }, dialogOpen: true })
    expect(document.querySelectorAll('[data-dsh-update-notes] li')).toHaveLength(40)
  })

  it('renders the empty-notes copy when the release carries none', () => {
    mount({
      status: { ...availableStatus, latest: { ...availableStatus.latest, notes: [] } },
      dialogOpen: true,
    })
    expect(document.querySelector('[data-dsh-update-notes]')).toBeNull()
    expect(screen.getByText(en['dialog.notesEmpty'])).toBeTruthy()
  })

  it('renders the prepare progress panel with step, bar, last line, and no switch warning', () => {
    mount({
      status: availableStatus,
      run: run({ step: 4, phase: 'preparing', lastLine: '[4/9] dependencies and build' }),
      dialogOpen: true,
    })
    expect(document.querySelector('[data-dsh-update-progress]')?.getAttribute('data-dsh-update-progress')).toBe('preparing')
    expect(screen.getByText(en['progress.preparing'])).toBeTruthy()
    expect(document.querySelector('[data-dsh-update-step]')?.textContent).toBe('Step 4/9')
    expect(document.querySelector('[data-dsh-update-fill]')?.getAttribute('style')).toContain('width: 44%')
    expect(document.querySelector('[data-dsh-update-lastline]')?.textContent).toBe('[4/9] dependencies and build')
    expect(screen.queryByText(en['progress.disconnectWarning'])).toBeNull()
  })

  it('renders the apply progress panel and the switch disconnect warning from step 8', () => {
    const applying = mount({
      status: availableStatus,
      run: run({ mode: 'apply', phase: 'applying', step: 5, lastLine: '[5/9] transport' }),
      dialogOpen: true,
    })
    expect(screen.getByText(en['progress.applying'])).toBeTruthy()
    expect(screen.queryByText(en['progress.disconnectWarning'])).toBeNull()
    applying.unmount()
    mount({
      status: availableStatus,
      run: run({ mode: 'apply', phase: 'applying', step: 8, lastLine: '[8/9] switch, service and backfill' }),
      dialogOpen: true,
    })
    expect(screen.getByText(en['progress.switching'])).toBeTruthy()
    expect(screen.getByText(en['progress.disconnectWarning'])).toBeTruthy()
  })

  it('renders the prepared hint and [Restart to update] calling apply', () => {
    const { actions } = mount({
      status: availableStatus,
      run: run({ phase: 'prepared', step: 7, staged: true }),
      dialogOpen: true,
    })
    expect(document.querySelector('[data-dsh-update-prepared]')).not.toBeNull()
    expect(screen.getByText(en['progress.prepared'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['action.restart'] }))
    expect(actions.apply).toHaveBeenCalledTimes(1)
    // No offer actions while prepared: the staged tree is applied, not replaced.
    expect(screen.queryByRole('button', { name: en['action.updateNow'] })).toBeNull()
  })

  it('renders the starting copy and a zero bar before the first step', () => {
    mount({ status: availableStatus, run: run(), dialogOpen: true })
    expect(document.querySelector('[data-dsh-update-step]')?.textContent).toBe('Step 0/9')
    expect(document.querySelector('[data-dsh-update-fill]')?.getAttribute('style')).toContain('width: 0%')
    expect(document.querySelector('[data-dsh-update-lastline]')?.textContent).toBe(en['progress.starting'])
  })

  it('renders the failure surface with the reason, the log tail, and Retry', () => {
    const { actions } = mount({
      status: availableStatus,
      run: run({
        result: 'failed',
        phase: 'failed',
        step: 4,
        reason: 'the updater exited before reporting a result',
        logTail: ['[4/9] dependencies and build', 'unpacking archive'],
      }),
      dialogOpen: true,
    })
    expect(document.querySelector('[data-dsh-update-failure]')?.getAttribute('data-dsh-update-failure')).toBe('failed')
    expect(screen.getByText(en['result.failed'])).toBeTruthy()
    expect(document.querySelector('[data-dsh-update-reason]')?.textContent).toBe('the updater exited before reporting a result')
    expect(document.querySelector('[data-dsh-update-log]')?.textContent).toBe('[4/9] dependencies and build\nunpacking archive')
    fireEvent.click(screen.getByRole('button', { name: en['action.retry'] }))
    expect(actions.retry).toHaveBeenCalledTimes(1)
  })

  it('renders the rolled-back copy for a rolledback run', () => {
    mount({
      status: availableStatus,
      run: run({ mode: 'apply', result: 'rolledback', phase: 'rolledback', reason: 'dsh update FAILED; rolled back to 0.1.7-enpoi.2.81' }),
      dialogOpen: true,
    })
    expect(screen.getByText(en['result.rolledback'])).toBeTruthy()
  })

  it('renders the success line for a landed run', () => {
    mount({ status: availableStatus, run: run({ mode: 'apply', result: 'success', phase: 'success', step: 9 }), dialogOpen: true })
    expect(document.querySelector('[data-dsh-update-success]')?.textContent).toBe('Updated to 0.1.7-enpoi.2.84')
  })

  it('disables the offer actions while a call is in flight and shows the action error', () => {
    mount({ status: availableStatus, dialogOpen: true, busy: true, actionError: 'an update is already running' })
    expect(screen.getByRole('button', { name: en['action.updateNow'] }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Action failed: an update is already running')).toBeTruthy()
  })

  it('renders nothing visible while closed and unloaded', () => {
    const { container } = mount()
    expect(container.textContent).toBe('')
  })
})

describe('UpdateIndicator toast', () => {
  it('announces a landed update once', () => {
    mount({ status: availableStatus, toastVersion: '0.1.7-enpoi.2.84' })
    expect(screen.getByRole('alert').textContent).toContain('Updated to 0.1.7-enpoi.2.84')
  })
})
