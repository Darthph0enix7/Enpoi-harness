# Welcome demo — storyboard

Read this when: reviewing the first-run welcome flow before it is wired into the product, or moving a demo step into real settings. The demo is standalone and side-effect-free; this document is the copy and behaviour authority for it.

## What the demo is

- Page: `apps/web/public/welcome-demo.html`, served later at `/welcome-demo.html` (no build step; works loaded from source and from `file://`).
- Assets: `apps/web/public/welcome-demo/demo.css`, `demo.js`, `skin-tokens.css`, `dark-liquid-flow.jpg`.
- `skin-tokens.css` is a verbatim copy of the frozen skin `summer-liquid-glass` v1.0.0-frozen (`~/.dsh/skins/summer-liquid-glass/skin.css`) plus a two-line provenance header; every colour, radius and shadow in `demo.css` resolves through those tokens. Re-copy the file if the skin version ever changes.
- The page follows the standalone-page pattern of `apps/web/dist/preview.html` (dark boot style, `data-ds-dark-theme`, theme-color metas, public-dir favicons) and the backdrop image + scrim declared in `skin.json`.
- Side-effect-free by construction: no settings are read or written, no network request is made, and nothing is persisted. All state lives in memory; the URL hash only carries deep links for screenshots and is updated with `history.replaceState`.
- Reset button (top bar, keyboard `R`) restores the initial state. A `DEMO · nothing is saved` pill is visible on every screen.
- Deep links: `#step=1..7`, `#step=5&stop=0..4`, `#step=6&run=1` (analysis already running), `#step=4&enable=compaction,keeper` / `#step=4&off=whiteboard` (intelligence toggles; all land on by default), `#step=3&provider=<id>` (open that template's form), `#step=3&run=1` (Kilo created: discovery and test done), `#step=3&view=heavy` / `#step=3&view=docs` (FreeLLMAPI form and documentation view).

## Layout

- Placeholder app chrome (decorative, `aria-hidden`): left icon rail, sidebar (brand, New session, Plugins, Tasks, session rows, Context Dashboard, Settings), conversation with tabs/messages/composer chips (`orchestrator`, `workspace-write`, `kilo-auto/free`, `/plan`), right rail + panel.
- Wizard: left step rail (7 steps, clickable) + glass panel with the step content; footer carries the keyboard hint and the progress dots. Completed steps show a green index, skipped steps a struck-through dimmed one.
- Step 5 hides the wizard and runs the spotlight overlay over the chrome instead; the analysis dock (step 6) stays fixed bottom-right across later steps.
- All chrome is placeholder; no real app is loaded behind the demo.

## Steps — exact copy and behaviour

### Step 1 — Welcome

- Eyebrow: `Step 1 · Welcome`; heading: `Welcome to Enpoi Harness`.
- Lead: `A local AI workspace. It runs on this machine, talks only to the providers you choose, and keeps every session as a file you own.`
- Cards: `Chat, tools, background jobs — one window.` / `Ask in plain language; it reads files, runs commands and delegates to helpers.` — `Local first.` / `Nothing is sent anywhere until you pick a provider.` — `Changeable and skippable.` / `Every choice here can be revisited later — nothing is locked in.`
- Fineprint: `This page is a self-contained demo: it reads and writes no settings and touches nothing on disk.`
- Actions: `Set up in 7 short steps →` (primary), `Skip the tour` (ghost; skips to step 7 and marks steps 2–6 skipped).
- Wiring: none. In the product this is the first-run entry; gating will read a first-run marker under `$DSH_HOME`, which does not exist yet.

### Step 2 — Security & access

- Eyebrow: `Step 2 · Security & access`; heading: `Where it listens, and who can reach it`.
- Card `Loopback by default`: `The web interface binds to 127.0.0.1. Only this machine can open it. Binding 0.0.0.0 is a deliberate choice and brings no TLS, password or origin policy of its own.`
- Card `Trusted-network model`: `There is no password by default. Anyone who can reach the port has your access. To use it from another device, expose it only inside a trusted private network (VPN, Tailscale, LAN you control) — never a bare public port.`
- Subhead `Sandbox mode — how much agents may do without asking`, three radio options (click selects; default `workspace-write`): `Read-only` / `Inspect files; edits and shell commands are denied.` — `Workspace write [default]` / `Write inside the workspace; wider actions ask first.` — `Full access` / `Everything allowed, no prompts. Choose deliberately.`
- Fineprint: `Changeable per session later — the composer's access-mode switch.`
- Wiring: the host/port pair is `@deepseek-ai/dsh-host-webserver` config (shipped web bundle binds `127.0.0.1:3080`); the choice maps to the permission presets `read-only` / `workspace-write` / `danger-full-access` (`packages/interaction/permission-presets`) and its later per-session surface is the composer seat `conversation.input.permission`.

### Step 3 — First provider (the real Add Provider screen)

- Eyebrow: `Step 3 · First provider`; heading: `Add a provider — the real screen`; lead: `The real Add Provider screen: catalogue first, then the route form.`
- The step embeds a mirror of the Settings → Models Add Provider dialog (`AddProviderModal.tsx`): the same views, fields, state names and copy, so a reviewer reads exactly what the wired wizard will show. Only the catalogue is rendered as static cards (the real grid virtualises nothing; it is 2 columns with its own scroll).
- Picker (first view): title `Add model provider`, search field placeholder `Search 212 providers (OpenAI, Anthropic, Gemini, Ollama...)`, `Empty Provider` button, then the group labels `Popular`, `All Providers`, `Self-hosted / heavy`.
- `Popular` shows the real ordering (`OpenCode Zen`, `OpenCode Go`, `Anthropic`, `GitHub Copilot`, `OpenAI`, `Google`, `OpenRouter`, `Vercel AI Gateway`); `All Providers` shows `Kilo Gateway` pre-selected (highlighted card, `✓`) and `DeepSeek`; the heavy group lists `FreeLLMAPI`, `Antigravity Proxy` and `Command Code (keypool)`, each badged `Listed — add to configure` (the real `heavyListedBadge`; an already-added heavy route reads `Heavy`).
- Footer note while picking: `Kilo Gateway is pre-selected for this first run.` Clicking a mainstream card opens that template's form with its real preset data (display name, id, protocol, base URL, env ref, docs).
- Kilo form (pre-selected template): `Display Name` `Kilo Gateway`, `Provider ID (slug)` `kilo`, `API Protocol` `openai-completions`, `Base URL / Endpoint` `https://api.kilo.ai/api/gateway`, and the key field with the keyless placeholder `No key required — leave empty for the anonymous free tier`; preset meta row `Env: KILO_API_KEY`, `No key required — anonymous free tier`, `Docs ↗`. Footer note: `Keyless route — nothing here needs a key.`
- `Create provider` simulates the add: the button reads `Discovering models…` with an inline spinner, then `✓ Models discovered: 5 — written to the route.`, then `✓ Test call succeeded · 0.8s · kilo-auto/free` with the bubble `Ready — running free on the Kilo Gateway.` (the real flow runs `settings.mutate('llm-pi-ai', …)` → `llm.discoverModels` → a second mutate of the model list; the test call is the demo's confirmation). Finishing marks the step done; a toast repeats that nothing was stored.
- Heavy path (`FreeLLMAPI` card) mirrors `HeavyProviderForm`: summary, `Dashboard ↗` / `Docs ↗`, health badge `Healthy · 200`, `Check now` (re-checks to `Checking…` then `Healthy · 200`), `Quirks` (six, verbatim from the manifest), `How to add`, the detection offer `Running at http://127.0.0.1:3002 — use it`, the mode choice `Use a detected instance · Recommended` (base URL `http://127.0.0.1:3002/v1`) versus `Install locally` (`Dependencies: Docker Engine + Compose · Footprint: ~700 MB disk (536 MB image), ~84 MB RAM idle, no GPU`), the `Documentation` toggle, and the `Unified key (optional)` field.
- No `Requires a browser` badge appears for FreeLLMAPI: its manifest's `requiresBrowser` is empty (its dashboard steps are ordinary quirks). The badge belongs to Antigravity Proxy's OAuth flow only.
- `Documentation` opens the `HeavyProviderDocs` mirror: `FreeLLMAPI · Documentation` with the protocol tag and route slug, `Authentication` (`Unified key — one gateway key authenticates every upstream.`), `Detected instance vs local install` (reuse/local labels, `Dependencies`/`Footprint` lines, health URL, `Nothing new is installed on this device — zero added disk, RAM, and GPU.`), the `Install platform` selector (`Linux` selected; macOS/Windows swap the local label, dependency line and install steps from the manifest's platform table), the resolved steps with their commands, then quirks, `What gets installed`, `What gets removed` and `Removal will do all of this:`.
- Heavy `Create provider` only simulates: it toasts `Demo only — nothing was installed.` FreeLLMAPI is the worked example; clicking Antigravity Proxy or Command Code answers with a toast naming the real behavior instead of opening a second manifest.
- Fineprint: `Same flow as Settings → Models — nothing is stored in this demo.`
- Wiring: `AddProviderModal` / `HeavyProviderForm` / `HeavyProviderDocs` in `packages/client/ui-settings-models`; mainstream ids and fields from `provider-presets.ts` (kilo route: protocol `openai-completions`, base URL `https://api.kilo.ai/api/gateway`, env `KILO_API_KEY`, keyless via `KEYLESS_PRESET_IDS`); heavy rows from `heavy-providers.ts` (the host's `enpoiHeavy.manifests` reply is authoritative once connected). Real add path: `credentials.set(deriveKeyRef(id), key)` → `settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', id], value }])` → `llm.discoverModels` → a second mutate with the discovered models; heavy add goes through `enpoiHeavy.reuse` (probe, `pendingRestart` possible) or `enpoiHeavy.install` (polled job). Default session route row `agent-default-model` → `kilo/kilo-auto/free`.

### Step 4 — Intelligence

- Eyebrow: `Step 4 · Intelligence`; heading: `Background helpers — on by default`.
- Lead: `Compaction, the Context Keeper and the Whiteboard all land enabled. With free models there is no cost — each one is a single click from off.`
- Banner (explicit about the model calls): `⚠ Compaction is LLM-based — a model writes the replacement summary. A mechanical fallback is always on and makes no model call: it runs when the LLM one is unavailable. The Context Keeper and the summariser seat also use an LLM. When enabled they use the Kilo free gateway (free), not your main session model.`
- Toggle `Compaction` (lands On, detail visible): sub `On by default. Shortens a session before it outgrows the model's window.`; detail `LLM summary — a model writes the replacement summary. Mechanical fallback — always on, no model call: drops tool-result middles and leaves a stub naming how to recover them; it takes over when the LLM summary is unavailable.` Segmented choice, default `LLM summary`; chip `Uses an LLM · route: Kilo free gateway (free) · not your main session model`; `Mechanical only` swaps it for `No model call · the always-on mechanical fallback runs`.
- Toggle `Context Keeper` (lands On): sub `On by default. Keeps a short State checkpoint of decisions and open threads, refreshed in the background.`; detail `A restarted session still knows where it was. Without it, sessions simply start from their stored history.`; chip `Uses an LLM · route: Kilo free gateway (free) · not your main session model`.
- Toggle `Whiteboard` (lands On): sub `On by default. A small pinned scratchpad (paths, rules, facts, tasks) re-injected each turn.`; detail `Writes happen inside a normal turn — it stores what you or the agent pin. No separate background model call.`; chip `No extra model call`.
- Fineprint: `Everything here is one click off. Nothing in this step is required for the harness to work.` Primary button `Continue →`; it becomes `Continue with them off →` only when all three are off. Clicking any switch marks the step done; the state resets to all-on with `R`.
- Wiring: all three ship on (doc 10). Compaction is upstream with `parameters.compaction` (mode + effective-policy readout) and the designated summariser seat `personas.compaction`; keeper `dsh-enpoi-context-keeper` + capability `capabilities.tools.keeper`; whiteboard the `enpoi-whiteboard` board (`enpoi-orchestration.whiteboard`) + its tools. The demo's chips name the Kilo free gateway as the LLM route for the keeper and the summariser, so enabling them carries no cost; real assignments live in Agent Models / Settings → Orchestration.

