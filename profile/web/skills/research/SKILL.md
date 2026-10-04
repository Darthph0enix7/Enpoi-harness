---
name: research
description: Deep, current, verified web research — delegated by default. Main sessions dispatch one librarian (never run research in the main session); librarians run this process with a coverage checklist, archived sources, verbatim-quoted claims, mechanical anchor verification, and one cited synthesis. Dials from lookup to exhaustive. Use whenever an answer depends on the live web (news, pricing, releases, docs, comparisons, "what is the latest…") or when the operator asks for deep/current/thorough/exhaustive research.
---

# Research — deep, current, verified

## Who runs this

**Main sessions (orchestrator, sysadmin, any non-librarian agent): delegate — do not run research yourself.** One dispatch, one result. The main session never fetches, saves, or extracts; it receives the cited answer and stays lean. Same pattern as offloading code to a fixer.

```
subagent — description: "librarian: research — <question>"
prompt:
  Question: <exact question, scope, what "done" looks like>
  Dial: <lookup | quick | standard | deep | exhaustive>   (default: standard)
  Freshness: <e.g. "as of October 2026", or "any time">
  Budget: ≤<N> sources, ≤<M> minutes
  Deliverable: <inline cited answer | 1–2 page cited answer file | full dossier>
  Follow the research skill: archive sources with research-fetch, write anchored
  claims, run custom_research-verify to PASS, then answer. Return the answer
  inline plus the run-dir path and the verification summary.
```

**Librarians: run the process below.** You own the run end to end. One librarian handles lookup, quick, and standard solo; deep and exhaustive fan out readers (you may dispatch `librarian` children).

## Capability check — detect what is actually available

The web layer is composed per install: the operator's web setup decides whether `web_search` and `web_fetch` exist in your catalog at all. Check which are really mounted before choosing a dial, and run the mode you are in.

- **`web_search` + `web_fetch` — full mode.** Every dial works as written.
- **`web_search` only — snippets + local archiving.** Discovery works; harness `web_fetch` is absent. You can still read a chosen result: archive its URL with `custom_research-fetch` (local, no provider, no key) and extract from the saved file. Never claim a harness page read; say the reading was local when it matters.
- **`web_fetch` only — given-URL mode.** No discovery. Read operator-supplied URLs with `web_fetch` (and `custom_research-fetch` when you want an archived copy); decline open-ended "find me…" questions and offer to read a URL instead.
- **Neither — local-only mode.** No discovery and no harness fetch. `custom_research-fetch` still reads operator-supplied URLs; decline open-ended questions, point the operator at **Settings → the web setup step**, and never fabricate sources.

A tool absent from your schema does not exist: never call `web_search`/`web_fetch` speculatively, and never cite a page you could not read.

## The dials

| Dial | Use for | Sources | Readers | Verifier | Deliverable | Target |
|---|---|---|---|---|---|---|
| **lookup** | one fact, one page | 1–3 fetches | 0 | none — quote inline | inline answer, quotes inline | <1 min |
| **quick** | a small question, few facts | 2–4 | 0 | 1 pass | short cited answer + mini run dir | 2–3 min |
| **standard** *(default)* | comparisons, overviews, buying decisions | 5–10 | 0–2 | 1–2 passes | cited answer, 1–2 pages, in `answer.md` + inline | 3–6 min |
| **deep** | a real dossier, many angles | 15–25 | 3–6 | iterative to PASS | `dossier.md` with an Unknowns section + inline summary | 8–15 min |
| **exhaustive** | deep + adversarial falsification | 25+ | 6–10 | iterative + counter-searches | dossier + falsification notes | 15–30 min |

State the dial and budget when you start; say which limit ended the run. When unsure, run **standard** — never default to deep.

## Non-negotiables

- **Anchored claims only.** Every reported fact carries four things: the claim, the source URL, a short **verbatim quote** from that page, and its date context. Copy one contiguous span exactly — never compose a quote from separate fragments, never paraphrase it. `custom_research-verify` mechanically checks each quote against the saved page. A claim that fails is **not reportable** — re-quote it, re-source it, or mark it unknown.
- **Coverage checklist.** Decompose the question and write the checklist with `todo_write` before searching (one item per sub-question, freshness horizon per item). Completeness is tracked, never hoped for. Re-read the checklist after every round.
- **Freshness.** Prefer the newest sources unless the operator gave a date — then treat that date as an "as of" lens (sources published up to then). Put the year/period in your queries. Read publication dates when present; an undated source is weaker evidence. Never present stale data as current.
- **No silent blending.** Distinguish source-backed facts from prior knowledge. If only your weights say it, label it "model prior — unverified" or leave it out.
- **Abstention over confabulation.** "Not found" / "contested" is a valid, valuable answer. Report unknowns explicitly.

