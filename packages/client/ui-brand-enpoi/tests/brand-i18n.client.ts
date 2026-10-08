/**
 * Translate stub for specs that render this package's operator surfaces
 * directly: resolves keys against the shipped English dictionary and fills
 * `{name}` template params the way the locale runtime does.
 */
import { en } from '../src/client/locales.ts'

/** Dictionary-bound translate stub rendering the shipped English copy. */
export const brandT = (key: string, params?: Record<string, unknown>): string => {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}
