/**
 * In-app update surface, browser half: one `shell.overlay` entry that renders
 * the update pill, the dialog (changelog, progress, failure), and the
 * post-restart toast, plus one General-settings row that keeps the update
 * reachable after a skip (it shares the controller's store and actions, so
 * there is exactly one polling source). All data arrives through the
 * controller's inject face; the controller owns the polling cadence and the
 * reconnect detection.
 * @module @deepseek-ai/dsh-client-ui-update/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the `connection/reset` event declaration (the reconnect
// trigger after the update's switch restarts the service).
import type {} from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the shell's SlotMap merge (the 'shell.overlay' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.general.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { UpdateController } from './controller.ts'
import type { UpdateIndicatorInjected } from './UpdateIndicator.tsx'
import { UpdateIndicator } from './UpdateIndicator.tsx'
import type { UpdateSettingsInjected } from './UpdateSettingsRow.tsx'
import { UpdateSettingsRow } from './UpdateSettingsRow.tsx'
import { en, NS, zh, type UpdateKey } from './locales.ts'

export type { UpdateIndicatorInjected, UpdateIndicatorProps } from './UpdateIndicator.tsx'
export type { UpdateSettingsInjected, UpdateSettingsRowProps } from './UpdateSettingsRow.tsx'
export type { UpdateUiState } from './controller.ts'
export type {
  UpdateCancelOutcomeWire, UpdateCheckLatestWire, UpdateCheckState, UpdateCheckStatusWire, UpdateRunMode, UpdateRunPhase,
  UpdateRunResult, UpdateRunWire, UpdateRung,
} from './rpc.ts'
export type { UpdateKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** In-app update copy. */
    'update': UpdateKey
  }
}

/** Required services: the slot registry and the dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the shell-overlay
 * indicator, and start the controller's polling.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-update: dictionaries')
  const controller = new UpdateController()
  ctx.effect(() => () => { controller.dispose() }, 'ui-update: polling')
  ctx.effect(() => ctx.on('connection/reset', () => { controller.onConnectionReset() }), 'ui-update: reconnect')
  controller.mount()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'update-indicator',
    locale: NS,
    inject: (): UpdateIndicatorInjected => ({
      hooks: { update: controller.store },
      actions: {
        open: () => { controller.open() },
        close: () => { controller.close() },
        start: () => { controller.start() },
        apply: () => { controller.apply() },
        retry: () => { controller.retry() },
        skip: () => { controller.skip() },
        cancel: () => { controller.cancel() },
        checkNow: () => { controller.checkNow() },
        toastDone: () => { controller.toastDone() },
      },
    }),
  }, UpdateIndicator))
  // The durable entry point beside the General settings version row: a
  // skipped release keeps an Update control even though the shell pill hides.
  // It shares the controller state and actions — no second polling source.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'update',
    // Directly under the current-version row (order 100).
    order: 101,
    locale: NS,
    inject: (): UpdateSettingsInjected => ({
      hooks: { update: controller.store },
      actions: {
        open: () => { controller.open() },
        apply: () => { controller.apply() },
        checkNow: () => { controller.checkNow() },
      },
    }),
  }, UpdateSettingsRow))
}
