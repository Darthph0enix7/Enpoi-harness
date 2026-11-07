/**
 * enpoi: deferred bodies for the brand operator surfaces. Each wrapper is the
 * component passed to its unchanged slot registration, so tab and section
 * order never depends on when a body chunk arrives. Only bodies that are
 * already isolated behind a tab or settings route live here; shell chrome,
 * icons, and shared boot stores stay eager.
 */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { LazySurface } from './lazy-surface.tsx'
import type { AgentModelsBodyProps } from './AgentModelsBody.tsx'
import type { DynamicSettingsProps } from './dynamic/DynamicSettings.tsx'
import type { GitBodyProps } from './GitBody.tsx'
import type { OrchestrationSettingsProps } from './OrchestrationSettings.tsx'
import type { SubagentSessionsBodyProps } from './SubagentSessionsBody.tsx'
import type { WatchtowerViewProps } from './WatchtowerView.tsx'

/** Empty, non-textual pending marker shared by every deferred body. */
const PENDING = <span aria-hidden="true" data-enpoi-lazy-pending />

const loadWatchtowerView = async (): Promise<{ default: (props: WatchtowerViewProps) => ReactNode }> =>
  ({ default: (await import('./WatchtowerView.tsx')).WatchtowerView })

const loadAgentModelsBody = async (): Promise<{ default: (props: AgentModelsBodyProps) => ReactNode }> =>
  ({ default: (await import('./AgentModelsBody.tsx')).AgentModelsBody })

const loadSubagentSessionsBody = async (): Promise<{ default: (props: SubagentSessionsBodyProps) => ReactNode }> =>
  ({ default: (await import('./SubagentSessionsBody.tsx')).SubagentSessionsBody })

const loadGitBody = async (): Promise<{ default: (props: GitBodyProps) => ReactNode }> =>
  ({ default: (await import('./GitBody.tsx')).GitBody })

const loadOrchestrationSettings = async (): Promise<{ default: (props: OrchestrationSettingsProps) => ReactNode }> =>
  ({ default: (await import('./OrchestrationSettings.tsx')).OrchestrationSettings })

const loadPermissionsSettings = async (): Promise<{ default: (props: DeferredSettingsProps) => ReactNode }> =>
  ({ default: (await import('./PermissionsSettings.tsx')).PermissionsSettings })

const loadDynamicSettings = async (): Promise<{ default: (props: DynamicSettingsProps) => ReactNode }> =>
  ({ default: (await import('./dynamic/DynamicSettings.tsx')).DynamicSettings })

/** Props the Permissions settings body receives from its registration. */
export type DeferredSettingsProps = { readonly close: () => void } & PropsLocale<'brandEnpoi'>

/**
 * Render the Watchtower body from its deferred chunk.
 * @param props - the conversation-view props.
 * @returns the pending marker, the panel, or a retryable failure.
 */
export function LazyWatchtowerView(props: WatchtowerViewProps): ReactNode {
  return (
    <LazySurface
      load={loadWatchtowerView}
      render={Component => <Component {...props} />}
      fallback={PENDING}
      failed={props.t('panelLoadFailed')}
      retry={props.t('commonRetry')}
    />
  )
}

/**
 * Render the Agent Models body from its deferred chunk.
 * @param props - the sidebar tab props.
 * @returns the pending marker, the panel, or a retryable failure.
 */
export function LazyAgentModelsBody(props: AgentModelsBodyProps): ReactNode {
  return (
    <LazySurface
      load={loadAgentModelsBody}
      render={Component => <Component {...props} />}
      fallback={PENDING}
      failed={props.t('panelLoadFailed')}
      retry={props.t('commonRetry')}
    />
  )
}

/**
 * Render the Subagent Sessions body from its deferred chunk.
 * @param props - the sidebar tab props.
 * @returns the pending marker, the panel, or a retryable failure.
 */
export function LazySubagentSessionsBody(props: SubagentSessionsBodyProps): ReactNode {
  return (
    <LazySurface
      load={loadSubagentSessionsBody}
      render={Component => <Component {...props} />}
      fallback={PENDING}
      failed={props.t('panelLoadFailed')}
      retry={props.t('commonRetry')}
    />
  )
}

/**
 * Render the Git body from its deferred chunk.
 * @param props - the sidebar tab props.
 * @returns the pending marker, the panel, or a retryable failure.
 */
export function LazyGitBody(props: GitBodyProps): ReactNode {
  return (
    <LazySurface
      load={loadGitBody}
      render={Component => <Component {...props} />}
      fallback={PENDING}
      failed={props.t('panelLoadFailed')}
      retry={props.t('commonRetry')}
    />
  )
}

/**
 * Render the Orchestration settings body from its deferred chunk.
 * @param props - the settings-section props.
 * @returns the pending marker, the panel, or a retryable failure.
 */
export function LazyOrchestrationSettings(props: OrchestrationSettingsProps): ReactNode {
  return (
    <LazySurface
      load={loadOrchestrationSettings}
      render={Component => <Component {...props} />}
      fallback={PENDING}
      failed={props.t('panelLoadFailed')}
      retry={props.t('commonRetry')}
    />
  )
}

/**
 * Render the Permissions settings body from its deferred chunk.
 * @param props - the settings-section props.
 * @returns the pending marker, the panel, or a retryable failure.
 */
export function LazyPermissionsSettings(props: DeferredSettingsProps): ReactNode {
  return (
    <LazySurface
      load={loadPermissionsSettings}
      render={Component => <Component {...props} />}
      fallback={PENDING}
      failed={props.t('panelLoadFailed')}
      retry={props.t('commonRetry')}
    />
  )
}

/**
 * Render the Dynamic settings body from its deferred chunk.
 * @param props - the settings-section props.
 * @returns the pending marker, the panel, or a retryable failure.
 */
export function LazyDynamicSettings(props: DynamicSettingsProps): ReactNode {
  return (
    <LazySurface
      load={loadDynamicSettings}
      render={Component => <Component {...props} />}
      fallback={PENDING}
      failed={props.t('panelLoadFailed')}
      retry={props.t('commonRetry')}
    />
  )
}
