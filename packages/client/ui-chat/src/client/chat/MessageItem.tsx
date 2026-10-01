import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PendingSubmission, SessionIterationVariant } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { fileExtension, FileTypeIcon, fileSizeText, JsonBlock, projectUserText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ModelRetryNode, TurnErrorNode, UserMessageNode } from '../contract/snapshot.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import { SwipeReveal } from './SwipeReveal.tsx'
import css from './MessageItem.module.css'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>
type UserFile = Extract<UserMessageNode['content'][number], { type: 'file' }>
type PresentedAttachment =
  | { readonly type: 'image'; readonly image: MessageImageSource }
  | { readonly type: 'file'; readonly file: UserFile['attachment'] }

function contentParts(content: readonly unknown[]): {
  text: string
  attachments: PresentedAttachment[]
  rest: unknown[]
} {
  const texts: string[] = []
  const attachments: PresentedAttachment[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) {
      attachments.push({ type: 'image', image: { attachment: (b as UserImage).attachment } })
    }
    else if (b.type === 'file' && b.attachment !== undefined) {
      attachments.push({ type: 'file', file: (b as UserFile).attachment })
    }
    else rest.push(block)
  }
  return { text: texts.join(''), attachments, rest }
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function failureMessage(
  message: string,
  code: unknown,
  t: ChatViewSlotProps['t'],
): string {
  if (code === 'ACCOUNT_SIGNED_OUT') return t('message.failure.accountSignedOut')
  if (code === 'ACCOUNT_SIGN_IN_REQUIRED') return t('message.failure.accountSignInRequired')
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return t('message.failure.quota')
  if (code === 'AUTH') {
    // The localized headline, then the provider's own detail (usually its
    // machine code and message, e.g. `PAID_MODEL_AUTH_REQUIRED: You need to
    // sign in to use this model.`). The detail is what makes a paid-model
    // sign-in wall distinguishable from a genuinely bad stored key.
    const headline = t('message.failure.auth')
    return message.length === 0 || message === headline ? headline : `${headline}: ${message}`
  }
  return message
}

function ModelRetryItem({ node, active, t }: {
  node: ModelRetryNode
  active: boolean
  t: ChatViewSlotProps['t']
}) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq])
  const scheduledSeconds = retrySeconds(node.delayMs)
  const maximum = node.mode === 'normal' ? node.maxRetries : '∞'
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? t('message.retry.active')
    : node.retryState === 'cancelled'
      ? t('message.retry.cancelled')
      : node.retryState === 'started'
        ? t('message.retry.started')
        : t('message.retry.scheduled')
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t('message.retry.status', { label, retry: node.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.delay')}</span>
          {t('duration.milliseconds', { milliseconds: Math.round(node.delayMs) })}
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.failure')}</span>
          {failureMessage(node.failure.message, node.failure.code, t)}
        </div>
      </div>
    </details>
  )
}

/** Persistent, turn-positioned feedback for a terminal failure. */
function TurnErrorItem({ node, t }: {
  node: TurnErrorNode
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{node.code === 'ACCOUNT_SIGNED_OUT' ? t('message.accountStopped') : t('message.turnError')}</span>
        <span className={css.turnErrorMessage}>{failureMessage(node.message, node.code, t)}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
    </div>
  )
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }: {
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t('message.maxTokens')}</span>
        <span className={css.turnErrorMessage}>{t('message.maxTokens.hint')}</span>
      </div>
    </div>
  )
}

