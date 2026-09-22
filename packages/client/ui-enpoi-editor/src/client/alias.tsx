/**
 * The `enpoi-editor` tab kind's body, kept only as a migrator.
 *
 * The editing surface lives inside the unified document pane (the `text` tab's
 * display-type menu), so a persisted session or an old surface record that
 * still references this kind is redirected on restore: the same address opens
 * as a `text` tab — replacing this one in place — with the file's remembered
 * display type set to the editor renderer. Without the document-preview
 * service there is no text pane to land in, so the redirect declines and the
 * tab renders nothing rather than resurrecting the retired editor shell.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SidebarRightTabActions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** What the alias needs from the apply closure: the in-place redirect. */
export interface EditorAliasInjected {
  /**
   * Redirect one restored tab to the unified document pane.
   * @param address - the tab's file address.
   * @param actions - the tab's own actions, which replace it in place.
   * @returns whether the redirect was issued.
   */
  readonly redirect: (address: string, actions: SidebarRightTabActions) => boolean
}

/** The alias body's composed props. */
export type EditorTabAliasProps =
  & { readonly useTabInfo: UseSidebarRightTabInfo }
  & { readonly redirect: EditorAliasInjected['redirect'] }

/**
 * The `enpoi-editor` tab body: a one-shot redirect to `kind: 'text'`.
 * @param props - the tab reader and the redirect.
 * @returns nothing; the tab replaces itself on mount.
 */
export function EditorTabAlias({ useTabInfo, redirect }: EditorTabAliasProps): ReactNode {
  const { tab } = useTabInfo()
  const issuedRef = useRef(false)
  useEffect(() => {
    if (issuedRef.current || tab.signal.aborted) return
    issuedRef.current = true
    redirect(tab.contentId, tab.actions)
  }, [redirect, tab.actions, tab.contentId, tab.signal])
  return null
}
