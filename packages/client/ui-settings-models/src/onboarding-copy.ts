/** Durable settings namespace for product-wide GUI onboarding facts. */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-settings-general'

/** Field storing the last welcome notice version the user acknowledged. */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
export const WELCOME_NOTICE_VERSION = '2026-08-13.1'

/** Shipped version label the notice prose falls back to without build metadata. */
export const SHIPPED_PRODUCT_VERSION = '0.1'

/**
 * The major/minor label the notice prose states, derived from the build's
 * version metadata instead of baked into translated copy.
 * @param version - the build's `DSH_CLIENT_VERSION`, when present.
 * @returns the label, or the shipped fallback when the build carries none.
 */
export function productVersionLabel(version: string | undefined): string {
  const match = /^(\d+\.\d+)/.exec(version ?? '')
  return match?.[1] ?? SHIPPED_PRODUCT_VERSION
}
