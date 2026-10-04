/**
 * Clipboard serialization for rendered Markdown. `serializeSelectionToMarkdown`
 * turns a selection fragment back into Markdown source for `text/plain`;
 * `serializeSelectionToCleanHtml` emits the same selection as HTML with every
 * KaTeX tree replaced by its TeX delimiters for `text/html`, so rich targets
 * never receive KaTeX's glyph DOM. The renderer's DOM vocabulary is fixed
 * (`render.tsx`); unknown elements fall back to their text.
 */

/** Selection semantics for {@link serializeSelectionToMarkdown}. */
export interface SerializeSelectionOptions {
  /** The selection lies wholly inside one code block, so its text is the code without fences. */
  readonly rawCode?: boolean
}

const BLOCK_TAGS = new Set([
  'BLOCKQUOTE', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL',
])

/** The DOM guarantees a string `textContent` for an element. */
function elementText(element: Element): string {
  return element.textContent
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : null
}

function isBlock(node: Node): boolean {
  const element = elementOf(node)
  return element !== null && BLOCK_TAGS.has(element.tagName)
}

function isWhitespaceText(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && (node as Text).data.trim() === ''
}

/** The formula ancestor (`.katex-display` or `.katex`) of a boundary, if any. */
function formulaAt(node: Node): Element | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  if (element === null) return null
  return element.closest('.katex-display') ?? element.closest('.katex')
}

/** The `pre` ancestor of a boundary, if any. */
function codeBlockAt(node: Node): Element | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  if (element === null) return null
  return element.closest('pre')
}

/**
 * Grow a range's boundaries outward so either one sitting inside a formula
 * covers that whole formula: formulas are atomic and must never be sliced.
 * @param range - The live selection range to expand in place.
 */
export function expandRangeToWholeMath(range: Range): void {
  const start = formulaAt(range.startContainer)
  const end = formulaAt(range.endContainer)
  if (start !== null) range.setStartBefore(start)
  if (end !== null) range.setEndAfter(end)
}

/**
 * Whether both range boundaries sit inside the same code block; such a
 * selection is raw code and is copied without fences.
 * @param range - The live selection range.
 * @returns True when the whole selection lies inside one fence or code card.
 */
export function rangeInsideOneCodeBlock(range: Range): boolean {
  const start = codeBlockAt(range.startContainer)
  return start !== null && start === codeBlockAt(range.endContainer)
}

/**
 * Serialize a selection fragment back to Markdown source.
 * @param fragment - The selected DOM, as produced by `Range.cloneContents()`.
 * @param options - Serialization mode; `rawCode` emits just the selected code.
 * @returns The Markdown source for the selection.
 */
export function serializeSelectionToMarkdown(fragment: DocumentFragment, options?: SerializeSelectionOptions): string {
  if (options?.rawCode === true) return fragment.textContent
  return serializeBlockChildren([...fragment.childNodes]).trim()
}

/**
 * Serialize the same selection to HTML with clean math text: every KaTeX
 * `.katex`/`.katex-display` tree is replaced by `$tex$`/`$$tex$$`.
 * @param fragment - The selected DOM, as produced by `Range.cloneContents()`.
 * @returns The selection HTML.
 */
export function serializeSelectionToCleanHtml(fragment: DocumentFragment): string {
  const holder = document.createElement('div')
  holder.append(fragment.cloneNode(true))
  for (const element of holder.querySelectorAll('.katex-display, .katex, .katex-error')) {
    if (element.classList.contains('katex') && element.closest('.katex-display') !== null) continue
    element.replaceWith(document.createTextNode(serializeKatex(element)))
  }
  return holder.innerHTML
}

function serializeBlockChildren(nodes: readonly Node[]): string {
  const blocks = nodes.some(isBlock)
  const parts: string[] = []
  let inline = ''
  for (const node of nodes) {
    if (isBlock(node)) {
      if (inline !== '') {
        parts.push(inline)
        inline = ''
      }
      parts.push(serializeBlock(node as Element))
    } else if (!blocks || !isWhitespaceText(node)) {
      inline += serializeInline(node)
    }
  }
  if (inline !== '') parts.push(inline)
  return parts.filter(part => part !== '').join('\n\n')
}

