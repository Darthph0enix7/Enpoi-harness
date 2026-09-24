/**
 * Settings domain base plugin, browser half. Provides the settings-domain
 * services — `ctx.settingsScope`, the settings-namespace scope service the
 * fork's preference rows still bind their durable section through, and
 * `ctx.configForms`, the shared configuration forms the merged upstream
 * features inject (the `settingsScope` callers migrate to `configForms` in a
 * follow-up lane) — and owns the one `settings.describe` reader in the
 * browser: the describe mirror, whose invalidation subscriptions
 * (`settings/document-updated`, `connection/reset`) live here so every derived
 * surface refreshes from a single wire read. It depends on no `ui-*`
 * presentation package, so any feature that owns a preference can reach it:
 * the settings SHELL — the `sidebar.settings` occupant, its navigation, and
 * the chrome — lives in ui-settings-general, because a shell dependency on
 * ui-sidebar would close a reference cycle through ui-layout and ui-theme.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote merge, the fixed Host facts, and the carrier's
// `connection/reset` lifecycle event, all through the assembly package.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only pair supplying `$on` and its key face without dragging a build
// artifact into the Host graph (rationale beside the same pair in
// settings-scope.ts).
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import { ConfigForms } from './config-form.ts'
import { SettingsSchemaService } from './schema.ts'
import { SettingsScopeBinder } from './settings-scope.ts'
import { SettingsDescribeMirror } from './settings-mirror.ts'

function isPrivilegedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/]$/, '').toLowerCase()
  if (host === 'localhost' || host === '[::1]') return true
  if (host.endsWith('.ts.net')) return true
  if (host === 'serverlocal' || host.startsWith('serverlocal.')) return true
  if (host.startsWith('100.')) {
    const octets = host.split('.').map(Number)
    const cgnatSecond = octets[1]
    if (octets.length === 4 && octets[0] === 100 && cgnatSecond !== undefined
      && Number.isInteger(cgnatSecond) && cgnatSecond >= 64 && cgnatSecond <= 127) return true
  }
  const parts = host.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export type {
  SettingsGeneralItemOwnerProps, SettingsHeaderOwnerProps, SettingsLauncherOwnerProps,
  SettingsOnboardingOwnerProps, SettingsPluginsTabOwnerProps, SettingsSectionOwnerProps,
  SettingsTriggerOwnerProps,
} from './contract/slots.ts'
export type { SettingsScopeController, SettingsScopeBinder } from './settings-scope.ts'
export type { SettingsScope, SettingsScopeSnapshot, SettingsScopeSpec } from './settings-contract.ts'
export type { SettingsSchemaService } from './schema.ts'
export type { SchemaNode } from './schema.ts'
export type {
  SettingsDescribeFace, SettingsDescribeView, SettingsMirrorSnapshot,
} from './settings-mirror.ts'
export type { ConfigForms } from './config-form.ts'
export type { ConfigForm, ConfigFormSnapshot } from './config-form-types.ts'

/**
 * Required services: the Remote namespace the mirror reads through and the
 * forwarded settings invalidation it refreshes on.
 */
export const inject = ['remote', 'remote.settings']

/**
 * Provide the settings-domain services over one shared describe mirror, and
 * keep that mirror fresh on the two signals that can move the settings
 * document: a document commit and a (re)connect.
 *
 * Constructing the services in this plugin's fiber keeps their traced methods
 * bound to each consuming plugin's context.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const schema = new SettingsSchemaService(ctx)
  // Resolved once here, where `remote` is declared in this plugin's own
  // `inject`; the binder hands the same answer to every scope it binds.
  // Fork: Tailscale and other privileged private origins count as loopback
  // too. The carrier's loopback detection only recognizes the browser's own
  // machine, so the tunnel origins would fall to the in-memory store and the
  // config/plugins pages would show "settings unavailable in this browser".
  const privileged = ctx.remote.$host.isLoopback
    || (typeof location !== 'undefined' && isPrivilegedHostname(location.hostname))
  const persistence = privileged ? 'host' : 'memory'
  const mirror = new SettingsDescribeMirror(ctx, persistence)
  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('settings/document-updated', () => { void mirror.load() }),
      ctx.on('connection/reset', () => { void mirror.load() }),
    ]
    // The first connection also emits connection/reset, so startup normally
    // costs two reads (budgeted in startup-rpc-budget.e2e.ts). The in-flight
    // fold does not merge them into one; it guarantees at most one pending
    // read at a time and that no invalidation arriving mid-read is lost.
    void mirror.ensure()
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings: describe mirror invalidations')
  new ConfigForms(ctx, { mirror, schema, persistence })
  new SettingsScopeBinder(ctx, { mirror, schema, persistence })
}
