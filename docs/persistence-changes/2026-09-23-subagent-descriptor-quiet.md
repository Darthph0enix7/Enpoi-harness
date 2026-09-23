---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-subagent-descriptor-quiet

English | [中文](2026-09-23-subagent-descriptor-quiet.zh.md)

## Summary

Adds the optional quiet flag to a continuable subagent descriptor so settlement notices and report relays stay suppressed after a cold resume.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-subagent-descriptor-quiet
baseline: false
changes:
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "b35946d8fb062b10f73dda91fcde70c687a34159712ae5118ced3b4f4d7a0103"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The flag is optional and written only for continuable descriptors whose creator declared quiet; one-shot and non-quiet children omit it, and descriptors already in old logs read unchanged. The descriptor keeps version 3 because quiet is an optional member of the same composition record, not a new input shape. A build that predates the field folds descriptors through an exact per-mode allowlist and refuses an unknown field, so it cannot read a newly written quiet descriptor; that exposure is limited to newly created quiet children and never changes the reading of historical sessions.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts packages/subagent/subagent/tests/service.spec.ts: 196 tests passed across 2 files, including quiet persistence and cold-resume restoration. pnpm exec vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts: 73 tests passed across 2 files; the persistence preview classified only an optional addition and required no version bump.

<a id="dev-note"></a>
## Dev Note

None.