function serializeBlock(element: Element): string {
  if (element.classList.contains('md-code-block')) return serializeCode(element)
  switch (element.tagName) {
    case 'P':
      return serializeInlineChildren(element)
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return `${'#'.repeat(Number(element.tagName.slice(1)))} ${serializeInlineChildren(element)}`
    case 'HR':
      return '---'
    case 'BLOCKQUOTE': {
      const inner = serializeBlockChildren([...element.childNodes])
      return inner.split('\n').map(line => (line === '' ? '>' : `> ${line}`)).join('\n')
    }
    case 'UL':
      return serializeList(element, false, 0)
    case 'OL':
      return serializeList(element, true, 0)
    case 'PRE':
      return serializeCode(element)
    case 'TABLE':
      return serializeTable(element)
    case 'SECTION':
      return serializeFootnoteSection(element)
    default:
      // `DIV` wrappers (the table scrollport and other block containers) and
      // unknown blocks carry their markdown in their children.
      return serializeBlockChildren([...element.childNodes])
  }
}

function serializeInlineChildren(parent: Node): string {
  let out = ''
  for (const node of parent.childNodes) out += serializeInline(node)
  return out
}

function serializeInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data
  const element = elementOf(node)
  if (element === null) return ''
  if (
    element.classList.contains('katex')
    || element.classList.contains('katex-display')
    || element.classList.contains('katex-error')
  ) {
    return serializeKatex(element)
  }
  switch (element.tagName) {
    case 'STRONG':
    case 'B':
      return `**${serializeInlineChildren(element)}**`
    case 'EM':
    case 'I':
      return `*${serializeInlineChildren(element)}*`
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return `~~${serializeInlineChildren(element)}~~`
    case 'CODE': {
      const code = elementText(element)
      const fence = backtickFence(code)
      return `${fence}${code}${fence}`
    }
    case 'A': {
      const href = element.getAttribute('href')
      return `[${serializeInlineChildren(element)}](${href === null ? '' : href})`
    }
    case 'IMG': {
      const alt = element.getAttribute('alt')
      const src = element.getAttribute('src')
      return `![${alt === null ? '' : alt}](${src === null ? '' : src})`
    }
    case 'BR':
      // The renderer follows every `br` with a newline text node, which
      // completes this backslash hard break.
      return '\\'
    case 'BUTTON':
      return element.querySelector('img') === null
        ? `\`${elementText(element)}\``
        : serializeInlineChildren(element)
    case 'SUP':
      return isFootnoteBackReference(element) ? '' : `[^${elementText(element)}]`
    default:
      // Unknown vocabulary (SVG icons included) renders its text: the renderer
      // controls the DOM, so an unmapped element carries no markdown structure
      // to preserve.
      return elementText(element)
  }
}

function serializeKatex(element: Element): string {
  const annotation = element.querySelector('annotation[encoding="application/x-tex"]')
  // An error span has no annotation; its text is the failed TeX source, so it
  // gets the same delimiters as rendered math.
  const tex = annotation === null ? elementText(element) : elementText(annotation)
  // Expansion keeps whole formulas in the fragment, so the display wrapper
  // itself is the element this sees for display math.
  return element.classList.contains('katex-display') ? `$$${tex}$$` : `$${tex}$`
}

function isFootnoteBackReference(element: Element): boolean {
  const parent = element.parentElement
  return parent !== null && elementText(parent).includes('↩')
}

/** The shortest backtick fence that wraps `text` without colliding with it. */
function backtickFence(text: string): string {
  let length = 1
  while (text.includes('`'.repeat(length))) length += 1
  return '`'.repeat(length)
}

function firstCheckbox(item: Element): HTMLInputElement | null {
  for (const child of item.children) {
    if (child.tagName === 'INPUT') return child as HTMLInputElement
    if (child.tagName === 'P') {
      for (const grandchild of child.children) {
        if (grandchild.tagName === 'INPUT') return grandchild as HTMLInputElement
      }
    }
  }
  return null
}

function isInput(node: Node): boolean {
  const element = elementOf(node)
  return element !== null && element.tagName === 'INPUT'
}

