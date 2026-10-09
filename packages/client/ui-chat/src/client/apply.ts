/** Register the Chat Conversation target, renderers, stats, and details surface. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { GroupKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightResourceParamsMap } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RevertDockInjected } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// The `file` entry of `SidebarRightResourceParamsMap`, which types `{ params: { line } }` below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
// Type-only service and declaration merges used by the apply world.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  ChatNodeInjected, ChatScrollPosition, ChatViewInjected, OpenFileOptions, QuotaNoticeInjected, QuotaNoticeState, TurnTailOwnerProps,
} from './contract/slots.ts'
import type { ChatSnapshot } from './contract/snapshot.ts'
import { EMPTY_CHAT_SNAPSHOT } from './contract/snapshot.ts'
import { ApprovalCommand } from './chat/ApprovalCommand.tsx'
import { ChatView } from './chat/ChatView.tsx'
import { registerChatNodeRenderers } from './chat/register-node-renderers.ts'
import { StatsPills } from './chat/StatsPills.tsx'
import { registerConversationNodes } from './conversation-nodes/register.ts'
import { RevertTray } from './chat/RevertTray.tsx'
import { QuotaNoticeHost } from './chat/QuotaNoticeHost.tsx'
import { en, NS, zh } from './locale.ts'
import { TranscriptViewRow, type TranscriptViewRowInjected } from './settings/TranscriptViewRow.tsx'
import { createChatStore } from './stores.ts'
import { TranscriptViewPolicy } from './transcript-view.ts'
import { derivePresentationPolicy } from './presentation-policy.ts'
import { CHAT_SETTINGS_NAMESPACE, DEFAULT_LINK_OPENING, type ChatSettings } from '../chat-settings.ts'
import { LinkOpeningRow, type LinkOpeningRowInjected } from './settings/LinkOpeningRow.tsx'
import { PerformanceUsageRow, type PerformanceUsageRowInjected } from './settings/PerformanceUsageRow.tsx'
import { PerformanceUsagePolicy } from './performance-usage.ts'
import { useTurnDataValue } from './chat/use-turn-data.ts'
import { bindDisclosure } from './chat/use-disclosure.ts'

const CHAT_NODE_INJECT: ChatNodeInjected = {
  hooks: {
    turnData: (_standard, { turnData }) => function useTurnData(key) {
      return useTurnDataValue(turnData, key)
    },
    disclosure: (_standard, { disclosureReset }) => bindDisclosure(disclosureReset),
  },
}

/** Services required by the Chat target and its presentation registrations. */
export const inject = [
  'slots', 'sessions', 'uiWorkspace', 'uiSession', 'uiConversation', 'locale',
  'configForms', 'remote', 'remote.session', 'sidebarRight',
]

