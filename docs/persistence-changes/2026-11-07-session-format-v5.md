---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-session-format-v5

English | [中文](2026-11-07-session-format-v5.zh.md)

## Summary

Advances `SessionHeader.version` from 4 to 5 for the identity-body V5 writer. Records the expanded approval outcome vocabulary, the `max-tokens-continuation` source kind, the removed `user-approval` and `model-selection` source variants, the optional `request/context.nativeFileInputs` policy descriptor, and the V4-era same-version event additions. Retires two unaccepted V4 records that forked accepted history and acknowledges their surviving roots directly from the accepted V4 tip.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-session-format-v5
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "22c6899a78214dd841c266348ae997027ef391174ddb21127f1b71dc1b362824"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "db655a74967e9c1b2d5f4763a8d930aebd0d8b1161233db0633a539c81490142"
    decision: version-bump
  - root: "event:approval/decided"
    previous: "2026-09-11-initial"
    after: "a2448bcb223dc12996b55ac351064b0000d71b95f196724c23f2fe2a097c3b32"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "cf192c719b0febabe8244e1de05eef4bd39e88a3a371157f359c31e63202ffe1"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "9c6f7442e5621d80cb1e57ce18d635366477bf62be9209571ef21238df37bdce"
    decision: version-bump
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "d36e0831e56d3195346b63301f46dca6cde03d79164152c14101a8a05fe4a468"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "3e990433b6e4327b45dc1285750d716c18da2355ddc8a57d99008aad58d07b27"
    decision: version-bump
  - root: "event:llm/attempt-failed"
    previous: null
    after: "946eb1b89fe299bfe8ebb0257e67386fada612d12b7b0e11e62b6e03e940db9d"
    decision: version-bump
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "bd52986551dc8102017f344a40c17b262a5625b5966b5aa89e4e8145344ffbc5"
    decision: version-bump
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "b902b34dc7a4c08b58ad9c36519dad7dda638624a3d905d5394e9ef9969037a0"
    decision: version-bump
  - root: "event:request/context"
    previous: "2026-09-11-initial"
    after: "429ad19b7ae2b6270c50c98e807a5b227511c31b07c0db58cfe26a6ff84476eb"
    decision: version-bump
  - root: "event:revert/branch"
    previous: null
    after: "13eb99c2a2d7291fb5d14904e927e07e020e719d0ebb389f2699754c639d96b6"
    decision: version-bump
  - root: "event:revert/iteration"
    previous: null
    after: "0000e40458eff9852e4bd97456430b0dd9186594477cf06d6d8ffa374507a4b4"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "2c600ba8579367970510fb7da25d651ce609f136925f3d3713dc099191bbd753"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "54c880f9aa3a28f3507f58101746fcf34b8cefad7d622812c4eefddd032af188"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "a8ba2aeae8ad5488af29144d87fdef68d34c2b7d8b89a4d95b632e95824c332d"
    decision: version-bump
  - root: "event:verify/unmet"
    previous: null
    after: "e891cfa7e9fdced1a0da31d1040120268aacd24293850150f2ebcb4e769b1a35"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

The V4-to-V5 migration preserves every event, compact run, coordinate, timestamp, reference, and payload verbatim. It changes only the logical header version and re-derives the inherited cut from the source marker. An older V4 binary refuses a V5 header; the V4 predecessor stays on disk for inspection, and no fallback or downgrade path exists. Historical V4 read opens present the same trusted prefix the V4 reader admits; write open refuses a V5 successor when strict row recovery dropped any committed V4 row, leaving the V4 generation selected and unchanged until the source becomes cleanly migratable. A torn final line or frame repair is not recovery and publishes normally. Session append validates `request/context` payload fields, including `nativeFileInputs`, before log-only surface metadata, so a payload error precedes a metadata error when both are invalid; this matches every other event type. The expanded approval outcome vocabulary is a real incompatibility: older V4 runtimes validate a closed outcome union, so V5 may write `allowed-always` and `allowed-always-broad` while the migration preserves every historical outcome unchanged. `user-approval` and `model-selection` sources are preserved verbatim as unknown-producer kinds, and the new `max-tokens-continuation` kind is admitted without changing message replay. The optional `nativeFileInputs` member is policy only: it carries no bytes, filenames, sentinels, attachment ids, or sidecar message, and its absence means every file was projected to handle text. Because an older reader would ignore the descriptor and change the native projection and token budget, it is folded into this single V5 record rather than added later. The two retired `2026-09-23-*` records had V1-shaped snapshots and predecessor edges that forked the accepted V4 history; their files are frozen evidence under `docs/archive/retired-persistence/`, and this record acknowledges the six forked roots plus the surviving `event:model/selection` edge directly from `2026-09-16-session-format-v4` and `2026-09-11-initial`. `docs/persistence-changes/finalized/v4.json` and every accepted record remain byte-identical.

<a id="verification"></a>
## Verification

Focused V4-to-V5, V3-to-V4 regression, catalog-chain, JSONL V4-to-V5 migration, and installed Session suites passed 1,069 tests across 51 files, and the log-deepseek plus JSONL migration, listing, catalog, and retired-content suites passed 165 tests with one skip across 8 files. Assertions cover identity-body equality, inherited-cut derivation, deterministic repeat, non-V4 refusal, unknown required refusal, opaque ignorable preservation, legacy sources and outcomes, read-open non-publication, exclusive V5 successor publication with unchanged V4 bytes and inode, idempotent second open, fresh-process reopen, corrupt predecessor refusal, and V6 refusal without fallback. The loop-level descriptor suites passed 481 agent-loop and 434 llm tests, including descriptor capture on the prepared call, deep equality, adapter-validation refusal, and request/context logging when the policy changes. The persistence script suites passed 303 tests across 6 files, covering fork rejection, retarget rejection, the V5 header transition, and the retained finalized history. The new edge and the refactored V4 validation and codec report 100% statements, branches, functions, and lines; the JSONL format helpers also report 100%. `gen-persistence-catalog` and `verify-persistence-catalog` pass; `verify-persistence-formats` reports six complete V0-V5 references; `verify-session-format-catalog`, `verify-dependency-catalog`, and `verify-module-graph` pass; the keyless session domain corpus passes after extending its policy to accept V4 as a retained baseline; the Python SDK passes 207 tests with 12 skips. The keyless TypeScript SDK `text-turn` snapshot refresh and replay pass with a V5 successor fixture. The full `pnpm run build`, `pnpm run typecheck`, and `pnpm run lint` stop on pre-existing errors in the dirty worktree outside this migration (`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` passes plain numbers where `SessionSeq` is required, and `packages/llm/llm/tests/service.spec.ts` omits the required `kind` on a model source). The full `packages/session` suite passes 2,730 tests with five pre-existing projection/title failures that reproduce at the base commit; the full coverage run passes 41,762 tests with 138 pre-existing failures and unhandled errors across the wider dirty tree; the remaining SDK scenarios fail on pre-existing tool-description drift that also reproduces at the base commit.

<a id="dev-note"></a>
## Dev Note

None.
