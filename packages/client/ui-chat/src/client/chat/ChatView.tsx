// An enclosing `[data-conversation-scroll]` owns scrolling when present;
// otherwise this view owns it. Each row subscribes to one stable node key.

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import type {
  NodeKey, RenderEntry, RenderMessageImages,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  Button, IconChevronDownOutlineRegular, MarkdownDelegateProvider, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, OpenFileOptions } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import {
  buildChatVirtualItems, chatVirtualItemKey, CHAT_VIRTUALIZATION_THRESHOLD,
  CHAT_VIRTUAL_INITIAL_VIEWPORT_HEIGHT, CHAT_VIRTUAL_OVERSCAN,
  estimateChatVirtualHeight, openTurnProcessTail, type ChatVirtualItem,
} from './chat-virtual-items.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { TurnNavigator } from './TurnNavigator.tsx'
import { mergeTurnRailItems } from './turn-rail-items.ts'
import { useChatScroll } from './use-chat-scroll.ts'
import type { ChatVirtualWindow } from './use-chat-viewport.ts'
import { fileMediaUrl, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import css from './ChatView.module.css'

/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
function openFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? fallback : message
}

/**
 * Durable input identities suppress matching echoes in the same render.
 * The last input's Turn also distinguishes an empty opening control from
 * one whose human input or trigger notice is already present.
 */
function observedInputs(
  order: readonly string[],
  nodes: ChatSnapshot['nodes'],
): { readonly rpcIds: ReadonlySet<string>; readonly lastInputTurn: number | undefined } {
  const observed = new Set<string>()
  let lastInputTurn: number | undefined
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering' && node.kind !== 'turn-trigger')) continue
    if (node.location.kind === 'turn' || node.location.kind === 'step') lastInputTurn = node.location.turn.turn
    if (node.kind === 'turn-trigger') continue
    const source = (node.data as { readonly source?: unknown }).source as
      | { readonly kind?: unknown; readonly rpcId?: unknown }
      | undefined
    if (source?.kind === 'user' && typeof source.rpcId === 'string') observed.add(source.rpcId)
  }
  return { rpcIds: observed, lastInputTurn }
}

type PendingInput = PendingSubmission | InboxState['next-step'][number]

/** Stable empty list for snapshots that predate the iteration block. */
const EMPTY_ITERATION_EDGES: readonly never[] = []

/**
 * Measured height of one virtual row, including its leading CSS margin.
 * The flow gap lives in `margin-top`; folding it into the measured size keeps
 * the virtualizer's offsets aligned with the rendered flow for both the 16px
 * rhythm and the compact-answer 8px rhythm.
 */
function measureChatRow(element: Element): number {
  const height = element.getBoundingClientRect().height
  const margin = Number.parseFloat(window.getComputedStyle(element).marginTop)
  return height + (Number.isFinite(margin) ? margin : 0)
}

/** The `data-chat-anchor-key` one render entry publishes. */
function chatAnchorKey(entry: RenderEntry): string {
  if (entry.kind === 'group') return `group:${entry.key}`
  return entry.groupPart === undefined || entry.groupPart === 'response'
    ? entry.key
    : JSON.stringify([entry.key, entry.groupPart])
}

/** The loaded Turn one virtual item belongs to, when it has one. */
function itemTurn(item: ChatVirtualItem | undefined, nodes: ChatSnapshot['nodes']): number | null {
  if (item?.kind !== 'entry' || item.entry.kind !== 'node') return null
  const location = nodes.get(item.entry.key)?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : null
}

function ChatVirtualRow({ item, index, measureRef, useChatGroup, ...seatProps }: Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey' | 'groupPart'> & {
  readonly item: ChatVirtualItem
  readonly index: number | undefined
  readonly measureRef: ((element: HTMLElement | null) => void) | undefined
  readonly useChatGroup: ChatViewSlotProps['useChatGroup']
}) {
  if (item.kind === 'entry') {
    switch (item.entry.kind) {
      case 'node':
        return <ChatNodeSeat {...seatProps} measureRef={measureRef} dataIndex={index} nodeKey={item.entry.key}
          {...item.entry.groupPart === undefined ? {} : { groupPart: item.entry.groupPart }} />
      case 'group':
        return <ChatGroupSeat {...seatProps} measureRef={measureRef} dataIndex={index}
          groupKey={item.entry.key} useChatGroup={useChatGroup} />
      default:
        return assertNever(item.entry)
    }
  }
  // An empty opening control follows one local transcript echo, never steering.
  // All rows share this keyed list so inserting the control keeps the echo mounted.
  const bubble = 'requestId' in item.input ? (
    <PendingSubmissionBubble submission={item.input}
      renderMessageImages={seatProps.renderMessageImages} t={seatProps.t} />
  ) : (
    <PendingSteeringBubble content={item.input.content}
      renderMessageImages={seatProps.renderMessageImages} t={seatProps.t} />
  )
  return measureRef === undefined
    ? bubble
    : <div ref={measureRef} data-index={index} className={css.flowItem}>{bubble}</div>
}

