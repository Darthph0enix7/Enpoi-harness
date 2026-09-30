// @vitest-environment jsdom
/** General Settings setup entry: the label, its description, and the re-run action. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SetupRow } from '../src/client/SetupRow.tsx'
import type { SetupRowProps } from '../src/client/SetupRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

// The row reads only its injected action and copy; the framework's standard
// props are stubs that throw if the component ever touches them.
const unusedHook = (() => { throw new Error('unused standard hook') }) as never

describe('SetupRow', () => {
  it('reopens the wizard from the General section entry', () => {
    const reopen = vi.fn()
    const props: SetupRowProps = {
      reopen,
      t: makeTranslate(en),
      useResource: unusedHook,
      usePanelInfo: unusedHook,
      useSessions: unusedHook,
      useSessionStatus: unusedHook,
      useSessionRetainInfo: unusedHook,
      useWorkspaces: unusedHook,
    }
    render(<SetupRow {...props} />)
    expect(screen.getByText(en.wizSetupNav)).toBeDefined()
    expect(screen.getByText(en.wizSetupIntro)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.wizSetupRun }))
    expect(reopen).toHaveBeenCalledOnce()
  })
})
