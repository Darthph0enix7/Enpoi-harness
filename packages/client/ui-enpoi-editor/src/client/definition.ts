/**
 * Stage one of this package's registration: what the `enpoi-editor` tab type IS.
 *
 * The type recognizes every session-scoped `dsh-resource://file/session/…`
 * address whose path classifies as an editable text file, but it is deliberately
 * demoted: it sits at the `fallback` band with a shorter glob than the rich
 * `text` viewer (`ui-sidebar-documentpreview`, `dsh-resource://file/**`), so an
 * automatic open always lands on the rich preview and the editor is reached only
 * when a caller names its kind explicitly. With the rich viewer absent the
 * editor is the only claimant left, which is the fail-open path.
 *
 * Images, PDFs, office documents, video, and unknown categories stay with the
 * fallback viewer, which owns their binary/download presentation.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DocumentPreviewDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

/** The tab kind this package owns. */
export const EDITOR_KIND = 'enpoi-editor'

/** This implementation's identity in the tab system: the key its body registers under. */
export const EDITOR_ID = 'enpoi-editor'

/**
 * Categories the editor refuses: the fallback preview owns binary rendering
 * (images, PDFs), office documents, video, and directories.
 */
const UNEDITABLE_TYPES: ReadonlySet<string> = new Set([
  'excel', 'folder', 'image', 'pdf', 'ppt', 'video', 'word',
])

/**
 * Extensions the classifier places nowhere but that are plain text in practice:
 * notes, logs, configs, shell scripts, and the common lock/readme names.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'text', 'log', 'md', 'markdown', 'mdx', 'rst', 'adoc',
  'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'csv', 'tsv', 'sql', 'graphql', 'gql', 'lock', 'sum', 'mod',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'rb', 'php', 'lua', 'r', 'scala', 'dart', 'ex', 'exs', 'erl', 'zig', 'nim', 'vue', 'svelte',
  'css', 'scss', 'sass', 'less', 'xml', 'svg', 'txt',
  'html', 'htm', 'xhtml', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'pyi', 'pyw', 'pl', 'pm',
])

/**
 * Suffixes the in-pane editor offers as a viewer candidate. Selection only
 * needs the suffix to match; the editor's own `canOpen` still decides which
 * addresses it will actually edit.
 */
const EDITOR_EXTENSIONS: readonly string[] = [...new Set(TEXT_EXTENSIONS)]

/**
 * Basenames that carry no extension but are text files.
 */
const TEXT_BASENAMES: ReadonlySet<string> = new Set([
  'license', 'licence', 'notice', 'readme', 'changelog', 'authors', 'contributors', 'todo',
  'makefile', 'dockerfile', 'procfile', 'gemfile', 'rakefile', 'justfile', 'vagrantfile', 'cmakelists.txt',
  'gitignore', 'gitattributes', 'gitmodules', 'dockerignore', 'npmrc', 'nvmrc', 'editorconfig', 'env',
])

/**
 * Whether a path names a file this type edits.
 *
 * The classifier decides for the categories it knows (code, config, markup,
 * docs, html); a path it cannot place is still editable when its extension or
 * basename marks it as plain text — `notes.txt`, `LICENSE`, `Cargo.lock` — and
 * stays with the read-only viewer otherwise, where unknown binaries belong.
 * @param path - a `/`-separated file path or basename.
 * @returns `true` when the file is text this editor may save.
 */
export function isEditablePath(path: string): boolean {
  const kind = classifyFileType(path)
  if (kind !== 'other') return !UNEDITABLE_TYPES.has(kind)
  // The classifier knows no category: text only when the name says so.
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === '') return false
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  if (extension !== '' && TEXT_EXTENSIONS.has(extension)) return true
  return TEXT_BASENAMES.has(name) || (name.startsWith('.') && TEXT_BASENAMES.has(name.slice(1)))
}

/**
 * The in-pane editor's document-renderer registration.
 *
 * It sits in the `editor` priority tier, so it is listed among a file's viewer
 * candidates but never chosen automatically: the rich renderer keeps the default
 * and the reader picks CodeMirror explicitly. `loading: 'renderer'` tells the
 * document owner the editor loads its own bytes through `fsops`.
 * @param title - locale-owned implementation name.
 * @returns the document renderer definition, keyed by the tab kind's own id.
 */
export function editorPreviewDefinition(title: () => string): DocumentPreviewDefinition {
  return {
    id: EDITOR_ID,
    extensions: EDITOR_EXTENSIONS,
    priority: 'editor',
    title,
    loading: 'renderer',
    wrap: true,
    capabilities: { search: true, gotoLine: true },
  }
}

/**
 * The tab title for one `file:` address: its decoded basename.
 *
 * Decoding is per segment, matching how the address was built, so a name
 * carrying `#`, `?`, or a space reads as itself.
 * @param address - a `file:`-shaped address.
 * @returns the decoded last path segment, or the address itself when it has none.
 */
export function basenameOf(address: string): string {
  const name = address.slice(address.lastIndexOf('/') + 1)
  if (name === '') return address
  try {
    return decodeURIComponent(name)
  } catch {
    // A malformed percent sequence is still a name; showing it raw beats refusing the address.
    return name
  }
}

/**
 * The editor type's registry definition.
 *
 * The kind stays registered only so persisted sessions and old surface records
 * referencing it survive a restore: its body is the redirect to the unified
 * document pane. No product UI opens it by kind anymore — the Edit control
 * switches the display type in place.
 * @returns the definition to register.
 */
export function editorDefinition(): SidebarRightTabDefinition {
  return {
    id: EDITOR_ID,
    kind: EDITOR_KIND,
    // Shorter than the rich viewer's `dsh-resource://file/**`, so a same-band
    // automatic open prefers the rich viewer and the editor stays explicit-only.
    patterns: ['dsh-resource://**'],
    priority: 'fallback',
    canOpen: (address) => {
      const file = parseFileAddress(address)
      return file?.scope === 'session' && file.path !== '' && isEditablePath(file.path)
    },
    title: basenameOf,
  }
}
