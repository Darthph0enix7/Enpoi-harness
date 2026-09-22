// @vitest-environment jsdom
/**
 * The `enpoi-editor` tab body's redirect: a restored tab of the retired kind
 * reopens its address as the unified `text` pane, replacing itself in place.
 */
import { describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { EditorTabAlias } from '../src/client/alias.tsx'

const ADDRESS = sessionFileAddress('session-1', 'notes.md')

/** Tab-info stub over one abort controller. */
function tabInfo(abort = new AbortController()): { useTabInfo: () => never; signal: AbortSignal } {
  const tab = {
    id: 'tab-9',
    kind: 'enpoi-editor',
    title: 'notes.md',
    contentId: ADDRESS,
    visible: true,
    navigation: { address: ADDRESS, params: undefined, revision: 0 },
    signal: abort.signal,
    actions: { openResource: vi.fn(), openTab: vi.fn(), close: vi.fn() },
  }
  return {
    useTabInfo: () => ({ sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-1' }, tab }) as never,
    signal: abort.signal,
  }
}

describe('editor tab alias', () => {
  it('redirects once to the text pane, replacing the tab in place', () => {
    const info = tabInfo()
    const redirect = vi.fn((_address: string, _actions: unknown) => true)
    const { container } = render(<EditorTabAlias useTabInfo={info.useTabInfo} redirect={redirect} />)
    expect(redirect).toHaveBeenCalledTimes(1)
    expect(redirect.mock.calls[0]?.[0]).toBe(ADDRESS)
    expect(container.firstChild).toBeNull()
    cleanup()
  })

  it('declines when there is no document pane to land in', () => {
    const info = tabInfo()
    const redirect = vi.fn(() => false)
    render(<EditorTabAlias useTabInfo={info.useTabInfo} redirect={redirect} />)
    expect(redirect).toHaveBeenCalledTimes(1)
    cleanup()
  })
})
