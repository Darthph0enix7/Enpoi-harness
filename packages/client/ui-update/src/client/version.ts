/**
 * Version-stamp display: the engine stamps source-built installs with a
 * `+g<short-sha>` suffix (`0.1.7-enpoi.2+gbb12abc`). The qualifier is
 * locale-owned and only ever decorates a version the UI already shows — the
 * pill stays version-free.
 * @module @deepseek-ai/dsh-client-ui-update/client/version
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

/** The engine's source-build stamp: `+g` followed by a short sha. */
export const SOURCE_BUILD_STAMP = /\+g[0-9a-f]{7,}/i

/** Whether a version carries the engine's `+g<sha>` source-build stamp. */
export function isSourceBuildVersion(version: string): boolean {
  return SOURCE_BUILD_STAMP.test(version)
}

type Translate = PropsLocale<typeof NS>['t']

/**
 * Render a version, qualifying a source-build stamp with locale-owned copy.
 * @param version - the raw wire version.
 * @param t - the `update` namespace translate seat.
 * @returns the version, plus the qualifier when it is a source build.
 */
export function formatVersion(version: string, t: Translate): string {
  return isSourceBuildVersion(version) ? t('version.sourceBuild', { version }) : version
}
