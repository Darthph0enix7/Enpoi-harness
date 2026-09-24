import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { diffWordsWithSpace, structuredPatch } from 'diff'
import { FoldToggle } from './FoldToggle.tsx'
import { writeClipboard } from './clipboard.ts'
import { CodeToolbar, type CodeToolbarLabels } from './CodeToolbar.tsx'
import { languageForPath } from './code-highlighting.ts'
import cardCss from './CodeCard.module.css'
import css from './DiffBlock.module.css'

/** Output lines shown before the height cap collapses the middle. */
export const DEFAULT_DIFF_MAX_LINES = 16

/**
 * One file change in the form {@link DiffBlock} renders. It is declared here
 * so this primitive stays independent of the tool contract.
 */
export interface DiffHunk {
  /** The changed file's path, drawn verbatim as the hunk's header (the tool's model-facing path). */
  path: string
  /** Prior content including context, or `null` when no prior content is available. */
  oldText: string | null
  /** Content after the change, including any shared context. */
  newText: string
}

/**
 * One hunk of a Host-computed comparison, exactly as the change routes serve
 * it: line numbers and `+`/`-`/space-prefixed lines. The served form keeps the
 * Host's own line alignment and hunk boundaries instead of re-deriving them
 * from two texts.
 */
export interface DiffServedHunk {
  /** 1-based first line of the old side. */
  readonly oldStart: number
  /** 1-based first line of the new side. */
  readonly newStart: number
  /** Every comparison line, prefixed `+`, `-`, or ` ` (context). */
  readonly lines: readonly string[]
}

/** One changed file of a served comparison, with every hunk the Host computed. */
export interface DiffServedFile {
  readonly path: string
  readonly hunks: readonly DiffServedHunk[]
}

export interface DiffBlockProps {
  /** One entry per applied hunk, in file order; empty renders nothing. */
  diffs: readonly DiffHunk[]
  /**
   * A Host-computed comparison to draw instead of `diffs`: hunk headers, line
   * numbers, and (with `wordLevel`) intra-line emphasis. When present it
   * replaces the locally derived patches.
   */
  served?: readonly DiffServedFile[] | undefined
  /** Unified rows, or the two-column side-by-side presentation of a served comparison. */
  view?: 'unified' | 'split' | undefined
  /** Pair changed lines within a served hunk and mark the words that moved. */
  wordLevel?: boolean | undefined
  /** Localized chrome supplied by the owning render site. */
  labels: DiffBlockLabels
  /** Height cap in body lines before the middle collapses (default {@link DEFAULT_DIFF_MAX_LINES}). */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/**
 * Localized chrome for {@link DiffBlock}: the shared code-card toolbar plus the
 * fold controls. `files` is the fork footer summary and stays optional so
 * upstream call sites that only pass toolbar and fold copy keep compiling.
 */
export interface DiffBlockLabels extends CodeToolbarLabels {
  copy: string
  copied: string
  collapseAria: string
  expandAria: (hidden: number) => string
  collapse: string
  expand: (hidden: number) => string
  files?: ((count: number) => string) | undefined
}

/** A single rendered body line and its role, so the height cap slices a flat list. */
interface DiffRow {
  kind: 'path' | 'del' | 'add' | 'context' | 'gap'
  text: string
}

/** One token run inside a changed line; a mark says the word moved. */
interface WordPart {
  readonly text: string
  readonly mark: 'add' | 'del' | null
}

/** One comparison line with the line numbers each side carries. */
interface ServedLine {
  readonly kind: 'del' | 'add' | 'context'
  readonly old: number | undefined
  readonly new: number | undefined
  readonly text: string
  /** Word-level runs when the line paired with its counterpart; undefined otherwise. */
  readonly parts: readonly WordPart[] | undefined
}

/** One side-by-side row: a deletion run paired against the addition run that follows it. */
interface ServedSplitRow {
  readonly left: ServedLine | undefined
  readonly right: ServedLine | undefined
}

/** One hunk of a served file, its header text, and its two presentations. */
interface ServedHunkModel {
  readonly header: string
  readonly lines: readonly ServedLine[]
  readonly splitRows: readonly ServedSplitRow[]
}

/** One served file's hunks. */
interface ServedFileModel {
  readonly path: string
  readonly hunks: readonly ServedHunkModel[]
}

/** The rendered model of one {@link DiffBlock}: local card rows, or a served comparison. */
type DiffModel =
  | { readonly mode: 'cards'; readonly rows: readonly DiffRow[] }
  | { readonly mode: 'served'; readonly files: readonly ServedFileModel[] }

/** The dim class per row kind (path/gap chrome vs the diff's own +/- colors). */
const ROW_CLASS: Record<DiffRow['kind'], string | undefined> = {
  path: css.path,
  del: css.del,
  add: css.add,
  context: css.context,
  gap: css.gap,
}

/** Bound synchronous edit-graph search; one replacement consumes two edits. */
const MAX_DIFF_EDIT_LENGTH = 256

/** Derive exact local patches or a whole-fragment replacement when search exceeds the limit. */
function localHunks(diff: DiffHunk) {
  const oldLines = contentLines(diff.oldText ?? '')
  const newLines = contentLines(diff.newText)
  const normalize = (lines: string[]): string => lines.map(line => `${line}\n`).join('')
  return structuredPatch('', '', normalize(oldLines), normalize(newLines),
    undefined, undefined, { context: 3, maxEditLength: MAX_DIFF_EDIT_LENGTH })?.hunks
    ?? [{ lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)] }]
}

