import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SettingsDocumentLocation, SettingsDocumentView } from '../src/client/settings-document-store.ts'

export const SESSION = 's-1' as SessionId
export const DOCUMENT: SettingsDocumentLocation = { path: '/home/op/.dsh/profiles/web/cordis.patch.yml', root: '/home/op/.dsh/profiles/web' }

/** The door's calls, for assertions. */
export interface ViewScript {
  readonly view: SettingsDocumentView
  readonly calls: {
    close: number
    reveal: Array<{ sessionId: SessionId; document: SettingsDocumentLocation }>
    locate: number
  }
}

/** A door with a scripted session, location, and reveal. */
export function scriptedView(options: {
  sessionId?: SessionId | undefined
  locate?: () => Promise<SettingsDocumentLocation>
} = {}): ViewScript {
  const calls: ViewScript['calls'] = { close: 0, reveal: [], locate: 0 }
  return {
    calls,
    view: {
      close: () => { calls.close += 1 },
      sessionId: () => options.sessionId,
      locate: () => {
        calls.locate += 1
        return (options.locate ?? (() => Promise.resolve(DOCUMENT)))()
      },
      reveal: (sessionId, document) => { calls.reveal.push({ sessionId, document }) },
    },
  }
}
