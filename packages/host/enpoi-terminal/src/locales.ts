/**
 * Host-locale dictionaries for the browser terminal surfaces.
 *
 * The session-cap refusal is the operator-visible error the terminal UI
 * renders. This package publishes no settings-facing surface, so the locale
 * comes from the launch environment only: an explicit `DSH_LOCALE`, then the
 * POSIX tags, then `en`. zh is the key-set source of truth; en is checked
 * complete against it.
 *
 * @module enpoi-terminal/locales
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
  'sessionLimit': '一个会话最多可以运行 {max} 个终端',
} satisfies Record<string, string>

/** The terminal text key union. */
export type TerminalTextKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'sessionLimit': 'at most {max} terminals may run in one session',
} satisfies Record<TerminalTextKey, string>

/**
 * Render one dictionary entry with its named parameters substituted.
 * @param locale - the resolved host locale.
 * @param key - the dictionary key.
 * @param params - placeholder values; an unlisted placeholder stays verbatim.
 * @returns the localized message.
 */
export function terminalText(
  locale: HostLocale,
  key: TerminalTextKey,
  params: Readonly<Record<string, string>> = {},
): string {
  const template = (locale === 'zh' ? zh : en)[key]
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => params[name] ?? match)
}