/**
 * Count displayed additions and deletions. Exact patches exclude shared context;
 * comparisons exceeding the edit limit count both complete fragments as replaced.
 * Text follows {@link contentLines}'s terminator rule.
 * @param diffs - the hunks to count.
 * @returns the +/- totals for summaries and the card footer.
 */
export function diffTotals(diffs: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    for (const hunk of localHunks(diff)) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++
        if (line.startsWith('-')) removed++
      }
    }
  }
  return { added, removed }
}

/**
 * Flatten local patches into rows.
 * A path header opens each new file. A `⋯` gap separates consecutive same-file
 * fragments and distant patches within a fragment.
 * @param diffs - the hunks to render.
 * @returns the body rows.
 */
function buildRows(diffs: readonly DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    if (diff.path !== prevPath) rows.push({ kind: 'path', text: diff.path })
    else rows.push({ kind: 'gap', text: '⋯' })
    prevPath = diff.path
    for (const [index, hunk] of localHunks(diff).entries()) {
      if (index > 0) rows.push({ kind: 'gap', text: '⋯' })
      for (const line of hunk.lines) {
        const kind = line.startsWith('-') ? 'del' : line.startsWith('+') ? 'add' : 'context'
        rows.push({ kind, text: line.slice(1) })
      }
    }
  }
  return rows
}

/**
 * Split a side's text into its content lines. Empty text is zero lines (a full
 * deletion's `newText` or a create's absent `oldText` side draws nothing), and a
 * single trailing newline is a line terminator rather than an extra empty line —
 * the same terminator rule TerminalBlock applies to command output. An interior
 * blank line (a genuine `\n\n`) survives.
 * @param text - the removed or added side's text.
 * @returns the content lines, without the terminating newline.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Mark the words that moved between a paired deletion and addition. The
 * comparison runs over words and whitespace, so prose and code read the same:
 * every token is drawn on both sides, with only the changed runs marked.
 * @param oldText - the deleted line's text.
 * @param newText - the added line's text.
 * @returns the runs for each side, or undefined when the pair is identical.
 */
function wordParts(oldText: string, newText: string): { left: readonly WordPart[]; right: readonly WordPart[] } | undefined {
  const parts = diffWordsWithSpace(oldText, newText)
  if (parts.length < 2) return undefined
  const left: WordPart[] = []
  const right: WordPart[] = []
  for (const part of parts) {
    if (!part.removed) right.push({ text: part.value, mark: part.added ? 'add' : null })
    if (!part.added) left.push({ text: part.value, mark: part.removed ? 'del' : null })
  }
  return { left, right }
}

/**
 * Number one served hunk's lines and, under `wordLevel`, pair each deletion run
 * with the addition run that follows it and mark the tokens that moved.
 * @param hunk - the Host's hunk.
 * @param wordLevel - whether to mark intra-line changes.
 * @returns the hunk's lines, in order.
 */