/** Right-aligned bubble shared by user and steering rows. */
function UserStyleBubble({
  content, renderMessageImages, actions, pending = false, echo = false, preview = false, referenceLabels = [], skillNames = [],
  previewAttachments, references, swipeRevert, t,
}: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: (text: string) => ReactNode
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean
  /** Whether this is a local submission echo (invisible marker; the echo renders exactly like its durable replacement). */
  echo?: boolean
  /** Whether the bubble shows a non-active iteration preview instead of the durable content. */
  preview?: boolean
  /** Exact session mention labels associated by the adjacent recall node. */
  referenceLabels?: readonly string[]
  /** Skill names the step's `skill-invocation` injections loaded for this message. */
  skillNames?: readonly string[]
  /** Local submission-echo attachments replacing the content-derived attachment sequence. */
  previewAttachments?: readonly PresentedAttachment[]
  references?: Pick<ChatNodeOwnerProps, 'openFile' | 'openSkill'>
  /** Touch-only swipe-reveal destructive action; omitted when the row has none. */
  swipeRevert?: (() => void) | undefined
  t: ChatViewSlotProps['t']
}): ReactNode {
  const { text, attachments: contentAttachments, rest } = contentParts(content)
  const attachments = previewAttachments ?? contentAttachments
  const compactImages = attachments.length > 1
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0
  const row = (
    <div
      className={css.userRow}
      data-pending-steering={pending || undefined}
      data-submission-echo={echo || undefined}
      data-iteration-preview={preview || undefined}
    >
      <div className={css.userStack}>
        {attachments.length > 0 && (
          <div className={css.attachmentRow} data-message-attachments>
            {attachments.map((attachment, index) => attachment.type === 'image'
              ? (
                <Fragment key={`image:${index}`}>
                  {renderMessageImages({
                    images: [attachment.image],
                    align: 'end',
                    compact: compactImages,
                  })}
                </Fragment>
              )
              : (
                <span key={`file:${index}`} className={css.fileCard} title={attachment.file.name}>
                  <FileTypeIcon path={attachment.file.name} className={css.fileIcon} />
                  <span className={css.fileContent}>
                    <span className={css.fileName}>{attachment.file.name}</span>
                    <span className={css.fileMeta}>
                      {[fileExtension(attachment.file.name).toUpperCase().slice(0, 8), fileSizeText(attachment.file.bytes)]
                        .filter(Boolean).join(' ')}
                    </span>
                  </span>
                </span>
              ))}
          </div>
        )}
        {showBubble && <div className={css.bubble}>
          {projectUserText(text, referenceLabels, skillNames, 'skill', references)}
          {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
        </div>}
        {referenceLabels.length > 0 && (
          <div className={css.referenceSummary}>
            {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
          </div>
        )}
      </div>
      {actions?.(text)}
    </div>
  )
  return swipeRevert === undefined ? row : (
    <SwipeReveal
      actionLabel={t('message.revertFromHere')}
      confirmLabel={t('message.revertConfirm')}
      cancelLabel={t('message.revertCancel')}
      onConfirm={swipeRevert}
    >
      {row}
    </SwipeReveal>
  )
}

/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and conversation translator.
 * @returns the pending steering bubble.
 */
export function PendingSteeringBubble({ content, renderMessageImages, t }: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  return (
    <UserStyleBubble
      content={content}
      renderMessageImages={renderMessageImages}
      pending
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/**
 * Render one local transcript or steering submission echo with the same
 * visual language and surface marker as the Host occurrence that replaces
 * it: draft text plus object-URL previews, visible from the submit click
 * until the durable `user/message` or steering occurrence renders.
 * @param props - the session snapshot's pending submission and render seats.
 * @returns the echoed user bubble.
 */
export function PendingSubmissionBubble({ submission, renderMessageImages, t }: {
  submission: PendingSubmission
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  const content = useMemo(
    () => (submission.text === '' ? [] : [{ type: 'text', text: submission.text }]),
    [submission.text],
  )
  const previewAttachments = useMemo<readonly PresentedAttachment[]>(
    () => submission.attachments.map(attachment => attachment.type === 'image'
      ? {
        type: 'image',
        image: {
          preview: {
            url: attachment.value.previewUrl,
            ...(attachment.value.name === undefined ? {} : { name: attachment.value.name }),
            ...(attachment.value.width === undefined ? {} : { width: attachment.value.width }),
            ...(attachment.value.height === undefined ? {} : { height: attachment.value.height }),
          },
        },
      }
      : { type: 'file', file: attachment.value }),
    [submission.attachments],
  )
  return (
    <UserStyleBubble
      content={content}
      previewAttachments={previewAttachments}
      renderMessageImages={renderMessageImages}
      pending={submission.placement === 'steering'}
      echo
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={submission.time}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/**
 * User and admitted-steering keyed Chat renderer.
 *
 * A user message that belongs to an iteration group (more than one variant)
 * carries the ◀ x/y ▶ navigator. Arrows change a component-local preview only
 * — the transcript, log, and file state are untouched until the operator
 * presses Restore, which writes through the Host.
 */
export const UserMessageNodeView = memo(function UserMessageNodeView({
  node, renderMessageImages, openFile, openSkill, t, revertAt,
  iterationGroups, loadIterationPreviews, restoreIteration,
}: ChatNodeViewProps<'user' | 'steering'>) {
  const data = node.data
  const group = node.kind === 'user' ? iterationGroups?.get(node.anchorSeq) : undefined
  const groupAnchor = group?.anchorSeq
  const variants = group?.variants ?? []
  const activeVariantSeq = group?.activeVariantSeq ?? null
  const activeIndex = variants.findIndex(variant => variant.seq === activeVariantSeq)
  const [previewSeq, setPreviewSeq] = useState<number | null>(null)
  const [previews, setPreviews] = useState<ReadonlyMap<number, SessionIterationVariant> | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [restoring, setRestoring] = useState(false)

  // A restore (this client's or another client's commit) moves the active
  // variant: the preview must fall back to the durable content.
  useEffect(() => {
    setPreviewSeq(null)
    setPreviewFailed(false)
  }, [activeVariantSeq, groupAnchor])

  const previewIndex = previewSeq === null ? activeIndex : variants.findIndex(variant => variant.seq === previewSeq)
  const selectedIndex = previewIndex < 0 ? Math.max(0, activeIndex) : previewIndex
  const selectedVariant = previewSeq === null ? undefined : previews?.get(previewSeq)

  // Bounded previews are fetched once per group, on first navigation only.
  useEffect(() => {
    if (previewSeq === null || previews !== null || groupAnchor === undefined || loadIterationPreviews === undefined) return
    let cancelled = false
    void loadIterationPreviews(groupAnchor).then((groups) => {
      if (cancelled) return
      const found = groups.find(candidate => candidate.anchorSeq === groupAnchor)
      setPreviews(new Map((found?.variants ?? []).map(variant => [variant.seq, variant])))
    }, () => {
      if (cancelled) return
      setPreviews(new Map())
      setPreviewFailed(true)
    })
    return () => { cancelled = true }
  }, [previewSeq, previews, groupAnchor, loadIterationPreviews])

  const move = useCallback((delta: number) => {
    if (variants.length === 0) return
    const next = Math.min(variants.length - 1, Math.max(0, selectedIndex + delta))
    const nextSeq = variants[next]?.seq
    if (nextSeq === undefined) return
    setPreviewSeq(nextSeq === activeVariantSeq ? null : nextSeq)
  }, [variants, selectedIndex, activeVariantSeq])

  const restore = useCallback(() => {
    if (previewSeq === null || restoreIteration === undefined || restoring) return
    setRestoring(true)
    void restoreIteration(previewSeq).then(
      () => { setRestoring(false) },
      () => { setRestoring(false) },
    )
  }, [previewSeq, restoreIteration, restoring])

  const previewing = previewSeq !== null
  const content = previewing
    ? [{ type: 'text', text: selectedVariant?.text ?? (previewFailed ? t('message.iteration.loadFailed') : t('message.iteration.loading')) }]
    : data.content
  return (
    <UserStyleBubble
      content={content}
      references={{ openFile, openSkill }}
      renderMessageImages={renderMessageImages}
      preview={previewing}
      {...data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }}
      {...data.skillNames === undefined ? {} : { skillNames: data.skillNames }}
      t={t}
      {...node.kind === 'user' && revertAt !== undefined
        ? { swipeRevert: () => { revertAt(node.anchorSeq) } }
        : {}}
      actions={text => (
        <div className={css.iterationActions}>
          <MessageIconActions
            text={text}
            time={data.time}
            clock="start"
            className={css.actions}
            onRevert={node.kind === 'user' && revertAt !== undefined ? () => { revertAt(node.anchorSeq) } : undefined}
            t={t}
          />
          {group !== undefined && variants.length > 1 && (
            <div className={css.iterationNav} data-iteration-preview={previewing || undefined}>
              <button
                type="button"
                className={css.iterationButton}
                aria-label={t('message.iteration.previous')}
                disabled={selectedIndex <= 0}
                onClick={() => { move(-1) }}
              >
                ◀
              </button>
              <span className={css.iterationPosition} aria-live="polite">
                {t('message.iteration.position', { index: selectedIndex + 1, total: variants.length })}
              </span>
              <button
                type="button"
                className={css.iterationButton}
                aria-label={t('message.iteration.next')}
                disabled={selectedIndex >= variants.length - 1}
                onClick={() => { move(1) }}
              >
                ▶
              </button>
              {previewing && (
                <button
                  type="button"
                  className={css.iterationRestore}
                  disabled={restoring || restoreIteration === undefined}
                  onClick={restore}
                >
                  {t('message.iteration.restore')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    />
  )
})

/** Injected-context keyed Chat renderer. */
export const ContextMessageNodeView = memo(function ContextMessageNodeView({ node, t }: ChatNodeViewProps<'context'>) {
  const data = node.data
  return (
    <ContextInjectionRow
      content={data.content}
      source={data.source}
      producer={data.producer}
      form={data.form}
      t={t}
    />
  )
})

/** Automatic compaction keyed Chat renderer. */
export const CompactionNodeView = memo(function CompactionNodeView({ node, t }: ChatNodeViewProps<'compaction'>) {
  return <CompactionItem node={node.data} t={t} />
})

/** Correlated retry-chain keyed Chat renderer. */
export const RetryNodeView = memo(function RetryNodeView({ node, t }: ChatNodeViewProps<'model-retry'>) {
  const data = node.data
  return <ModelRetryItem node={data.current} active={data.current.retryState === 'scheduled'} t={t} />
})

/** Terminal turn-error keyed Chat renderer. */
export const TurnErrorNodeView = memo(function TurnErrorNodeView({ node, t }: ChatNodeViewProps<'turn-error'>) {
  return <TurnErrorItem node={node.data} t={t} />
})

/** Max-tokens turn-end notice keyed Chat renderer. */
export const TurnMaxTokensNodeView = memo(function TurnMaxTokensNodeView({ t }: ChatNodeViewProps<'turn-max-tokens'>) {
  return <TurnMaxTokensItem t={t} />
})

/** Explicit unknown-surface keyed Chat renderer. */
export const UnknownNodeView = memo(function UnknownNodeView({ node, t }: ChatNodeViewProps<'unknown'>) {
  const data = node.data
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t('message.unknownSurface', { type: data.type })}
        payload={data.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </div>
  )
})
