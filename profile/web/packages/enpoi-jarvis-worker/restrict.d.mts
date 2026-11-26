import type { Context } from '@deepseek-ai/cordis'

/** Plugin name of the allow-only worker tool restriction. */
export const name: string
/** Services the restriction needs before it applies. */
export const inject: readonly string[]
/**
 * Install the reviewed allow-only tool mask in the preset's agent scope.
 * @param ctx - preset-scoped context.
 */
export function apply(ctx: Context): void