function servedLines(hunk: DiffServedHunk, wordLevel: boolean): ServedLine[] {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  const lines: ServedLine[] = hunk.lines.map((line) => {
    const kind = line.startsWith('-') ? 'del' : line.startsWith('+') ? 'add' : 'context'
    const text = line.slice(1)
    if (kind === 'add') return { kind, old: undefined, new: newNo++, text, parts: undefined }
    if (kind === 'del') return { kind, old: oldNo++, new: undefined, text, parts: undefined }
    return { kind, old: oldNo++, new: newNo++, text, parts: undefined }
  })
  if (!wordLevel) return lines
  let at = 0
  while (at < lines.length) {
    const current = lines[at]
    if (current === undefined || current.kind !== 'del') { at += 1; continue }
    let delEnd = at
    while (lines[delEnd]?.kind === 'del') delEnd += 1
    let addEnd = delEnd
    while (lines[addEnd]?.kind === 'add') addEnd += 1
    const pairs = Math.min(delEnd - at, addEnd - delEnd)
    for (let index = 0; index < pairs; index += 1) {
      const left = lines[at + index]
      const right = lines[delEnd + index]
      if (left === undefined || right === undefined) continue
      const parts = wordParts(left.text, right.text)
      if (parts === undefined) continue
      lines[at + index] = { ...left, parts: parts.left }
      lines[delEnd + index] = { ...right, parts: parts.right }
    }
    at = addEnd
  }
  return lines
}

/** Pair a served hunk's lines for the side-by-side view: deletion runs against the addition runs that follow them. */
function servedSplitRows(lines: readonly ServedLine[]): ServedSplitRow[] {
  const rows: ServedSplitRow[] = []
  let dels: ServedLine[] = []
  let adds: ServedLine[] = []
  const flush = (): void => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at += 1) {
      rows.push({ left: dels[at], right: adds[at] })
    }
    dels = []
    adds = []
  }
  for (const line of lines) {
    if (line.kind === 'del') dels.push(line)
    else if (line.kind === 'add') adds.push(line)
    else {
      flush()
      rows.push({ left: line, right: line })
    }
  }
  flush()
  return rows
}

/**
 * Build the served model: hunk headers from the Host's bounds, numbered lines,
 * and the paired presentation for the split view.
 * @param served - the files to draw.
 * @param wordLevel - whether to mark intra-line changes.
 * @returns the files with their hunk and split models.
 */
function buildServed(served: readonly DiffServedFile[], wordLevel: boolean): ServedFileModel[] {
  return served.map(file => ({
    path: file.path,
    hunks: file.hunks.map((hunk) => {
      const lines = servedLines(hunk, wordLevel)
      const oldLines = lines.filter(line => line.kind !== 'add').length
      const newLines = lines.filter(line => line.kind !== 'del').length
      return {
        header: `@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@`,
        lines,
        splitRows: servedSplitRows(lines),
      }
    }),
  }))
}

/**
 * Copy the full local diff, including folded rows: removed/added lines have
 * `- `/`+ ` prefixes, context has two spaces, and paths and gaps stay verbatim.
 * @param rows - the flattened body rows.
 * @returns the diff as plain text.
 */
function copyText(rows: readonly DiffRow[]): string {
  return rows.map((row) => {
    switch (row.kind) {
      case 'del': return `- ${row.text}`
      case 'add': return `+ ${row.text}`
      case 'context': return `  ${row.text}`
      case 'path': return row.text
      case 'gap': return row.text
    }
  }).join('\n')
}

/** The prefixed diff a served comparison copies, headers included. */
function servedCopyText(files: readonly ServedFileModel[]): string {
  const rows: string[] = []
  for (const file of files) {
    rows.push(file.path)
    for (const hunk of file.hunks) {
      rows.push(hunk.header)
      for (const line of hunk.lines) {
        rows.push(line.kind === 'add' ? `+ ${line.text}` : line.kind === 'del' ? `- ${line.text}` : `  ${line.text}`)
      }
    }
  }
  return rows.join('\n')
}

/** The marked token runs of one line, or its plain text. */
function LineText({ line }: { line: ServedLine }): ReactNode {
  if (line.parts === undefined) return line.text
  return line.parts.map((part, at) => part.mark === null
    ? <span key={at}>{part.text}</span>
    : <span key={at} className={part.mark === 'add' ? css.wordAdd : css.wordDel}>{part.text}</span>)
}

/** Lines one split row carries: one for a context pair, up to two for a paired change. */
function splitRowLines(row: ServedSplitRow): number {
  if (row.left === row.right) return row.left === undefined ? 0 : 1
  return (row.left === undefined ? 0 : 1) + (row.right === undefined ? 0 : 1)
}

/** Lines the split rows of one hunk carry. */
function splitHunkLines(hunk: ServedHunkModel): number {
  return hunk.splitRows.reduce((sum, row) => sum + splitRowLines(row), 0)
}

/**
 * Keep the leading split rows within a row budget and count the dropped lines.
 * The cap slices whole rows, so a paired row's two sides stay on one line.
 * @param files - the served files.
 * @param budget - rows that fit.
 * @returns the kept files and how many lines were dropped.
 */
