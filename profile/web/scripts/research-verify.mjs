#!/usr/bin/env node
/**
 * research-verify — deterministic anchor verification for a research run.
 *
 * Checks every claim's verbatim quote against its saved source page (exact →
 * whitespace-normalized → casefolded → token-window fuzzy), records date
 * context, groups claims by key/text for single-source and conflict flags, and
 * writes verification.json + verification.md into the run directory.
 *
 * Usage: node research-verify.mjs --run-dir <dir> [--quiet]
 * Exit codes: 0 = every claim anchored; 1 = at least one claim unanchored or
 * missing its source; 2 = usage / IO error.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const FUZZY_ACCEPT = 0.85

function fail(message) {
  process.stderr.write(`research-verify: ${message}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const args = { runDir: undefined, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--run-dir') args.runDir = argv[++i]
    else if (a === '--quiet') args.quiet = true
    else fail(`unknown argument "${a}"`)
  }
  if (!args.runDir) fail('missing required --run-dir')
  return args
}

/** Fold typographic variants and collapse whitespace (case preserved). */
function normalize(text) {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whitespace-normalized, punctuation folded to single spaces (case preserved). */
function loose(text) {
  return normalize(text)
    .replace(/[^\p{L}\p{N}$€£%]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Casefolded token list for fuzzy window matching. */
function tokens(text) {
  return loose(text).toLowerCase().split(' ').filter(t => t !== '')
}

/** Token-window similarity: best fraction of quote tokens found in any source window. */
function fuzzyRatio(quoteTokens, sourceTokens) {
  const window = quoteTokens.length
  if (window === 0 || sourceTokens.length < window) return 0
  const haystack = sourceTokens.length > 60000 ? sourceTokens.slice(0, 60000) : sourceTokens
  const quoteCounts = new Map()
  for (const t of quoteTokens) quoteCounts.set(t, (quoteCounts.get(t) ?? 0) + 1)
  let best = 0
  for (let start = 0; start + window <= haystack.length; start += 1) {
    const seen = new Map()
    let hits = 0
    for (let i = start; i < start + window; i += 1) {
      const t = haystack[i]
      const have = quoteCounts.get(t)
      if (have === undefined) continue
      const used = seen.get(t) ?? 0
      if (used < have) {
        seen.set(t, used + 1)
        hits += 1
      }
    }
    const ratio = hits / window
    if (ratio > best) best = ratio
    if (best >= 0.999) break
  }
  return best
}

/** Locate the quote in the source; returns { status, method, ratio, index, space }. */
function anchor(quote, rawSource) {
  if (quote.length === 0) return { status: 'unanchored', method: 'empty', ratio: 0, index: -1, space: 'raw' }
  const exact = rawSource.indexOf(quote)
  if (exact !== -1) return { status: 'anchored', method: 'exact', ratio: 1, index: exact, space: 'raw' }
  const nq = normalize(quote)
  const ns = normalize(rawSource)
  const at = ns.indexOf(nq)
  if (at !== -1) return { status: 'anchored', method: 'normalized', ratio: 1, index: at, space: 'normalized' }
  const lq = loose(quote)
  const ls = loose(rawSource)
  const looseAt = ls.indexOf(lq)
  if (looseAt !== -1) return { status: 'anchored', method: 'loose', ratio: 1, index: looseAt, space: 'loose' }
  const ci = ls.toLowerCase().indexOf(lq.toLowerCase())
  if (ci !== -1) return { status: 'anchored', method: 'loose-casefolded', ratio: 1, index: ci, space: 'loose' }
  const ratio = fuzzyRatio(tokens(quote), tokens(rawSource))
  if (ratio >= FUZZY_ACCEPT) return { status: 'weak', method: 'fuzzy', ratio, index: -1, space: 'raw' }
  return { status: 'unanchored', method: 'none', ratio, index: -1, space: 'raw' }
}

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec'

/** Common renderings of one ISO date; empty when the date is not ISO-parseable. */
function dateVariants(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!m) return []
  const [, y, mo, d] = m
  const day = Number(d)
  const monthLong = new Date(`${date}T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const monthShort = new Date(`${date}T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const out = new Set([
    `${y}-${mo}-${d}`,
    `${y}/${mo}/${d}`,
    `${day}.${Number(mo)}.${y}`,
    `${d}.${mo}.${y}`,
  ])
  // "Sept" is a common short form that neither long nor 3-letter short covers.
  for (const mon of [monthLong, monthShort, 'Sept']) {
    out.add(`${mon} ${day}, ${y}`)
    out.add(`${day} ${mon} ${y}`)
    out.add(`${day} ${mon}, ${y}`)
    out.add(`${mon} ${y}`)
  }
  return [...out]
}

/** Whether the date (or its variants) appears in the text. */
function dateInText(date, text) {
  const variants = dateVariants(date)
  if (variants.length === 0) return undefined
  const hay = normalize(text)
  return variants.some(v => hay.includes(v) || hay.toLowerCase().includes(v.toLowerCase()))
}

/** Canonical numeric values of a claim: k-suffix expanded, separators and trailing zeros normalized. */
function numbersOf(text) {
  const expanded = text.replace(/\b(\d+(?:\.\d+)?)\s*[kK]\b/g, (_, n) => String(Math.round(Number(n) * 1000)))
  const tokens = expanded.match(/-?\d[\d.,]*%?/g) ?? []
  const out = new Set()
  for (const t of tokens) {
    let s = t.replace(/[%.,]+$/, '')
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replaceAll(',', '')
    else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replaceAll('.', '').replace(',', '.')
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
    if (s !== '' && s !== '-') out.add(s)
  }
  return [...out]
}

/** Numbers masked to `#`, punctuation folded: the assertion's skeleton for similarity. */
function maskedTokens(text) {
  const masked = text
    .replace(/\b(\d+(?:\.\d+)?)\s*[kK]\b/g, '#')
    .replace(/\d[\d.,]*%?/g, '#')
  return new Set(tokens(masked).filter(t => t !== '#'))
}

/** Jaccard similarity of two token sets. */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function loadClaims(runDir) {
  const claimsDir = join(runDir, 'claims')
  if (!existsSync(claimsDir)) fail(`no claims/ directory in ${runDir}`)
  const claims = []
  for (const name of readdirSync(claimsDir).sort()) {
    if (!name.endsWith('.jsonl')) continue
    const lines = readFileSync(join(claimsDir, name), 'utf8').split('\n')
    for (const [i, line] of lines.entries()) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch (error) {
        claims.push({ id: `c-${claims.length + 1}`, file: `${name}:${i + 1}`, parseError: String(error), claim: trimmed.slice(0, 120) })
        continue
      }
      claims.push({
        id: `c-${claims.length + 1}`,
        file: `${name}:${i + 1}`,
        claim: typeof parsed.claim === 'string' ? parsed.claim : '',
        quote: typeof parsed.quote === 'string' ? parsed.quote : '',
        source: typeof parsed.source === 'string' ? parsed.source : '',
        url: typeof parsed.url === 'string' ? parsed.url : '',
        date: typeof parsed.date === 'string' && parsed.date !== '' ? parsed.date : null,
        key: typeof parsed.key === 'string' && parsed.key !== '' ? parsed.key : null,
      })
    }
  }
  return claims
}

function main() {
  const { runDir: rawDir, quiet } = parseArgs(process.argv.slice(2))
  const runDir = resolve(rawDir)
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) fail(`run directory not found: ${runDir}`)

  const sourcesDir = join(runDir, 'sources')
  const index = []
  const indexFile = join(sourcesDir, 'index.json')
  if (existsSync(indexFile)) {
    try {
      const parsed = JSON.parse(readFileSync(indexFile, 'utf8'))
      if (Array.isArray(parsed)) index.push(...parsed)
    } catch (error) {
      process.stderr.write(`research-verify: warning: sources/index.json unreadable (${String(error)})\n`)
    }
  }
  const byFile = new Map(index.filter(e => e && typeof e.file === 'string').map(e => [e.file, e]))

  const claims = loadClaims(runDir)
  if (claims.length === 0) fail('no claims found (claims/*.jsonl is empty)')

  const sourceCache = new Map()
  const readSource = file => {
    if (sourceCache.has(file)) return sourceCache.get(file)
    const candidates = [file, `${file}.md`, join(sourcesDir, file)]
    let text
    for (const c of candidates) {
      const p = c.startsWith('/') ? c : join(sourcesDir, c)
      if (existsSync(p)) {
        text = readFileSync(p, 'utf8')
        break
      }
    }
    sourceCache.set(file, text)
    return text
  }

  let anchored = 0
  let weak = 0
  let unanchored = 0
  for (const c of claims) {
    if (c.parseError !== undefined) {
      c.status = 'unanchored'
      c.method = 'parse-error'
      unanchored += 1
      continue
    }
    const text = c.source === '' ? undefined : readSource(c.source)
    if (text === undefined) {
      c.status = 'unanchored'
      c.method = c.source === '' ? 'missing-source-field' : 'source-file-missing'
      unanchored += 1
      continue
    }
    const result = anchor(c.quote, text)
    c.status = result.status
    c.method = result.method
    c.ratio = Math.round(result.ratio * 100) / 100
    if (result.status === 'anchored') anchored += 1
    else if (result.status === 'weak') weak += 1
    else unanchored += 1
    if (c.date !== null) {
      c.dateInSource = dateInText(c.date, text) ?? null
      if (result.index >= 0) {
        const spaceText = result.space === 'raw' ? text : result.space === 'loose' ? loose(text) : normalize(text)
        const near = spaceText.slice(Math.max(0, result.index - 1500), result.index + 1500)
        c.dateNearQuote = dateInText(c.date, near) ?? null
      } else {
        c.dateNearQuote = null
      }
    }
    const meta = byFile.get(c.source)
    if (meta && typeof meta.url === 'string' && c.url === '') c.url = meta.url
  }

  // Groups: same key (preferred) or same normalized claim text.
  const groups = new Map()
  for (const c of claims) {
    const key = c.key ?? normalize(c.claim).toLowerCase().slice(0, 120)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }
  const groupSummaries = []
  let singleSource = 0
  let conflicts = 0
  for (const [key, members] of groups) {
    const sources = [...new Set(members.map(m => m.source).filter(s => s !== ''))]
    const numberSets = members.map(m => new Set(numbersOf(m.claim)))
    const masked = members.map(m => maskedTokens(m.claim))
    let conflicting = false
    let conflictSimilarity = 0
    for (let i = 0; i < members.length && !conflicting; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        // A same-source pair is a detail variant of one page, not a disagreement.
        if (members[i].source === members[j].source) continue
        const a = numberSets[i]
        const b = numberSets[j]
        if (a.size === 0 && b.size === 0) continue
        const differs = [...a].some(n => !b.has(n)) || [...b].some(n => !a.has(n))
        if (!differs) continue
        // Only near-identical assertions count: a differing detail (an extra
        // price row, a latency figure, a different vendor) is not a contradiction.
        const sim = jaccard(masked[i], masked[j])
        if (sim >= 0.75) {
          conflicting = true
          conflictSimilarity = sim
          break
        }
      }
    }
    const summary = {
      key,
      claims: members.map(m => m.id),
      sources,
      singleSource: sources.length === 1,
      conflicting,
      ...conflicting ? { similarity: Math.round(conflictSimilarity * 100) / 100 } : {},
    }
    if (summary.singleSource) singleSource += 1
    if (conflicting) conflicts += 1
    groupSummaries.push(summary)
    for (const m of members) {
      m.group = key
      m.flags = [
        ...(summary.singleSource ? ['single-source'] : []),
        ...(conflicting ? ['conflict'] : []),
        ...(m.status === 'weak' ? ['weak-anchor'] : []),
        ...(m.date === null ? ['no-date'] : []),
        ...(m.date !== null && m.dateInSource === false ? ['date-not-in-source'] : []),
      ]
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    runDir,
    totals: {
      claims: claims.length,
      anchored,
      weak,
      unanchored,
      singleSource,
      conflicts,
      sources: byFile.size,
    },
    claims,
    groups: groupSummaries,
  }
  writeFileSync(join(runDir, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`)

  const lines = []
  lines.push(`# Verification — ${runDir}`)
  lines.push('')
  lines.push(`Generated ${report.generatedAt} · ${claims.length} claims · ${anchored} anchored · ${weak} weak · ${unanchored} unanchored · ${singleSource} single-source · ${conflicts} conflicting`)
  lines.push('')
  lines.push('| id | status | method | source | date | flags | claim |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const c of claims) {
    const flags = (c.flags ?? []).join(', ')
    const date = c.date === null ? '—' : `${c.date}${c.dateInSource === false ? ' (!)' : ''}`
    lines.push(`| ${c.id} | ${c.status} | ${c.method}${c.ratio !== undefined && c.method === 'fuzzy' ? ` ${c.ratio}` : ''} | ${c.source || '—'} | ${date} | ${flags} | ${c.claim.replaceAll('|', '\\|').slice(0, 140)} |`)
  }
  if (unanchored + weak > 0) {
    lines.push('')
    lines.push('## Not reportable as-is')
    lines.push('')
    for (const c of claims.filter(x => x.status !== 'anchored')) {
      lines.push(`- **${c.id}** (${c.method}${c.ratio !== undefined && c.method === 'fuzzy' ? `, ratio ${c.ratio}` : ''}) — re-quote verbatim from \`${c.source || 'a saved source'}\`, re-source, or mark unknown.`)
      lines.push(`  - claim: ${c.claim.slice(0, 200)}`)
      if (c.quote) lines.push(`  - quote: ${c.quote.slice(0, 200)}`)
    }
  }
  const conflictingGroups = groupSummaries.filter(g => g.conflicting)
  if (conflictingGroups.length > 0) {
    lines.push('')
    lines.push('## Conflicting values (check dates before judging)')
    lines.push('')
    for (const g of conflictingGroups) {
      lines.push(`- **${g.key}** — ${g.claims.join(', ')} across ${g.sources.join(', ')}`)
    }
  }
  writeFileSync(join(runDir, 'verification.md'), `${lines.join('\n')}\n`)

  if (!quiet) {
    const verdict = unanchored === 0 && weak === 0
      ? 'PASS — every claim is anchored'
      : `ATTENTION — ${unanchored} unanchored, ${weak} weak (not reportable until fixed)`
    process.stdout.write(
      `research-verify: ${verdict}\n`
      + `claims ${claims.length} · anchored ${anchored} · weak ${weak} · unanchored ${unanchored} · single-source ${singleSource} · conflicts ${conflicts}\n`
      + `report: ${join(runDir, 'verification.md')}\n`,
    )
  }
  process.exit(unanchored > 0 || weak > 0 ? 1 : 0)
}

main()
