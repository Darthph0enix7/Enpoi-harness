// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  PermissionCatalog, PermissionSelection,
} from '@deepseek-ai/dsh-permission-presets/client'
import {
  PermissionSelect, type PermissionSelectProps,
} from '../src/client/PermissionSelect.tsx'
import type { PermissionCatalogState } from '../src/client/catalog.ts'
import { accessZh } from '../src/client/locales.ts'

afterEach(cleanup)

const CATALOG: PermissionCatalog = {
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
    {
      value: 'auto',
      name: 'Auto review',
      description: 'Host English Auto description',
    },
  ],
  defaultOptions: [],
  defaultPreset: 'workspace-write',
}

const t: PermissionSelectProps['t'] = makeTranslate(accessZh)

function setup(options: {
  selection?: PermissionSelection | undefined
  catalog?: PermissionCatalog | null
  locked?: boolean
  select?: (preset: string) => Promise<boolean>
} = {}) {
  const selection = createSnapshotStore<{ value: PermissionSelection | undefined }>({
    value: 'selection' in options ? options.selection : { currentValue: 'workspace-write' },
  })
  const catalog = createSnapshotStore<PermissionCatalogState>({
    value: options.catalog === undefined ? CATALOG : options.catalog,
  })
  const useProjection = (_key: string, selector?: (value: unknown) => unknown) =>
    bindSnapshotSelector(selection)(state => (selector ?? (value => value))(state.value))
  const select = vi.fn(options.select ?? (() => Promise.resolve(true)))
  const props = {
    locked: options.locked ?? false,
    useProjection,
    usePermissionCatalog: bindSnapshotSelector(catalog),
    select,
    t,
  } as unknown as PermissionSelectProps
  const view = render(<PermissionSelect {...props} />)
  return { catalog, props, select, selection, view }
}

function trigger(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^访问模式/ }) as HTMLButtonElement
}

describe('PermissionSelect', () => {
  it('renders only when both the Session selection and process catalog exist', () => {
    const missingSelection = setup({ selection: undefined })
    expect(missingSelection.view.container.innerHTML).toBe('')
    cleanup()
    const missingCatalog = setup({ catalog: null })
    expect(missingCatalog.view.container.innerHTML).toBe('')
  })

  it('is icon-only and cycles read-only → workspace-write → full access → read-only with no popup', () => {
    const { select, selection } = setup({ selection: { currentValue: 'read-only' } })
    const trigger = () => screen.getByRole<HTMLButtonElement>('button', { name: /^访问模式/ })
    // Icon-only: no visible text, exactly one glyph.
    expect(trigger().textContent).toBe('')
    expect([...trigger().querySelectorAll('svg')]
      .every(icon => icon.closest('[aria-hidden="true"]') !== null)).toBe(true)
    // No menu, no dialog — a click cycles directly to the next fixed mode.
    fireEvent.click(trigger())
    expect(select).toHaveBeenLastCalledWith('workspace-write')
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => { selection.set({ value: { currentValue: 'workspace-write' } }) })
    fireEvent.click(trigger())
    expect(select).toHaveBeenLastCalledWith('danger-full-access')
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => { selection.set({ value: { currentValue: 'danger-full-access' } }) })
    fireEvent.click(trigger())
    expect(select).toHaveBeenLastCalledWith('read-only')
    expect(select).toHaveBeenCalledTimes(3)
  })

  it('labels the current mode and cycles by the fixed order, not the catalog order', () => {
    const catalog: PermissionCatalog = {
      options: [
        { value: 'workspace-write', name: 'Project Files', description: 'Host description' },
        { value: 'danger-full-access', name: 'Operator Mode' },
        { value: 'custom-mode', name: 'custom-mode' },
      ],
      defaultOptions: [],
      defaultPreset: 'workspace-write',
    }
    const { select } = setup({ catalog, selection: { currentValue: 'workspace-write' } })
    expect(trigger().textContent).toBe('')
    expect(trigger().getAttribute('aria-label')).toBe('访问模式，当前：Project Files')
    expect(trigger().getAttribute('title')).toBe('Host description')
    fireEvent.click(trigger())
    expect(select).toHaveBeenCalledExactlyOnceWith('danger-full-access')
  })

  it('falls back to a conventional name and no glyph for an unknown current value', () => {
    const { select } = setup({ selection: { currentValue: 'custom-mode' } })
    expect(trigger().getAttribute('aria-label')).toBe('访问模式，当前：Custom Mode')
    expect(trigger().querySelectorAll('svg')).toHaveLength(0)
    // An unknown mode is outside the cycle: the next click starts it over.
    fireEvent.click(trigger())
    expect(select).toHaveBeenCalledExactlyOnceWith('read-only')
  })

  it('shows the Auto review badge and copy, and cycles an Auto value back to read-only', () => {
    const { select } = setup({ selection: { currentValue: 'auto' } })
    expect(trigger().getAttribute('aria-label')).toBe('访问模式，当前：Auto review EXP')
    expect(trigger().getAttribute('title'))
      .toBe('无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查。')
    fireEvent.click(trigger())
    expect(select).toHaveBeenCalledExactlyOnceWith('read-only')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reaches Full access in one click without any acknowledgement step', () => {
    const { select } = setup({ selection: { currentValue: 'workspace-write' } })
    fireEvent.click(trigger())
    expect(select).toHaveBeenCalledExactlyOnceWith('danger-full-access')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    // The wrap back to read-only needs no confirmation either.
    cleanup()
    const back = setup({ selection: { currentValue: 'danger-full-access' } })
    fireEvent.click(trigger())
    expect(back.select).toHaveBeenCalledExactlyOnceWith('read-only')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is disabled while locked and unmounts when either source disappears', () => {
    const locked = setup({ selection: { currentValue: 'read-only' } })
    locked.view.rerender(<PermissionSelect {...locked.props} locked />)
    expect(trigger().disabled).toBe(true)
    fireEvent.click(trigger())
    expect(locked.select).not.toHaveBeenCalled()

    cleanup()
    const vanished = setup()
    act(() => { vanished.catalog.set({ value: null }) })
    expect(vanished.view.container.innerHTML).toBe('')

    cleanup()
    const missingSelection = setup()
    act(() => { missingSelection.selection.set({ value: undefined }) })
    expect(missingSelection.view.container.innerHTML).toBe('')
  })

  it('leaves the current mode in force when the select write rejects', async () => {
    const select = vi.fn(() => Promise.reject(new Error('rejected')))
    const { selection } = setup({ selection: { currentValue: 'read-only' }, select })
    fireEvent.click(trigger())
    await act(async () => {})
    expect(select).toHaveBeenCalledExactlyOnceWith('workspace-write')
    act(() => { selection.set({ value: { currentValue: 'workspace-write' } }) })
    expect(trigger().getAttribute('aria-label')).toBe('访问模式，当前：工作区内修改')
  })
})