### Step 5 — The tour

- Eyebrow: `Step 5 · The tour`; heading: `A quick look around`; lead: `Five stops over the interface behind this panel — sidebar, settings, skills & MCP, the composer switches, and the Context Dashboard.` Fineprint: `Placeholder chrome only: no real app is loaded behind this demo.`
- Actions: `← Back`, `Skip the tour` (marks the step skipped), `Start the tour →`.
- Stops (target in the placeholder chrome → real surface): sidebar → sidebar panel rows/workspace browser; Settings row → Settings sections (Models, Orchestration, Permissions, Dynamic); Plugins row → Plugins + Settings → Dynamic (Skills/MCPs); composer → composer seats (agent preset, access mode, model picker, plan); Context Dashboard row → dsh-context sidebar entry.
- Stop copy: `Sessions` / `Start here. New session at the top; every past session stays as a row below it.` — `Settings` / `Models, Orchestration, Permissions, Dynamic — the switches all live behind this row.` — `Plugins, skills & MCP` / `Skills and MCP servers are added here and under Settings → Dynamic.` — `The composer switches` / `Agent preset, access mode, model picker and plan — the four controls you will touch most.` — `Context Dashboard` / `How much of the model's window your sessions are using. Open it any time from here.`
- Tip card shows `Stop n of 5`, title, body, `← Back`, `Skip the tour`, `Next stop →` (last stop: `Finish the tour`), and the top bar reads `Step 5 of 7 · tour stop n/5`. Finishing or skipping returns the wizard at step 6.
- Wiring: none — the tour is presentational; each stop names the real surface it will point at when the real app is behind it.

