/**
 * Deliverables plugin, browser half: registers the changed-files card and
 * delivery cards into the chat view's turn-tail list, the `changes-review`
 * right-Sidebar tab type that reviews one turn's changed files one comparison
 * at a time, and provides the `chatFileMentions` service that links
 * inline-code mentions of produced or delivered files in the closing prose.
 * All policy lives here — the supported mutation calls, mention matching, row
 * cap, and copy — so composing this plugin out of cordis.yml removes every
 * surface; the owning view renders an empty list and inert prose at zero cost.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ChatFileMentions } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { ChangesDiffStore } from './changes-diff.ts'
import { ChangesSummaryStore } from './changes-summary.ts'
import { PresentedOpenController } from './present-open.ts'
import { PresentRow } from './PresentRow.tsx'
import { DeliverablesTail, type DeliverablesInjected } from './Deliverables.tsx'
import { CHANGES_DIFF_ID, DiffPreview, changesDiffPreviewDefinition, type DiffPreviewInjected } from './diff-preview.tsx'
import { en, NS, zh, type DeliverablesKey } from './locales.ts'
import {
  deliverablesDefinition, presentedForClosing, producedFileMentions, selectProducedFiles,
} from './turn-deliverables.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Changed-files card, review tab, delivery card, and file-mention copy. */
    'deliverables': DeliverablesKey
  }
}

/** Required services for the tail-slot and comparison-renderer registrations and their dictionaries. */
export const inject = ['slots', 'locale', 'uiConversation', 'remote', 'remote.session', 'sidebarRight']

/**
 * Client plugin body: register the dictionaries, the turn-tail entry, and the comparison tab type.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const opener = new PresentedOpenController()
  const summaries = new ChangesSummaryStore()
  const diffs = new ChangesDiffStore()
  ctx.effect(() => () => Promise.all([opener.dispose(), summaries.dispose(), diffs.dispose()]))
  ctx.on('connection/reset', () => {
    opener.resetHost()
    summaries.reset()
    diffs.reset()
  })
  ctx.uiConversation.events.register(deliverablesDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-deliverables: dictionaries')
  ctx.slots.inject(
    'conversation.chat.turnTail',
    () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: '@deepseek-ai/dsh-client-ui-deliverables',
      locale: NS,
      inject: (): DeliverablesInjected => ({
        hooks: { presentedOpen: opener.state, presentedHost: opener.host, changesSummary: summaries.state },
        reloadPresentedHost: () => opener.loadHost(),
        loadChangesSummary: (sessionId, seq) => summaries.load(sessionId, seq),
        openPresented: (sessionId, seq, index, action) => opener.open(sessionId, seq, index, action),
        openChanged: (sessionId, seq, index) => opener.openChanged(sessionId, seq, index),
        openChangedDiff: (sessionId, cwd, path, seq, index, turn) => {
          ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, path), {
            params: { diff: { seq, index, turn } },
          })
        },
      }),
    }, DeliverablesTail),
  )
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'present', locale: NS }, PresentRow,
  ))
  const t = ctx.locale.bind(NS)
  // The comparison renderer belongs to the document pane's registry: it is the
  // one surface a changed file's diff opens in (the detached changes-review
  // route is retired).
  ctx.inject(['documentPreviews'], (scope) => {
    scope.effect(
      () => scope.documentPreviews.register(changesDiffPreviewDefinition(() => t('diffView.title'))),
      'ui-deliverables: diff preview metadata',
    )
    scope.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
      {
        name: 'sidebar.right.tab.document', key: CHANGES_DIFF_ID, locale: NS,
        inject: (): DiffPreviewInjected => ({
          hooks: { changesDiff: diffs.state },
          loadChangesDiff: (sessionId, seq, index) => diffs.load(sessionId, seq, index),
        }),
      },
      DiffPreview,
    )), 'ui-deliverables: diff preview body')
  })
  // The prose side of the same vocabulary: the chat view reaches this face
  // via ctx.get, so its absence — this plugin composed out — is the off state.
  const mentions: ChatFileMentions = {
    forClosing(owner) {
      const paths = selectProducedFiles(owner)
      const presented = presentedForClosing(owner)
      if (paths === null && presented.length === 0) return undefined
      return producedFileMentions([...new Set([...paths ?? [], ...presented.map(file => file.path)])], owner.openFile,
        path => t('presented.previewButton', { name: path }))
    },
  }
  ctx.provide('chatFileMentions', mentions)
}
