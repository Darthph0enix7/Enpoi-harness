/**
 * Stage one of this package's registration: what the `enpoi-editor` tab type IS.
 *
 * The type claims every session-scoped `dsh-resource://file/session/…` address
 * whose path classifies as an editable text file, at the `extension` band so it
 * beats the read-only `text` fallback (`ui-sidebar-documentpreview`) for exactly
 * those files. Images, PDFs, office documents, video, and unknown categories
 * stay with the fallback viewer, which owns their binary/download presentation.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
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
])

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
 * @returns the definition to register.
 */
export function editorDefinition(): SidebarRightTabDefinition {
  return {
    id: EDITOR_ID,
    kind: EDITOR_KIND,
    patterns: ['dsh-resource://file/**'],
    priority: 'extension',
    canOpen: (address) => {
      const file = parseFileAddress(address)
      return file?.scope === 'session' && file.path !== '' && isEditablePath(file.path)
    },
    title: basenameOf,
  }
}
