/**
 * Command Code CLI request headers.
 *
 * The vendor only serves its CLI-shaped `/alpha/generate` endpoint to clients
 * that identify as the Command Code CLI. The four header values mirror the
 * standalone keypool proxy (`keypool/proxy.js`), which injected them on every
 * pooled request; the version is pinned because the vendor rejects clients it
 * considers out of date. Auth mirrors the proxy's dual shape: `Authorization:
 * Bearer` for gateway readers and `x-api-key` for Anthropic-style readers,
 * both carrying the same per-attempt key.
 *
 * @module dsh-enpoi-commandcode-provider/headers
 */

/** CLI version the vendor gate accepts; mirrors the keypool proxy's value. */
export const COMMAND_CODE_CLI_VERSION = '1.54.0'

/** CLI identity headers every Command Code request must carry. */
export const COMMAND_CODE_CLI_HEADERS: Readonly<Record<string, string>> = {
  'x-command-code-version': COMMAND_CODE_CLI_VERSION,
  'x-cli-environment': 'production',
  'x-project-slug': 'opencode',
  'user-agent': 'cli',
}

/**
 * The complete identity and auth header set for one pooled attempt: the four
 * CLI headers plus, when a key is present, the proxy's dual auth. No key sends
 * no auth header, which is the only honest shape for an unresolved identity.
 * @param apiKey - the identity's resolved key, when one exists.
 * @returns headers to merge into the request.
 */
export function commandCodeHeaders(apiKey?: string): Record<string, string> {
  return {
    ...COMMAND_CODE_CLI_HEADERS,
    ...apiKey === undefined || apiKey === '' ? {} : {
      authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
    },
  }
}
