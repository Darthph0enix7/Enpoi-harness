/**
 * The toolbar's host-level quick actions: download, and clipboard writes.
 *
 * These belong to the document owner, not to any renderer: they act on the
 * open file and need no renderer hooks. Download rides the profile's fenced
 * `/sidebar/fsops/fs.download` route — same-origin, same envelope the editor's
 * fsops client speaks; a host without the route answers 404 and the toolbar
 * says so.
 */
import type { SessionFile } from './rpc.ts'

/** What the download route answers with. */
interface DownloadValue {
  /** The file's bytes, base64-encoded. */
  readonly base64: string
  /** The basename the browser saves under. */
  readonly name: string
}

/** The one envelope shape both success and failure answers share. */
interface DownloadEnvelope {
  readonly ok?: boolean
  readonly value?: DownloadValue
  readonly error?: { readonly message?: string }
}

/**
 * Save one open file to the reader's downloads through the fenced route.
 * @param file - the session and workspace path the tab's address names.
 * @returns when the browser has been handed the download.
 * @throws when the route is missing, refuses the file, or the page has no DOM to save with.
 */
export async function downloadSessionFile(file: SessionFile): Promise<void> {
  let response: Response
  try {
    response = await fetch('/sidebar/fsops/fs.download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: file.sessionId, path: file.path }),
    })
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error })
  }
  const parsed = await response.json().catch(() => null) as DownloadEnvelope | null
  if (!response.ok || parsed?.ok !== true || parsed.value === undefined) {
    throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
  }
  const binary = atob(parsed.value.base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  const url = URL.createObjectURL(new Blob([bytes]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = parsed.value.name
  anchor.click()
  // The browser holds its own reference until the save dialog resolves.
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
}

/**
 * Write text to the page's clipboard.
 * @param text - the text to copy.
 * @returns when the clipboard holds the text.
 * @throws when the clipboard is unavailable or refuses the write.
 */
export async function copyPlainText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}