/** Stable empty window for snapshots that render the plain list. */
const EMPTY_VIRTUAL_ITEMS: readonly VirtualItem[] = []

type ChatNodeListProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey' | 'groupPart'> & {
  readonly useChatGroup: ChatViewSlotProps['useChatGroup']
  readonly items: readonly ChatVirtualItem[]
  readonly virtualize: boolean
  readonly virtualItems: readonly VirtualItem[]
  readonly virtualTotalSize: number
  readonly scrollMargin: number
  readonly measureElement: (element: HTMLElement | null) => void
}

const ChatNodeList = memo(function ChatNodeList({
  items, virtualize, virtualItems, virtualTotalSize, scrollMargin, measureElement, useChatGroup, ...seatProps
}: ChatNodeListProps) {
  const rows = virtualize
    ? virtualItems.flatMap((virtualItem) => {
      const item = items[virtualItem.index]
      return item === undefined ? [] : [(
        <ChatVirtualRow {...seatProps} useChatGroup={useChatGroup} key={chatVirtualItemKey(item)} item={item}
          index={virtualItem.index} measureRef={measureElement} />
      )]
    })
    : items.map(item => (
      <ChatVirtualRow {...seatProps} useChatGroup={useChatGroup} key={chatVirtualItemKey(item)} item={item}
        index={undefined} measureRef={undefined} />
    ))
  const first = virtualItems[0]
  const last = virtualItems.at(-1)
  const topPad = first === undefined ? 0 : Math.max(0, first.start - scrollMargin)
  const bottomPad = last === undefined ? 0 : Math.max(0, virtualTotalSize + scrollMargin - last.end)
  return (
    <>
      {topPad > 0 && (
        <div className={css.virtualSpacer} data-chat-virtual-spacer="top"
          style={{ height: `${topPad}px`, marginTop: 0 }} aria-hidden="true" />
      )}
      {rows}
      {bottomPad > 0 && (
        <div className={css.virtualSpacer} data-chat-virtual-spacer="bottom"
          style={{ height: `${bottomPad}px`, marginTop: 0 }} aria-hidden="true" />
      )}
    </>
  )
})

/**
 * Filtered-node fallback anchor. Once a revert boundary or shadow range is
 * active, a key that no longer resolves in the node store cannot be proven to
 * sit outside the hidden spans, so the filter drops it instead of rendering a
 * withdrawn node. Named so the drop stays a deliberate decision, never an
 * accidental `undefined` comparison.
 */
