# Tier1: Revert + File-History Port — COMPLETE

## 1. Goal
Port the complete working-branch revert system onto post-merge `local/serverlocal` without duplication, message loss, or file clobber. Guarantees: FR1-5, surfaceOp shadowing, per-row restore/fork, affected-files tray with save-beside.

## 2. Root Causes Found & Fixed (all committed)

1. **Sub-agent duplication** (`6858e183ea`): descriptor version gate `3` rejected `2-quiet` fibers → NOT_RESUMABLE → lost quiet. Accept `2|3`.
2. **Send-after-revert blank chat** (`58afb18074`): client `prompt()` never sent `revertFromSeq` — host appended new message without surfaceOp replace, landing after the boundary → hidden. Now payload carries it.
3. **Host null-vs-number** (`520a5541ac`): `revertFromSeq` is `number|null`; host checked `!== undefined` so `null` slipped in. Now `typeof === 'number'`.
4. **Session corruption on load** (`23d3b74e3b`): agent-loop appended `revert/state` commits with `{ignorable:true}` but the merged envelope validator only allows type/seq/time/data/surfaceOp/sourceEventSeqs → every commit event failed "invalid event envelope" → session refused to load. Removed flag from new appends + accept legacy `ignorable` in validator.
5. **Affected files never rendered** (`23d3b74e3b`): client fold MUTATED `revertFileOutcomes`/`revertFileConflicts` in place → snapshot reference never changed → RevertTray useMemo (deps [outcomes]) never re-ran. Now immutable updates.
6. **prependWindow never folded revert events** (`23d3b74e3b`): older pages loaded via loadOlder carried revert/file-* the incremental fold missed. Now re-folds the complete loaded window on prepend.

## 3. Verified
- Session loads (no corruption), tray shows "Reverted messages (2)" + "AFFECTED FILES (3)" with Trashed/Restored badges.
- File chips open in sidebar (dsh-open-file event).
- Files trashed to ~/.dsh/trash (test-file.txt, test-example.txt), restored (test_new.txt).
- Zero page errors.

## 4. Remaining
- Conflict resolution buttons (Keep/Force Revert/Save Beside) — backend RPC verified, UI buttons present; live conflict scenario needs a real agent turn.
- Trajectory shows raw log (by design — append-only; model surface excludes shadowed spans via surfaceOp).