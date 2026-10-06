#!/usr/bin/env node
/**
 * research-fetch — fetch one public URL and archive it as a markdown source
 * file inside a research run directory. Only metadata is printed to stdout;
 * the page text never enters the conversation.
 *
 * Usage: node research-fetch.mjs --url <url> --dir <sources-dir> [--name <slug>] [--max-chars N]
 * Output: one JSON line {ok, file, url, title, chars, index} (or {ok:false, error}).
 * Exit codes: 0 = handled (see ok), 2 = usage error.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const DEFAULT_MAX_CHARS = 400000
const TIMEOUT_MS = 30000
const USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'

function fail(message) {
  process.stderr.write(`research-fetch: ${message}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const args = { url: undefined, dir: undefined, name: '', maxChars: DEFAULT_MAX_CHARS }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--url') args.url = argv[++i]
    else if (a === '--dir') args.dir = argv[++i]
    else if (a === '--name') args.name = argv[++i] ?? ''
    else if (a === '--max-chars') args.maxChars = Number(argv[++i])
    else fail(`unknown argument "${a}"`)
  }
  if (!args.url) fail('missing required --url')
  if (!args.dir) fail('missing required --dir')
  if (!Number.isFinite(args.maxChars) || args.maxChars < 1000) fail('--max-chars must be a number >= 1000')
  return args
}

/** Refuse obvious non-public destinations (localhost and private IP literals). */
function assertPublicUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return { error: `not a valid URL: ${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: `unsupported protocol ${url.protocol}` }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const blocked = host === 'localhost' || host.endsWith('.localhost') || host === '::1'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host)
    || /^0\./.test(host)
    || /^(fc|fd|fe80)/i.test(host)
  if (blocked) return { error: `refusing to fetch a private/loopback address: ${host}` }
  return { url }
}

/** Turndown + GFM via the harness's own conversion stack (the web_fetch converter). */
function loadTurndown() {
  // The harness checkout holds the dependency; an explicit HARNESS_ROOT/DSH_REPO
  // wins, then the documented clone, then the installer layout. Without a
  // checkout the crude stripper below handles the page.
  const harness = [
    process.env.HARNESS_ROOT,
    process.env.DSH_REPO,
    join(homedir(), 'deepseek-harness'),
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'harness', 'current'),
  ].filter(Boolean).find(candidate => existsSync(join(candidate, 'packages')))
  const anchors = [
    harness === undefined ? undefined : join(harness, 'packages/web/tool-web/package.json'),
  ].filter(Boolean)
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      const TurndownService = require('turndown')
      const { gfm } = require('@joplin/turndown-plugin-gfm')
      const Ctor = typeof TurndownService === 'function' ? TurndownService : TurndownService.default
      const service = new Ctor({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
      service.use(gfm)
      // Same non-content removal the web_fetch converter applies.
      service.addRule('removeNonVisibleContent', {
        filter(node) {
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.nodeName)) return true
          if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true
          if (node.nodeName === 'INPUT' && node.getAttribute('type')?.toLowerCase() === 'hidden') return true
          const declarations = node.getAttribute('style')?.split(';') ?? []
          return declarations.some((declaration) => {
            const separator = declaration.indexOf(':')
            if (separator === -1) return false
            const property = declaration.slice(0, separator).trim().toLowerCase()
            const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/u, '')
            return (property === 'display' && value === 'none')
              || (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
          })
        },
        replacement() {
          return ''
        },
      })
      return service
    } catch {
      // fall through to the crude stripper
    }
  }
  return undefined
}

/** Decode the common HTML entities (title text). */
function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** Crude HTML→text fallback when the converter stack is unavailable. */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function titleOf(html, markdown) {
  const tag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (tag && tag[1].trim()) return decodeEntities(tag[1].replace(/\s+/g, ' ').trim()).slice(0, 200)
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown)
  if (heading) return heading[1].trim().slice(0, 200)
  return ''
}

function slugify(text) {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug === '' ? 'source' : slug
}

function nextIndex(dir) {
  let max = 0
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)-/.exec(name)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

function updateIndex(dir, entry) {
  const indexFile = join(dir, 'index.json')
  let entries = []
  if (existsSync(indexFile)) {
    try {
      const parsed = JSON.parse(readFileSync(indexFile, 'utf8'))
      if (Array.isArray(parsed)) entries = parsed
    } catch {
      // A corrupt index is rebuilt from this entry onward; sources stay intact.
    }
  }
  if (!entries.some(e => e && e.file === entry.file)) entries.push(entry)
  writeFileSync(indexFile, `${JSON.stringify(entries, null, 2)}\n`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const checked = assertPublicUrl(args.url)
  if (checked.error) {
    process.stdout.write(`${JSON.stringify({ ok: false, url: args.url, error: checked.error })}\n`)
    return
  }
  const url = checked.url

  const dir = resolve(args.dir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  let response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
    })
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, url, error: `fetch failed: ${error instanceof Error ? error.message : String(error)}` })}\n`)
    return
  }
  if (!response.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, url, status: response.status, error: `HTTP ${response.status}` })}\n`)
    return
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  let body
  try {
    body = await response.text()
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, url, error: `body read failed: ${error instanceof Error ? error.message : String(error)}` })}\n`)
    return
  }

  let markdown
  let title = ''
  if (contentType.includes('html') || /^\s*<(!doctype|html)/i.test(body)) {
    const turndown = loadTurndown()
    markdown = turndown ? turndown.turndown(body) : stripHtml(body)
    title = titleOf(body, markdown)
  } else if (contentType.includes('json')) {
    try {
      markdown = `\`\`\`json\n${JSON.stringify(JSON.parse(body), null, 2)}\n\`\`\``
    } catch {
      markdown = body
    }
  } else {
    markdown = body
  }
  markdown = markdown.replace(/\n{4,}/g, '\n\n\n').trim()

  let truncated = false
  if (markdown.length > args.maxChars) {
    markdown = `${markdown.slice(0, args.maxChars)}\n\n[truncated at ${args.maxChars} characters]`
    truncated = true
  }

  const slug = slugify(args.name !== '' ? args.name : new URL(url).pathname.split('/').filter(Boolean).pop() ?? url)
  const index = nextIndex(dir)
  const file = `${String(index).padStart(2, '0')}-${slug}.md`
  const fetchedAt = new Date().toISOString().slice(0, 10)
  const content = `# ${title || slug}\n\nURL: ${url}\nFetched: ${fetchedAt}\n\n${markdown}\n`
  writeFileSync(join(dir, file), content)
  updateIndex(dir, { file, url, title: title || slug, fetchedAt })

  process.stdout.write(`${JSON.stringify({ ok: true, file, url, title: title || slug, chars: markdown.length, truncated, index: join(dir, 'index.json') })}\n`)
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: `unexpected: ${error instanceof Error ? error.message : String(error)}` })}\n`)
})
