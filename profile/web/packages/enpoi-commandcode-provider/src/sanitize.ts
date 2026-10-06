/**
 * Command Code request sanitizer: the keypool proxy's request-level text
 * limits, ported as pure functions over the `/alpha/generate` envelope.
 *
 * The standalone proxy applied these limits to every harness's forwarded body
 * (`~/.config/opencode/keypool/proxy.js`); with the native pool the adapter
 * owns them. Constants and replacement wording are identical to the proxy so a
 * request sanitized here matches one sanitized there.
 *
 * Current call sites:
 * - {@link sanitizeText} — applied by `convert.ts` at the conversion seam for
 *   a route with no keypool proxy in front of it: embedded base64 data URIs
 *   are scrubbed, then text beyond 200,000 characters is truncated.
 * - {@link stripOlderImagesKeepingNewest} — the one 413 retry: every image but
 *   the newest is replaced, and the adapter retries the SAME identity once.
 *
 * Image budgeting is deliberately absent: the converter's forward pass (12
 * images / 16 MiB total / 8 MiB per image) is the request's only image budget,
 * so a second envelope-wide pass never stacks on top of it.
 *
 * @module dsh-enpoi-commandcode-provider/sanitize
 */

/**
 * Maximum inline tool/output text length; 1-to-1 parity with the Command Code
 * CLI and the keypool proxy.
 */
export const MAX_INLINE_TOOL_TEXT_CHARS = 200_000

/** Embedded data-URI scrub target; 1-to-1 parity with the keypool proxy. */
export const EMBEDDED_B64_RE = /data:image\/[^;]{1,64};base64,[A-Za-z0-9+/=]{512,}/g

/** Replacement note for an image omitted by the 413 retry. */
const IMAGE_STRIP_NOTE = '[older image omitted: request exceeded the upstream payload limit]'

/** One message/part object the sanitizer reads and rewrites; wire objects built by the converter. */
export interface SanitizableMessage {
  role?: unknown
  content?: unknown
  tool_call_id?: unknown
  [key: string]: unknown
}

/** The envelope subset the sanitizer touches; the messages live under `params.messages`. */
export interface SanitizableEnvelope {
  params: {
    messages?: unknown
  }
}

/**
 * Scrub embedded base64 image data URIs from one string, then cap it at
 * {@link MAX_INLINE_TOOL_TEXT_CHARS}. The truncation note is part of the
 * returned text, exactly as the proxy emitted it.
 * @param str - the text to sanitize.
 * @returns the scrubbed and capped text.
 */
export function sanitizeText(str: string): string {
  let s = str
  if (s.includes(';base64,')) {
    s = s.replace(EMBEDDED_B64_RE, (match) => {
      const kb = Math.max(1, Math.round(match.length * 0.75 / 1024))
      return `[embedded base64 payload omitted: ~${kb} KB]`
    })
  }
  if (s.length > MAX_INLINE_TOOL_TEXT_CHARS) {
    const orig = s.length
    s = s.slice(0, MAX_INLINE_TOOL_TEXT_CHARS)
      + `\n... [output truncated: ${orig} chars exceed ${MAX_INLINE_TOOL_TEXT_CHARS} limit]`
  }
  return s
}

/**
 * Whether one wire part carries an image payload. Covers the Command Code
 * envelope shape (`type: "image"` with `image`/`data`) plus the proxy's
 * `image_url` and image-typed `file` spellings.
 * @param part - the candidate part object.
 * @returns true when the part is an image.
 */
function isImagePart(part: unknown): boolean {
  if (part === null || typeof part !== 'object') return false
  const record = part as Record<string, unknown>
  if (record.type === 'image' || record.type === 'image_url') return true
  if (record.type === 'file' && String(record.mediaType ?? record.mimeType ?? '').startsWith('image/')) return true
  return false
}

/**
 * The one 413 retry: replace every image except the newest in the last
 * image-bearing user message, keeping the newest, and report how many were
 * replaced. A request with no image to strip reports 0 and must not be retried.
 * @param envelope - the `/alpha/generate` envelope, mutated in place.
 * @returns the number of images replaced.
 */
export function stripOlderImagesKeepingNewest(envelope: SanitizableEnvelope): number {
  const rawMessages = envelope.params.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return 0
  const messages = rawMessages as Array<Record<string, unknown>>
  let kept = false
  let removed = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message === undefined || message === null || message.role !== 'user' || !Array.isArray(message.content)) continue
    const content = message.content as unknown[]
    for (let p = content.length - 1; p >= 0; p--) {
      if (!isImagePart(content[p])) continue
      if (!kept) {
        kept = true
        continue
      }
      content[p] = { type: 'text', text: IMAGE_STRIP_NOTE }
      removed += 1
    }
  }
  return removed
}
