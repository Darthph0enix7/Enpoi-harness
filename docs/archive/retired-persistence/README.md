# Retired persistence history

These files are frozen evidence, not current authority. They are excluded from the loaded persistence history and from bilingual pairing.

Two terminal, unaccepted records were moved here from `docs/persistence-changes/` during the [Session V5 change](../../persistence-changes/2026-11-07-session-format-v5.md):

- `2026-09-23-inbound-attribution`
- `2026-09-23-model-chain-provenance`

Both declared `previous: 2026-09-14-image-offload` for roots that the accepted `2026-09-16-session-format-v4` record had already advanced, so they forked accepted V4 history. Their after snapshots are V1-shaped (`formatVersion: 1`) while the V4 record's snapshot is `formatVersion: 2`; retargeting their predecessor edges would therefore classify the V1-to-current difference as a version bump and require a header transition these records do not contain. Their only surviving non-forked edge, `event:model/selection` from `2026-09-11-initial`, is acknowledged by the V5 record instead.

The V5 record re-acknowledges the six forked roots directly from `2026-09-16-session-format-v4`. Restoring these files to `docs/persistence-changes/` would recreate the fork and fail verification. The complete originals also remain retrievable from Git history.
