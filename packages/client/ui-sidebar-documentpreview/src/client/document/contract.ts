/** Document renderer slot: the owner supplies shared file state, renderers own their presentation. */
import type { PropsRuntime, SlotHookFactory } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RefCallback } from 'react'

/** One loaded text window, retaining source line positions. */
export interface DocumentTextPage {
  readonly offset: number
  readonly text: string
  readonly lines: number
}

/**
 * Ordinary file contents, or a request for the selected renderer to load its content.
 * Byte arrays are transient UI input, never persisted layout or Session data.
 */
export type DocumentContent =
  | { readonly kind: 'text'; readonly text: string; readonly pages: readonly DocumentTextPage[]; readonly eof: boolean }
  | { readonly kind: 'bytes'; readonly data: Uint8Array<ArrayBuffer> }
  | {
    readonly kind: 'renderer'
    /** Changes on reload or implementation replacement; retained contents belong to one revision. */
    readonly revision: number
    /** Report the displayed source version; stale revisions cannot update the owner. @param version - loaded source version. */
    readonly loaded: (version: string) => void
    /** End a failed load; a later file change can start another revision. */
    readonly failed: () => void
    /** Cancel the current load and start a new revision. */
    readonly reload: () => void
  }

/**
 * Navigation parameters that ask the pane to open a file as its served
 * comparison: the coordinates the change routes and the review pane address
 * the comparison by.
 */
export interface DocumentDiffParams {
  /** Sequence of the `workspace/changes` event that announced the turn. */
  readonly seq: number
  /** The file's index in that turn's summary. */
  readonly index: number
  /** The summarized turn, carried so the body can reach the aggregate review. */
  readonly turn?: number
}

/**
 * The commands a renderer-owned body offers the shared toolbar. Static
 * capability flags on the definition say whether the entries render; this
 * bridge is how the toolbar reaches the live implementation, mirroring
 * `scrollportRef`.
 */
export interface DocumentRendererCommands {
  /** Open the renderer's own find surface, when it offers one. */
  readonly find?: () => void
  /** Jump to a 1-based line the shared toolbar's field carries, when the renderer offers it. */
  readonly gotoLine?: (line: number) => void
}

/** Owner inputs of the shared toolbar's renderer-contributed segment. */
export interface DocumentToolbarOwnerProps {
  /** The display type the row is showing, so one seat serves every renderer. */
  readonly rendererId: string
  /** The row collapsed its optional actions; contributed controls should stay icon-only. */
  readonly compact: boolean
}

/** Content and viewing inputs shared by document bodies and nested PDF presentation. */
export interface DocumentBodyOwner {
  /** Observe a file read by this renderer. @param address - complete file resource address. */
  readonly addResource: (address: string) => void
  /** Replace this renderer's dependencies. @param addresses - complete file resource addresses. */
  readonly setResources: (addresses: readonly string[]) => void
  /** Original file address, also readable through the standard useResource hook. */
  readonly resourceAddress: string
  /** Ordinary file content or a renderer-owned loading request; text accumulates until eof. */
  readonly content: DocumentContent
  /** The document toolbar's current wrapping preference. */
  readonly wrap: boolean
  /** Report a renderer-owned scrollport; passing `null` restores the shared body as the owner. */
  readonly scrollportRef: RefCallback<HTMLElement>
  /** Report the renderer's toolbar commands; passing `null` withdraws them. */
  readonly commandsRef?: RefCallback<DocumentRendererCommands | null>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Document body selected by a registered implementation id. */
    'sidebar.right.tab.document': {
      kind: 'keyed'
      scope: 'session'
      owner: DocumentBodyOwner
      hookContext: UseSidebarRightTabInfo
      inject: {
        hooks: {
          tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo>
        }
      }
    }
    /**
     * Header toolbar contributions acting on the previewed file, rendered
     * after the preview's own controls once the file's Host path is known.
     */
    'sidebar.right.tab.document.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** Absolute path in the file's execution environment; native actions must verify a Host mapping. */
        readonly absolutePath: string
      }
    }
    /**
     * Empty-state contributions for a file this preview cannot render,
     * offered where Retry would stand once the file's Host path is known.
     */
    'sidebar.right.tab.document.unpreviewable': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** Absolute path in the file's execution environment; native actions must verify a Host mapping. */
        readonly absolutePath: string
      }
    }
    /** Renderer-specific controls before the document toolbar's reload button. */
    'sidebar.right.tab.document.action': {
      kind: 'keyed'
      scope: 'session'
      owner: { readonly content: DocumentContent }
      hookContext: UseSidebarRightTabInfo
      inject: { hooks: { tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> } }
    }
    /**
     * The renderer-contributed segment of the pane's single toolbar row: a
     * keyed seat under the selected display type's id, so an editor can put
     * its own save controls beside the shared actions instead of stacking a
     * second row.
     */
    'sidebar.right.tab.document.toolbar': {
      kind: 'keyed'
      scope: 'session'
      owner: DocumentToolbarOwnerProps
      hookContext: UseSidebarRightTabInfo
      inject: {
        hooks: {
          tabInfo: SlotHookFactory<'sidebar.right.tab.document.toolbar', UseSidebarRightTabInfo>
        }
      }
    }
  }
}

/** Standard input for every document body; entry-local stores and locale props can be intersected with it. */
export type DocumentPreviewProps = PropsRuntime<'sidebar.right.tab.document'>

/**
 * Forward the framework's tab reader to the selected document body.
 * @param _standard - framework standard props.
 * @param useTabInfo - enclosing tab's bound reader.
 * @returns the same reader, without another subscription adapter.
 */
export const documentTabInfoFactory: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> =
  (_standard, useTabInfo) => useTabInfo

/**
 * Forward the framework's tab reader to the selected toolbar segment.
 * @param _standard - framework standard props.
 * @param useTabInfo - enclosing tab's bound reader.
 * @returns the same reader, without another subscription adapter.
 */
export const documentToolbarTabInfoFactory: SlotHookFactory<'sidebar.right.tab.document.toolbar', UseSidebarRightTabInfo> =
  (_standard, useTabInfo) => useTabInfo