/**
 * Mount all Chat-owned contributions.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  // The one way a file opens from the chat side: the same file address and the
  // same navigation parameters for every entry point (a prose mention, a tool
  // row, the revert tray), so they can never disagree about where the file
  // lands. The Sidebar's registry decides which surface claims the address.
  const openFile = async (sessionId: SessionId, path: string, options?: OpenFileOptions): Promise<void> => {
    const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
    const url = fileAddressFor(sessionId, cwd, path)
    // Line navigation and the diff request ride the file resource's params; a
    // plain open carries none, so the file's remembered display type applies.
    const params: SidebarRightResourceParamsMap['file'] = {
      ...options?.line === undefined ? {} : { line: options.line },
      ...options?.diff === undefined ? {} : { diff: options.diff },
    }
    if (Object.keys(params).length === 0) ctx.sidebarRight.openResource(url)
    else ctx.sidebarRight.openResource(url, { params })
    await Promise.resolve()
  }
  const quotaNotice = createSnapshotStore<QuotaNoticeState | null>(null)
  let quotaNoticeSeq = 0
  // Each hold is its own token, so a release can only drop the hold it was
  // issued for: one arriving after a dismissal or a later acquisition leaves
  // that newer hold alone.
  const quotaNoticeHolds = new Set<symbol>()
  const chatSources = new WeakMap<SessionBinding, ObservableSnapshot<ChatSnapshot>>()
  const quotaSubscriptions = new Set<() => Promise<void>>()
  ctx.effect(() => async () => {
    await Promise.all([...quotaSubscriptions].map(dispose => dispose()))
  }, 'ui-chat: live quota notices')
  const chatSource = (binding: SessionBinding): ObservableSnapshot<ChatSnapshot> => {
    let source = chatSources.get(binding)
    if (source === undefined) {
      // One live quota failure publishes one frame-wide notice; history
      // replacement or paging never does, because an old failure scrolling
      // back into view is not news.
      const dispose = binding.ctx.effect(() => {
        const stop = binding.eventSource.subscribe(() => {
          const { change } = binding.eventSource.getSnapshot()
          if (change.kind !== 'append') return
          for (const { event } of change.entries) {
            if (event.type !== 'turn/end' || event.data.reason.kind !== 'error') continue
            const { code } = event.data.reason.error
            if (quotaNoticeHolds.size > 0 || (code !== 'QUOTA' && code !== 'ACCOUNT_QUOTA')) continue
            quotaNotice.set({ code, seq: ++quotaNoticeSeq })
          }
        })
        return () => {
          stop()
          chatSources.delete(binding)
          quotaSubscriptions.delete(dispose)
        }
      }, 'ui-chat: Provider binding quota notices')
      quotaSubscriptions.add(dispose)
      const target = ctx.uiConversation.binding(binding).target('chat')
      source = {
        getSnapshot: () => target.getSnapshot() ?? EMPTY_CHAT_SNAPSHOT,
        subscribe: listener => target.subscribe(listener),
      }
      chatSources.set(binding, source)
    }
    return source
  }
  registerConversationNodes(ctx)
  ctx.uiSession.provide({
    hooks: ['chat'],
    resolve: binding => ({ hooks: { chat: chatSource(binding) } }),
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chat: dictionaries')
  const t = ctx.locale.bind(NS)
  const chatStore = createChatStore()
  const chatScrollPositions = new Map<SessionId, ChatScrollPosition>()
  const chatSettings = ctx.configForms.get<ChatSettings>(CHAT_SETTINGS_NAMESPACE)
  const linkOpening = createSnapshotStore(chatSettings.getSnapshot().value?.linkOpening ?? DEFAULT_LINK_OPENING)
  ctx.effect(() => chatSettings.subscribe(() => {
    const accepted = chatSettings.getSnapshot().value?.linkOpening
    if (accepted !== undefined) linkOpening.set(accepted)
  }))
  ctx.inject(['sidebarRightTabs'], (scope) => {
    const tabs = scope.sidebarRightTabs
    const browserAvailable: ObservableSnapshot<boolean> = {
      getSnapshot: () => tabs.get('browser') !== undefined,
      subscribe: listener => tabs.subscribe(listener),
    }
    scope.slots.inject('settings.general.item', () => scope.slots.register({
      name: 'settings.general.item',
      id: 'link-opening',
      order: 14,
      locale: NS,
      inject: (): LinkOpeningRowInjected => ({
        hooks: { linkOpening, browserAvailable },
        setLinkOpening: (destination) => {
          linkOpening.set(destination)
          void chatSettings.set('linkOpening', destination).catch((_error: unknown) => {
            // The local choice remains usable when persistence is unavailable.
          })
        },
      }),
    }, LinkOpeningRow))
  })
  const transcriptView = new TranscriptViewPolicy(chatSettings)
  const presentation = derivePresentationPolicy(transcriptView.mode)
  const performancePolicy = new PerformanceUsagePolicy(chatSettings)
  ctx.effect(() => () => { transcriptView.dispose(); performancePolicy.dispose() })
  const performanceUsage = performancePolicy.mode
  registerChatNodeRenderers(ctx, performanceUsage, presentation)

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'performance-usage',
    order: 13,
    locale: NS,
    inject: (): PerformanceUsageRowInjected => ({
      hooks: { performanceUsage },
      setPerformanceUsage: (mode) => { performancePolicy.setMode(mode) },
    }),
  }, PerformanceUsageRow))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'transcript-view',
    order: 12,
    locale: NS,
    inject: (): TranscriptViewRowInjected => ({
      hooks: { transcriptView: transcriptView.mode },
      setTranscriptView: (mode) => { transcriptView.setMode(mode) },
    }),
  }, TranscriptViewRow))

  ctx.slots.inject('conversation.view', () => {
    const disposeView = ctx.slots.register({
      name: 'conversation.view',
      id: 'chat',
      order: 0,
      label: () => t('view.chat'),
      locale: NS,
      children: {
        'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
        'conversation.message.images': { kind: 'single', scope: 'session' },
      },
      store: chatStore,
      inject: (sessionId: SessionId): ChatViewInjected => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) throw new Error(`ui-chat: unknown session "${sessionId}"`)
        const session = binding.session
        const chat = chatSource(binding)
        const conversation = ctx.uiConversation.binding(binding)
        return {
          hooks: { presentation },
          keyedHooks: {
            chatNode: key => chat.getSnapshot().nodes.source(key),
            chatNodeProcess: key => chat.getSnapshot().nodes.processSource(key),
            chatGroup: key => conversation.snapshot.getSnapshot().views.grouped('chat')?.groupSource(key as GroupKey),
          },
          fileMentions: (owner: TurnTailOwnerProps) => ctx.get('chatFileMentions')?.forClosing(owner, sessionId),
          // Files open in the right Sidebar, not in a desktop application: the
          // content stays in the product, beside the conversation that produced
          // it. The canonical opener carries the file address and its
          // navigation parameters; the Sidebar decides which surface claims it.
          openFile: (path, options) => openFile(sessionId, path, options),
          openSkill: (name) => {
            const scope = ctx.sessions.scope(sessionId)
            if (scope === undefined) return
            ctx.get('inputTriggers')?.sessionOf(scope).openReference('skill', { ref: `/${name}` })
          },
          openExternalLink: (url) => {
            if (linkOpening.getSnapshot() === 'sidebar' && ctx.get('sidebarRightTabs')?.get('browser') !== undefined) {
              ctx.sidebarRight.openTab('browser', { params: { url } })
            } else {
              window.open(url, '_blank', 'noopener,noreferrer')
            }
          },
          loadOlder: () => { void session.loadOlder() },
          loadThrough: seq => session.loadThrough(seq),
          loadImage: Object.assign(
            (attachment: ImageAttachmentRef) => ctx.uiConversation.imageUrl(sessionId, attachment),
            { peek: (attachment: ImageAttachmentRef) => ctx.uiConversation.peekImageUrl(sessionId, attachment) },
          ),
          chatScroll: {
            save: (position) => {
              if (position === null) chatScrollPositions.delete(sessionId)
              else chatScrollPositions.set(sessionId, position)
            },
            read: () => chatScrollPositions.get(sessionId) ?? null,
          },
          forkAt: (seq) => {
            ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
              .then((childId) => { ctx.uiWorkspace.openSession(childId) })
              .catch(() => {
                // Fork or child-title failure leaves the source view unchanged.
              })
          },
          revertAt: (seq: number) => {
            void ctx.sessions.revert({ sessionId, atSeq: seq })
              .then(({ revertedText }) => {
                // Populate the composer draft with the reverted query so the
                // textarea updates live (the reverted text re-enters input).
                const scoped = ctx.sessions.scope(sessionId)
                if (scoped !== undefined) {
                  const conversation = scoped.get('conversation')
                  conversation?.input.for(scoped).setDraft(revertedText)
                }
              })
              .catch((error: unknown) => {
                // Surface the failure (e.g. the message is compaction-shadowed).
                console.error('revert failed', error)
              })
          },
          loadIterationPreviews: (anchorSeq: number) =>
            ctx.sessions.revertIterations({ sessionId, anchorSeq }),
          restoreIteration: (variantSeq: number) =>
            ctx.sessions.revertIterationRestore({ sessionId, variantSeq }),
        }
      },
    }, ChatView)
    return disposeView
  })

  // The quota notice host lives in the frame-wide layer so a notice outlives
  // the Chat panel that reported it. Its chain child lets a package with a
  // billing surface claim the one live notice without importing Chat.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'chat.quota-notice', locale: NS,
    children: { 'shell.quota-notice': { kind: 'chain', scope: 'root' } },
    inject: (): QuotaNoticeInjected => ({
      hooks: { notice: quotaNotice },
      dismissNotice: () => { quotaNoticeHolds.clear(); quotaNotice.set(null) },
      keepNoticeOpen: () => {
        // Nothing live to retain: later failures must still publish.
        if (quotaNotice.getSnapshot() === null) return () => {}
        const token = Symbol('ui-chat quota notice hold')
        quotaNoticeHolds.add(token)
        return () => { quotaNoticeHolds.delete(token) }
      },
    }),
  }, QuotaNoticeHost))

  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock', id: 'stats', order: 0, locale: NS,
      inject: () => ({ hooks: { performanceUsage } }),
    }, StatsPills))

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({
      name: 'conversation.input.dock', id: 'revert-tray', order: 5, locale: 'conversation',
      inject: (sessionId: SessionId): RevertDockInjected => ({
        revertRestore: (restoreSeq) => {
          void ctx.sessions.revertRestore({
            sessionId,
            ...restoreSeq === undefined ? {} : { restoreSeq },
          }).catch((error: unknown) => { console.error('revert restore failed', error) })
        },
        forkAt: (seq) => {
          ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
            .then((childId) => { ctx.uiWorkspace.openSession(childId) })
            .catch(() => { /* Fork failure leaves the source view unchanged. */ })
        },
        openFile: path => openFile(sessionId, path),
        resolveFileConflict: async (conflictId, resolution) => {
          await ctx.sessions.resolveFileConflict({ sessionId, conflictId, resolution })
        },
      }),
    }, RevertTray))

  ctx.slots.inject('conversation.approval.detail', () =>
    ctx.slots.register({ name: 'conversation.approval.detail', locale: NS }, ApprovalCommand))

}
