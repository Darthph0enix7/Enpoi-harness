# Archived documentation

Frozen upstream pages that no longer describe the upstream path live here. Archiving is a move, never a delete: page content is preserved in full below a one-line banner at the top of the file.

Banner format (first line of every archived page):

```md
> Archived — superseded; see <pointer>
```

Rules:

1. A page is archived only when it is clearly stale or misleading for the upstream path — a moved, renamed, or replaced mechanism — or when the fork has superseded it and the upstream text would send readers the wrong way.
2. Inbound links to the old path are updated or removed in the same change; the archived file keeps its own content byte-for-byte below the banner.
3. A page that remains accurate for the upstream path is **not** archived; it stays where it is and is declared in [`../README.md`](../README.md#upstream-pages-that-are-not-the-forks-path-left-in-place-declared).
4. Historical tiers keep their own frozen homes and are not duplicated here: [`../postmortem/`](../postmortem/README.md), [`../persistence-changes/historical-formats/`](../persistence-changes/historical-formats/README.md), and `.agents/notes/archived/`.

## Index

No pages are archived as of 2026-09-28. The audit that established this: every `docs/**` page is upstream-authored and upstream-current (freshness gates and `pnpm run verify-md-links` are green for the whole tree), and the fork's divergent entry content is declared in the map rather than moved. The first qualifying page gets moved here with the banner above and an index row below.

| Archived page | Superseded by | Date |
|---|---|---|
| _(none yet)_ | — | — |
