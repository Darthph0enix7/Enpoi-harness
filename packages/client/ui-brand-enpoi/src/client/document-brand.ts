/**
 * Document identity guard for the fork. The merged shell owns the browser
 * title through ui-layout's DocumentTitle projection and derives the product
 * part from `process.env.DSH_CLIENT_TITLE` (the official build default is
 * "DeepSeek Harness") with `brand.localBuild` as fallback; its icon links also
 * point at an upstream dark-scheme asset. Keep the tab on the fork identity
 * after boot and after every later shell write.
 * @module @deepseek-ai/dsh-client-ui-brand-enpoi/src/client/document-brand
 */

import { en } from './locales.ts'

/** Product title the fork shows in the browser tab. */
export const ENPOI_PRODUCT_TITLE: string = en.productTitle

/** Product-title markers a non-fork build environment may embed in the shell (matched, never rendered). */
const UPSTREAM_PRODUCT_MARKERS = ['DeepSeek Harness', 'DSH Local Build'] as const

/** Upstream dark-scheme favicon; the fork's monogram is its sibling. */
const UPSTREAM_ICON_FILE = 'favicon-dark.svg'

/** Fork favicon shipped beside the upstream asset in the web root. */
const ENPOI_ICON_FILE = 'favicon.svg'

/**
 * Replace an embedded upstream product title with the fork title. The shell
 * projects a selected session as `${sessionTitle} — ${productTitle}`, so only
 * the product suffix changes.
 * @param current - Title currently on the document.
 * @returns The fork title, or the input when it carries no upstream product title.
 */
export function brandedDocumentTitle(current: string): string {
  for (const upstream of UPSTREAM_PRODUCT_MARKERS) {
    if (current === upstream) return ENPOI_PRODUCT_TITLE
    const suffix = ` — ${upstream}`
    if (current.endsWith(suffix)) return `${current.slice(0, -suffix.length)} — ${ENPOI_PRODUCT_TITLE}`
  }
  return current
}

/** Repoint every upstream dark icon link at the fork's monogram. */
function applyBrandIcon(): void {
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
    const href = link.getAttribute('href')
    if (href === null || !href.endsWith(UPSTREAM_ICON_FILE)) continue
    link.setAttribute('href', `${href.slice(0, -UPSTREAM_ICON_FILE.length)}${ENPOI_ICON_FILE}`)
  }
}

/**
 * Apply the fork title immediately and after each later shell write, and point
 * the active icon links at the fork monogram.
 * @returns Disposer that stops observing the title element.
 */
export function installDocumentBrand(): () => void {
  // No document in non-browser test faces; the browser half owns branding.
  if (typeof document === 'undefined') return () => {}
  applyBrandIcon()
  const reapply = (): void => {
    const next = brandedDocumentTitle(document.title)
    if (next !== document.title) document.title = next
  }
  reapply()
  const title = document.querySelector('title')
  if (title === null || typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(reapply)
  observer.observe(title, { childList: true, characterData: true, subtree: true })
  return () => { observer.disconnect() }
}
