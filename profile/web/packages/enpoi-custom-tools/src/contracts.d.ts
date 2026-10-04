/**
 * Local type shim for the untyped `dsh-enpoi-contracts` leaf package (it ships
 * JS only). Mirrors the reader surface this plugin consumes.
 */
declare module 'dsh-enpoi-contracts' {
  /** The settings service surface the orchestration reader accepts. */
  export interface SettingsDocumentReader {
    get?: (ns: string) => unknown
    describeNamespace?: (ns: string) => { ns: string; value?: unknown } | undefined
    describe?: () => ReadonlyArray<{ ns: string; value?: unknown }>
  }
  /** Read the shared `enpoi-orchestration` document. */
  export function readOrchestrationDocument(settings: SettingsDocumentReader | undefined): Record<string, unknown> | undefined
}