### Step 6 — Agents

- Eyebrow: `Step 6 · Agents`; heading: `Three helpers, one picker`; lead: `Agent presets are chosen in the composer. Each has a different job:`.
- Cards: `Orchestrator` / `Plans, implements and delegates. The default.` — `Sysadmin` / `Runs the machine: services, packages, disks, logs.` — `Creator` / `Repairs and extends the harness itself. Ask it when the app misbehaves.`
- Offer card `Analyse this system now?`: `A read-only scan — hardware, OS, services — that runs in the background while you finish this tour. The result becomes context your agents can see. Skip it and agents start from a default system context.` Buttons `Analyse in the background` (primary) and `Skip — use the default context`.
- Choosing analyse hides the buttons, shows `Running in the background — keep going, you do not need to wait.`, and opens the dock: `System analysis · running`, one line per stage (hardware → OS/kernel → services → writing context), then `✓ System context ready · 28 threads · 62 GiB RAM · 4 services` tagged `sample data in this demo`. The dock stays visible across step 7 and toasts on completion if the user has moved on.
- Skipping marks step 6 skipped and notes `Using the default system context. Ask Sysadmin to analyse the machine later.`
- Wiring: preset ids `orchestrator` / `sysadmin` / `creator` (shipped fork presets, doc 07) and the composer agent seat `conversation.input.agent`. The real analysis is a read-only sysadmin job over hardware/OS/services; the sample numbers in the demo match this host only as illustration.

