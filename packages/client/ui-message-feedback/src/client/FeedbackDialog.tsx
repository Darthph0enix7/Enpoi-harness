/**
 * The feedback dialog, its acknowledgement and failure toasts, and the
 * non-blocking bottom-right pipeline chip, rendered as one entry of
 * `conversation.input.overlay` so each Session owns exactly one of each. The
 * Modal, the Toast, and the pipeline chip all portal to `document.body`; the
 * overlay slot only supplies the per-session controller and the composer card
 * the toast centers over.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client/FeedbackDialog
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, Checkbox, IconWarningOutlineRegular, Modal, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FeedbackCategory } from '@deepseek-ai/dsh-command-feedback/types'
import type { FeedbackShareFlags } from './dialog.ts'
import type { FeedbackDialogProps } from './slots.ts'
import css from './FeedbackDialog.module.css'

/** Pause the settled success chip holds before fading, and the fade's own length. */
const SENT_HOLD_MS = 3000
const SENT_FADE_MS = 400

/**
 * The chips in presentation order. A client bundle may not import a Host
 * package's values, so the taxonomy is restated as a complete record of the
 * `FeedbackCategory` union: a missing or foreign id is a compile error.
 */
const CATEGORY_CHIPS = {
  'task-result': true,
  'instruction-following': true,
  'product-interaction': true,
  'service-stability': true,
  'resource-cost': true,
  'security-privacy-permission': true,
  'other': true,
} satisfies Record<FeedbackCategory, true>
const CATEGORIES = Object.keys(CATEGORY_CHIPS) as FeedbackCategory[]

/**
 * Share checkboxes in presentation order. Each id is both the shared-data flag
 * and its `share.<id>` copy key, so an id without either is a compile error.
 */
const SHARE_ITEMS: readonly (keyof FeedbackShareFlags)[] = ['systemInfo', 'context', 'session', 'message']

/** Failure codes with their own copy; every other code reads the generic line. */
const FAILURE_COPY: Partial<Record<string, 'error.conflict' | 'error.noteTooLarge'>> = {
  'version-conflict': 'error.conflict',
  'note-too-large': 'error.noteTooLarge',
}

/**
 * Render one Session's feedback dialog, its acknowledgement and failure
 * toasts, and the non-blocking background-pipeline chip.
 * @param props - the dialog hook, the draft verbs, and the locale seat.
 * @returns the modal while a target is open, either toast while it is showing,
 *   and the bottom-right pipeline chip while a Session record is in flight or
 *   settled.
 */
