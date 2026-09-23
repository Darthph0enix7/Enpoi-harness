---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-inbound-attribution

English | [中文](2026-09-23-inbound-attribution.zh.md)

## Summary

Adds optional provenance to persisted inbound message sources and turn-end cancellation records: a ParticipantTag on MessageSourceMap.user and on AgentCancelCause's user variant, the model failover-chain id on model message sources, and the terminal provider failure on a turn aborted by a cancellation.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-inbound-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-14-image-offload"
    after: "cadf725ba3f4f901af69f53b88939a691b0138d0fe007e3acceed5518dfaff24"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-14-image-offload"
    after: "d240ee700d481b6493bb7157e55d500773aa5e88358a4863f1d942949cd1a37b"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-14-image-offload"
    after: "90451e186d67b39f7cc3dca49d4d282a11c793b9c67a645f5f2f1c63431fa5c3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-14-image-offload"
    after: "41cfde553a6cceb62d77f1de7638dde2c3732693fe2eb198db1051d19e7a05c0"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All additions are optional properties; no required member, event envelope, or Session header changes. Existing logs carry none of them, so historical reads, model replay, and folds are unchanged. The participant tag is attribution only — it never carries authority, and producers that cannot name the actor omit it; consumers that ignore it still see the same message kind and content. The chain id appears only when the source came from a grouped assignment and stays consistent with the concrete provider/model already persisted; readers that ignore it attribute the answer to the same route as before. A turn aborted before the cancellation reached the loop may now carry error; observers that predate it simply do not read the field, and the existing reason remains authoritative.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm/tests/message.spec.ts packages/session/session-title-llm/tests/llm.spec.ts: 16 tests passed across 2 files. pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts packages/subagent/subagent/tests/service.spec.ts: 196 tests passed across 2 files. pnpm exec vitest run packages/core/agent-loop/tests/cancel.spec.ts: 39 tests passed. pnpm exec vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts: 73 tests passed across 2 files; the persistence preview classified only optional additions on these roots and required no version bump.

<a id="dev-note"></a>
## Dev Note

None.