function serializeList(list: Element, ordered: boolean, depth: number): string {
  const start = ordered ? Number(list.getAttribute('start') ?? '1') : 0
  return [...list.children]
    .filter(child => child.tagName === 'LI')
    .map((item, index) => serializeListItem(item, ordered ? `${start + index}. ` : '- ', depth))
    .join('\n')
}

function serializeListItem(item: Element, marker: string, depth: number): string {
  const indent = '  '.repeat(depth)
  const checkbox = firstCheckbox(item)
  const task = checkbox === null ? '' : checkbox.checked ? '[x] ' : '[ ] '
  const prefix = `${indent}${marker}${task}`
  const continuation = `${indent}${' '.repeat(marker.length + task.length)}`
  const chunks: { text: string; nested: boolean }[] = []
  let inline = ''
  const flush = (): void => {
    if (inline === '') return
    chunks.push({ text: inline, nested: false })
    inline = ''
  }
  for (const node of item.childNodes) {
    if (isInput(node)) continue
    if (isBlock(node)) {
      const element = node as Element
      flush()
      chunks.push(
        element.tagName === 'UL' || element.tagName === 'OL'
          ? { text: serializeList(element, element.tagName === 'OL', depth + 1), nested: true }
          : { text: serializeBlock(element), nested: false },
      )
    } else if (!isWhitespaceText(node) || inline !== '') {
      inline += serializeInline(node)
    }
  }
  flush()
  let out = ''
  for (const [index, chunk] of chunks.entries()) {
    if (index === 0) {
      out = chunk.nested ? `${prefix.trimEnd()}\n${chunk.text}` : prefix + chunk.text
    } else if (chunk.nested) {
      out += `\n${chunk.text}`
    } else {
      out += `\n\n${continuation}${chunk.text.replace(/\n/g, `\n${continuation}`)}`
    }
  }
  return out === '' ? prefix.trimEnd() : out
}

function serializeCode(element: Element): string {
  const pre = element.tagName === 'PRE' ? element : element.querySelector('pre')
  if (pre === null) return ''
  const code = elementText(pre)
  const language = codeLanguage(element, pre)
  return `\`\`\`${language}\n${code.endsWith('\n') ? code : `${code}\n`}\`\`\``
}

/** Fence language, preferring the code card's stable hook over the banner info string. */
function codeLanguage(element: Element, pre: Element): string {
  const hook = element.querySelector('[data-code-block-content]')?.getAttribute('data-language')
  if (hook !== null && hook !== undefined && hook !== '') return hook
  const info = element.querySelector('.infostring')
  if (info !== null && elementText(info) !== '') return elementText(info)
  return languageFromCode(pre)
}

function languageFromCode(pre: Element): string {
  const code = pre.querySelector('code')
  if (code === null) return ''
  return /language-([\w-]+)/.exec(code.className)?.[1] ?? ''
}

function serializeTable(table: Element): string {
  const rows = [...table.querySelectorAll('tr')]
  const head = rows[0]
  if (head === undefined) return ''
  const header = tableCells(head)
  const lines = [tableRow(header), `| ${header.map(alignmentMarker).join(' | ')} |`]
  for (const row of rows.slice(1)) lines.push(tableRow(tableCells(row)))
  return lines.join('\n')
}

function tableCells(row: Element): Element[] {
  return [...row.children].filter(child => child.tagName === 'TH' || child.tagName === 'TD')
}

function tableRow(cells: readonly Element[]): string {
  return `| ${cells.map(cell => serializeInlineChildren(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`
}

function alignmentMarker(cell: Element): string {
  switch ((cell as HTMLElement).style.textAlign) {
    case 'left':
      return ':---'
    case 'center':
      return ':---:'
    case 'right':
      return '---:'
    default:
      return '---'
  }
}

function serializeFootnoteSection(section: Element): string {
  const list = [...section.children].find(child => child.tagName === 'OL')
  if (list === undefined) return ''
  return [...list.children]
    .filter(child => child.tagName === 'LI')
    .map((item, index) => `[^${index + 1}]: ${serializeBlockChildren([...item.childNodes]).replace(/\n/g, '\n    ')}`)
    .join('\n\n')
}
