/**
 * Deferred leave reports for the right-column seats.
 *
 * The frame's right track is one global fact, so a seat that unmounts must hand
 * it back — but a seat that unmounts because a replacement has already arrived
 * in the same commit must not: the replacement reports its own presentation,
 * and an interim close would collapse the track for a frame. Reports are keyed
 * per seat and deferred one microtask; a report runs only when no seat has
 * mounted by then, so two seats unmounting together both report while a
 * session switch's replacement suppresses the departing seat's close.
 */
export class SeatLeaveReports {
  private readonly live = new Set<symbol>()
  private readonly pending = new Map<symbol, () => void>()

  /**
   * Mark a seat as live. A seat that arrives in the same commit as a departing
   * one suppresses that departure's report.
   * @param token - the seat instance's identity.
   */
  enter(token: symbol): void {
    this.live.add(token)
  }

  /**
   * Mark a seat as gone and schedule its report for the next microtask.
   * @param token - the seat instance's identity.
   * @param report - the frame hand-back to run when no seat has replaced it.
   */
  leave(token: symbol, report: () => void): void {
    this.live.delete(token)
    this.pending.set(token, report)
    queueMicrotask(() => {
      if (this.pending.get(token) !== report) return
      this.pending.delete(token)
      if (this.live.size > 0) return
      report()
    })
  }
}

/** The module-level coordinator shared by every seat this package mounts. */
export const seatLeaveReports = new SeatLeaveReports()
