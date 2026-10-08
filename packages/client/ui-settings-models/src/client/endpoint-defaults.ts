/**
 * Shipped endpoint defaults for provider forms.
 *
 * Endpoint addresses are deployment data, not translated copy: forms read
 * them from here (or from the operator's own settings), so a locale
 * dictionary never carries a URL.
 * @module ui-settings-models/endpoint-defaults
 */

/** DeepSeek's Anthropic-compatible endpoint, the shipped default for its route. */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

/** OpenAI-compatible URL shown as an input example. */
export const OPENAI_BASE_URL_EXAMPLE = 'https://api.openai.com/v1'

/** OpenAI-compatible gateway URL shown as an input example. */
export const CUSTOM_BASE_URL_EXAMPLE = 'https://gateway.example/v1'

/** Anthropic-compatible gateway URL shown as an input example. */
export const CUSTOM_ANTHROPIC_BASE_URL_EXAMPLE = 'https://gateway.example'
