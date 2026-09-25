/**
 * Browser half: register `text` as a right-Sidebar tab type.
 *
 * The type reaches the Sidebar through its public path only: the definition into
 * `ctx.sidebarRightTabs`, the body into the keyed `sidebar.right.pane.tab`
 * seat, and the chip title into `sidebar.right.pane.tab.title`, both under the
 * definition's `id`. Nothing here reaches into the Sidebar's store, its
 * panes, or its sequence. The file's metadata comes from the standard
 * `useResource`, served by the `file` provider; the content is this type's own
 * business, read through its face. Every import from another
 * client plugin is a type.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { WorkspaceFileParams } from '@deepseek-ai/dsh-api-workspace-files/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TextPreview } from './TextPreview.tsx'
import type { TextPreviewInjected } from './TextPreview.tsx'
import { TextTitle } from './TextTitle.tsx'
import { TEXTPREVIEW_ID, textDefinition } from './definition.ts'
import { textFace } from './face.ts'
import { createReadPage } from './rpc.ts'
import { createTextStore } from './store.ts'
import { en, zh } from './locales.ts'
import { DocumentPreviewRegistry } from './document/registry.ts'
import { documentTabInfoFactory, documentToolbarTabInfoFactory } from './document/contract.ts'
import { apply as registerText } from './text/index.ts'
import { apply as registerMarkdown } from './markdown/index.ts'
import { apply as registerHtml } from './html/index.ts'
import { apply as registerImage } from './image/index.ts'
import { apply as registerPdf } from './pdf/index.ts'
import { apply as registerCode } from './code/index.ts'
import { apply as registerOffice } from './office/index.ts'
import { apply as registerExcel } from './excel/index.ts'
import { Config } from '../config.ts'

// Values stay package-private unless another package needs them; the plugin
// surface is `apply`, `inject`, and the store factory another registration may
// share, plus the types a consumer of the seat or the store names.
export type { SidebarDocumentPreviewKey } from './locales.ts'
export type { TextPreviewProps } from './TextPreview.tsx'
export type { TextInjected } from './face.ts'
export type { ReadDocumentBytes, DocumentFileBytes, ReadWorkspaceFilePage, SessionFile, WorkspaceFilesReadRemote } from './rpc.ts'
export type { TextPage, TextState, TextStore, TextTabState } from './store.ts'
export type { DocumentContent, DocumentDiffParams, DocumentPreviewProps, DocumentRendererCommands, DocumentTextPage } from './document/contract.ts'
export type { DocumentLoadMode, DocumentPreviewCapabilities, DocumentPreviewDefinition } from './document/registry.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** File-extension renderer registrations, independent from their keyed document bodies. */
    documentPreviews: DocumentPreviewRegistry
  }
}

/** This package's copy namespace. */
const NS = 'sidebarDocumentPreview'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /**
     * File line navigation supported by the text preview, plus the comparison
     * coordinates that select the diff renderer instead of the suffix-derived
     * one.
     */
    file: WorkspaceFileParams & { diff?: import('./document/contract.ts').DocumentDiffParams }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Text-preview progress, paging, change, control, and failure lines. */
    sidebarDocumentPreview: import('./locales.ts').SidebarDocumentPreviewKey
  }
}

/**
 * Required browser services: the tab registry, the slot registry, copy, and the
 * Remote carrier with its `workspaceFiles` namespace.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles', 'resources']

/**
 * Client plugin body: register the type, its dictionaries, its body, and its chip title.
 * @param ctx - client root context carrying the registry, the slots, copy, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  const config = Config((globalThis as { __DSH_DOCUMENT_PREVIEW_CONFIG__?: unknown }).__DSH_DOCUMENT_PREVIEW_CONFIG__ ?? {})
  const previews = new DocumentPreviewRegistry()
  const disposePreviews = ctx.reflect.provide('documentPreviews', previews)
  ctx.effect(() => disposePreviews)
  ctx.effect(() => ctx.sidebarRightTabs.register(textDefinition()), 'ui-sidebar-documentpreview: text type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-documentpreview: dictionaries')

  const store = createTextStore()
  const face = textFace(
    createReadPage(ctx.remote),
    (file, signal) => ctx.remote.workspaceFiles.readBytes(file.sessionId, file.path, {}, signal),
    ctx.resources,
  )
  const source = { getSnapshot: previews.getSnapshot, subscribe: previews.subscribe }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab', key: TEXTPREVIEW_ID, locale: NS, store,
      children: {
        'sidebar.right.tab.document': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: documentTabInfoFactory } } },
        'sidebar.right.tab.document.actions': { kind: 'list', scope: 'session' },
        'sidebar.right.tab.document.unpreviewable': { kind: 'list', scope: 'session' },
        'sidebar.right.tab.document.action': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: documentTabInfoFactory } } },
        'sidebar.right.tab.document.toolbar': {
          kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: documentToolbarTabInfoFactory } },
        },
      },
      inject: (sessionId, actions): TextPreviewInjected => ({
        ...face(sessionId, actions), hooks: { documentPreviews: source },
        // The copy action's fallback for renderer-owned views: one complete
        // Host read, decoded as UTF-8. A failure surfaces as the toolbar's
        // copy-failure flash.
        readAllText: async (file) => {
          // The address is a string boundary: its id segment is the Session id it names.
          const result = await ctx.remote.workspaceFiles.readBytes(file.sessionId as SessionId, file.path, {})
          if (!result.ok) throw new Error(result.error.code)
          return new TextDecoder().decode(result.value.data)
        },
      }),
    },
    TextPreview,
  )), 'ui-sidebar-documentpreview: text body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TEXTPREVIEW_ID },
    TextTitle,
  )), 'ui-sidebar-documentpreview: text title')
  registerText(ctx)
  registerMarkdown(ctx)
  registerHtml(ctx)
  registerImage(ctx)
  registerPdf(ctx)
  // Specialized parse-first renderers register before the shared highlighter:
  // the registry keeps the earlier claimant and Code offers its suffixes as a
  // later candidate.
  registerOffice(ctx, config.office)
  registerExcel(ctx, config.excel)
  registerCode(ctx)
}
