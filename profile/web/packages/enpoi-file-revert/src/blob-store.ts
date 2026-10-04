/**
 * Content-addressed raw-byte storage with reachability GC.
 * Liveness is derived by scanning manifests + WAL intents (cross-session),
 * never by in-memory refcounts (which die on restart).
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class BlobStore {
  constructor(private readonly rootDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
  }

  async put(bytes: Buffer): Promise<string> {
    const sha = sha256Of(bytes)
    const path = join(this.rootDir, sha)
    try {
      await writeFile(path, bytes, { flag: 'wx' }) // never overwrite existing blob
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    return sha
  }

  async get(sha: string | null): Promise<Buffer | null> {
    if (sha === null) return null
    return readFile(join(this.rootDir, sha))
  }

  /**
   * Reachability GC: sweep unreferenced blobs older than ttlMs.
   * @param liveShas — every SHA referenced by live records anywhere
   */
  async gc(liveShas: Iterable<string>, ttlMs: number, now = Date.now()): Promise<void> {
    const live = new Set(liveShas)
    const entries = await readdir(this.rootDir)
    for (const name of entries) {
      if (live.has(name)) continue
      const path = join(this.rootDir, name)
      try {
        const st = await stat(path)
        if (now - st.mtimeMs > ttlMs) await unlink(path)
      } catch { /* raced */ }
    }
  }
}