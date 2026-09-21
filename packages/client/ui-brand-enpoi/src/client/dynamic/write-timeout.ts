/**
 * Bounded write helper for the Dynamic settings panels.
 *
 * Each panel serializes or gates writes per entity. A `fetch` that never
 * settles would otherwise wedge that entity's later edits behind it forever,
 * so every write races against {@link WRITE_TIMEOUT_MS}; a timeout resolves
 * with the caller's fallback and is handled exactly like a rejected write.
 */

/** How long one settings write may run before it is treated as failed. */
export const WRITE_TIMEOUT_MS = 20_000

/**
 * Race one write against {@link WRITE_TIMEOUT_MS}.
 * @param work - the in-flight write.
 * @param fallback - the value a timeout resolves with.
 * @returns the write result, or the fallback when the write exceeds the bound.
 */
export async function withWriteTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => { resolve(fallback) }, WRITE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
