/**
 * The operator-document door the settings action opens through.
 *
 * Three steps: ask the fenced `/sidebar/fsops/settings.document` route for the
 * host's own document location, close Settings, then reveal the document in the
 * right Sidebar — the files page rooted at the document's containing directory,
 * and the document itself in the preview/editor pane beside it. The route
 * derives the document from the live settings provider and grants that one
 * directory; no caller input can widen it, and the agents' tool path never
 * passes through these routes.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
// Type-only: pulls the ctx.sidebarRight / ctx.sessions service declarations and
// the `files` page navigation parameters this door names.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type { SettingsDocumentLocation, SettingsDocumentView } from './settings-document-store.ts'

/** One fenced-route answer, as the fs routes emit it. */
interface FsRouteEnvelope {
  readonly ok?: boolean
  readonly value?: { readonly path?: unknown; readonly root?: unknown }
  readonly error?: { readonly message?: unknown }
}

/**
 * Ask the host for the operator document location.
 * @returns the document path and its containing directory.
 * @throws when the route refuses or the provider has no document.
 */
async function locateDocument(): Promise<SettingsDocumentLocation> {
  let response: Response
  try {
    response = await fetch('/sidebar/fsops/settings.document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  } catch (error: unknown) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  const parsed = await response.json().catch(() => null) as FsRouteEnvelope | null
  const path = parsed?.value?.path
  const root = parsed?.value?.root
  if (!response.ok || parsed?.ok !== true || typeof path !== 'string' || typeof root !== 'string') {
    throw new Error(typeof parsed?.error?.message === 'string' ? parsed.error.message : `HTTP ${response.status}`)
  }
  return { path, root }
}

/**
 * Build the door over the client context.
 * @param ctx - client root context carrying the right Sidebar and the session catalog.
 * @param close - the Settings shell's close action.
 * @returns the door the document store orchestrates.
 */
export function createSettingsDocumentView(ctx: ClientContext, close: () => void): SettingsDocumentView {
  return {
    close,
    sessionId: () => {
      const mounted = ctx.get('sidebarRight')?.mounted.getSnapshot()
      if (mounted !== undefined) return mounted
      // No seat is mounted yet (a fresh home before its first session): the
      // newest catalog row is the session the seat would bind.
      return ctx.get('sessions')?.list.getSnapshot().ids[0]
    },
    locate: locateDocument,
    reveal: (sessionId: SessionId, document: SettingsDocumentLocation) => {
      const sidebar = ctx.get('sidebarRight')
      if (sidebar === undefined) throw new Error('the right sidebar is unavailable')
      // The page first: the tree is the anchor every file open lands beside.
      sidebar.openTab('files', { params: { root: document.root } })
      sidebar.openResource(sessionFileAddress(sessionId, document.path))
    },
  }
}
