/**
 * Browser half: register `enpoi-editor` as a right-Sidebar tab type, its body,
 * and its dictionaries.
 *
 * The type reaches the Sidebar through its public path only: the definition into
 * `ctx.sidebarRightTabs`, the body into the keyed `sidebar.right.pane.tab` seat
 * under the definition's `id`, and copy into the `enpoiEditor` locale namespace.
 * Every import from another client plugin stays type-only except the allowed
 * baseline primitives.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { EDITOR_ID, editorDefinition } from './definition.ts'
import { EditorBody } from './EditorBody.tsx'
import type { EditorInjected } from './EditorBody.tsx'
import { createEditorStore } from './store.ts'
import { createFsOps } from './fsops.ts'
import { en, zh } from './locales.ts'
import type { EnpoiEditorKey } from './locales.ts'

// Values stay package-private: the plugin surface is `apply`, `inject`, and the
// store factory the registration declares.
export type { EditorBodyProps, EditorInjected } from './EditorBody.tsx'
export type { EditorFsOps, FileSnapshot, FileStat, WriteAck } from './fsops.ts'
export type {
  EditorLoadOutcome, EditorPollOutcome, EditorSaveOutcome, PollInput, SaveBaseline, SaveInput,
} from './machine.ts'
export type { EditorStore, EditorTabState } from './store.ts'
export type { EnpoiEditorKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Editor toolbar, banner, and failure copy. */
    enpoiEditor: EnpoiEditorKey
  }
}

/** This package's copy namespace. */
const NS = 'enpoiEditor'

/** Required browser services: the slot registry, the tab registry, and copy. */
export const inject = ['slots', 'sidebarRightTabs', 'locale']

/**
 * Client plugin body: register the type, its dictionary, and its keyed body.
 * @param ctx - client root context carrying the registry, the slots, and copy.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register(editorDefinition()), 'ui-enpoi-editor: editor tab type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-enpoi-editor: dictionaries')
  const store = createEditorStore()
  // One stable fsops face for every occurrence; the fetch it closes over is the
  // page's own, and the routes are same-origin so no credentials ride along.
  const fs = createFsOps()
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab',
      key: EDITOR_ID,
      locale: NS,
      store,
      inject: (): EditorInjected => ({ fs }),
    },
    EditorBody,
  )), 'ui-enpoi-editor: editor body')
}
