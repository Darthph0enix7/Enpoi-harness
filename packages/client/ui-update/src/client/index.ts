/**
 * In-app update surface, browser half: one `shell.overlay` entry that renders
 * the update pill, the dialog (changelog, progress, failure), and the
 * post-restart toast. All data arrives through the controller's inject face;
 * the controller owns the polling cadence and the reconnect detection.
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
import { UpdateController } from './controller.ts'
import type { UpdateIndicatorInjected } from './UpdateIndicator.tsx'
import { UpdateIndicator } from './UpdateIndicator.tsx'
import { en, NS, zh, type UpdateKey } from './locales.ts'

export type { UpdateIndicatorInjected, UpdateIndicatorProps } from './UpdateIndicator.tsx'
export type { UpdateUiState } from './controller.ts'
export type {
  UpdateCheckLatestWire, UpdateCheckState, UpdateCheckStatusWire, UpdateRunPhase, UpdateRunResult, UpdateRunWire,
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
        skip: () => { controller.skip() },
        toastDone: () => { controller.toastDone() },
      },
    }),
  }, UpdateIndicator))
}
