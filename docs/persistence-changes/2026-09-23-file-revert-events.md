---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-file-revert-events

English | [中文](2026-09-23-file-revert-events.zh.md)

## Summary

Declares the four log-only file-revert events: revert/state records the active revert boundary, revert/file-intent and revert/file-result form the write-ahead intent/result pair for disk mutation, and revert/file-conflict records a file that needs operator resolution.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-file-revert-events
baseline: false
changes:
  - root: "event:revert/file-conflict"
    previous: null
    after: "0dd5d9778443f63729df9c252fdf3e476c6725b59d277cb257c3679de7f64142"
    decision: same-version
  - root: "event:revert/file-intent"
    previous: null
    after: "61a1ef6dfd7fa95da9e6023325c83c07d981a1e241a04a47e4a66d9f3e28729c"
    decision: same-version
  - root: "event:revert/file-result"
    previous: null
    after: "c41ca325c68f183c2c9f30184966d4982a672e442ffb1462d2476d689482982a"
    decision: same-version
  - root: "event:revert/state"
    previous: null
    after: "93a0e2ed44bc50262e59abbf13cbe484b965a0d2d9b9f716ec38e4dc6425f186"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New event roots in the same Session format; existing logs contain no such events and stay valid. All four are log-only and never surface-eligible, so they never enter derived model history. A reader that predates a root refuses a log carrying it, as any required-on-read event does; a session without them simply shows no revert state. Current readers fold the latest revert/state to truncate a reverted transcript, treat an intent without a matching result as unsealed for idempotent recovery, and render the conflict modal. No header, envelope, or existing event changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/agent-loop/tests/revert-commit.spec.ts packages/api/session-controller/tests/revert.host.spec.ts packages/api/session-controller/tests/revert-fold.client.spec.ts: 14 tests passed across 3 files. pnpm exec vitest run packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts: 22 tests passed, covering revert batch folding into the transcript. pnpm exec vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts: 73 tests passed across 2 files; the persistence preview classified four ordinary event-root additions and required no version bump.

<a id="dev-note"></a>
## Dev Note

None.