function capSplit(files: readonly ServedFileModel[], budget: number): { files: ServedFileModel[]; hidden: number } {
  const kept: ServedFileModel[] = []
  let remaining = budget
  let hidden = 0
  for (const file of files) {
    if (remaining <= 0) {
      hidden += file.hunks.reduce((sum, hunk) => sum + splitHunkLines(hunk), 0)
      continue
    }
    const hunks: ServedHunkModel[] = []
    for (const hunk of file.hunks) {
      if (remaining <= 0) {
        hidden += splitHunkLines(hunk)
        continue
      }
      if (hunk.splitRows.length <= remaining) {
        hunks.push(hunk)
        remaining -= hunk.splitRows.length
        continue
      }
      const rows = hunk.splitRows.slice(0, remaining)
      hidden += hunk.splitRows.slice(remaining).reduce((sum, row) => sum + splitRowLines(row), 0)
      // The split presentation reads only `splitRows`; the uncapped model still
      // carries every line for the copy action and the footer counts.
      hunks.push({ header: hunk.header, lines: [], splitRows: rows })
      remaining = 0
    }
    kept.push({ path: file.path, hunks })
  }
  return { files: kept, hidden }
}

/**
 * Keep the leading served lines within a budget and count the rest as hidden.
 * @param files - the served files.
 * @param budget - lines that fit.
 * @returns the kept files and how many lines were dropped.
 */
function capServed(files: readonly ServedFileModel[], budget: number): { files: ServedFileModel[]; hidden: number } {
  const kept: ServedFileModel[] = []
  let remaining = budget
  let hidden = 0
  for (const file of files) {
    if (remaining <= 0) {
      hidden += file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
      continue
    }
    const hunks: ServedHunkModel[] = []
    for (const hunk of file.hunks) {
      if (remaining <= 0) {
        hidden += hunk.lines.length
        continue
      }
      if (hunk.lines.length <= remaining) {
        hunks.push(hunk)
        remaining -= hunk.lines.length
        continue
      }
      hunks.push({ header: hunk.header, lines: hunk.lines.slice(0, remaining), splitRows: [] })
      hidden += hunk.lines.length - remaining
      remaining = 0
    }
    kept.push({ path: file.path, hunks })
  }
  return { files: kept, hidden }
}

