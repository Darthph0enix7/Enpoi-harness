// @vitest-environment jsdom
/**
 * UpdateSettingsRow: the General-settings update control in every state, with
 * the skipped (dismissed) release keeping its Update entry point.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { UpdateSettingsRow } from '../src/client/UpdateSettingsRow.tsx'
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
    rung: 'two-phase',
    phase: 'preparing',
    step: 0,
    steps: 9,
    lastLine: '',
    startedAt: '2026-10-13T12:00:00.000Z',
    pid: 4242,
    logPath: '/home/dsh/update-check/run.log',
    result: null,
    launcher: 'setsid',
    staged: false,
    logTail: [],
    ...overrides,
  }
}

const availableStatus = {
  state: 'available' as const,
  current: { version: '0.1.7-enpoi.2.81', commit: 'abc1234', channel: 'stable' },
  latest: {
    version: '0.1.7-enpoi.2.84',
    commit: 'def5678',
    releasedAt: '2026-10-13T12:00:00.000Z',
    notes: ['feat(update): in-app updates'],
  },
}

const currentStatus = {
  state: 'current' as const,
  current: { version: '0.1.7-enpoi.2.81', commit: 'abc1234', channel: 'stable' },
}

function mount(initial: Partial<UpdateUiState> = {}) {
  const store = createSnapshotStore<UpdateUiState>({
    status: null,
    run: null,
    dialogOpen: false,
    busy: false,
    actionError: null,
    checking: false,
    checkError: null,
    toastVersion: null,
    ...initial,
  })
  const actions = { open: vi.fn(), apply: vi.fn(), checkNow: vi.fn() }
  const props = {
    actions,
    useUpdate: bindSnapshotSelector(store),
    t: makeTranslate(en),
  } as unknown as Parameters<typeof UpdateSettingsRow>[0]
  return { ...render(<UpdateSettingsRow {...props} />), store, actions }
}

const rowState = (): string | null => document.querySelector('[data-dsh-update-settings]')?.getAttribute('data-dsh-update-settings') ?? null

describe('UpdateSettingsRow', () => {
  it('renders nothing before the first check result', () => {
    const empty = mount()
    expect(empty.container.firstChild).toBeNull()
  })

  it('offers the quiet manual check while current, and none of the update actions', () => {
    const { actions } = mount({ status: { ...availableStatus, state: 'current' } })
    expect(rowState()).toBe('current')
    expect(screen.getByText(en['settings.upToDate'])).toBeTruthy()
    const check = document.querySelector('[data-dsh-update-check]')
    expect(check?.textContent).toBe(en['check.action'])
    fireEvent.click(check!)
    expect(actions.checkNow).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: en['action.updateNow'] })).toBeNull()
    expect(screen.queryByRole('button', { name: en['action.restart'] })).toBeNull()
  })

  it('offers the quiet manual check while unknown (never checked / offline)', () => {
    const { actions } = mount({ status: { state: 'unknown', current: { version: '', commit: '', channel: 'stable' } } })
    expect(rowState()).toBe('unknown')
    expect(screen.getByText(en['settings.notChecked'])).toBeTruthy()
    fireEvent.click(document.querySelector('[data-dsh-update-check]')!)
    expect(actions.checkNow).toHaveBeenCalledTimes(1)
  })

  it('disables the check while one is in flight and shows its quiet failure line', async () => {
    const { store } = mount({ status: { ...availableStatus, state: 'current' } })
    store.set({ ...store.getSnapshot(), checking: true })
    await waitFor(() => {
      const checking = document.querySelector('[data-dsh-update-check]')
      expect(checking?.textContent).toBe(en['check.checking'])
      expect(checking?.hasAttribute('disabled')).toBe(true)
    })
    store.set({ ...store.getSnapshot(), checking: false, checkError: 'gateway responded 502' })
    await waitFor(() => {
      expect(screen.getByText('Check failed: gateway responded 502')).toBeTruthy()
    })
  })

  it('keeps the primary actions (and no second check control) while an update is offered', () => {
    mount({ status: availableStatus })
    expect(screen.queryByRole('button', { name: en['action.updateNow'] })).toBeTruthy()
    expect(document.querySelector('[data-dsh-update-check]')).toBeNull()
    cleanup()
    mount({ status: { ...availableStatus, state: 'dismissed' } })
    expect(screen.queryByRole('button', { name: en['action.updateNow'] })).toBeTruthy()
    expect(document.querySelector('[data-dsh-update-check]')).toBeNull()
    cleanup()
    mount({ status: availableStatus, run: run({ phase: 'prepared', step: 7, staged: true }) })
    expect(screen.getByRole('button', { name: en['action.restart'] })).toBeTruthy()
    expect(document.querySelector('[data-dsh-update-check]')).toBeNull()
  })

  it('offers Update (opening the shared dialog) while a release is available', () => {
    const { actions } = mount({ status: availableStatus })
    expect(rowState()).toBe('available')
    expect(screen.getByText('New version 0.1.7-enpoi.2.84 available')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['action.updateNow'] }))
    expect(actions.open).toHaveBeenCalledTimes(1)
  })

  it('keeps the Update control on a skipped (dismissed) version with the skip hint', () => {
    const { actions } = mount({ status: { ...availableStatus, state: 'dismissed' } })
    expect(rowState()).toBe('skipped')
    expect(screen.getByText('New version 0.1.7-enpoi.2.84 available')).toBeTruthy()
    expect(screen.getByText(en['settings.skipped'])).toBeTruthy()
    const button = screen.getByRole('button', { name: en['action.updateNow'] })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(actions.open).toHaveBeenCalledTimes(1)
  })

  it('follows an executing run with View progress opening the dialog', () => {
    const { actions } = mount({ status: availableStatus, run: run({ phase: 'preparing', step: 3 }) })
    expect(rowState()).toBe('updating')
    expect(screen.getByText(en['indicator.updating'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['action.viewProgress'] }))
    expect(actions.open).toHaveBeenCalledTimes(1)
    expect(actions.apply).not.toHaveBeenCalled()
  })

  it('performs the prepared restart through the shared controller action', () => {
    const { actions } = mount({
      status: availableStatus,
      run: run({ phase: 'prepared', step: 7, staged: true }),
    })
    expect(rowState()).toBe('prepared')
    expect(screen.getByText(en['settings.prepared'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['action.restart'] }))
    expect(actions.apply).toHaveBeenCalledTimes(1)
  })

  it('never offers the prepared restart for a one-shot record', () => {
    const { actions } = mount({
      status: availableStatus,
      run: run({ mode: 'one-shot', rung: 'one-shot', phase: 'prepared', step: 7, staged: true }),
    })
    expect(rowState()).toBe('available')
    expect(screen.queryByRole('button', { name: en['action.restart'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['action.updateNow'] }))
    expect(actions.open).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed run with Retry opening the failure dialog', () => {
    const { actions } = mount({
      status: availableStatus,
      run: run({ phase: 'failed', result: 'failed', reason: 'the prepare run exited before reporting a result' }),
    })
    expect(rowState()).toBe('failed')
    expect(screen.getByText(en['settings.failed'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['action.retry'] }))
    expect(actions.open).toHaveBeenCalledTimes(1)
  })

  it('labels a cancelled run and offers Retry through the dialog while an update is still offered', () => {
    const { actions } = mount({
      status: availableStatus,
      run: run({ observed: true, launcher: 'external', phase: 'cancelled', result: 'cancelled', reason: 'Cancelled run ext-1' }),
    })
    expect(rowState()).toBe('failed')
    expect(screen.getByText(en['settings.cancelled'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['action.retry'] }))
    expect(actions.open).toHaveBeenCalledTimes(1)
  })

  it('renders a terminal cancelled record as history when the install is current (the live Mac defect)', () => {
    // The exact live shape: the cancelled record persisted after the user
    // cancelled, while the status now reports `current` (no update exists).
    // The row used to show "Update cancelled / Retry" forever; Retry then
    // launched no-op prepares. It must render as up to date with the quiet
    // Check action and no Retry/Update/restart affordance.
    const { actions } = mount({
      status: currentStatus,
      run: run({ observed: true, launcher: 'external', phase: 'cancelled', result: 'cancelled', reason: 'Cancelled run ext-1' }),
    })
    expect(rowState()).toBe('current')
    expect(screen.getByText(en['settings.upToDate'])).toBeTruthy()
    expect(screen.queryByText(en['settings.cancelled'])).toBeNull()
    expect(screen.queryByRole('button', { name: en['action.retry'] })).toBeNull()
    expect(screen.queryByRole('button', { name: en['action.updateNow'] })).toBeNull()
    expect(screen.queryByRole('button', { name: en['action.restart'] })).toBeNull()
    fireEvent.click(document.querySelector('[data-dsh-update-check]')!)
    expect(actions.checkNow).toHaveBeenCalledTimes(1)
  })

  it('renders a failed record as history while current, for every terminal result', () => {
    for (const result of ['failed', 'rolledback', 'cancelled'] as const) {
      mount({
        status: currentStatus,
        run: run({ phase: result, result, reason: `the prepare run reported ${result}` }),
      })
      expect(rowState()).toBe('current')
      expect(screen.queryByRole('button', { name: en['action.retry'] })).toBeNull()
      cleanup()
    }
  })

  it('presents a no-op prepare (already up to date, nothing staged) as up to date, never a dead-end restart', () => {
    // The no-op prepare ends in a terminal success record pinned to the
    // offered version (the engine prints "already up to date") with no staged
    // tree; the row shows the quiet current state, and the pill stays hidden.
    mount({
      status: currentStatus,
      run: run({ mode: 'prepare', phase: 'success', result: 'success', target: '0.1.7-enpoi.2.92', staged: false }),
    })
    expect(rowState()).toBe('current')
    expect(screen.getByText(en['settings.upToDate'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['action.restart'] })).toBeNull()
    expect(screen.queryByRole('button', { name: en['action.retry'] })).toBeNull()
  })

  it('never lets a failed record mask an offered release: available stays actionable', () => {
    mount({
      status: availableStatus,
      run: run({ phase: 'failed', result: 'failed', staged: false, reason: 'the prepare run exited before reporting a result' }),
    })
    expect(rowState()).toBe('failed')
    expect(screen.getByRole('button', { name: en['action.retry'] })).toBeTruthy()
  })

  it('does not re-offer the release a landed run just installed, and re-arms on a newer one', () => {
    // Lagging status still says available for the version the success landed.
    mount({
      status: availableStatus,
      run: run({ mode: 'apply', phase: 'success', result: 'success', step: 9, target: availableStatus.latest.version }),
    })
    expect(screen.queryByRole('button', { name: en['action.updateNow'] })).toBeNull()
    expect(screen.getByText(en['settings.upToDate'])).toBeTruthy()
    cleanup()
    // A newer catalog version re-offers the action.
    mount({
      status: { ...availableStatus, latest: { ...availableStatus.latest, version: '0.1.7-enpoi.2.85' } },
      run: run({ mode: 'apply', phase: 'success', result: 'success', step: 9, target: '0.1.7-enpoi.2.84' }),
    })
    expect(screen.getByRole('button', { name: en['action.updateNow'] })).toBeTruthy()
  })

  it('disables the control while a call is in flight', () => {
    mount({ status: availableStatus, busy: true })
    expect(screen.getByRole('button', { name: en['action.updateNow'] }).hasAttribute('disabled')).toBe(true)
  })
})
