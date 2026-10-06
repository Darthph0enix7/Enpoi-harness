var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __knownSymbol = (name2, symbol) => (symbol = Symbol[name2]) ? symbol : Symbol.for("Symbol." + name2);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __decoratorStart = (base) => [, , , __create(base?.[__knownSymbol("metadata")] ?? null)];
var __decoratorStrings = ["class", "method", "getter", "setter", "accessor", "field", "value", "get", "set"];
var __expectFn = (fn) => fn !== void 0 && typeof fn !== "function" ? __typeError("Function expected") : fn;
var __decoratorContext = (kind, name2, done, metadata, fns) => ({ kind: __decoratorStrings[kind], name: name2, metadata, addInitializer: (fn) => done._ ? __typeError("Already initialized") : fns.push(__expectFn(fn || null)) });
var __decoratorMetadata = (array, target) => __defNormalProp(target, __knownSymbol("metadata"), array[3]);
var __runInitializers = (array, flags, self, value) => {
  for (var i = 0, fns = array[flags >> 1], n = fns && fns.length; i < n; i++) flags & 1 ? fns[i].call(self) : value = fns[i].call(self, value);
  return value;
};
var __decorateElement = (array, flags, name2, decorators, target, extra) => {
  var fn, it, done, ctx, access, k = flags & 7, s = !!(flags & 8), p = !!(flags & 16);
  var j = k > 3 ? array.length + 1 : k ? s ? 1 : 2 : 0, key = __decoratorStrings[k + 5];
  var initializers = k > 3 && (array[j - 1] = []), extraInitializers = array[j] || (array[j] = []);
  var desc = k && (!p && !s && (target = target.prototype), k < 5 && (k > 3 || !p) && __getOwnPropDesc(k < 4 ? target : { get [name2]() {
    return __privateGet(this, extra);
  }, set [name2](x) {
    return __privateSet(this, extra, x);
  } }, name2));
  k ? p && k < 4 && __name(extra, (k > 2 ? "set " : k > 1 ? "get " : "") + name2) : __name(target, name2);
  for (var i = decorators.length - 1; i >= 0; i--) {
    ctx = __decoratorContext(k, name2, done = {}, array[3], extraInitializers);
    if (k) {
      ctx.static = s, ctx.private = p, access = ctx.access = { has: p ? (x) => __privateIn(target, x) : (x) => name2 in x };
      if (k ^ 3) access.get = p ? (x) => (k ^ 1 ? __privateGet : __privateMethod)(x, target, k ^ 4 ? extra : desc.get) : (x) => x[name2];
      if (k > 2) access.set = p ? (x, y) => __privateSet(x, target, y, k ^ 4 ? extra : desc.set) : (x, y) => x[name2] = y;
    }
    it = (0, decorators[i])(k ? k < 4 ? p ? extra : desc[key] : k > 4 ? void 0 : { get: desc.get, set: desc.set } : target, ctx), done._ = 1;
    if (k ^ 4 || it === void 0) __expectFn(it) && (k > 4 ? initializers.unshift(it) : k ? p ? extra = it : desc[key] = it : target = it);
    else if (typeof it !== "object" || it === null) __typeError("Object expected");
    else __expectFn(fn = it.get) && (desc.get = fn), __expectFn(fn = it.set) && (desc.set = fn), __expectFn(fn = it.init) && initializers.unshift(fn);
  }
  return k || __decoratorMetadata(array, target), desc && __defProp(target, name2, desc), p ? k ^ 4 ? extra : desc : target;
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateIn = (member, obj) => Object(obj) !== obj ? __typeError('Cannot use the "in" operator on this value') : member.has(obj);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

// src/index.ts
import { homedir } from "node:os";
import { join as join3 } from "node:path";

// src/jobs.ts
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var LOG_CAP_BYTES = 8192;
var HeavyJobManager = class {
  jobs = /* @__PURE__ */ new Map();
  running = /* @__PURE__ */ new Set();
  dir;
  run;
  now;
  /**
   * @param options - cache directory, step runner, and a clock seam for tests.
   */
  constructor(options) {
    this.dir = options.dir;
    this.run = options.run;
    this.now = options.now ?? Date.now;
    this.recoverInterrupted();
  }
  /**
   * A job persisted as `running` belongs to a previous process: the runner
   * died with it, so the file is rewritten as failed instead of leaving the
   * UI polling a job nothing will ever finish.
   */
  recoverInterrupted() {
    try {
      readdirSync(this.dir).filter((name2) => name2.endsWith(".json")).forEach((name2) => {
        const path = join(this.dir, name2);
        try {
          const view = JSON.parse(readFileSync(path, "utf8"));
          if (view?.state === "running") {
            view.state = "failed";
            view.error = "interrupted by harness restart";
            view.finishedAt = this.now();
            this.persist(view);
          }
        } catch {
        }
      });
    } catch {
    }
  }
  /**
   * Start a job unless one is already running for that id. The returned view
   * is the initial snapshot; `finalize` runs only after all required steps
   * succeed, and its failure marks the job failed.
   * @param id - provider id (the job file name).
   * @param kind - install or teardown.
   * @param steps - declared steps in order.
   * @param finalize - success action (route write); absent means none.
   * @returns the initial job snapshot.
   */
  start(id, kind, steps, finalize) {
    if (this.running.has(id)) return this.snapshot(id) ?? failed(id, "job already running");
    const total = steps.reduce((sum, step) => sum + (step.weight ?? 1), 0);
    const view = {
      id,
      kind,
      state: "running",
      stage: steps[0]?.label ?? "Finishing",
      stageIndex: 0,
      stageCount: steps.length,
      pct: 0,
      logTail: "",
      startedAt: this.now()
    };
    this.jobs.set(id, view);
    this.running.add(id);
    this.persist(view);
    void this.runAll(view, steps, total, finalize);
    return { ...view };
  }
  /** The latest snapshot: in-memory first, then the persisted file (survives a restart). */
  snapshot(id) {
    const memory = this.jobs.get(id);
    if (memory !== void 0) return { ...memory };
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8"));
      return raw !== null && typeof raw === "object" ? raw : void 0;
    } catch {
      return void 0;
    }
  }
  appendLog(view, chunk) {
    view.logTail = `${view.logTail}${chunk}`.slice(-LOG_CAP_BYTES);
  }
  persist(view) {
    try {
      mkdirSync(this.dir, { recursive: true });
      const path = join(this.dir, `${view.id}.json`);
      const temporary = `${path}.tmp-${String(process.pid)}`;
      writeFileSync(temporary, JSON.stringify(view), "utf8");
      renameSync(temporary, path);
    } catch {
    }
  }
  async runAll(view, steps, total, finalize) {
    let done = 0;
    for (const [index, step] of steps.entries()) {
      view.stage = step.label;
      view.stageIndex = index;
      this.persist(view);
      let outcome;
      try {
        outcome = await this.run(step);
      } catch (error) {
        if (step.optional === true) {
          this.appendLog(view, `$ ${step.label}: optional step failed \u2014 ${error instanceof Error ? error.message : String(error)}
`);
          done += step.weight ?? 1;
          view.pct = Math.min(99, Math.round(done / total * 99));
          continue;
        }
        this.fail(view, `${step.label}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      this.appendLog(view, `$ ${step.label}
${outcome.output}
`);
      if (outcome.exitCode !== 0) {
        if (step.optional === true) {
          this.appendLog(view, `$ ${step.label}: optional step exited ${String(outcome.exitCode)}
`);
        } else {
          this.fail(view, `${step.label}: exit ${String(outcome.exitCode)}`);
          return;
        }
      }
      done += step.weight ?? 1;
      view.pct = Math.min(99, Math.round(done / total * 99));
      this.persist(view);
    }
    view.stage = "Finishing";
    this.persist(view);
    try {
      await finalize?.();
    } catch (error) {
      this.fail(view, error instanceof Error ? error.message : String(error));
      return;
    }
    view.state = "succeeded";
    view.pct = 100;
    view.finishedAt = this.now();
    this.running.delete(view.id);
    this.persist(view);
  }
  fail(view, error) {
    view.state = "failed";
    view.error = error;
    view.finishedAt = this.now();
    this.running.delete(view.id);
    this.persist(view);
  }
};
function failed(id, error) {
  return {
    id,
    kind: "install",
    state: "failed",
    stage: "rejected",
    stageIndex: 0,
    stageCount: 0,
    pct: 0,
    logTail: "",
    startedAt: 0,
    finishedAt: 0,
    error
  };
}

// src/manifests.ts
function resolveHeavyInstall(local, platform) {
  const variant = platform === "linux" || platform === "darwin" || platform === "win32" ? local.install[platform] ?? local.install.default : local.install.default;
  return {
    label: variant.label ?? local.label,
    deps: variant.deps ?? local.deps,
    diskHint: variant.diskHint ?? local.diskHint,
    steps: variant.steps
  };
}
var LLM_PI_AI_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"];
var RUNTIME_TOOL_RE = {
  docker: /\bdocker(?:-compose|\s+compose)?\b/,
  podman: /\bpodman\b/,
  node: /\b(?:node|npm|npx|pnpm|yarn)\b/
};
var HEAVY_MANIFESTS = [
  {
    id: "freellmapi",
    label: "FreeLLMAPI",
    summary: "Self-hosted free-tier gateway: ~30 providers behind one OpenAI-compatible endpoint.",
    protocol: "openai-completions",
    auth: { kind: "unified", apiKeyEnv: "FREELLMAPI_API_KEY", keyless: false },
    dashboardUrl: "http://127.0.0.1:3002",
    docsUrl: "https://freellmapi.co",
    defaultPort: 3002,
    // Browser badges belong only to account flows that cannot complete without
    // a browser (antigravity's Google OAuth); FreeLLMAPI's dashboard steps are
    // ordinary quirks, not an operator-blocking browser requirement.
    requiresBrowser: [],
    quirks: [
      "Local install dependencies: native installers for Linux/macOS/Windows; Docker required only for the fallback path",
      "First-run setup code and password-reset code appear only in `docker compose logs`; upstream provider keys are added on the web dashboard",
      "Unified key is the only client auth \u2014 never expose this port beyond the local machine",
      "Losing ENCRYPTION_KEY (in ~/freellmapi/.env) makes every stored upstream key unrecoverable",
      "The free-tier catalog is a monthly snapshot; /v1/models can list models no key serves",
      "A missing bind-mounted JSON file is created as a directory by Docker \u2192 boot loop"
    ],
    reuse: {
      label: "Use a detected instance",
      baseURL: "http://127.0.0.1:3002/v1",
      note: "Zero install: uses a FreeLLMAPI instance already running on this device.",
      health: { url: "http://127.0.0.1:3002/api/ping", timeoutMs: 5e3 }
    },
    local: {
      label: "Install locally (Docker)",
      baseURL: "http://127.0.0.1:3002/v1",
      deps: ["Docker Engine + Compose"],
      diskHint: "~700 MB disk (536 MB image), ~84 MB RAM idle, no GPU",
      dashboardUrl: "http://127.0.0.1:3002",
      runtime: "docker",
      install: {
        // Unknown platforms fall back to the manual Docker Compose path.
        default: {
          steps: [
            { label: "Clone FreeLLMAPI", command: "git clone --depth 1 https://github.com/tashfeenahmed/freellmapi {home}/freellmapi", weight: 2 },
            {
              label: "Generate ENCRYPTION_KEY",
              // PORT is the HOST port (compose maps ${PORT}:3001); keep it at
              // 3002 so the local route's baseURL resolves.
              command: 'test -f {home}/freellmapi/.env || printf "ENCRYPTION_KEY=%s\\nPORT=3002\\nHOST_BIND=127.0.0.1\\n" "$(openssl rand -hex 32)" > {home}/freellmapi/.env'
            },
            { label: "Start the stack", command: "docker compose up -d", cwd: "{home}/freellmapi" },
            {
              label: "Wait for the gateway",
              command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1'
            }
          ]
        },
        // The vendor one-liner is the documented Linux/macOS server install;
        // PORT=3002 keeps the route baseURL valid.
        linux: {
          label: "Install locally (vendor one-liner, Docker)",
          steps: [
            {
              label: "Run the FreeLLMAPI one-liner",
              command: "curl -fsSL https://freellmapi.co/install.sh | PORT=3002 HOST_BIND=127.0.0.1 bash",
              weight: 3
            },
            {
              label: "Wait for the gateway",
              command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1'
            }
          ]
        },
        // macOS prefers the vendor desktop app: no Docker Desktop overhead.
        darwin: {
          label: "Install locally (vendor desktop app, no Docker)",
          deps: ["macOS 11+"],
          diskHint: "~250 MB app; data in ~/Library/Application Support/FreeLLMAPI",
          runtime: "vendor-app",
          steps: [
            {
              label: "Download the latest .dmg",
              command: `mkdir -p {home}/Downloads && curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE '"browser_download_url": *"[^"]+\\.dmg"' | head -1 | cut -d'"' -f4 | xargs -I{} curl -fsSL -o {home}/Downloads/FreeLLMAPI.dmg {}`,
              weight: 2
            },
            {
              label: "Install the app from the disk image",
              command: "hdiutil attach {home}/Downloads/FreeLLMAPI.dmg -nobrowse -quiet -mountpoint /tmp/freellmapi-dmg && cp -R /tmp/freellmapi-dmg/*.app /Applications/ && hdiutil detach /tmp/freellmapi-dmg -quiet"
            },
            {
              label: "Pin the desktop app to port 3002",
              command: `mkdir -p {home}/Library/Application\\ Support/FreeLLMAPI && printf '{"port":3002}\\n' > {home}/Library/Application\\ Support/FreeLLMAPI/config.json`
            },
            { label: "Launch FreeLLMAPI", command: "open -a FreeLLMAPI" },
            {
              label: "Wait for the gateway",
              command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1'
            }
          ]
        },
        // Windows only ships a desktop app (no Docker path in the vendor docs).
        win32: {
          label: "Install locally (vendor desktop app, no Docker)",
          deps: ["Windows 10+"],
          diskHint: "~250 MB app; data in %APPDATA%\\FreeLLMAPI",
          runtime: "vendor-app",
          steps: [
            {
              label: "Download the latest installer",
              command: `mkdir -p {home}/Downloads && curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE '"browser_download_url": *"[^"]+\\.exe"' | head -1 | cut -d'"' -f4 | xargs -I{} curl -fsSL -o {home}/Downloads/FreeLLMAPI-Setup.exe {}`,
              weight: 2
            },
            { label: "Install silently", command: 'cmd //c start //wait "" "$HOME/Downloads/FreeLLMAPI-Setup.exe" /S' },
            {
              label: "Pin the desktop app to port 3002",
              command: `mkdir -p "$APPDATA/FreeLLMAPI" && printf '{"port":3002}\\n' > "$APPDATA/FreeLLMAPI/config.json"`
            },
            { label: "Launch FreeLLMAPI", command: 'cmd //c start "" "$LOCALAPPDATA\\Programs\\FreeLLMAPI\\FreeLLMAPI.exe"' },
            {
              label: "Wait for the gateway",
              command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1'
            }
          ]
        }
      },
      health: { url: "http://127.0.0.1:3002/api/ping", timeoutMs: 5e3 }
    },
    removal: {
      steps: [
        { label: "Stop the stack and drop its volume", command: "docker compose down -v", cwd: "{home}/freellmapi", optional: true },
        { label: "Remove the container image", command: "docker image rm ghcr.io/tashfeenahmed/freellmapi:latest", optional: true },
        { label: "Remove the clone directory", command: "rm -rf {home}/freellmapi" }
      ],
      warnings: [
        "`docker compose down -v` deletes volume freellmapi_freellmapi-data \u2014 every upstream key and the unified key die with it",
        "~/freellmapi/.env holds ENCRYPTION_KEY; back it up if the volume data is kept anywhere"
      ]
    },
    fallbackModel: "auto"
  },
  {
    id: "antigravity",
    label: "Antigravity Proxy",
    summary: "Multi-account Anthropic-compatible proxy for Google Antigravity OAuth accounts.",
    protocol: "anthropic-messages",
    // The proxy itself needs no client key, but llm-pi-ai refuses
    // keyless anthropic routes: a placeholder reference is stored, and the
    // route MUST NOT declare a DSH pool — the proxy runs its own sticky one.
    auth: { kind: "placeholder", apiKeyEnv: "ANTIGRAVITY_API_KEY", keyless: false },
    dashboardUrl: "http://127.0.0.1:8082",
    docsUrl: "https://www.npmjs.com/package/antigravity-claude-proxy",
    defaultPort: 8082,
    requiresBrowser: [
      "Adding a Google account is an OAuth flow that opens a browser and waits on a localhost callback \u2014 on a headless host the printed URL must be opened from a machine that can reach the callback (e.g. over an SSH port-forward); it cannot be automated"
    ],
    quirks: [
      "Local install dependencies: native npm package for Linux/macOS/Windows (Node.js >= 18); Docker is never required",
      "The proxy runs its own sticky account pool with cooldowns \u2014 DSH key pooling MUST stay off for this route",
      "The console at :8082 has no auth (webuiPassword empty) \u2014 trusted networks only",
      'Quotas are per-account/per-model weekly windows; "RESOURCE_EXHAUSTED \u2026 resets after 46h" is normal',
      "Other tools on this device may consume the same proxy \u2014 removing the service breaks them too"
    ],
    reuse: {
      label: "Use a detected instance",
      baseURL: "http://127.0.0.1:8082",
      note: "Zero install: uses the proxy instance already running on this device and its configured account pool.",
      health: { url: "http://127.0.0.1:8082/health", timeoutMs: 5e3 }
    },
    local: {
      label: "Install locally (npm + systemd user unit)",
      baseURL: "http://127.0.0.1:8082",
      deps: ["Node.js >= 18"],
      diskHint: "~23 MB install, ~78\u2013150 MB RAM, no GPU",
      dashboardUrl: "http://127.0.0.1:8082",
      runtime: "node",
      install: {
        default: {
          steps: [
            { label: "Install the proxy package", command: "npm install -g antigravity-claude-proxy", weight: 2 },
            {
              label: "Write the systemd user unit",
              command: "mkdir -p {config}/systemd/user && cat > {config}/systemd/user/antigravity-proxy.service <<'EOF'\n[Unit]\nDescription=Antigravity Claude proxy (per-device)\nAfter=network-online.target\n\n[Service]\nEnvironment=PORT=8082\nEnvironment=HOST=127.0.0.1\nExecStart=/bin/bash -lc 'exec antigravity-claude-proxy'\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\nEOF"
            },
            { label: "Enable and start the unit", command: "systemctl --user daemon-reload && systemctl --user enable --now antigravity-proxy.service" },
            {
              label: "Wait for the proxy",
              command: 'for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8082/health >/dev/null && exit 0; sleep 2; done; echo "proxy did not answer within 60s"; exit 1'
            }
          ]
        }
      },
      health: { url: "http://127.0.0.1:8082/health", timeoutMs: 5e3 }
    },
    removal: {
      steps: [
        { label: "Stop and disable the unit", command: "systemctl --user disable --now antigravity-proxy.service", optional: true },
        { label: "Remove the unit file", command: "rm -f {config}/systemd/user/antigravity-proxy.service && systemctl --user daemon-reload", optional: true },
        { label: "Uninstall the package", command: "npm uninstall -g antigravity-claude-proxy", optional: true },
        { label: "Remove the config directory (OAuth tokens, presets, usage history)", command: "rm -rf {config}/antigravity-proxy" }
      ],
      warnings: [
        "Any other tool configured against the same proxy stops working when the service is removed",
        "If a dotfiles/config repository manages the systemd unit, remove it there too or the next sync resurrects it",
        "Deleting ~/.config/antigravity-proxy destroys every Google OAuth token and the usage history",
        "DSH route, credential, pool state, discovered cache, and chain links are removed separately by this teardown"
      ]
    },
    fallbackModel: "gemini-2.5-flash"
  },
  {
    id: "commandcode",
    label: "Command Code (keypool)",
    summary: "Command Code's CLI-shaped API behind the shared multi-key keypool proxy, served by the DSH provider package.",
    protocol: "commandcode/alpha-generate",
    // The keypool owns the real keys and replaces the Authorization header per
    // request, so the DSH route is keyless; COMMANDCODE_API_KEY remains the
    // reference a direct (non-keypool) route would name.
    auth: { kind: "none", apiKeyEnv: "COMMANDCODE_API_KEY", keyless: true },
    dashboardUrl: "http://127.0.0.1:8899/status",
    docsUrl: "https://commandcode.ai",
    defaultPort: 8899,
    // Served by `dsh-enpoi-commandcode-provider` (ctx.llm.registerAdapter), not
    // llm-pi-ai: the CLI-shaped protocol has no llm-pi-ai entry, so the route
    // profile must never be written into the llm-pi-ai schema.
    settingsNs: "commandcode-provider",
    // Browser badges belong only to account flows that cannot complete without
    // a browser (antigravity's Google OAuth); the vendor dashboard is an
    // ordinary quirk here, not an operator-blocking browser requirement.
    requiresBrowser: [],
    quirks: [
      "Local install dependencies: native provider package + keypool for Linux/macOS/Windows (Node.js 22); Docker is never required",
      "The vendor account and quota dashboard live at commandcode.ai (browser)",
      'The vendor endpoint rejects generic HTTP clients ("Proxy use detected") \u2014 traffic must go through the keypool with CLI headers',
      "DSH speaks this protocol through the dsh-enpoi-commandcode-provider adapter; llm-pi-ai cannot declare it",
      "The keypool may be shared with other tools \u2014 never stop or remove the shared keypool service when removing this provider",
      "The local dashboards are keypool :8899/keys and /status; there is no provider-owned UI",
      "The keypool sanitizer (older-image stripping, embedded-base64 scrub, 200k text cap) is the only sanitizer \u2014 clients must not duplicate it",
      'Quota is per key and real: the keypool rotates on exhaustion, and a QUOTA failure ("weekly usage limit" / "insufficient credits") appears only when every pooled key is spent \u2014 a normal state, not a routing defect'
    ],
    reuse: {
      label: "Use a detected instance",
      baseURL: "http://127.0.0.1:8899/commandcode",
      note: "Uses the keypool already running on this device; the provider package speaks the CLI protocol and fetches the 83-model catalog from /commandcode/catalog.json.",
      health: { url: "http://127.0.0.1:8899/healthz", timeoutMs: 5e3 }
    },
    local: {
      label: "Install locally (provider package + keypool)",
      baseURL: "http://127.0.0.1:8899/commandcode",
      deps: ["Node.js 22", "systemd user units"],
      diskHint: "~5 MB provider package, ~150 MB RAM for the keypool, no GPU",
      dashboardUrl: "http://127.0.0.1:8899/status",
      runtime: "node",
      install: {
        default: {
          steps: [
            { label: "Build and link the DSH provider package", command: 'node "{dshHome}/profiles/web/packages/enpoi-commandcode-provider/scripts/install.mjs" "{dshHome}/profiles/web"', weight: 3 },
            { label: "Seed the commandcode pool in pools.json", command: 'node "{dshHome}/profiles/web/packages/enpoi-commandcode-provider/scripts/keypool-seed.mjs"' },
            {
              label: "Deploy the keypool proxy from dotfiles (optional)",
              // A dotfiles checkout is not required: the step looks in the
              // DSH-home and home dotfiles layouts, and skips with guidance
              // instead of failing the install when neither exists.
              optional: true,
              command: 'src=""; for candidate in "{dshHome}/dotfiles/opencode-dotfiles/keypool/proxy.js" "{home}/dotfiles/opencode-dotfiles/keypool/proxy.js"; do if test -f "$candidate"; then src="$candidate"; break; fi; done; if test -z "$src"; then echo "keypool proxy.js not found (searched the dotfiles layouts under DSH_HOME and HOME) \u2014 skipping; place proxy.js at {config}/opencode/keypool/proxy.js or install opencode-dotfiles, then re-run this step"; exit 0; fi; install -Dm644 "$src" {config}/opencode/keypool/proxy.js'
            },
            {
              label: "Write the keypool systemd user unit",
              command: "mkdir -p {config}/systemd/user && cat > {config}/systemd/user/keypool.service <<'EOF'\n[Unit]\nDescription=OpenCode KeyPool \u2014 multi-key rotation proxy\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=/bin/bash -lc 'exec node %h/.config/opencode/keypool/proxy.js'\nRestart=on-failure\nRestartSec=10s\nEnvironment=KEYPOOL_PORT=8899\nEnvironment=KEYPOOL_HOST=127.0.0.1\nEnvironment=HOME=%h\n\n[Install]\nWantedBy=default.target\nEOF"
            },
            { label: "Enable and start the keypool", command: "systemctl --user daemon-reload && systemctl --user enable --now keypool.service", optional: true },
            {
              label: "Wait for the keypool",
              command: 'for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8899/healthz >/dev/null && exit 0; sleep 2; done; echo "keypool did not answer within 60s"; exit 1'
            }
          ]
        }
      },
      health: { url: "http://127.0.0.1:8899/healthz", timeoutMs: 5e3 }
    },
    removal: {
      steps: [
        // Drops only the commandcode pool entry; the keypool rereads pools.json
        // per request, so the shared service (and the `go` pool) is never
        // stopped, restarted, or otherwise touched.
        { label: "Drop only pools.commandcode (keypool and other pools stay)", command: 'node "{dshHome}/profiles/web/packages/enpoi-commandcode-provider/scripts/keypool-remove.mjs"', optional: true }
      ],
      warnings: [
        "Removal drops only DSH state and the commandcode pool keys \u2014 it never stops or removes the shared keypool service (other tools may need it)",
        "usage.jsonl is keypool-wide and is not touched",
        "The provider package and its profile entry stay installed; delete the entry only when no route declares it"
      ]
    },
    fallbackModel: "deepseek/deepseek-v4.1-flash"
  }
];
function manifestById(id) {
  return HEAVY_MANIFESTS.find((manifest) => manifest.id === id);
}
function manifestProblems(manifests = HEAVY_MANIFESTS) {
  const problems = [];
  const seen = /* @__PURE__ */ new Set();
  for (const manifest of manifests) {
    const where = `manifest "${manifest.id}"`;
    if (manifest.id === "") problems.push(`${where}: id is empty`);
    if (seen.has(manifest.id)) problems.push(`${where}: duplicate id`);
    seen.add(manifest.id);
    for (const [field, value] of [["label", manifest.label], ["summary", manifest.summary], ["protocol", manifest.protocol]]) {
      if (typeof value !== "string" || value.trim() === "") problems.push(`${where}: ${field} is empty`);
    }
    if (!Number.isInteger(manifest.defaultPort) || manifest.defaultPort < 1 || manifest.defaultPort > 65535) {
      problems.push(`${where}: defaultPort must be a TCP port`);
    }
    if (manifest.reuse.baseURL === "" && manifest.unsupported === void 0) problems.push(`${where}: reuse.baseURL is empty`);
    if (manifest.reuse.health.url === "") problems.push(`${where}: reuse.health.url is empty`);
    const variants = [manifest.local.install.default, manifest.local.install.linux, manifest.local.install.darwin, manifest.local.install.win32];
    if (manifest.unsupported === void 0) {
      if (manifest.local.install.default.steps.length === 0) problems.push(`${where}: local.install.default is empty`);
      if (manifest.local.baseURL === "") problems.push(`${where}: local.baseURL is empty`);
      if (manifest.local.health.url === "") problems.push(`${where}: local.health.url is empty`);
    }
    for (const [index, variant] of variants.entries()) {
      if (variant === void 0) continue;
      if (variant.steps.length === 0 && manifest.unsupported === void 0) {
        problems.push(`${where}: platform install variant ${String(index)} has no steps`);
      }
      const runtime = variant.runtime ?? manifest.local.runtime;
      const declared = runtime === void 0 ? void 0 : RUNTIME_TOOL_RE[runtime];
      if (declared === void 0 || variant.steps.length === 0) continue;
      const commands = variant.steps.map((step) => step.command).join("\n");
      if (declared.test(commands)) continue;
      const conflicting = Object.keys(RUNTIME_TOOL_RE).filter((other) => other !== runtime && RUNTIME_TOOL_RE[other]?.test(commands) === true);
      if (conflicting.length > 0) {
        problems.push(`${where}: platform install variant ${String(index)} declares runtime "${String(runtime)}" but its steps invoke ${conflicting.join("/")} tooling instead`);
      }
    }
    if (manifest.settingsNs !== void 0 && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.settingsNs)) {
      problems.push(`${where}: settingsNs must be a lowercase plugin entry id`);
    }
    if (manifest.unsupported === void 0 && !LLM_PI_AI_PROTOCOLS.includes(manifest.protocol) && manifest.settingsNs === void 0) {
      problems.push(`${where}: protocol "${manifest.protocol}" is not served by llm-pi-ai and needs an explicit settingsNs`);
    }
    if (manifest.removal.warnings.length === 0) problems.push(`${where}: removal.warnings is empty`);
    if (manifest.auth.kind === "none" && manifest.protocol === "anthropic-messages") {
      problems.push(`${where}: keyless anthropic routes are refused by llm-pi-ai`);
    }
    if (manifest.auth.kind !== "none" && (manifest.auth.apiKeyEnv === void 0 || !/^[A-Z_][A-Z0-9_]*$/.test(manifest.auth.apiKeyEnv))) {
      problems.push(`${where}: apiKeyEnv must be an uppercase credential reference`);
    }
    if (manifest.auth.kind === "placeholder" && manifest.auth.keyless) {
      problems.push(`${where}: a placeholder-auth route cannot be keyless`);
    }
    for (const step of [...variants.flatMap((variant) => variant?.steps ?? []), ...manifest.removal.steps]) {
      if (step.command.trim() === "") problems.push(`${where}: a step command is empty (${step.label})`);
    }
  }
  return problems;
}

// src/planner.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, join as join2 } from "node:path";
var LLM_NS = "llm-pi-ai";
var ORCHESTRATION_NS = "enpoi-orchestration";
function substitute(value, home, dshHome) {
  return value.replaceAll("{home}", home).replaceAll("{config}", join2(home, ".config")).replaceAll("{dshHome}", dshHome ?? join2(home, ".dsh"));
}
function modeBaseURL(manifest, mode) {
  return mode === "reuse" ? manifest.reuse.baseURL : manifest.local.baseURL;
}
function urlPort(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port !== "") return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : void 0;
  } catch {
    return void 0;
  }
}
function urlPath(url) {
  try {
    const path = new URL(url).pathname;
    return path === "/" ? "" : path;
  } catch {
    return "";
  }
}
function instanceHealth(manifest, port) {
  return { ...manifest.local.health, url: `http://127.0.0.1:${port}${urlPath(manifest.local.health.url)}` };
}
function instanceBaseURL(manifest, port) {
  return `http://127.0.0.1:${port}${urlPath(manifest.reuse.baseURL)}`;
}
function healthForBase(manifest, baseURL) {
  try {
    const base = new URL(baseURL);
    const declared = new URL(manifest.reuse.health.url);
    return { ...manifest.reuse.health, url: `${base.protocol}//${base.host}${declared.pathname}` };
  } catch {
    return manifest.reuse.health;
  }
}
function instanceCandidates(manifest, configuredBaseURL) {
  const candidates = [];
  const add = (baseURL, url) => {
    if (candidates.some((candidate) => candidate.url === url)) return;
    const port = urlPort(baseURL);
    candidates.push({ url, baseURL, ...port === void 0 ? {} : { port } });
  };
  if (configuredBaseURL !== void 0 && configuredBaseURL !== "") {
    add(configuredBaseURL, healthForBase(manifest, configuredBaseURL).url);
  }
  add(manifest.reuse.baseURL, manifest.reuse.health.url);
  add(instanceBaseURL(manifest, manifest.defaultPort), instanceHealth(manifest, manifest.defaultPort).url);
  return candidates;
}
async function detectInstance(deps, manifest, configuredBaseURL) {
  let firstFailure;
  for (const candidate of instanceCandidates(manifest, configuredBaseURL)) {
    const health = await probeHealth({ ...manifest.reuse.health, url: candidate.url }, deps.fetchImpl);
    const detection = {
      ok: health.ok,
      baseURL: candidate.baseURL,
      ...candidate.port === void 0 ? {} : { port: candidate.port },
      url: candidate.url,
      health
    };
    if (health.ok) return detection;
    firstFailure ??= detection;
  }
  return firstFailure ?? {
    ok: false,
    baseURL: manifest.reuse.baseURL,
    url: manifest.reuse.health.url,
    health: { ok: false, error: "no probe candidates", checkedAt: Date.now() }
  };
}
async function detectRuntimes(runStep2) {
  try {
    const outcome = await runStep2({
      label: "Detect container runtimes",
      command: "command -v docker >/dev/null 2>&1 && echo available:docker; command -v podman >/dev/null 2>&1 && echo available:podman; exit 0"
    });
    return {
      docker: /(^|\n)available:docker(\n|$)/.test(outcome.output),
      podman: /(^|\n)available:podman(\n|$)/.test(outcome.output)
    };
  } catch {
    return { docker: false, podman: false };
  }
}
function declaredRuntime(manifest, platform) {
  const variant = platform === "linux" || platform === "darwin" || platform === "win32" ? manifest.local.install[platform] : void 0;
  return variant?.runtime ?? manifest.local.runtime ?? "node";
}
function chooseLocalPath(manifest, platform, runtime, detectedPort) {
  const resolved = resolveHeavyInstall(manifest.local, platform);
  if (detectedPort !== void 0) {
    return { path: "detected", label: "Use the detected instance", deps: [], diskHint: "", steps: [], requires: [], missing: [] };
  }
  const base = { deps: resolved.deps, diskHint: resolved.diskHint, steps: resolved.steps };
  switch (declaredRuntime(manifest, platform)) {
    case "docker":
      if (runtime.docker) return { path: "docker", label: resolved.label, ...base, requires: ["docker"], missing: [] };
      if (runtime.podman) return { path: "podman", label: resolved.label, ...base, requires: ["podman"], missing: [] };
      return { path: "unsupported", label: resolved.label, ...base, requires: ["docker"], missing: ["Docker Engine + Compose (or Podman)"] };
    case "podman":
      return runtime.podman ? { path: "podman", label: resolved.label, ...base, requires: ["podman"], missing: [] } : { path: "unsupported", label: resolved.label, ...base, requires: ["podman"], missing: ["Podman"] };
    case "vendor-app":
      return { path: "vendor-app", label: resolved.label, ...base, requires: [], missing: [] };
    case "node":
      return { path: "node", label: resolved.label, ...base, requires: [], missing: [] };
  }
}
function readServerOverlay(dshHome) {
  try {
    const document = JSON.parse(readFileSync2(join2(dshHome, "heavy-server-overlay.json"), "utf8"));
    if (document === null || typeof document !== "object" || Array.isArray(document)) return {};
    const entries = document.providers;
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return {};
    return entries;
  } catch {
    return {};
  }
}
function overlayManifest(manifest, entry) {
  if (entry === void 0) return manifest;
  return {
    ...manifest,
    ...entry.dashboardUrl === void 0 ? {} : { dashboardUrl: entry.dashboardUrl },
    reuse: {
      ...manifest.reuse,
      ...entry.reuseBaseURL === void 0 ? {} : { baseURL: entry.reuseBaseURL },
      ...entry.reuseHealthURL === void 0 ? {} : { health: { ...manifest.reuse.health, url: entry.reuseHealthURL } }
    }
  };
}
function routeProfile(manifest, mode, models, overrides = {}) {
  const list = models.length > 0 ? models.map((model) => model.name === void 0 ? { id: model.id } : { id: model.id, name: model.name }) : manifest.fallbackModel === void 0 ? [] : [{ id: manifest.fallbackModel }];
  return {
    displayName: `${manifest.label}${mode === "reuse" ? " (detected)" : " (local)"}`,
    api: manifest.protocol,
    baseURL: overrides.baseURL ?? modeBaseURL(manifest, mode),
    ...manifest.auth.apiKeyEnv === void 0 ? {} : { apiKeyEnv: manifest.auth.apiKeyEnv },
    ...manifest.auth.kind === "none" ? { keyless: true } : {},
    models: list
  };
}
async function probeHealth(probe, fetchImpl = globalThis.fetch, now = Date.now) {
  const checkedAt = now();
  try {
    const response = await fetchImpl(probe.url, { signal: AbortSignal.timeout(probe.timeoutMs ?? 5e3) });
    const accepted = probe.expectStatus ?? void 0;
    const statusOk = accepted === void 0 ? response.status >= 200 && response.status < 300 : accepted.includes(response.status);
    if (!statusOk) return { ok: false, status: response.status, error: `HTTP ${String(response.status)}`, checkedAt };
    if (probe.expectBody !== void 0 && !(await response.text()).includes(probe.expectBody)) {
      return { ok: false, status: response.status, error: `body missing "${probe.expectBody}"`, checkedAt };
    }
    return { ok: true, status: response.status, checkedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), checkedAt };
  }
}
async function discoverModels(baseURL, apiKey, fetchImpl = globalThis.fetch) {
  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const headers = { accept: "application/json" };
  if (apiKey !== void 0 && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15e3) });
    if (!response.ok) return [];
    const body = JSON.parse(await response.text());
    const rows = Array.isArray(body) ? body : body.data;
    if (!Array.isArray(rows)) return [];
    const seen = /* @__PURE__ */ new Set();
    const models = [];
    for (const row of rows.slice(0, 2e3)) {
      if (row === null || typeof row !== "object") continue;
      const id = row.id;
      if (typeof id !== "string" || id === "" || seen.has(id)) continue;
      seen.add(id);
      const name2 = row.name;
      models.push(typeof name2 === "string" && name2 !== "" ? { id, name: name2 } : { id });
    }
    return models;
  } catch {
    return [];
  }
}
function revisionOf(settings, ns) {
  return settings.describe?.().find((entry) => entry.ns === ns)?.revision;
}
function readNamespace(settings, ns) {
  const value = settings?.describe?.().find((entry) => entry.ns === ns)?.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  return value;
}
function routeSettingsNs(manifest) {
  return manifest.settingsNs ?? LLM_NS;
}
function pendingRestartMessage(ns) {
  return `Available after the next restart \u2014 the "${ns}" settings namespace is not registered in the running profile yet (build the profile, then restart the service).`;
}
function settingsNamespaceReady(deps, ns) {
  const settings = deps.settings;
  if (settings === void 0 || settings.describe === void 0) return void 0;
  return settings.describe().some((entry) => entry.ns === ns);
}
function pendingRestartForManifest(deps, manifest) {
  const ns = routeSettingsNs(manifest);
  return settingsNamespaceReady(deps, ns) === false ? { ns, message: pendingRestartMessage(ns) } : void 0;
}
function configuredProfile(deps, id, settingsNs = LLM_NS) {
  const section = readNamespace(deps.settings, settingsNs);
  const providers = section?.providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return void 0;
  const profile = providers[id];
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) return void 0;
  return profile;
}
async function writeRoute(deps, manifest, mode, models, overrides = {}) {
  const settings = deps.settings;
  if (settings === void 0) throw new Error("settings seam absent \u2014 cannot write the route");
  const pending = pendingRestartForManifest(deps, manifest);
  if (pending !== void 0) throw new Error(pending.message);
  const profile = routeProfile(manifest, mode, models, overrides);
  const settingsNs = routeSettingsNs(manifest);
  await settings.mutate(settingsNs, [{ op: "set", path: ["providers", manifest.id], value: profile }], revisionOf(settings, settingsNs));
  return profile;
}
async function storeCredential(deps, manifest, key) {
  const ref = manifest.auth.apiKeyEnv;
  if (key === void 0 || key.trim() === "" || ref === void 0) return false;
  const credentials = deps.credentials;
  if (credentials === void 0) throw new Error("credentials seam absent \u2014 cannot store the key");
  await credentials.set(ref, key.trim());
  return true;
}
async function useDetectedInstance(deps, manifest, key) {
  const profile = configuredProfile(deps, manifest.id, routeSettingsNs(manifest));
  const configuredBase = typeof profile?.baseURL === "string" ? profile.baseURL : void 0;
  const detection = await detectInstance(deps, manifest, configuredBase);
  const endpoint = detection.ok ? detection.baseURL : manifest.reuse.baseURL;
  const models = await discoverModels(endpoint, key, deps.fetchImpl);
  const route = await writeRoute(deps, manifest, "reuse", models, { baseURL: endpoint });
  const credentialStored = await storeCredential(deps, manifest, key);
  return {
    route,
    health: detection.health,
    models,
    credentialStored,
    ...detection.ok && detection.port !== void 0 ? { port: detection.port } : {},
    endpoint
  };
}
function discoveredCachePath(deps) {
  const override = process.env.DSH_DISCOVERED_MODELS;
  if (override !== void 0 && override.length > 0) return override;
  return join2(deps.dshHome, "cache", "discovered-models.json");
}
function removeDiscoveredEntry(deps, id) {
  const path = discoveredCachePath(deps);
  if (!existsSync(path)) return false;
  try {
    const document = JSON.parse(readFileSync2(path, "utf8"));
    const routes = document.routes;
    if (routes === null || typeof routes !== "object" || routes === void 0) return false;
    if (!(id in routes)) return false;
    delete routes[id];
    mkdirSync2(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${String(process.pid)}`;
    writeFileSync2(temporary, JSON.stringify(document), "utf8");
    renameSync2(temporary, path);
    return true;
  } catch {
    return false;
  }
}
function removePoolState(deps, id) {
  const path = join2(deps.dshHome, "pools", `${id}.json`);
  if (!existsSync(path)) return false;
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}
function linkReferences(link, id) {
  return link !== null && typeof link === "object" && link.provider === id;
}
async function removeChainReferences(deps, id) {
  const settings = deps.settings;
  const document = readNamespace(settings, ORCHESTRATION_NS);
  const chains = document?.chains;
  if (chains === null || typeof chains !== "object" || Array.isArray(chains)) return 0;
  let removed = 0;
  const next = {};
  for (const [chainId, raw] of Object.entries(chains)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      next[chainId] = raw;
      continue;
    }
    const chain = raw;
    const links = Array.isArray(chain.links) ? chain.links : [];
    const kept = links.filter((link) => {
      const drop = linkReferences(link, id);
      if (drop) removed += 1;
      return !drop;
    });
    const selectors = Array.isArray(chain.selectors) ? chain.selectors : [];
    if (kept.length === 0 && selectors.length === 0 && links.length > 0) continue;
    next[chainId] = kept.length === links.length ? chain : { ...chain, links: kept };
  }
  if (removed === 0 || settings === void 0) return removed;
  await settings.mutate(ORCHESTRATION_NS, [{ op: "set", path: ["chains"], value: next }], revisionOf(settings, ORCHESTRATION_NS));
  return removed;
}
async function removeProvider(deps, manifest, options = {}) {
  const errors = [];
  let teardown = { ran: false, ok: true, output: "" };
  if (options.uninstall === true && manifest.removal.steps.length > 0) {
    let output = "";
    let ok = true;
    let failedStep;
    for (const step of manifest.removal.steps) {
      try {
        const outcome = await deps.runStep(step);
        output += `$ ${step.label}
${outcome.output}
`;
        if (outcome.exitCode !== 0 && step.optional !== true) {
          ok = false;
          failedStep = step.label;
          break;
        }
      } catch (error) {
        if (step.optional === true) {
          output += `$ ${step.label} (optional, failed: ${error instanceof Error ? error.message : String(error)})
`;
          continue;
        }
        ok = false;
        failedStep = step.label;
        output += `$ ${step.label} (failed: ${error instanceof Error ? error.message : String(error)})
`;
        break;
      }
    }
    teardown = { ran: true, ok, ...failedStep === void 0 ? {} : { failedStep }, output };
  }
  let routeRemoved = false;
  const settingsNs = routeSettingsNs(manifest);
  if (deps.settings !== void 0 && configuredProfile(deps, manifest.id, settingsNs) !== void 0) {
    try {
      await deps.settings.mutate(settingsNs, [{ op: "unset", path: ["providers", manifest.id] }], revisionOf(deps.settings, settingsNs));
      routeRemoved = true;
    } catch (error) {
      errors.push(`route: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let credentialRemoved = false;
  if (deps.credentials !== void 0 && manifest.auth.apiKeyEnv !== void 0) {
    try {
      await deps.credentials.unset(manifest.auth.apiKeyEnv);
      credentialRemoved = true;
    } catch (error) {
      errors.push(`credential: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const poolStateRemoved = removePoolState(deps, manifest.id);
  const cacheEntryRemoved = removeDiscoveredEntry(deps, manifest.id);
  let chainLinksRemoved = 0;
  try {
    chainLinksRemoved = await removeChainReferences(deps, manifest.id);
  } catch (error) {
    errors.push(`chains: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { routeRemoved, credentialRemoved, poolStateRemoved, cacheEntryRemoved, chainLinksRemoved, teardown, errors };
}

// src/remote.ts
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
var MAX_KEY_CHARS = 4096;
var RUNTIME_TTL_MS = 6e4;
function requireManifest(value) {
  if (typeof value !== "string" || value === "") {
    throw new RemoteError("gateway/bad-request", "enpoiHeavy: id must be a non-empty string", {});
  }
  const manifest = manifestById(value);
  if (manifest === void 0) {
    throw new RemoteError("gateway/bad-request", `enpoiHeavy: unknown heavy provider "${value}"`, {});
  }
  return manifest;
}
function optionalKey(value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw new RemoteError("gateway/bad-request", "enpoiHeavy: key must be a string", {});
  if (value.length > MAX_KEY_CHARS) throw new RemoteError("gateway/bad-request", "enpoiHeavy: key is too long", {});
  return value;
}
var _remove_dec, _job_dec, _install_dec, _reuse_dec, _status_dec, _manifests_dec, _a, _init;
var HeavyProvidersService = class extends (_a = TypertRemoteService, _manifests_dec = [Remote], _status_dec = [Remote], _reuse_dec = [Remote], _install_dec = [Remote], _job_dec = [Remote], _remove_dec = [Remote], _a) {
  /**
   * @param ctx - owning context (service registration is automatic).
   * @param options - deps accessor, job manager, and optional log sink.
   */
  constructor(ctx, options) {
    super(ctx, "enpoiHeavy");
    __runInitializers(_init, 5, this);
    __publicField(this, "options");
    __publicField(this, "runtimeCache");
    this.options = options;
  }
  /** The machine's container runtimes, memoized for one minute. */
  async runtime() {
    const now = Date.now();
    if (this.runtimeCache !== void 0 && now - this.runtimeCache.at < RUNTIME_TTL_MS) {
      return this.runtimeCache.value;
    }
    const value = await detectRuntimes(this.options.deps().runStep);
    this.runtimeCache = { at: now, value };
    return value;
  }
  /** The manifest with the operator's private overlay applied (read per call). */
  effectiveManifest(manifest) {
    return overlayManifest(manifest, readServerOverlay(this.options.deps().dshHome)[manifest.id]);
  }
  manifests() {
    const overlay = readServerOverlay(this.options.deps().dshHome);
    return {
      items: HEAVY_MANIFESTS.map((manifest) => overlayManifest(manifest, overlay[manifest.id])),
      problems: manifestProblems(),
      platform: process.platform
    };
  }
  async status(request) {
    const manifest = this.effectiveManifest(requireManifest(request?.id));
    const deps = this.options.deps();
    const settingsNs = routeSettingsNs(manifest);
    const profile = configuredProfile(deps, manifest.id, settingsNs);
    const configured = profile !== void 0;
    const configuredBase = typeof profile?.baseURL === "string" ? profile.baseURL : void 0;
    const mode = configuredBase === void 0 ? void 0 : configuredBase === manifest.reuse.baseURL ? "reuse" : "local";
    const detection = await detectInstance(deps, manifest, configuredBase);
    const runtime = await this.runtime();
    const preflight = chooseLocalPath(manifest, process.platform, runtime, detection.ok ? detection.port : void 0);
    const health = configuredBase === void 0 ? detection.health : await probeHealth(healthForBase(manifest, configuredBase), deps.fetchImpl);
    const settingsReady = settingsNamespaceReady(deps, settingsNs);
    const job = this.options.jobs.snapshot(manifest.id);
    return {
      id: manifest.id,
      manifest,
      settingsNs,
      ...settingsReady === void 0 ? {} : { settingsReady },
      configured,
      ...mode === void 0 ? {} : { mode },
      health,
      platform: process.platform,
      runtime,
      preflight,
      ...detection.ok && detection.port !== void 0 ? { detectedPort: detection.port } : {},
      ...detection.ok ? { detectedEndpoint: detection.baseURL } : {},
      ...manifest.unsupported === void 0 ? {} : { unsupported: manifest.unsupported },
      ...job === void 0 ? {} : { job }
    };
  }
  async reuse(request) {
    const manifest = this.effectiveManifest(requireManifest(request?.id));
    const key = optionalKey(request?.key);
    if (manifest.unsupported !== void 0) {
      return { ok: false, blocked: { reason: manifest.unsupported.reason, plannedWith: manifest.unsupported.plannedWith } };
    }
    const deps = this.options.deps();
    const pendingRestart = pendingRestartForManifest(deps, manifest);
    if (pendingRestart !== void 0) {
      this.options.log?.(`reuse ${manifest.id}: waiting for restart (${pendingRestart.ns} is not mounted)`);
      return { ok: false, pendingRestart };
    }
    const outcome = await useDetectedInstance(deps, manifest, key);
    this.options.log?.(`detected ${manifest.id}: health=${outcome.health.ok ? "ok" : "down"} endpoint=${outcome.endpoint} models=${String(outcome.models.length)}`);
    return { ok: true, ...outcome };
  }
  install(request) {
    const manifest = requireManifest(request?.id);
    const key = optionalKey(request?.key);
    if (manifest.unsupported !== void 0) {
      return { ok: false, blocked: { reason: manifest.unsupported.reason, plannedWith: manifest.unsupported.plannedWith } };
    }
    const deps = this.options.deps();
    const pendingRestart = pendingRestartForManifest(deps, manifest);
    if (pendingRestart !== void 0) {
      this.options.log?.(`install ${manifest.id}: waiting for restart (${pendingRestart.ns} is not mounted)`);
      return { ok: false, pendingRestart };
    }
    const job = this.options.jobs.start(manifest.id, "install", resolveHeavyInstall(manifest.local, process.platform).steps, async () => {
      const current = this.options.deps();
      const late = pendingRestartForManifest(current, manifest);
      if (late !== void 0) throw new Error(late.message);
      const models = await discoverModels(modeBaseURL(manifest, "local"), key, current.fetchImpl);
      await writeRoute(current, manifest, "local", models);
      await storeCredential(current, manifest, key);
    });
    return { ok: true, job };
  }
  job(request) {
    const manifest = requireManifest(request?.id);
    const job = this.options.jobs.snapshot(manifest.id);
    return job === void 0 ? {} : { job };
  }
  async remove(request) {
    const manifest = requireManifest(request?.id);
    if (request?.uninstall !== void 0 && typeof request.uninstall !== "boolean") {
      throw new RemoteError("gateway/bad-request", "enpoiHeavy: uninstall must be a boolean", {});
    }
    const summary = await removeProvider(this.options.deps(), manifest, { uninstall: request?.uninstall === true });
    this.options.log?.(`remove ${manifest.id}: route=${String(summary.routeRemoved)} pool=${String(summary.poolStateRemoved)} cache=${String(summary.cacheEntryRemoved)} teardown=${String(summary.teardown.ok)}`);
    return { ok: summary.errors.length === 0, summary };
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "manifests", _manifests_dec, HeavyProvidersService);
__decorateElement(_init, 1, "status", _status_dec, HeavyProvidersService);
__decorateElement(_init, 1, "reuse", _reuse_dec, HeavyProvidersService);
__decorateElement(_init, 1, "install", _install_dec, HeavyProvidersService);
__decorateElement(_init, 1, "job", _job_dec, HeavyProvidersService);
__decorateElement(_init, 1, "remove", _remove_dec, HeavyProvidersService);
__decoratorMetadata(_init, HeavyProvidersService);
/** Nothing is injected into the service fiber; the plugin passes its deps. */
__publicField(HeavyProvidersService, "inject", []);

// src/index.ts
var name = "enpoi-heavy-providers";
var inject = [];
async function runStep(ctx, step, home, dshHome) {
  const subprocess = ctx.get("subprocess");
  if (subprocess === void 0) throw new Error("subprocess seam absent \u2014 cannot run install steps");
  const handle = subprocess.spawn({
    argv: ["/bin/bash", "-lc", substitute(step.command, home, dshHome)],
    cwd: step.cwd === void 0 ? home : substitute(step.cwd, home, dshHome),
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 65536 },
      stderr: { maxBytes: 65536 }
    },
    graceMs: 1e4
  });
  const outcome = await handle.done;
  const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
  const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
  return { exitCode: outcome.exitCode, output: `${stdout}${stderr}`.slice(-16384) };
}
function apply(ctx) {
  const logger = ctx.logger("enpoi-heavy-providers");
  const home = process.env.HOME ?? homedir();
  const dshHome = process.env.DSH_HOME !== void 0 && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join3(home, ".dsh");
  const problems = manifestProblems();
  if (problems.length > 0) {
    for (const problem of problems) logger.warn(`[enpoi-heavy-providers] ${problem}`);
  }
  const jobs = new HeavyJobManager({
    dir: join3(dshHome, "cache", "heavy-jobs"),
    run: (step) => runStep(ctx, step, home, dshHome)
  });
  new HeavyProvidersService(ctx, {
    deps: () => ({
      home,
      dshHome,
      settings: ctx.get("settings"),
      credentials: ctx.get("credentials"),
      fetchImpl: globalThis.fetch,
      runStep: (step) => runStep(ctx, step, home, dshHome)
    }),
    jobs,
    log: (line) => logger.info(`[enpoi-heavy-providers] ${line}`)
  });
}
export {
  apply,
  inject,
  name
};