### Step 7 — Done

- Eyebrow: `Step 7 · Done`; heading: `That's the setup`; lead adapts: with no skips `Nothing here was required — and nothing was skipped. The harness is ready as configured.`; with skips `Skipped steps keep their defaults. The harness works either way — nothing below is required.`
- Skipped card: `You skipped N step(s) — defaults apply` with one line per skipped step: step 2 `Sandbox stays at workspace-write.`; step 3 `Kilo Gateway stays the default route (keyless, free).`; step 4 `Compaction, Keeper and Whiteboard stay off; sessions just use context normally.`; step 5 `The interface tour was skipped; reopen it from this demo or the Help surface later.`; step 6 `Agents start from a default system context; ask Sysadmin to analyse the machine later.`
- Creator card: `Where the Creator lives` / `Composer → the agent-preset picker → Creator. It is the agent that repairs and extends this harness — ask it anything about the setup.`
- Next list: `Start a session — type in the composer.` / `Add providers — Settings → Models.` / `Ask the Creator about anything you skipped.`
- `Finish` closes the wizard (mode `done`) and shows the closing toast: `Demo complete. In the real app this is where the harness opens — sidebar on the left, composer at the bottom.` with `Replay` (= Reset).
- Wiring: none; the closing copy is the product's entry point, not another surface.

## Skip semantics

