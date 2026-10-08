/** Dictionary-backed translate stubs with the locale service's `{name}` interpolation. */

import { en, zh } from '../src/client/locales.ts'

/** Interpolate one template with `{name}` placeholders; unknown names stay literal. */
export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

/** English translate stub matching the component `t` seat. */
export function translateEn(key: keyof typeof en, params?: Record<string, unknown>): string {
  return interpolate(en[key], params)
}

/** Chinese translate stub matching the component `t` seat. */
export function translateZh(key: keyof typeof zh, params?: Record<string, unknown>): string {
  return interpolate(zh[key], params)
}
