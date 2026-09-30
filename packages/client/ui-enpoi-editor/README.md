---
description: "The right Sidebar's editable file workbench for the dsh web client: a CodeMirror editor over session-scoped file addresses, with optimistic saves through the fenced /sidebar/fsops routes and external-change protection that never clobbers a dirty buffer."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-enpoi-editor

English | [中文](README.zh.md)

## Summary

The right Sidebar's editable workbench: a session file opened as a tab type at the `extension` band, edited in CodeMirror 6 and saved through the profile's fenced `/sidebar/fsops` JSON routes. It claims only text-ish session files — images, PDFs, office documents, and unknown categories stay with the read-only preview — and it polls `fs.stat` while its tab is visible so a disk change under a clean buffer swaps in place and never overwrites unsaved edits.

## Table of Contents

- [What it registers](#what-it-registers)
- [Editing and saving](#editing-and-saving)
- [Finding and navigating](#finding-and-navigating)
- [External changes](#external-changes)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The type** — `ctx.sidebarRightTabs.register(...)` with kind and id `enpoi-editor`, patterns `['dsh-resource://file/**']`, band `extension`, and `canOpen` accepting only a session-scoped address whose path `classifyFileType` places in an editable category. The band is the decision: for exactly those addresses this type beats the read-only `text` fallback registered by `ui-sidebar-documentpreview`; every other address never reaches it.
- **The chip title** — the definition's `title`, the decoded basename of the address (the read-only preview's own convention).
- **The body** — the keyed `sidebar.right.pane.tab` seat under the same id: toolbar, banners, the editor or preview, and the loading/missing/failed states. A declared store keyed by tab id holds one file's content, disk baseline, dirty buffer, and view choices so switching tabs and coming back keeps unsaved edits.
- **Copy** — the `enpoiEditor` locale namespace.

Six source files under `src/client/`: `definition.ts` (the type), `fsops.ts` (the `/sidebar/fsops` client), `machine.ts` (the async read/poll/save decisions), `store.ts` (what a tab keeps), `search.ts` (the find overlay, its reveal, and the go-to-line flash), `languages.ts` (the grammar map), and the components `EditorBody.tsx` / `CodeMirrorEditor.tsx` plus `EditorBody.module.css` and `icons.tsx` (the wiring lives in `index.ts`).

<a id="editing-and-saving"></a>
## Editing and saving

The editor is CodeMirror 6 with line numbers, undo history, a small language set (Markdown, JavaScript/TypeScript/JSX, JSON, Python), and two compartments: line wrapping and read-only. Preview renders the current buffer read-only through `MarkdownText` (Markdown) or `CodeBlock` (everything else). `Mod-s` inside the editor and the toolbar's Save button call the same save.

A save writes with `expectedSha` — the SHA-256 of the content **last read from disk**, never of the edited buffer. A `409 conflict` raises the conflict banner with **Overwrite** (retries with `expectedSha` omitted, the route's force form) and **Reload**; the buffer survives until the operator chooses. A truncated read (`truncated: true`) is read-only and never saves: the editor drops its save control and shows the notice, because a partial buffer must never replace the file.

I/O is same-origin `POST /sidebar/fsops/<method>` with `content-type: application/json`, wrapped by the injected `EditorFsOps` face: `fs.read` → `{content, sha256, mtimeMs, size, truncated}`, `fs.write` → the new digest/stat (or `409 conflict`), and `fs.stat` → `{mtimeMs, size}`. `not-found` (404) is a state, not an error.

<a id="finding-and-navigating"></a>
## Finding and navigating

**Find** (`Mod-F` or the toolbar control) opens the themed bar over the editing surface. Matches highlight as the query is typed, `Enter`/`Shift-Enter` (and the chevrons) step through them with wrap-around, and the counter reads `index / total` or the quiet **No matches** state. The case (`Aa`) and regex (`.*`) toggles re-query in place; regex is anchored at the query's own syntax and case-insensitive unless the case toggle is on. Escape sequences are never expanded when regex mode is off — a find field is literal text. An invalid pattern (`(`) is not an error surface: the bar reports **No matches** and clears the marks instead of throwing.

`@codemirror/search`'s own highlighter only decorates matches while its built-in panel is open, so this package owns the overlay: `search.ts` collects the query's ranges, marks every one `cm-searchMatch` and the revealed one `cm-searchMatch-selected` in a `StateField`, and dispatches the overlay, the selection, and a centered `EditorView.scrollIntoView` in one transaction — the match highlights and scrolls into view on the first query as well as on every step. `CodeMirrorEditor.tsx` styles both classes through `--dsw-alias-state-warn-primary` at two strengths, so they follow the active skin in either scheme; decorations map through document changes and clear when a replaced document invalidates the ranges.

**Go to line** (`g` or the toolbar control, while this renderer is selected) moves the cursor to the 1-based line, centers it, focuses the editor, and flashes the target line briefly (`cm-gotoFlash`, a line decoration removed after 1.4 s so a repeat jump flashes again).

<a id="external-changes"></a>
## External changes

While the addressed tab is visible (`tab.visible` and `document.visibilityState === 'visible'`) the body stats the file every 1500 ms. An unchanged stat costs one request.

- **Changed, buffer clean** → the file is re-read and the document is replaced in place with the selection clamped, then the new baseline is recorded. A keystroke landing during the read await aborts the swap — the buffer revision captured before the read is compared after it settles — and raises the banner instead.
- **Changed, buffer dirty** (or truncated) → the **File changed on disk** banner with **Reload** and **Dismiss**; the buffer is untouched. Reload asks for confirmation, then discards and re-reads.
- **`not-found`** → the body becomes the **File not found** state naming the path and offers Reload; a dirty buffer stays in the store and the state says it is kept. If the file reappears, the next poll adopts the new baseline around the buffer instead of discarding it.

<a id="model-experience"></a>
## Model Experience

### Browser-side editor

#### What the model sees

None; this package registers no model-facing input. File content, the disk baseline, and the dirty buffer stay in the browser and travel only over the fenced `/sidebar/fsops` routes.

#### Token effect

None; no prompt text, tool schema, or result rendering is contributed.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Unknown categories are refused.** `classifyFileType` has no text category for extensionless files or `.txt`/`.log`, so those stay with the read-only preview; widening `canOpen` with a text-extension allow-list is the deferred follow-up.
- **No new-file creation, rename, or delete.** The workbench edits files that already exist; exploration and fs operations belong to other surfaces.
- **The sha baseline degrades when the write route reports nothing.** A write ack without a digest falls back to WebCrypto; if `crypto.subtle` is unavailable, the next save may conflict and needs Overwrite.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

CodeMirror is inlined into `lib/client.js` (about 1.1 MB before minification), not requested from the module table: no other plugin shares its runtime identity, and the dependency policy keeps browser-only third-party implementations in the package's `devDependencies`. The grammar and highlight style ride the same artifact.

</details>

**Runtime invariant:** No companion is published. The only runtime state is one store bucket per tab, written by the body that owns it and forgotten on the tab's abort signal; there is no second observation of it to compare against.