/** The side-by-side half of a served comparison: one column per side, one fixed row per pair. */
function SplitServed({ files }: { files: readonly ServedFileModel[] }): ReactNode {
  const cellClass = (line: ServedLine | undefined): string | undefined => {
    if (line === undefined) return css.empty
    return line.kind === 'add' ? css.cellAdd : line.kind === 'del' ? css.cellDel : css.cellContext
  }
  return (
    <div className={css.split}>
      {files.map((file, fileAt) => (
        <div key={fileAt} data-diff-file={file.path}>
          <div className={clsx(css.path, css.splitPath)}>{file.path}</div>
          {file.hunks.map((hunk, hunkAt) => (
            <div key={hunkAt} className={css.hunk} data-diff-hunk={hunk.header}>
              <div className={css.hunkHeader}>{hunk.header}</div>
              {hunk.splitRows.map((row, at) => (
                <div key={at} className={css.splitRow}
                  data-diff-line={row.left?.kind === 'del' ? 'del' : row.right?.kind === 'add' ? 'add' : 'context'}>
                  <span className={clsx(css.cell, cellClass(row.left))}>
                    <span className={css.number}>{row.left?.old ?? ''}</span>
                    <span className={css.servedText}>{row.left === undefined ? '' : <LineText line={row.left} />}</span>
                  </span>
                  <span className={clsx(css.cell, cellClass(row.right))}>
                    <span className={css.number}>{row.right?.new ?? ''}</span>
                    <span className={css.servedText}>{row.right === undefined ? '' : <LineText line={row.right} />}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** The unified presentation of a served comparison: hunk headers, both line numbers, and word marks. */
function UnifiedServed({ files }: { files: readonly ServedFileModel[] }): ReactNode {
  return (
    <>
      {files.map((file, fileAt) => (
        <div key={fileAt} data-diff-file={file.path}>
          <div className={css.path}>{file.path}</div>
          {file.hunks.map((hunk, hunkAt) => (
            <div key={hunkAt} className={css.hunk} data-diff-hunk={hunk.header}>
              <div className={css.hunkHeader}>{hunk.header}</div>
              {hunk.lines.map((line, at) => (
                <div key={at} className={clsx(css.servedLine, line.kind === 'add' ? css.add : line.kind === 'del' ? css.del : css.context)}
                  data-diff-line={line.kind}>
                  <span className={css.number}>{line.old ?? ''}</span>
                  <span className={css.number}>{line.new ?? ''}</span>
                  <span className={css.sign}>{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
                  <span className={css.servedText}><LineText line={line} /></span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

/**
 * Render a file mutation as an inline diff surface.
 * @param props - see {@link DiffBlockProps}.
 * @returns the diff block element.
 */
export function DiffBlock({ diffs, served, view = 'unified', wordLevel = false, labels, maxLines = DEFAULT_DIFF_MAX_LINES, className }: DiffBlockProps) {
  const model = useMemo((): DiffModel => served === undefined
    ? { mode: 'cards', rows: buildRows(diffs) }
    : { mode: 'served', files: buildServed(served, wordLevel) }, [diffs, served, wordLevel])
  const counts = useMemo(() => {
    if (model.mode === 'cards') {
      return {
        added: model.rows.filter(row => row.kind === 'add').length,
        removed: model.rows.filter(row => row.kind === 'del').length,
        files: new Set(model.rows.filter(row => row.kind === 'path').map(row => row.text)).size,
      }
    }
    let added = 0
    let removed = 0
    for (const file of model.files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind === 'add') added++
          if (line.kind === 'del') removed++
        }
      }
    }
    return { added, removed, files: model.files.length }
  }, [model])
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [wrapped, setWrapped] = useState(false)
  const firstPath = model.mode === 'cards' ? model.rows.find(row => row.kind === 'path')?.text : model.files[0]?.path
  const firstLanguage = firstPath === undefined ? undefined : languageForPath(firstPath)
  const language = model.mode === 'cards'
    ? (diffs.every(diff => languageForPath(diff.path) === firstLanguage) ? firstLanguage : undefined)
    : firstLanguage

  const onCopy = useCallback(() => {
    if (copied) return
    const text = model.mode === 'cards' ? copyText(model.rows) : servedCopyText(model.files)
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, model])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  if (model.mode === 'cards' && model.rows.length === 0) return null
  if (model.mode === 'served' && model.files.length === 0) return null

  // Both served presentations cap their visible body; the split view caps whole
  // paired rows so a huge comparison cannot hang the pane without breaking the
  // left/right alignment the presentation exists for.
  const rowCount = model.mode === 'cards'
    ? model.rows.length
    : model.files.reduce((total, file) => total + file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0), 0)
  const servedCap = model.mode === 'served' && rowCount > maxLines
    ? view === 'split' ? capSplit(model.files, maxLines) : capServed(model.files, maxLines)
    : undefined
  const hidden = model.mode === 'cards' ? rowCount - maxLines : servedCap?.hidden ?? 0
  const capped = hidden > 0 && !expanded
  // Same split arithmetic as TerminalBlock and the TUI transcript's collapsed
  // card, so a body's head and tail slices agree across the front ends.
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = maxLines - headLines
  const servedView = capped ? servedCap : undefined

  return (
    <div className={clsx(cardCss.card, css.block, className)} data-diff="" data-code-wrap={wrapped}>
      <CodeToolbar
        lang={language}
        labels={labels}
        copyLabel={labels.copy}
        copiedLabel={labels.copied}
        copied={copied}
        wrapped={wrapped}
        onCopy={onCopy}
        onWrap={() => { setWrapped(value => !value) }}
      />
      <div className={css.body}>
        {model.mode === 'cards'
          ? (
            <>
              {(capped ? model.rows.slice(0, headLines) : model.rows).map((row, index) => (
                <div key={index} className={clsx(css.line, ROW_CLASS[row.kind])}>{row.text}</div>
              ))}
              {hidden > 0 && (
                <FoldToggle
                  className={css.expand}
                  expanded={expanded}
                  hidden={hidden}
                  labels={labels}
                  onToggle={onToggle}
                />
              )}
              {capped && model.rows.slice(model.rows.length - tailLines).map((row, index) => (
                <div key={index} className={clsx(css.line, ROW_CLASS[row.kind])}>{row.text}</div>
              ))}
            </>
          )
          : view === 'split'
            ? <SplitServed files={servedView?.files ?? model.files} />
            : <UnifiedServed files={servedView?.files ?? model.files} />}
        {model.mode === 'served' && hidden > 0 && (
          <FoldToggle
            className={css.expand}
            expanded={expanded}
            hidden={hidden}
            labels={labels}
            onToggle={onToggle}
          />
        )}
      </div>
      {labels.files !== undefined && (
        <div className={css.footer}>└ +{counts.added} -{counts.removed} · {labels.files(counts.files)}</div>
      )}
    </div>
  )
}
