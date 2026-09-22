/**
 * Browser half: register `enpoi-editor` as a right-Sidebar tab type whose body
 * redirects to the unified document pane, plus its in-pane editable renderer
 * and its dictionaries.
 *
 * The editing surface lives in the `text` pane as the keyed
 * `sidebar.right.tab.document` body `enpoi-editor`; the tab kind's own body is
 * a one-shot redirect so persisted sessions referencing the retired
 * fullscreen editor land in the unified pane. The renderer registers through
 * the document-preview service only when that package is present.
 * Every import from another client plugin stays type-only except the allowed
 * baseline primitives.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { SidebarRightTabActions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { EDITOR_ID, editorDefinition, editorPreviewDefinition } from './definition.ts'
import { isEditablePath } from './definition.ts'
import { EditorBody } from './EditorBody.tsx'
import type { EditorInjected } from './EditorBody.tsx'
import { EditorToolbar } from './EditorToolbar.tsx'
import { EditorTabAlias } from './alias.tsx'
import { createEditorStore } from './store.ts'
import { createFsOps } from './fsops.ts'
import { rememberViewerByPath } from './viewer-prefs.ts'
import { en, zh } from './locales.ts'
import type { EnpoiEditorKey } from './locales.ts'

// Values stay package-private: the plugin surface is `apply`, `inject`, and the
// store factory the registration declares.
export type { EditorBodyProps, EditorInjected } from './EditorBody.tsx'
export type { EditorToolbarProps } from './EditorToolbar.tsx'
export type { EditorFindBarProps } from './EditorFindBar.tsx'
export type { EditorTabAliasProps, EditorAliasInjected } from './alias.tsx'
export type { EditorFsOps, FileSnapshot, FileStat, WriteAck } from './fsops.ts'
export type {
  EditorLoadOutcome, EditorPollOutcome, EditorSaveOutcome, EditorSaveBesideOutcome,
  PollInput, SaveBaseline, SaveInput, SaveBesideInput,
} from './machine.ts'
export type { EditorStore, EditorTabState, EditorViewState } from './store.ts'
export type { EnpoiEditorKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Editor toolbar, conflict-flow, and failure copy. */
    enpoiEditor: EnpoiEditorKey
  }
}

/** This package's copy namespace. */
const NS = 'enpoiEditor'

/** Required browser services: the slot registry, the tab registry, and copy. */
export const inject = ['slots', 'sidebarRightTabs', 'locale']

/**
 * Client plugin body: register the redirecting tab type, its dictionary, its
 * in-pane editable renderer, and the redirect body.
 * @param ctx - client root context carrying the registry, the slots, and copy.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register(editorDefinition()), 'ui-enpoi-editor: editor tab type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-enpoi-editor: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createEditorStore()
  // One stable fsops face for every occurrence; the fetch it closes over is the
  // page's own, and the routes are same-origin so no credentials ride along.
  const fs = createFsOps()
  // The redirect: the address reopens as the unified `text` pane — replacing
  // this tab in place — with the file's remembered display type set to this
  // renderer. Without the document-preview service there is nothing to open,
  // so the redirect declines and the alias renders nothing.
  const redirect = (address: string, actions: SidebarRightTabActions): boolean => {
    if (ctx.get('documentPreviews') === undefined) return false
    const file = parseFileAddress(address)
    if (file?.scope === 'session' && file.path !== '' && isEditablePath(file.path)) {
      rememberViewerByPath(file.path, EDITOR_ID)
    }
    actions.openResource(address, { replaceTab: true })
    return true
  }
  // Restored sessions and old surface records land here; nothing in the product
  // UI opens the kind anymore.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab',
      key: EDITOR_ID,
      locale: NS,
      inject: (): { redirect: typeof redirect } => ({ redirect }),
    },
    EditorTabAlias,
  )), 'ui-enpoi-editor: editor tab redirect')
  // The in-pane editable renderer belongs to the document preview package:
  // register the `editor` candidate and its keyed body only while that service
  // is present.
  ctx.inject(['documentPreviews'], (scope) => {
    scope.effect(
      () => scope.documentPreviews.register(editorPreviewDefinition(() => t('viewerTitle'))),
      'ui-enpoi-editor: preview metadata',
    )
    scope.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
      {
        name: 'sidebar.right.tab.document',
        key: EDITOR_ID,
        locale: NS,
        store,
        inject: (): EditorInjected => ({ fs }),
      },
      EditorBody,
    )), 'ui-enpoi-editor: document body')
    // The editor's controls render in the pane's single toolbar row.
    scope.effect(() => ctx.slots.inject('sidebar.right.tab.document.toolbar', () => ctx.slots.register(
      {
        name: 'sidebar.right.tab.document.toolbar',
        key: EDITOR_ID,
        locale: NS,
        store,
      },
      EditorToolbar,
    )), 'ui-enpoi-editor: document toolbar')
  })
}
