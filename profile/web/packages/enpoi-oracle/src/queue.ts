/**
 * Per-parent FIFO queue for Oracle consultations.
 *
 * One lane per parent session: a consultation holds the lane from child
 * discovery through its result or detached handoff, so overlapping
 * `oracle_review` calls run one after another in call order instead of being
 * rejected. Waiting calls are not cancelled by the queue; each waiter's own
 * deadline already counts the time spent here.
 *
 * @module dsh-enpoi-oracle/queue
 */

/** Serializes tasks per string key while letting distinct keys run in parallel. */
export class ParentFifoQueue {
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * Run one task after every earlier task enqueued under the same key settled.
   * @param key - parent session id owning the lane.
   * @param task - work that must not overlap another task on this lane.
   * @returns the task's value or rejection, unchanged.
   */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    try {
      await previous
      return await task()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  /**
   * Read whether tasks are queued or running on one lane.
   * @param key - parent session id.
   * @returns whether a lane entry exists.
   */
  isBusy(key: string): boolean {
    return this.tails.has(key)
  }
}
