/**
 * Bounded worker pool for per-file syscall work (walk hashing, seeding).
 * Concurrency is capped by the caller; EMFILE/ENFILE (fd exhaustion under
 * load) backs off and retries instead of failing the update. Results are
 * collected in input order, so manifests, indexes, and reports are identical
 * to a sequential run.
 */

import { cpus } from 'node:os'

/**
 * Map over items with a bounded number of concurrent workers.
 * @param items - Input items.
 * @param limit - Maximum concurrent workers (>= 1).
 * @param worker - Async worker for one item.
 * @returns Results in input order.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  const concurrency = Math.max(1, Math.min(Math.trunc(limit), items.length))
  if (concurrency <= 1) {
    for (let index = 0; index < items.length; index += 1) {
      results[index] = await withFdRetry(() => worker(items[index] as T, index))
    }
    return results
  }
  let next = 0
  const runners = Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await withFdRetry(() => worker(items[index] as T, index))
    }
  })
  await Promise.all(runners)
  return results
}

/** Retry fd-exhaustion errors with a short backoff; everything else propagates. */
async function withFdRetry<R>(operation: () => Promise<R>): Promise<R> {
  let attempt = 0
  for (;;) {
    try {
      return await operation()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code !== 'EMFILE' && code !== 'ENFILE') || attempt >= 5) throw error
      attempt += 1
      await new Promise(resolve => setTimeout(resolve, 50 * attempt))
    }
  }
}

/** Default worker count: parallel only when the tree is large enough to pay for it. */
export function defaultParallelism(fileCount: number): number {
  const env = process.env.DSH_WALK_JOBS
  if (env !== undefined && /^\d+$/u.test(env)) return Math.max(1, Math.min(16, Number.parseInt(env, 10)))
  if (fileCount < 20_000) return 1
  return Math.max(2, Math.min(8, cpus().length))
}
