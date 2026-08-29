# Tier1: Revert + File-History Port (working branch → 0.1.2-alpha.1)

## 1. Goal
Port the complete working-branch revert system (commit f8a569b560 = 536bcc674a^1) onto post-merge `local/serverlocal` 60ff0bcf43 without duplication, message loss, or file clobber. Guarantees: FR1-5 (zero silent clobber/deletion, exact-byte fidelity, clean tree, idempotent WAL), surfaceOp shadowing, per-row restore/fork, affected-files tray with save-beside, 500-record cap/30d GC, tailnet bypass intact.

Don't touch already-fixed tailnet auth, sidebar file-preview guards, or git 500 fix.

## 2. Context (explorer ses_fb1716f3dffezy2Ok8ngu2edXW, 33044B audit)

Working branch docs: 42 (design, revert/state event, surfaceOp replace, tray), 44 (FR1-5, two-seam capture, 6-state matrix, WAL, storage), 45 (production layout, isKnownSpanState, TOCTOU/pre-clobber, UI, workbench), 34 (FA-1 log-anchored delivery). Core types: packages/core/session/src/types.ts has revert/state {fromSeq|null, cause?}, revert/file-intent, revert/file-result, revert/file-conflict (ignorable, never surface-eligible), SurfaceOp {op:replace start,end} with sourceEventSeqs. Agent loop: agent.ts followup({surfaceOp, sourceEventSeqs, clearRevert}) appends user/message with replace + atomic revert/state commit. Host: api/session-controller (ex-apiproxy) folds revertBoundary/revertFileOutcomes/revertFileConflicts, enforces queued+idle+anchor guards, ledger ~/.dsh/revert-ledger. Client: runtime/session.ts folds with clear on revert/state, shadowRanges union, history paginator carries projections; UI: ui-conversation RevertTray (dock input, per-row restore/fork, affected files chips + badges, Save Beside), ui-chat revertAt. File plugin: enpoi-file-revert (profile) two-seam capturePre/Post, content-addressed blobs, span-wide isKnownSpanState, executor with TOCTOU + pre-clobber backup + trash, WAL intent/result pair, resolveFileConflict waterfall.

Current post-merge drift: enpoi-file-revert not mounted correctly after merge (profile symlinks 323 but harness types may have drifted: core SessionEventMap now at packages/core/session + api/session-controller, not apiproxy; client runtime at api/session-controller/client vs runtime). Tray shows duplication when restoring (anchorSeq vs seq confusion) and send-after-revert shows nothing (clearRevert not threaded). Those are the symptoms to fix.

## 3. Technical Plan & Oracle Review

**Plan (one-to-one port, no new design):**

1. **Verify type registrations:** Ensure `revert/state|file-intent|file-result|file-conflict` are in `packages/core/session/src/types.ts` KNOWN_SESSION_EVENT_TYPES + SessionEventMap (working branch lines 205-285). If missing after merge, re-add with `ignorable` not needed (type-registered = never surface-eligible).

2. **Agent loop:** Ensure `packages/core/agent-loop/src/agent.ts` followup/steer accept {surfaceOp, sourceEventSeqs, clearRevert} and append user/message + revert/state commit atomically (working L313-318). If upstream overwrote, restore.

3. **Host controller:** Port `packages/api/session-controller/src/index.ts` revert/revertRestore/resolveFileConflict + history folds (foldRevertBoundary etc.) from working `host/apiproxy/src/api-proxy.ts` L2043+. Ensure `session.prompt` handler respects `revertFromSeq` guards (queued-only, idle-only, anchor valid, has-tail) and threads surfaceOp+clearRevert to agent.followup.

4. **Client runtime:** Port `packages/api/session-controller/client/sessions/session.ts` folds (foldRevertState/outcomes/conflicts/shadowRanges) with clear-on-revert/state semantics and paginator hostRevert* mirrors; ensure `buildSnapshot` history carry.

5. **UI:** Ensure `packages/client/ui-conversation` RevertTray + `packages/client/ui-chat` revertAt + `packages/client/runtime` folds match working. Fix duplication: use activeTabType memo above no-session early return already done; verify per-row restore uses `nextItem.seq` not stale anchor.

6. **File plugin:** Ensure `~/.dsh/profiles/web/packages/enpoi-file-revert/src/` is mounted (profile package.json, cordis.patch.yml) and its host counterpart (if any) is symlinked. Verify two-seam capture, isKnownSpanState, executor TOCTOU/pre-clobber, WAL. Run its 39 tests + profile integration 109/109.

7. **Verification:** headless E2E: text-only revert no-op + conflict & Force Revert + Save Beside + missing recreation + trash; messages never duplicated; ledger exists.

**Oracle Review Notes:** (to be filled after oracle call)

## 4. Execution Log
- 2026-08-29: explorer ses_fb1716f3… completed audit.
- Plan drafted, awaiting oracle plan review.

## 5. Final Oracle Review & Validation
- pending
