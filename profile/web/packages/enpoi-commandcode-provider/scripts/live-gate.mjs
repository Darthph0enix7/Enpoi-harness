#!/usr/bin/env node
/**
 * Owner-run live gate for the direct Command Code path (native key pool).
 *
 * Proves the vendor CLI gate with two direct `/alpha/generate` requests:
 * one carrying the four Command Code CLI headers (the native-pool shape) and
 * one with auth but without them. The key is read from an environment variable
 * and is never written to disk, printed, or included in the output.
 *
 * Usage:
 *   COMMANDCODE_API_KEY=<key> node scripts/live-gate.mjs [--base-url URL] [--model ID]
 *
 * Environment overrides:
 *   COMMANDCODE_API_KEY   credential (required; the only place the key lives)
 *   COMMANDCODE_BASE_URL  vendor base URL (default https://api.commandcode.ai)
 *   COMMANDCODE_MODEL     model id (default deepseek/deepseek-v4.1-flash)
 *
 * Exit status: 0 when the CLI-header request is accepted (2xx); 1 otherwise.
 */

const KEY_ENV = 'COMMANDCODE_API_KEY'
const DEFAULT_BASE_URL = 'https://api.commandcode.ai'
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash'
const REQUEST_TIMEOUT_MS = 30_000
const SNIPPET_CHARS = 300

/** CLI identity headers the vendor gate expects (mirrors src/headers.ts). */
const CLI_HEADERS = {
  'x-command-code-version': '1.54.0',
  'x-cli-environment': 'production',
  'x-project-slug': 'opencode',
  'user-agent': 'cli',
}

function parseArgs(argv) {
  const args = { baseURL: process.env.COMMANDCODE_BASE_URL ?? DEFAULT_BASE_URL, model: process.env.COMMANDCODE_MODEL ?? DEFAULT_MODEL }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-url' && argv[i + 1] !== undefined) args.baseURL = argv[++i]
    else if (argv[i] === '--model' && argv[i + 1] !== undefined) args.model = argv[++i]
  }
  return args
}

/** The envelope `/alpha/generate` validates (mirrors src/convert.ts). */
function requestBody(model) {
  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().slice(0, 10),
      environment: `${process.platform}-${process.arch}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: '',
    taste: '',
    skills: null,
    permissionMode: 'standard',
    params: {
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: LIVE-GATE-OK' }] }],
      tools: [],
      system: '',
      max_tokens: 32,
      stream: true,
    },
  }
}

/** Shorten response text and remove any accidental key echo. */
function safeSnippet(text, key) {
  const redacted = key.length > 0 ? text.split(key).join('[redacted]') : text
  return redacted.replace(/\s+/g, ' ').slice(0, SNIPPET_CHARS)
}

/**
 * One direct request.
 * @returns {Promise<{ status: number | undefined, ok: boolean, text: string, error?: string }>}
 */
async function send({ baseURL, model, key, withCliHeaders }) {
  const url = `${baseURL.replace(/\/+$/, '')}/alpha/generate`
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${key}`,
    'x-api-key': key,
    ...(withCliHeaders ? CLI_HEADERS : {}),
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody(model)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text().catch(() => '')
    return { status: response.status, ok: response.ok, text }
  } catch (error) {
    return { status: undefined, ok: false, text: '', error: error instanceof Error ? error.message : String(error) }
  }
}

async function main() {
  const key = process.env[KEY_ENV]
  if (key === undefined || key === '') {
    console.error(`${KEY_ENV} is not set — export the Command Code key and re-run; it is never printed.`)
    process.exit(2)
  }
  const args = parseArgs(process.argv.slice(2))
  console.log('commandcode live gate — direct /alpha/generate')
  console.log(`  endpoint: ${args.baseURL.replace(/\/+$/, '')}/alpha/generate`)
  console.log(`  model:    ${args.model}`)

  const withHeaders = await send({ ...args, key, withCliHeaders: true })
  console.log('')
  if (withHeaders.status === undefined) {
    console.log(`  with CLI headers:    TRANSPORT ERROR — ${withHeaders.error ?? 'unknown'}`)
  } else {
    const verdict = withHeaders.ok ? 'ACCEPTED' : 'REJECTED'
    console.log(`  with CLI headers:    HTTP ${withHeaders.status} ${verdict} — ${safeSnippet(withHeaders.text, key)}`)
  }

  const withoutHeaders = await send({ ...args, key, withCliHeaders: false })
  if (withoutHeaders.status === undefined) {
    console.log(`  without CLI headers: TRANSPORT ERROR — ${withoutHeaders.error ?? 'unknown'}`)
  } else {
    const verdict = withoutHeaders.ok ? 'ACCEPTED (gate not enforced)' : 'REJECTED'
    console.log(`  without CLI headers: HTTP ${withoutHeaders.status} ${verdict} — ${safeSnippet(withoutHeaders.text, key)}`)
  }

  console.log('')
  if (withHeaders.ok) {
    console.log('verdict: the direct path with CLI headers works — the native pool can reach the vendor.')
    process.exit(0)
  }
  console.log('verdict: the direct path with CLI headers did NOT succeed — keep the keypool proxy and re-check the header version.')
  process.exit(1)
}

await main()