export function FeedbackDialog({
  useDialog, edit, submit, dismiss, dismissPipeline, dismissFailure, dismissToast, t,
}: FeedbackDialogProps) {
  const state = useDialog(s => s)
  // The toast centers over the composer card this entry renders inside of.
  const probeRef = useRef<HTMLSpanElement>(null)
  const [card, setCard] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setCard(probeRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null)
  }, [])
  const toast = state.toast
  const onToastDone = useCallback(() => { dismissToast(toast) }, [dismissToast, toast])
  // A toast retires with the entry that showed it: the Toast's own timer dies
  // on unmount, and the Session's controller must not replay it on return.
  useEffect(() => () => { dismissToast(toast) }, [dismissToast, toast])
  const pipeline = state.pipeline
  const failureCode = state.failure
  const failure = failureCode === null ? null : t(FAILURE_COPY[failureCode] ?? 'error.generic')
  const onFailureDone = useCallback(() => { dismissFailure() }, [dismissFailure])
  // A settled success chip pauses, fades, then retires through the controller;
  // a failure chip stays until its dismiss control retires it.
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (pipeline !== 'sent') {
      setLeaving(false)
      return
    }
    const fade = setTimeout(() => { setLeaving(true) }, SENT_HOLD_MS)
    const retire = setTimeout(() => { setLeaving(false); dismissPipeline() }, SENT_HOLD_MS + SENT_FADE_MS)
    return () => {
      clearTimeout(fade)
      clearTimeout(retire)
    }
  }, [pipeline, dismissPipeline])

  return (
    <>
      <span ref={probeRef} hidden />
      {toast > 0 && failure === null && (
        <Toast
          key={toast}
          text={t('toast.recorded')}
          tone="success"
          anchor={card}
          onDone={onToastDone}
        />
      )}
      {failure !== null && state.target !== null && pipeline !== 'failed' && (
        <Toast
          key={`failure-${failureCode}`}
          text={failure}
          icon={<IconWarningOutlineRegular />}
          anchor={card}
          holdMs={6000}
          onDone={onFailureDone}
        />
      )}
      {/* The pipeline chip portals out of the overlay so it sits above the
          composer; the Session record is not awaited by the dialog. */}
      {pipeline !== 'idle' && createPortal((
        <div className={css.pipelineDock} data-feedback-pipeline={pipeline} data-leaving={leaving || undefined}>
          <div className={css.pipelineChip} role={pipeline === 'failed' ? 'alert' : 'status'}>
            <StateDot state={pipeline === 'running' ? 'ongoing' : pipeline === 'sent' ? 'done' : 'error'} />
            <span className={css.pipelineBody}>
              <strong>{t('chip.title')}</strong>
              <span className={css.pipelineStage} data-feedback-pipeline-stage>
                {pipeline === 'running' ? t('chip.running') : pipeline === 'sent' ? t('chip.sent') : (failure ?? t('error.generic'))}
              </span>
            </span>
            {pipeline === 'failed' && (
              <button
                type="button"
                className={css.pipelineDismiss}
                aria-label={t('close')}
                title={t('close')}
                data-feedback-pipeline-dismiss
                onClick={dismissFailure}
              >
                ×
              </button>
            )}
          </div>
        </div>
      ), document.body)}
      <Modal
        open={state.target !== null}
        title={t('dialog.title')}
        closeLabel={t('close')}
        onClose={dismiss}
        className={css.dialog as string}
        contentClassName={css.scrollArea as string}
        footer={(
          <Button
            variant="primary"
            className={css.submit}
            disabled={state.submitting}
            onClick={() => { void submit() }}
          >
            {state.submitting ? t('submitting') : t('submit')}
          </Button>
        )}
      >
        <div className={css.categories} role="group" aria-label={t('dialog.categories')}>
          {CATEGORIES.map(category => (
            <button
              key={category}
              type="button"
              className={state.category === category ? `${css.chip} ${css.chipActive}` : css.chip}
              aria-pressed={state.category === category}
              disabled={state.submitting}
              onClick={() => { edit({ category: state.category === category ? null : category }) }}
            >
              {t(`category.${category}`)}
            </button>
          ))}
        </div>
        <textarea
          className={css.detail}
          aria-label={t('dialog.detail')}
          placeholder={t('dialog.hint')}
          value={state.text}
          readOnly={state.submitting}
          onChange={(event) => { edit({ text: event.target.value }) }}
        />
        {/* The share flags gate the Session submission only; a message-target
            dialog stores its note locally and shares nothing, so it renders no
            controls that could not take effect. */}
        {state.target?.kind === 'session' && (
          <fieldset className={css.share}>
            <legend className={css.shareLegend}>{t('share.legend')}</legend>
            <div className={css.shareRow}>
              {SHARE_ITEMS.map(item => (
                <Checkbox
                  key={item}
                  className={css.shareItem}
                  checked={state.share[item]}
                  disabled={state.submitting}
                  label={t(`share.${item}`)}
                  onChange={(next) => { edit({ share: { ...state.share, [item]: next } }) }}
                />
              ))}
            </div>
            <p className={css.shareHint}>{t('share.hint')}</p>
          </fieldset>
        )}
      </Modal>
    </>
  )
}