const UNRESOLVED_NODE_ANCHOR = Number.POSITIVE_INFINITY

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useChat, useChatNode, useChatNodeProcess, useChatGroup, useConversation, useSessions, useStore, actions, renderSlot,
  sessionId, openFile, openSkill, openExternalLink, loadOlder, loadThrough, loadImage, inspectCall, chatScroll, forkAt, revertAt,
  loadIterationPreviews, restoreIteration,
  fileMentions, usePresentation, useProjection, t,
}: ChatViewSlotProps) {
  const order = useChat(s => s.order)
  const nodeStore = useChat(s => s.nodes)
  const revertFromSeq = useSession(s => s.revertFromSeq)
  const revertShadowRanges = useSession(s => s.revertShadowRanges)
  // Older fixtures and legacy transports may omit the iteration block.
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- wire compatibility
  const iterationEdges = useSession(s => s.revertIterations ?? EMPTY_ITERATION_EDGES)
  // Every variant seq resolves to its group, so the visible node of a group
  // finds the navigator data without a second lookup channel.
  const iterationGroups = useMemo(() => {
    const groups = new Map<number, (typeof iterationEdges)[number]>()
    for (const edge of iterationEdges) {
      for (const variant of edge.variants) groups.set(variant.seq, edge)
    }
    return groups
  }, [iterationEdges])
  // Revert boundary: hide nodes after the reverted-from message from the
  // transcript (the RevertTray reads them from the store directly), plus the
  // spans shadowed by landed revert-commits (stay hidden after commit).
  const visibleOrder = useMemo(() => {
    const ranges = revertShadowRanges
    if (revertFromSeq === null && ranges.length === 0) return order
    return order.filter((key) => {
      const anchorSeq = nodeStore.get(key)?.anchorSeq ?? UNRESOLVED_NODE_ANCHOR
      // Strictly less: the boundary message itself is reverted (its text went
      // into the input card), so it hides with the span after it.
      if (revertFromSeq !== null && anchorSeq >= revertFromSeq) return false
      for (const range of ranges) {
        if (anchorSeq >= range.start && anchorSeq < range.end) return false
      }
      return true
    })
  }, [order, nodeStore, revertFromSeq, revertShadowRanges])
  const groupedEntries = useConversation(snapshot => snapshot.views.grouped('chat')?.entries)
  // A revert boundary falls back to the flat order: a group's members are
  // observed by its own seat, so a partially hidden group cannot be sliced here.
  const entries = useMemo<readonly RenderEntry[]>(() => visibleOrder === order && groupedEntries !== undefined
    ? groupedEntries
    : visibleOrder.map(key => ({ kind: 'node', key: key as NodeKey })), [groupedEntries, visibleOrder, order])
  // The rail's items are accumulated in the Chat snapshot, so this selector is
  // both the data and its change signal: the array identity moves only when a
  // Turn enters, leaves, or changes its preview.
  const turnNavigationItems = useChat(s => s.navigation.items())
  // Host-computed whole-log outline; the merge is view-layer only (the
  // conversation snapshot never carries projection values).
  const turnOutline = useProjection('turnOutline')
  const railItems = useMemo(
    () => mergeTurnRailItems(turnNavigationItems, turnOutline),
    [turnNavigationItems, turnOutline],
  )
  const inbox = useProjection('inbox') as unknown as InboxState | undefined
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const fileImages = useMemo(() => ({
    resolve: (path: string) => fileMediaUrl(document.baseURI, resolveWorkspacePath(cwd, path)),
    labels: {
      open: t('image.open'), loading: t('image.loading'), failed: t('image.failed'),
      dialog: t('image.dialog'), close: t('image.close'),
    },
  }), [cwd, t])
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const [fileOpenError, setFileOpenError] = useState<{ path: string; message: string } | null>(null)
  const [fileOpenBusy, setFileOpenBusy] = useState(false)
  // Close/retry must ignore a settlement that started before the latest
  // gesture; otherwise a cancelled in-flight refusal reopens the dialog.
  const fileOpenRequest = useRef(0)

  const requestOpenFile = useCallback((path: string, options?: OpenFileOptions) => {
    const id = ++fileOpenRequest.current
    setFileOpenBusy(true)
    void (options === undefined ? openFile(path) : openFile(path, options)).then(
      () => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError(null)
        setFileOpenBusy(false)
      },
      (error: unknown) => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError({
          path,
          message: openFailureMessage(
            error,
            t('fileOpen.unknown'),
          ),
        })
        setFileOpenBusy(false)
      },
    )
  }, [openFile, t])

  const closeFileOpenError = useCallback(() => {
    fileOpenRequest.current += 1
    setFileOpenError(null)
    setFileOpenBusy(false)
  }, [])

  const inboxSteering = useMemo(
    () => inbox?.['next-step'].filter(message => message.source.kind === 'user') ?? [],
    [inbox],
  )
  const pendingSubmissions = useSession(s => s.pendingSubmissions)
  // Submission echoes still awaiting their durable counterpart. `order` is the
  // recompute trigger: durable user material always arrives as an append, and
  // every append replaces the order array.
  const [visibleSubmissions, lastInputTurn] = useMemo(() => {
    if (pendingSubmissions.length === 0) return [pendingSubmissions, undefined] as const
    const observed = observedInputs(order, nodeStore)
    return [pendingSubmissions.filter(submission => (
      submission.placement !== 'queued' && !observed.rpcIds.has(submission.requestId)
    )), observed.lastInputTurn] as const
  }, [pendingSubmissions, order, nodeStore])
  const pendingInputs = useMemo(() => {
    const local = new Map(visibleSubmissions.map(submission => [submission.requestId, submission]))
    // Admitted local identities outlive their bubbles until the Inbox claim watermark.
    const localIds = new Set(pendingSubmissions.filter(submission => submission.placement !== 'queued')
      .map(submission => submission.requestId))
    const pending = inboxSteering.flatMap<PendingInput>((item) => {
      const source = item.source
      if (source.kind !== 'user' || !('rpcId' in source)) return [item]
      const submission = local.get(source.rpcId)
      if (submission === undefined) return localIds.has(source.rpcId) ? [] : [item]
      local.delete(source.rpcId)
      return [submission]
    })
    return [...pending, ...local.values()]
  }, [inboxSteering, pendingSubmissions, visibleSubmissions])
  const renderMessageImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.message.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )

  const firstKey = visibleOrder[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = visibleOrder.at(-1) ?? null
  const latestSteering = pendingInputs.findLast(item => 'source' in item)
  const steeringId = latestSteering?.source.kind === 'user' && 'rpcId' in latestSteering.source
    ? latestSteering.source.rpcId : latestSteering?.id ?? null
  const scroll = useChatScroll({
    ready: openState === 'open',
    order: visibleOrder, firstSeq, lastKey, running, loadingOlder, hasMore, chatScroll, loadOlder, loadThrough,
    lastIsUser: lastKey !== null && nodeStore.get(lastKey)?.kind === 'user',
    steeringId,
    submissionId: visibleSubmissions.at(-1)?.requestId ?? null,
    loadedTurns: turnNavigationItems,
  })

  const items = useMemo(
    () => buildChatVirtualItems(entries, pendingInputs, openTurnProcessTail(entries, nodeStore, lastInputTurn)),
    [entries, pendingInputs, nodeStore, lastInputTurn],
  )
  const virtualize = items.length > CHAT_VIRTUALIZATION_THRESHOLD
  const getVirtualScrollElement = useCallback(() => {
    const list = scroll.listRef.current
    return list === null ? null : list.closest<HTMLElement>('[data-conversation-scroll]') ?? list
  }, [scroll.listRef])
  const [virtualScrollMargin, setVirtualScrollMargin] = useState(0)
  const virtualPrefixRef = useRef<HTMLDivElement | null>(null)
  // The scrollport keeps its reader position when the list first virtualizes
  // or re-enables; programmatic writes alone never deliver a scroll event.
  const getInitialScrollOffset = useCallback(() => getVirtualScrollElement()?.scrollTop ?? 0,
    [getVirtualScrollElement])
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: virtualize ? items.length : 0,
    enabled: virtualize,
    getScrollElement: getVirtualScrollElement,
    initialOffset: getInitialScrollOffset,
    estimateSize: useCallback((index: number) => estimateChatVirtualHeight(items[index]), [items]),
    getItemKey: useCallback((index: number) => {
      const item = items[index]
      return item === undefined ? `missing:${String(index)}` : chatVirtualItemKey(item)
    }, [items]),
    overscan: CHAT_VIRTUAL_OVERSCAN,
    anchorTo: 'end',
    followOnAppend: scroll.followingTail ? 'auto' : false,
    initialRect: { width: 0, height: CHAT_VIRTUAL_INITIAL_VIEWPORT_HEIGHT },
    scrollMargin: virtualScrollMargin,
    measureElement: measureChatRow,
  })
  // The virtual rows begin after the history controls; their offset within the
  // scroll element is the virtualizer's coordinate origin.
  useLayoutEffect(() => {
    if (!virtualize) return
    const prefix = virtualPrefixRef.current
    const scroller = getVirtualScrollElement()
    if (prefix === null || scroller === null) return
    const measure = (): void => {
      const offset = prefix.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      const next = Math.max(0, offset + prefix.offsetHeight)
      setVirtualScrollMargin(previous => Math.abs(previous - next) < 0.5 ? previous : next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(prefix)
    observer.observe(scroller)
    return () => { observer.disconnect() }
  }, [virtualize, getVirtualScrollElement])
  // Unmounted rows answer navigation and restore by absolute offset instead of
  // DOM measurement; the delegate is released when the plain list returns.
  const virtualWindow = useMemo<ChatVirtualWindow>(() => {
    const indexByKey = new Map<string, number>()
    for (const [index, item] of items.entries()) {
      indexByKey.set(chatVirtualItemKey(item), index)
      if (item.kind === 'entry') indexByKey.set(chatAnchorKey(item.entry), index)
    }
    return {
      landingForAnchor(key) {
        const index = indexByKey.get(key)
        const item = index === undefined ? undefined : items[index]
        if (index === undefined || item === undefined) return null
        const offset = virtualizer.getOffsetForIndex(index)?.[0]
        if (offset === undefined) return null
        return { key, offset, turn: itemTurn(item, nodeStore) }
      },
      landingAtOrAfterTurn(turn) {
        for (const [index, item] of items.entries()) {
          const candidate = itemTurn(item, nodeStore)
          if (candidate === null || candidate < turn) continue
          const offset = virtualizer.getOffsetForIndex(index)?.[0]
          if (offset === undefined) return null
          return { key: item.kind === 'entry' ? chatAnchorKey(item.entry) : item.key, offset, turn: candidate }
        }
        return null
      },
    }
  }, [items, virtualizer, nodeStore])
  useLayoutEffect(() => {
    scroll.viewport.setVirtualWindow(virtualize ? virtualWindow : null)
    return () => { scroll.viewport.setVirtualWindow(null) }
  }, [scroll.viewport, virtualize, virtualWindow])

  // Read inside ChatView so the virtualizer's own re-render reaches the list;
  // the memoized window keeps the list from re-rendering on unrelated updates.
  const virtualItems = virtualize ? virtualizer.getVirtualItems() : EMPTY_VIRTUAL_ITEMS
  const virtualTotalSize = virtualize ? virtualizer.getTotalSize() : 0

  const historyPrefix = (
    <>
      {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
      {openState === 'error' && openError !== null && (
        <div className={css.openError}>
          {t('chat.loadError', { message: openError.message, code: openError.code })}
        </div>
      )}
      {hasMore && (
        <div className={css.older}>
          <button type="button" disabled={loadingOlder} onClick={scroll.loadEarlier}>
            {loadingOlder ? t('loading') : t('chat.loadOlder')}
          </button>
        </div>
      )}
    </>
  )

  return (
    <div className={css.frame}>
      {scroll.initialized && (
        <TurnNavigator
          items={railItems}
          activeTurn={scroll.activeTurn}
          busyTurn={scroll.busyTurn}
          onNavigate={scroll.navigateToTurn}
          t={t}
        />
      )}
      <div className={css.root} data-chat-following-tail={scroll.followingTail ? '' : undefined}>
        <div ref={scroll.listRef} className={css.scroll}>
          <div ref={scroll.columnRef} className={css.column} data-chat-flow=""
            {...virtualize ? { 'data-chat-virtual': '' } : {}}>
            {virtualize
              ? <div ref={virtualPrefixRef} className={css.virtualPrefix}>{historyPrefix}</div>
              : historyPrefix}
            <MarkdownDelegateProvider openExternalLink={openExternalLink} openFile={requestOpenFile} fileImages={fileImages}>
              <ChatNodeList
                items={items}
                virtualize={virtualize}
                virtualItems={virtualItems}
                virtualTotalSize={virtualTotalSize}
                scrollMargin={virtualScrollMargin}
                measureElement={virtualizer.measureElement}
                nodeStore={nodeStore}
                useChatGroup={useChatGroup}
                useChatNode={useChatNode}
                useChatNodeProcess={useChatNodeProcess}
                usePresentation={usePresentation}
                useStore={useStore}
                actions={actions}
                cwd={cwd}
                openFile={requestOpenFile}
                openSkill={openSkill}
                inspectCall={inspectCall}
                forkAt={forkAt}
                revertAt={revertAt}
                iterationGroups={iterationGroups}
                loadIterationPreviews={loadIterationPreviews}
                restoreIteration={restoreIteration}
                loadImage={loadImage}
                renderMessageImages={renderMessageImages}
                fileMentions={fileMentions}
                renderSlot={renderSlot}
                t={t}
              />
            </MarkdownDelegateProvider>
            {/* No pending placeholders: questions (ui-user-questions) and approvals
                (ApprovalPanel) both take over the composer, so a flow card would
                double-render the same wait. */}
          </div>
        </div>
      </div>
      {!scroll.followingTail && (
        <div className={css.toBottomSlot}>
          <button
            type="button"
            className={css.toBottom}
            aria-label={t('chat.toBottom')}
            onClick={scroll.returnToBottom}
          >
            <IconChevronDownOutlineRegular />
          </button>
        </div>
      )}
      {fileOpenError !== null && (
        <FileOpenErrorDialog
          message={fileOpenError.message}
          busy={fileOpenBusy}
          onClose={closeFileOpenError}
          onRetry={() => { requestOpenFile(fileOpenError.path) }}
          t={t}
        />
      )}
    </div>
  )
}

/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
function FileOpenErrorDialog({
  message, busy, onClose, onRetry, t,
}: {
  message: string
  busy: boolean
  onClose: () => void
  onRetry: () => void
  t: ChatViewSlotProps['t']
}) {
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t('fileOpen.title')}
      description={message}
      footer={(
        <>
          <Button variant="outline" className={css.modalAction} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={css.modalAction} disabled={busy} onClick={onRetry}>{t('retry')}</Button>
        </>
      )}
    />
  )
}