Every step is skippable (`Skip step` button, `Esc`, or `Skip the tour` on step 1 / `Skip the tour` on step 5), and the demo shows the resulting defaults on step 7. A step counts as done when its action happened (a provider was created in the mirror, a toggle was clicked, a sandbox mode was chosen, analysis started, tour finished); leaving a step with no action counts as skipped. Steps 3 and 4 land configured (Kilo pre-selected, helpers on), so skipping them keeps those defaults rather than an empty state. A completed step is never downgraded to skipped by a later skip.

## Animation specs

- Step entry: `step-in` 340 ms `cubic-bezier(.22,.61,.36,1)`, opacity 0→1 + `translateY(7px)`→0, fill `both`, stagger 30/60/90/110/130 ms on the first children. Toggle details and bubbles reuse it at 250–300 ms.
- Spotlight: hole and tip move with 450 ms `cubic-bezier(.22,.61,.36,1)` on left/top/width/height; the first positioning on tour entry is instant (`no-anim` class removed on the next frame). Hole = target rect + 8 px padding, `border-radius: 14px`, `box-shadow: 0 0 0 9999px rgba(4,10,19,.66)`; ring border in `--dsw-alias-brand-primary` pulses 2.4 s ease-in-out (opacity .55↔1, scale 1↔1.012).
- Backdrop: slow drift 90 s ease-in-out alternate (scale 1→1.035, translate −0.8%/−0.6%).
- Controls: switch knob 220 ms, toggle cards 200 ms, buttons 150 ms (skin's shared transition), spinner 800 ms linear, provider create/discovery ≈1.15 s, health re-check 700 ms, platform switch instant, analysis stages at 650 ms + 700 ms each + 900 ms finalize, toast 2.6 s.
- Reduced motion (`prefers-reduced-motion: reduce`): `animation: none` and `transition: none` on everything, backdrop and ring static, spinner keeps a slow 1.6 s rotation. The evidence renders use `--force-prefers-reduced-motion`, so the screenshots double as the reduced-motion check.

## Keyboard

- `←` / `→` (or PageUp/PageDown): previous/next step; inside the tour, previous/next stop.
- `1`–`7`: jump to a step (leaving the tour first).
- `Esc`: skip the current step; inside the help overlay it closes it; inside the tour it leaves the tour.
- `R`: reset; `?`: toggle the keyboard help overlay.
- Step headings take focus on navigation so the reading position follows; the tour tip heading takes focus on entry (without an outline ring).

## Evidence renders

Command (one render per state; `#step=…` deep links drive the state, no clicks needed):

```sh
SHELL_BIN=~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
"$SHELL_BIN" --headless --disable-gpu --no-sandbox --hide-scrollbars --force-prefers-reduced-motion \
  --window-size=1440,900 --virtual-time-budget=6000 --screenshot=<out.png> \
  "file:///home/adam/deepseek-harness/apps/web/public/welcome-demo.html#<hash>"
```

Screenshots in `~/dsh-migration/evidence/welcome-demo/`: `step-1-welcome.png`, `step-2-security.png`, `step-3-provider-kilo.png` (the catalogue with Kilo pre-selected and the heavy group badged), `step-3b-discovery-test.png` (`#step=3&run=1`: the Kilo form after create — models discovered and test succeeded), `step-3c-heavy-detection.png` (`#step=3&view=heavy`: FreeLLMAPI detection offer, modes and dependency line), `step-3d-heavy-docs.png` (`#step=3&view=docs`: the docs view with the platform selector and install steps), `step-4-intelligence-enabled.png` (all helpers on, the default landing state), `step-4b-intelligence-off.png` (`#step=4&off=whiteboard`: one component switched off), `step-5-tour-spotlight-settings.png`, `step-5-tour-spotlight-composer.png`, `step-6-agents-offer.png`, `step-6-agents-analysis-running.png`, `step-7-done.png`. The step-3/4 renders use the deep links above; every render uses `--force-prefers-reduced-motion`, so they double as the reduced-motion check.

## Not wired (deliberately)

No settings read or write, no provider added, no discovery run, no test call sent, no heavy install run, no analysis run, no session created, no navigation into the real app. The demo's provider catalogue and forms, `Create provider`, `Check now`, install-platform selector, module toggles, sandbox radios, analyse offer and finish action are local simulations, each labelled as such where it could be mistaken for a real action.
