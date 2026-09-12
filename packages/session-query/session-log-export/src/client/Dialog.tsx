import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionLogDownloadState } from './controller.ts'
import { NS } from './locales.ts'

/** Browser operations and state injected into the Session Header contribution. */
export interface SessionLogDownloadDialogInjected {
  hooks: { sessionLogDownload: ObservableSnapshot<SessionLogDownloadState> }
  request: (sessionId: SessionId) => Promise<void>
  dismiss: (sessionId: SessionId) => void
}

export type SessionLogDownloadDialogProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionLogDownloadDialogInjected>

export interface SessionLogGlobalOverlayInjected {
  hooks: { sessionLogDownload: ObservableSnapshot<SessionLogDownloadState> }
  dismiss: (sessionId: SessionId) => void
}

export type SessionLogGlobalOverlayProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionLogGlobalOverlayInjected>

/**
 * Global modal mounted into `shell.overlay` so any session log download
 * across the app (sidebar 3-dots, `/export`, etc.) presents status/error feedback.
 */
export function SessionLogGlobalOverlay({
  useSessionLogDownload, dismiss, t,
}: SessionLogGlobalOverlayProps) {
  const bySession = useSessionLogDownload(state => state.bySession)
  const activeSessionId = Object.keys(bySession).find(id => bySession[id]?.open === true)
  if (activeSessionId === undefined) return null

  const entry = bySession[activeSessionId]
  const status = entry?.status
  const error = status === 'error' ? entry?.error || t('dialog.commandFailed') : null
  const title = status === 'downloading'
    ? t('dialog.preparingTitle')
    : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle')
  const description = status === 'downloading'
    ? t('dialog.preparingDescription')
    : status === 'success' ? t('dialog.successDescription') : error ?? t('dialog.commandFailed')

  return (
    <Modal
      open={true}
      onClose={() => { dismiss(activeSessionId as SessionId) }}
      title={title}
      description={description}
      closeLabel={t('dialog.close')}
      footer={<Button variant="primary" onClick={() => { dismiss(activeSessionId as SessionId) }}>{t('dialog.close')}</Button>}
    />
  )
}

/**
 * Modal shared by the Session Header download menu item and this browser's `/export` command.
 * @param props - Session runtime, bound controller state, actions, and localized copy.
 * @returns the modal portal contribution.
 */
export function SessionLogDownloadDialog({
  sessionId, useSessionLogDownload, dismiss, t,
}: SessionLogDownloadDialogProps) {
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])

  const status = entry?.status
  const open = entry?.open === true
  const error = status === 'error' ? entry?.error || t('dialog.commandFailed') : null
  const title = status === 'downloading'
    ? t('dialog.preparingTitle')
    : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle')
  const description = status === 'downloading'
    ? t('dialog.preparingDescription')
    : status === 'success' ? t('dialog.successDescription') : error ?? t('dialog.commandFailed')

  return (
    <Modal
      open={open}
      onClose={() => { dismiss(sessionId) }}
      title={title}
      description={description}
      closeLabel={t('dialog.close')}
      footer={<Button variant="primary" onClick={() => { dismiss(sessionId) }}>{t('dialog.close')}</Button>}
    />
  )
}
