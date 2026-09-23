/**
 * Read-only exposure of the LLM seam's per-Session wire captures: what the
 * model was actually sent for one Session's most recent main request.
 *
 * The bodies are secret-bearing (system prompt, tool schemas, message text),
 * so the summary is the default and callers must opt in to the bodies.
 *
 * @module @deepseek-ai/dsh-api-session-controller/request-snapshot
 */

import { readSessionWireCapture } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRequestSnapshotRequest, SessionRequestSnapshotValue } from './types.ts'

/** Session identities addressable as capture file names; anything else is a bad request. */
const CAPTURE_FILE_NAME = /^[A-Za-z0-9._-]+$/

/**
 * Read the most recent captured main model request for one Session.
 * @param request - Session identity and whether secret-bearing bodies are requested.
 * @param signal - caller cancellation for the capture read.
 * @param root - optional wire log root override (tests); defaults to the seam's own root.
 * @returns the summary, or the bodies too when requested and the capture stores them.
 * @throws RemoteError `gateway/bad-request` for an unaddressable identity or `session/not-found` when no capture exists.
 */
export async function readSessionRequestSnapshot(
  request: SessionRequestSnapshotRequest,
  signal: AbortSignal,
  root?: string,
): Promise<SessionRequestSnapshotValue> {
  signal.throwIfAborted()
  if (!CAPTURE_FILE_NAME.test(request.sessionId)) {
    throw new RemoteError(
      'gateway/bad-request',
      `session.requestSnapshot cannot address session "${request.sessionId}"`,
      {},
    )
  }
  const capture = await readSessionWireCapture(
    request.sessionId,
    root === undefined ? {} : { root },
  )
  signal.throwIfAborted()
  if (capture === undefined) {
    throw new RemoteError(
      'session/not-found',
      `no captured model request for session "${request.sessionId}"`,
      { sessionId: request.sessionId },
    )
  }
  const summary = {
    capturedAt: capture.summary.capturedAt,
    sessionId: request.sessionId,
    provider: capture.summary.provider,
    model: capture.summary.model,
    system: capture.summary.system,
    tools: capture.summary.tools,
    messages: capture.summary.messages,
  }
  if (request.includeBodies !== true) return { ...summary, bodiesIncluded: false }
  if (capture.truncated) return { ...summary, bodiesIncluded: false, bodiesOmitted: 'size-cap' }
  return {
    ...summary,
    bodiesIncluded: true,
    bodies: {
      system: capture.system,
      tools: capture.tools,
      messages: capture.messages,
    },
  }
}