## The run directory

Create `<cwd>/.research/<slug>-<yyyymmdd-hhmm>/` (prefer a path outside a git repo, or ensure `.research/` is ignored):

```
sources/            one .md per archived page — written by research-fetch
sources/index.json  maintained by research-fetch (file, url, title, fetchedAt)
claims/             *.jsonl, one claim per line, one file per writer
scratch/            reader scratch — keep it HERE, never the home directory
verification.json   written by custom_research-verify
verification.md     written by custom_research-verify
answer.md           quick/standard deliverable (deep: dossier.md)
```

One claim line:

```json
{"claim":"…","quote":"verbatim sentence(s) from the page","source":"01-slug.md","url":"…","date":"YYYY-MM-DD or null","key":"optional.grouping.key"}
```

- `quote` must be copied verbatim from the archived source — never paraphrased, never reconstructed from memory.
- `key` groups claims about the same fact across sources; the verifier uses it for single-source and conflict detection.
- `date` is the claim's date context (source publication date, or the "as of" date it speaks to).

## Tools

- **`custom_research-fetch`** — archive every source: fetch URL → `sources/NN-slug.md` + index entry, returning only metadata (the page text never enters your context). This is the default fetch. Use `web_fetch` only when you must read a page right now (triage before archiving, or a stubborn page) — then archive it.
- **`read` / `grep`** — pull quotes out of archived sources; `grep` is the cheapest way to find a quote.
- **`write` / `edit`** — claims files, answer/dossier.
- **`custom_research-verify`** — the anchor check; run it, fix what it flags, re-run until PASS.
- **`subagent`** — deep/exhaustive only: fan out readers.

## Phases

1. **Scope** (all dials). Restate the question; list what would make the answer wrong or incomplete. For unfamiliar domains, run one probe search first — never plan blind.
2. **Plan** (quick and up). Write the checklist to `todo_write`.
3. **Discover** (all). `web_search` with **multiple queries per call** — decompose; add the year, synonyms, exact phrases, site hints. Triage by title, date, snippet; drop weak results.
4. **Read & archive** (all). `custom_research-fetch` each chosen page into `sources/`. Inspect with `web_fetch` only when triage needs it.
5. **Extract claims** (quick and up). While each page is fresh, grep/read it and append claims to `claims/`. Lookup skips this — it quotes inline.
6. **Fan out** (deep and up). Dispatch readers — one per sub-question or source cluster (see below).
7. **Verify** (quick and up). Run `custom_research-verify` on the run dir. Only `anchored` claims are reportable; fix `weak`/`unanchored` ones (re-quote verbatim, re-source, or drop to unknown) and re-run.
8. **Gap-chase** (standard and up). Compare findings against the checklist: what is unanswered, single-sourced, or contradicted? Search specifically for that. Repeat until covered or budget ends.
9. **Synthesize — once, at the end.** The direct answer first; per-checklist findings with inline `[title](url)` citations; quotes where precision matters; "as of <date>" stamps; an explicit **Unknowns / Contested** section; and which parts (if any) are model priors. Write `answer.md` (quick/standard) or `dossier.md` (deep/exhaustive) and return the answer inline. Never write sections in parallel.

## Deep fan-out (deep / exhaustive)

Split the work by sub-question or source cluster and dispatch `librarian` readers (3–6 for deep, 6–10 for exhaustive). Each reader:

- gets the exact sub-question, the archived source paths to mine, and its claim file path (`claims/<label>.jsonl`);
- mines the given sources with `read`/`grep`; if it needs new material it searches and archives its own pages with `custom_research-fetch`;
- writes its claims directly to its file and returns only: counts, the file path, and gaps/contradictions found — not the claim text.

Then you verify, chase gaps, and synthesize. Readers never write the dossier and never present.

## Working rules

- The whiteboard is the orchestrator's long-lived context — do **not** put research state on it. Research state lives in the run directory and the `todo_write` checklist.
- Prefer primary sources (vendor pages, docs, filings) over aggregators and SEO farms; cross-check single-source claims before reporting them.
- A source that speaks about the past is not evidence about today — date every claim by what it actually supports.
- Move superseded run files to `scratch/` with `mv` rather than deleting them with `rm` — `rm` triggers an approval card, and the move keeps the audit trail.
- Never restart the web service or edit configuration as part of a research run.
