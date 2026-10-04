/**
 * enpoi-role-registry — Host RPC surface for the effective role registry.
 *
 * The Dynamic → Roles panel edits only the settings override layer
 * (`enpoi-orchestration.roles`); the built-in personas live in the fork's role
 * tables (`tool-subagent`). This plugin serves the EFFECTIVE registry — the
 * merged view the spawn path itself resolves — through the `enpoiRoles`
 * Typert Remote namespace, so the client shows populated baselines without
 * duplicating persona text. `list()` reads fresh per call, so a settings write
 * is visible without a reload.
 *
 * Failure posture is fail-open on the client: an absent/failed namespace
 * leaves the panel on the settings-layer display.
 */
import type { Context } from '@deepseek-ai/cordis'
import { mountEnpoiRolesRemote } from './roles-remote'

export const name = 'enpoi-role-registry'

/** The settings service must be up before the effective registry can be read. */
export const inject = ['settings']

/**
 * Mount the `enpoiRoles` remote namespace.
 * @param ctx - profile plugin Context.
 */
export function apply(ctx: Context): void {
  mountEnpoiRolesRemote(ctx)
  process.stderr.write('[enpoi-role-registry] mounted\n')
}
