/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** Feedback rendered after one explicit retry attempt. */
export interface BootRetryFeedback {
  /** Bounded explanation for the suppressed attempt or reload handoff. */
  readonly message: string
  /** Disable further clicks because only a manual page reload can continue. */
  readonly disabled?: boolean
}

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly wordmark: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined
  private retry: (() => BootRetryFeedback | undefined) | undefined
  private retryFeedback: string | undefined
  private retryDisabled = false

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    this.card = div(css.card)
    this.wordmark = div(css.wordmark, 'ENPOI')
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint, 'Loading plugins…')
    this.card.append(this.wordmark, this.spinner, this.hint)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Replace the status line below the spinner, so the reveal gate can name the
   * read it is waiting on after the module graph has settled.
   * @param text - status line text.
   */
  setHint(text: string): void {
    this.hint.textContent = text
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   * @param retry - Optional explicit retry action rendered on the report.
   */
  fail(message: string, retry?: () => BootRetryFeedback | undefined): void {
    this.failure = message
    this.retry = retry
    this.retryFeedback = undefined
    this.retryDisabled = false
    this.render()
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.root.remove()
  }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.wordmark, this.spinner, this.hint)
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    const retry = this.retry
    if (retry !== undefined) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = css.failedItem ?? ''
      button.dataset.dshBootRetry = ''
      button.textContent = 'Retry'
      button.disabled = this.retryDisabled
      button.addEventListener('click', () => {
        const feedback = retry()
        if (feedback === undefined) return
        this.retryFeedback = feedback.message
        this.retryDisabled = feedback.disabled === true
        this.render()
      })
      report.append(button)
      if (this.retryFeedback !== undefined) {
        const feedback = div(css.failedItem, this.retryFeedback)
        feedback.dataset.dshBootRetryFeedback = ''
        report.append(feedback)
      }
    }
    this.card.replaceChildren(this.wordmark, report)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
