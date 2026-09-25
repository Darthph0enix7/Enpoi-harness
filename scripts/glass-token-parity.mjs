#!/usr/bin/env node
/**
 * Glass token-parity gate: every seam-relevant transition in the shell packages
 * must read the shared motion tokens (`--ds-transition-duration-slow`,
 * `--ds-ease-in-out`). A merge that re-hardcodes `120ms` (or a bare easing) in
 * one file silently de-synchronises the frame track, the panel slide, the rail
 * reservation and the dock ride — the seam that glass-seam-probe.mjs measures.
 *
 * Seam-relevant rules are the surfaces whose geometry rides a track toggle:
 * .frame, .centerCol, .sidebarCol, .handle, .panel, .editor(.Divider) and .dock.
 * Only durations and easings on those rules are checked; hover washes on
 * buttons and the dock handle's background hint are out of scope.
 *
 * Usage: node scripts/glass-token-parity.mjs
 * Exit: 0 parity holds, 1 on the first hard-coded motion value, 2 on a missing file.
 */
import fs from 'node:fs'
import path from 'node:path'

const FILES = [
  'packages/client/ui-layout/src/client/AppFrame.module.css',
  'packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css',
  'packages/client/ui-brand-enpoi/src/client/terminal/TerminalPanel.module.css',
]
/** Rules whose geometry rides the shared curve. */
const SEAM_SELECTOR = /(^|[\s,>+~])\.(frame|centerCol|sidebarCol|handle|panel|editorDivider|editor|dock)(?![\w-])/
/** Duration/easing literals that must not appear on those rules. */
const LITERAL_DURATION = /(?:^|[\s,(])(\d*\.?\d+)(ms|s)(?![\w-])/g
const BARE_EASING = /(?:^|[\s,(])(ease-in-out|ease-in|ease-out|ease)(?![\w-])/g

const violations = []
for (const file of FILES) {
  const absolute = path.resolve(file)
  if (!fs.existsSync(absolute)) {
    console.error(`glass-token-parity: missing ${file}`)
    process.exitCode = 2
    continue
  }
  const source = fs.readFileSync(absolute, 'utf8')
  const lines = source.split('\n')
  // Strip comments but keep line positions by replacing with spaces.
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
  const rulePattern = /(?:^|[{};\s])([^{}]+?)\{([^{}]*)\}/g
  let match
  while ((match = rulePattern.exec(cleaned)) !== null) {
    const selector = match[1].trim()
    const body = match[2]
    if (!SEAM_SELECTOR.test(selector)) continue
    const declarations = body.split(';').map(part => part.trim()).filter(Boolean)
    for (const declaration of declarations) {
      const [property, ...rest] = declaration.split(':')
      const value = rest.join(':')
      if (property.trim() !== 'transition' && !property.trim().startsWith('transition-')) continue
      // Durations: any nonzero literal is a re-hardcoded ride time.
      for (const hit of value.matchAll(LITERAL_DURATION)) {
        if (Number(hit[1]) === 0) continue
        violations.push({ file, selector, declaration, why: `hard-coded duration ${hit[1]}${hit[2]}` })
      }
      // Easings: `linear` stays legal for the visibility flip's step delay.
      for (const hit of value.matchAll(BARE_EASING)) {
        violations.push({ file, selector, declaration, why: `hard-coded easing ${hit[1]}` })
      }
    }
  }
  for (const violation of violations.filter(v => v.file === file)) {
    const line = lines.findIndex(text => text.includes(violation.declaration.slice(0, 24))) + 1
    console.error(`${violation.file}:${line}  ${violation.selector}  ${violation.declaration}  (${violation.why})`)
  }
}

if (violations.length > 0) {
  console.error(`glass-token-parity: ${violations.length} hard-coded motion value(s); use var(--ds-transition-duration-slow) and var(--ds-ease-in-out)`)
  process.exitCode = 1
} else {
  console.log(`glass-token-parity: OK (${FILES.length} files)`)
}
