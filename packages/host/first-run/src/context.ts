/**
 * The sysadmin system-profile provider. Mounted inside the sysadmin agent
 * preset, it contributes a reference to the stored system profile as dynamic
 * context; before any analysis ran — or after the operator rejected the
 * document — it contributes the documented default instead, so a skipped
 * analysis still leaves the sysadmin with an explicit fact rather than an
 * invented machine description.
 * @module @deepseek-ai/dsh-host-first-run/context
 */

import type { Context } from '@deepseek-ai/cordis'
// Empty type import carries the `systemPrompt` Context merge for the contribution below.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { systemProfileContextText } from './context-file.ts'

/** Stable Cordis plugin name. */
export const name = 'first-run-context'

/** The prompt registry this provider contributes to. */
export const inject = ['systemPrompt']

/** Order after the harness's own identity sections. */
const CONTEXT_ORDER = 40

/**
 * Register the system-profile contribution for the mounting preset's scope.
 * @param ctx - preset-scoped context carrying the prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'system-profile',
    order: CONTEXT_ORDER,
    text: () => systemProfileContextText(),
  }), 'first-run: sysadmin system profile')
}
