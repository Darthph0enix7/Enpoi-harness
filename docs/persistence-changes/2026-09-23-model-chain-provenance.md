---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-model-chain-provenance

English | [中文](2026-09-23-model-chain-provenance.zh.md)

## Summary

Adds optional failover-chain provenance to persisted model output: the answering link on a terminal stream chunk, the model-group id on an assistant message source, and the model-group id on a persisted model selection.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-model-chain-provenance
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-14-image-offload"
    after: "25aaf208018d9b7c2ecbd2317967cf8c9937823f4527412ee9c0ef65cebff783"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-14-image-offload"
    after: "048161739677c663f40ccd7d9f9f1f586e78ffffe9d5504a5f40c2491f34fbb4"
    decision: same-version
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "b902b34dc7a4c08b58ad9c36519dad7dda638624a3d905d5394e9ef9969037a0"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Every addition is optional. The answering link is written only when the runtime escalated away from the request's own route, and the chain id only when the request carried a model group; single-model requests omit both. Existing logs contain neither, so historical replay is unchanged. A consumer that ignores them still attributes the answer to the persisted concrete provider/model, which remains the active link; for model selection, an absent or unknown group id keeps single-model routing.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm/tests/model-chain.spec.ts packages/api/session-controller/tests/session-projections.host.spec.ts: 33 tests passed across 2 files, covering chain escalation, the answering link, and the model-selection fold with and without a chain. pnpm exec vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts: 73 tests passed across 2 files; the persistence preview classified only optional additions and required no version bump.

<a id="dev-note"></a>
## Dev Note

None.
