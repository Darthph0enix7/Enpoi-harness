/**
 * Host-locale dictionaries for the webserver's registration errors.
 *
 * Route collisions and a double-claimed fallback are composition errors the
 * operator reads in a boot failure or startup log. This package knows no
 * harness concepts and never reads the settings service, so the locale comes
 * from the launch environment only: an explicit `DSH_LOCALE`, then the POSIX
 * tags, then `en`. zh is the key-set source of truth; en is checked complete
 * against it.
 *
 * @module @deepseek-ai/dsh-host-webserver/locales
 */

/** Locale ids this surface ships dictionaries for. */
export type HostLocale = 'en' | 'zh'

/**
 * The host locale from the launch environment: an explicit `DSH_LOCALE` wins
 * over the POSIX tags. Anything but a `zh` tag resolves to `en`.
 * @param env - environment to read; defaults to the process environment.
 * @returns the resolved host locale.
 */
export function hostLocale(env: NodeJS.ProcessEnv = process.env): HostLocale {
  const tag = env.DSH_LOCALE ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? ''
  return /^zh\b/i.test(tag.replaceAll('_', '-')) ? 'zh' : 'en'
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'duplicateRoute': 'webserver：重复的 {kind} 路由 “{path}”',
  'duplicateUpgradeRoute': 'webserver：重复的升级路由 “{path}”',
  'fallbackRegistered': 'webserver：fallback 已注册',
} satisfies Record<string, string>

/** The webserver text key union. */
export type WebServerTextKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'duplicateRoute': 'webserver: duplicate {kind} route "{path}"',
  'duplicateUpgradeRoute': 'webserver: duplicate upgrade route "{path}"',
  'fallbackRegistered': 'webserver: fallback already registered',
} satisfies Record<WebServerTextKey, string>

/**
 * Render one dictionary entry with its named parameters substituted.
 * @param locale - the resolved host locale.
 * @param key - the dictionary key.
 * @param params - placeholder values; an unlisted placeholder stays verbatim.
 * @returns the localized message.
 */
export function webServerText(
  locale: HostLocale,
  key: WebServerTextKey,
  params: Readonly<Record<string, string>> = {},
): string {
  const template = (locale === 'zh' ? zh : en)[key]
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => params[name] ?? match)
}
