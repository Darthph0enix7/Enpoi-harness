/**
 * The small language set the editor recognises, mapped from the file address's
 * extension. CodeMirror gets the streaming grammar for live editing; the
 * read-only preview names the same language for the highlight renderer.
 */
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import type { Extension } from '@codemirror/state'
import { fileExtension } from '@deepseek-ai/dsh-client-ui-primitives'

const MARKDOWN = new Set(['md', 'mdx', 'markdown'])
const JSON_LIKE = new Set(['json', 'jsonc', 'json5'])
const PYTHON = new Set(['py', 'pyi', 'pyw', 'pyx'])
const JAVASCRIPT = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'])
const TYPESCRIPT = new Set(['ts', 'tsx', 'mts', 'cts'])
const JSX = new Set(['jsx', 'tsx'])

/**
 * The CodeMirror grammar for one path.
 * @param path - the file path or basename.
 * @returns the language extension, or an empty list for plain text.
 */
export function languageForPath(path: string): Extension[] {
  const extension = fileExtension(path).toLowerCase()
  if (MARKDOWN.has(extension)) return [markdown()]
  if (JSON_LIKE.has(extension)) return [json()]
  if (PYTHON.has(extension)) return [python()]
  if (JAVASCRIPT.has(extension)) {
    return [javascript({ typescript: TYPESCRIPT.has(extension), jsx: JSX.has(extension) })]
  }
  return []
}
