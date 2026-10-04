export {}

/**
 * The pre-0.1.7 settings engine emitted `settings/updated`; the merged engine
 * emits `settings/document-updated` (typed by @deepseek-ai/dsh-settings). Both
 * stay wired during the sync window, so the legacy event is declared here.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'settings/updated'(ns: string, revision?: number): void
  }
}
