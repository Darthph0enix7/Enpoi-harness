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
function visibleJobSnapshot(job, configured) {
  return job !== void 0 && job.state === "succeeded" && configured ? void 0 : job;
}

// src/manifests.ts
function platformInstallVariant(local, platform) {
  return platform === "linux" || platform === "darwin" || platform === "win32" ? local.install[platform] ?? local.install.default : local.install.default;
}
function platformUnsupported(manifest, platform) {
  return platformInstallVariant(manifest.local, platform).unsupported;
}
function resolveHeavyInstall(local, platform) {
  const variant = platformInstallVariant(local, platform);
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
var ANTIGRAVITY_LAUNCHD_LABEL = "dev.enpoi.antigravity-proxy";
var ANTIGRAVITY_PACKAGE = "antigravity-claude-proxy";
var ANTIGRAVITY_NPM_STEP = {
  label: "Install the proxy package",
  command: `mkdir -p "{home}/.local/bin" && npm install -g --prefix "{home}/.local" ${ANTIGRAVITY_PACKAGE}`,
  weight: 2
};
var ANTIGRAVITY_WAIT_STEP = {
  label: "Wait for the proxy",
  command: 'for i in {1..30}; do curl -fsS http://127.0.0.1:8082/health >/dev/null && exit 0; sleep 2; done; echo "proxy did not answer within 60s"; exit 1'
};
var ANTIGRAVITY_SYSTEMD_STEPS = [
  ANTIGRAVITY_NPM_STEP,
  {
    label: "Write the systemd user unit",
    // `start --log` is the package's foreground mode; a bare invocation only
    // prints help. The unit's main process must stay the server. The explicit
    // PATH resolves the npm shim's `node` when the version manager only
    // extends an interactive shell; the wrapper prefers the absolute path the
    // npm step guarantees and falls back to the PATH-resolved binary (a
    // version-managed node shim may live outside `~/.local/bin`).
    command: `mkdir -p {config}/systemd/user && cat > {config}/systemd/user/antigravity-proxy.service <<'EOF'
[Unit]
Description=Antigravity Claude proxy (per-device)
After=network-online.target

[Service]
Environment=PORT=8082
Environment=HOST=127.0.0.1
Environment=PATH={home}/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash -lc 'BIN="{home}/.local/bin/antigravity-claude-proxy"; test -x "$BIN" || BIN="$(command -v antigravity-claude-proxy)"; exec "$BIN" start --log'
Restart=on-failure

[Install]
WantedBy=default.target
EOF`
  },
  { label: "Enable and start the unit", command: "systemctl --user daemon-reload && systemctl --user enable --now antigravity-proxy.service" },
  {
    label: "Enable lingering (the unit starts without an open login session)",
    command: 'loginctl enable-linger "$(id -un)"',
    optional: true
  },
  ANTIGRAVITY_WAIT_STEP
];
var ANTIGRAVITY_LAUNCHD_STEPS = [
  ANTIGRAVITY_NPM_STEP,
  {
    label: "Write the launchd agent",
    command: `mkdir -p {home}/Library/LaunchAgents {home}/Library/Logs && cat > {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ANTIGRAVITY_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>BIN="{home}/.local/bin/antigravity-claude-proxy"; test -x "$BIN" || BIN="$(command -v antigravity-claude-proxy)"; exec "$BIN" start --log</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>8082</string>
    <key>HOST</key>
    <string>127.0.0.1</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:{home}/.nvm/versions/node/current/bin:{home}/Library/Application Support/fnm/aliases/default/bin:{home}/.local/share/fnm/aliases/default/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>{home}/Library/Logs/antigravity-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>{home}/Library/Logs/antigravity-proxy.err.log</string>
</dict>
</plist>
EOF`
  },
  {
    label: "Load and start the agent",
    command: `launchctl bootout gui/$(id -u)/${ANTIGRAVITY_LAUNCHD_LABEL} 2>/dev/null || true; launchctl bootstrap gui/$(id -u) {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist 2>/dev/null || launchctl load -w {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist`
  },
  ANTIGRAVITY_WAIT_STEP
];
var ANTIGRAVITY_PREFIX_SWEEP_COMMAND = `PKG=${ANTIGRAVITY_PACKAGE}; strip_prefix() { p="$1"; [ -n "$p" ] || return 0; if command -v npm >/dev/null 2>&1; then npm uninstall -g --prefix "$p" "$PKG" >/dev/null 2>&1 || true; fi; rm -rf "$p/lib/node_modules/$PKG" "$p/bin/$PKG" 2>/dev/null || true; if [ -L "$p/bin/acc" ]; then case "$(readlink "$p/bin/acc" 2>/dev/null)" in *"$PKG"*) rm -f "$p/bin/acc" 2>/dev/null || true;; esac; fi; for stage in "$p"/lib/node_modules/."$PKG"-*; do if [ -e "$stage" ]; then rm -rf "$stage" 2>/dev/null || true; fi; done; if [ -d "$p/lib/node_modules/$PKG" ] || [ -e "$p/bin/$PKG" ]; then echo "warning: $p still holds $PKG; remove it manually (system prefixes may need sudo): rm -rf $p/lib/node_modules/$PKG $p/bin/$PKG $p/bin/acc"; fi; }; strip_prefix "{home}/.local"; strip_prefix "{home}/.npm-global"; if command -v npm >/dev/null 2>&1; then strip_prefix "$(npm prefix -g 2>/dev/null)"; fi; for prefix in "{home}/.nvm/versions/node"/* "{home}/.local/share/nvm/versions/node"/* "{home}/.local/share/fnm/aliases/default" "{home}/Library/Application Support/fnm/aliases/default" "/opt/homebrew"; do if [ -d "$prefix" ]; then strip_prefix "$prefix"; fi; done; for prefix in "/usr/local" "/usr"; do if [ -d "$prefix/lib/node_modules/$PKG" ] || [ -e "$prefix/bin/$PKG" ]; then strip_prefix "$prefix"; fi; done; exit 0`;
var COMMANDCODE_HEALTH = {
  url: "https://api.commandcode.ai/",
  timeoutMs: 5e3,
  expectStatus: [200, 401, 403, 404, 405],
  headers: {
    "x-command-code-version": "1.54.0",
    "x-cli-environment": "production",
    "x-project-slug": "opencode",
    "user-agent": "cli"
  }
};
var COMMANDCODE_INSTALL_STEP = {
  label: "Link and build the DSH provider package",
  command: 'node "{dshHome}/profiles/web/packages/enpoi-commandcode-provider/scripts/install.mjs" "{dshHome}/profiles/web"',
  weight: 3
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
      "Local install dependencies: Linux uses Docker/Podman compose; macOS/Windows use the vendor desktop app (no Docker needed there)",
      "First-run setup code and password-reset code appear only in `docker compose logs`; upstream provider keys are added on the web dashboard",
      "Unified key is the only client auth \u2014 never expose this port beyond the local machine",
      "Losing ENCRYPTION_KEY (in ~/freellmapi/.env) makes every stored upstream key unrecoverable",
      "The free-tier catalog is a monthly snapshot; /v1/models can list models no key serves",
      "A missing bind-mounted JSON file is created as a directory by Docker \u2192 boot loop",
      "Windows: the desktop-app install steps run through Git Bash (the harness executes shell steps with bash) \u2014 install Git for Windows first"
    ],
    reuse: {
      label: "Use a detected instance",
      baseURL: "http://127.0.0.1:3002/v1",
      note: "Zero install: uses a FreeLLMAPI instance already running on this device.",
      health: { url: "http://127.0.0.1:3002/api/ping", timeoutMs: 5e3 }
    },
    local: {
      label: "Install locally (Docker or Podman)",
      baseURL: "http://127.0.0.1:3002/v1",
      deps: ["Docker Engine or Podman, with Compose"],
      diskHint: "~700 MB disk (536 MB image), ~84 MB RAM idle, no GPU",
      dashboardUrl: "http://127.0.0.1:3002",
      runtime: "docker",
      install: {
        // Unknown platforms fall back to the manual Docker Compose path.
        default: {
          steps: [
            // Re-running the install must not fail on the existing clone. A
            // stale non-git directory is replaced, but a `.env` inside it is
            // never wiped: it holds ENCRYPTION_KEY, and deleting it makes
            // every stored upstream key unrecoverable.
            { label: "Clone FreeLLMAPI", command: 'if [ -d "{home}/freellmapi" ] && [ ! -d "{home}/freellmapi/.git" ]; then if [ -f "{home}/freellmapi/.env" ]; then echo "Existing {home}/freellmapi/.env found without .git; refusing to wipe it \u2014 move the directory aside, then retry" >&2; exit 1; fi; rm -rf "{home}/freellmapi" 2>/dev/null || true; fi; test -d "{home}/freellmapi/.git" || git clone --depth 1 https://github.com/tashfeenahmed/freellmapi "{home}/freellmapi"', weight: 2 },
            {
              label: "Generate ENCRYPTION_KEY",
              // PORT is the HOST port (compose maps ${PORT}:3001); keep it at
              // 3002 so the local route's baseURL resolves. An existing .env
              // is kept only when its ENCRYPTION_KEY is non-empty: an empty
              // key makes every stored upstream key unrecoverable.
              command: `if [ ! -f "{home}/freellmapi/.env" ] || ! grep -qE '^ENCRYPTION_KEY=.+' "{home}/freellmapi/.env"; then printf "ENCRYPTION_KEY=%s\\nPORT=3002\\nHOST_BIND=127.0.0.1\\n" "$(openssl rand -hex 32)" > "{home}/freellmapi/.env"; fi`
            },
            {
              label: "Start the stack",
              // Docker or Podman: preflight offers Podman as the substitute,
              // so the step must resolve whichever engine exists. A Podman
              // without its compose plugin has to fail here, not midway
              // through `up`.
              command: 'ENGINE="$(command -v docker || command -v podman)"; test -n "$ENGINE" || { echo "neither docker nor podman is installed"; exit 1; }; "$ENGINE" compose version >/dev/null 2>&1 || { echo "podman compose plugin missing (need podman-compose)"; exit 1; }; "$ENGINE" compose up -d',
              cwd: "{home}/freellmapi"
            },
            {
              label: "Wait for the gateway",
              command: 'for i in {1..60}; do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1'
            }
          ]
        },
        // No linux override: the vendor one-liner is Docker-only, while
        // preflight accepts Podman as the substitute runtime, so Linux uses
        // the same engine-aware compose path as every other platform.
        // macOS prefers the vendor desktop app: no Docker Desktop overhead.
        darwin: {
          label: "Install locally (vendor desktop app, no Docker)",
          deps: ["macOS 11+"],
          diskHint: "~250 MB app; data in ~/Library/Application Support/FreeLLMAPI",
          runtime: "vendor-app",
          steps: [
            {
              label: "Download the latest .dmg",
              // Apple Silicon and Intel ship separate disk images; picking by
              // `uname -m` keeps the install correct on both. The asset name
              // ends `-<arch>.dmg`, so the pattern must carry that hyphen (a
              // `"arm64` pattern can never match). A re-run keeps the image
              // already in ~/Downloads.
              command: `arch="$(uname -m)"; test "$arch" = arm64 || arch=x64; url="$(curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE '"browser_download_url": *"[^"]+-'"$arch"'\\.dmg"' | head -1 | cut -d'"' -f4)"; test -n "$url" || { echo "no FreeLLMAPI $arch .dmg in the latest release"; exit 1; }; mkdir -p "{home}/Downloads"; test -f "{home}/Downloads/FreeLLMAPI.dmg" || curl -fsSL -o "{home}/Downloads/FreeLLMAPI.dmg" "$url"`,
              weight: 2
            },
            {
              label: "Install the app from the disk image",
              // A per-run mount point is detached and removed even when the
              // copy fails, so a hung volume never blocks the next attempt.
              command: 'MOUNT="/tmp/freellmapi-dmg-$$"; mkdir -p "$MOUNT"; hdiutil attach "{home}/Downloads/FreeLLMAPI.dmg" -nobrowse -quiet -mountpoint "$MOUNT" && cp -R "$MOUNT"/*.app /Applications/; status=$?; hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true; rmdir "$MOUNT" 2>/dev/null || true; exit $status'
            },
            {
              label: "Pin the desktop app to port 3002",
              command: `mkdir -p "{home}/Library/Application Support/FreeLLMAPI" && printf '{"port":3002}\\n' > "{home}/Library/Application Support/FreeLLMAPI/config.json"`
            },
            { label: "Launch FreeLLMAPI", command: "open -a FreeLLMAPI" },
            {
              label: "Wait for the gateway",
              command: 'for i in {1..60}; do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1'
            }
          ]
        },
        // Windows only ships a desktop app (no Docker path in the vendor docs).
        win32: {
          label: "Install locally (vendor desktop app, no Docker)",
          deps: ["Windows 10+", "Git Bash (the install steps run through bash)"],
          diskHint: "~250 MB app; data in %APPDATA%\\FreeLLMAPI",
          runtime: "vendor-app",
          steps: [
            {
              label: "Download the latest installer",
              // The matched URL lands in a file first: an empty match has to
              // fail the step instead of feeding xargs an empty string.
              command: `mkdir -p "{home}/Downloads" && curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE '"browser_download_url": *"[^"]+\\.exe"' | head -1 | cut -d'"' -f4 > "{home}/Downloads/freellmapi-setup-url"; test -s "{home}/Downloads/freellmapi-setup-url" || { echo "no .exe in the latest release"; exit 1; }; xargs -I{} curl -fsSL -o "{home}/Downloads/FreeLLMAPI-Setup.exe" {} < "{home}/Downloads/freellmapi-setup-url"`,
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
              command: 'for i in {1..60}; do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1'
            }
          ]
        }
      },
      health: { url: "http://127.0.0.1:3002/api/ping", timeoutMs: 5e3 }
    },
    removal: {
      steps: [
        // Resolve the engine the same way the install did; every step is
        // fail-soft so a machine that moved to another engine still cleans up.
        { label: "Stop the stack and drop its volume", command: 'ENGINE="$(command -v docker || command -v podman)"; test -n "$ENGINE" && "$ENGINE" compose down -v', cwd: "{home}/freellmapi", optional: true },
        { label: "Remove the container image", command: 'ENGINE="$(command -v docker || command -v podman)"; test -n "$ENGINE" && "$ENGINE" image rm ghcr.io/tashfeenahmed/freellmapi:latest', optional: true },
        { label: "Remove the clone directory", command: 'rm -rf "{home}/freellmapi"' },
        // The vendor desktop-app leftovers are platform-guarded: each step
        // exits cleanly on the platforms it does not own and never fails a
        // teardown.
        {
          label: "Remove the macOS desktop app and its data",
          optional: true,
          command: 'test "$(uname -s)" = Darwin || exit 0; pkill -f FreeLLMAPI 2>/dev/null || true; hdiutil detach "/tmp/freellmapi-dmg" >/dev/null 2>&1 || true; rm -rf /Applications/FreeLLMAPI.app "{home}/Library/Application Support/FreeLLMAPI" "{home}/Downloads/FreeLLMAPI.dmg" /tmp/freellmapi-dmg'
        },
        {
          label: "Remove the Windows desktop app and its data",
          optional: true,
          command: 'case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) exit 0;; esac; taskkill //F //IM FreeLLMAPI.exe 2>/dev/null || true; rm -rf "$APPDATA/FreeLLMAPI" "$LOCALAPPDATA/Programs/FreeLLMAPI" "$HOME/Downloads/FreeLLMAPI-Setup.exe"'
        }
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
    // keyless anthropic routes: the reference and a placeholder credential
    // value are stored, and the route MUST NOT declare a DSH pool — the proxy
    // runs its own sticky one.
    auth: { kind: "placeholder", apiKeyEnv: "ANTIGRAVITY_API_KEY", keyless: false },
    dashboardUrl: "http://127.0.0.1:8082",
    docsUrl: "https://www.npmjs.com/package/antigravity-claude-proxy",
    defaultPort: 8082,
    requiresBrowser: [
      "Adding a Google account is an OAuth flow that opens a browser and waits on a localhost callback \u2014 on a headless host the printed URL must be opened from a machine that can reach the callback (e.g. over an SSH port-forward); it cannot be automated"
    ],
    quirks: [
      "Local install dependencies: native npm package (Node.js >= 18) behind a systemd or launchd user service on Linux/macOS; Docker is never required. Windows has no supported local install \u2014 run the package manually or use a proxy running elsewhere",
      "Linux: the systemd user unit runs the proxy through /bin/bash -lc with PATH ~/.local/bin:/usr/local/bin:/usr/bin:/bin; the package installs under ~/.local/bin, and a Node.js reachable only from an nvm/fnm shell configuration is not found \u2014 keep it reachable from a login shell or one of those directories",
      "macOS: the launchd agent runs the proxy through /bin/bash -lc with PATH /opt/homebrew/bin:/usr/local/bin:~/.local/bin plus the common nvm/fnm node directories; the package installs under ~/.local/bin, and a Node.js reachable only from a fish/zsh/nvm/fnm shell configuration is not found \u2014 keep it reachable from a login bash profile or one of those directories",
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
      label: "Install locally (npm + user service)",
      baseURL: "http://127.0.0.1:8082",
      deps: ["Node.js >= 18", "A reachable systemd user session (systemctl --user) on the default path"],
      diskHint: "~23 MB install, ~78\u2013150 MB RAM, no GPU",
      dashboardUrl: "http://127.0.0.1:8082",
      runtime: "node",
      install: {
        // The npm package is cross-platform; the user-service wrapper is not.
        // Linux (and systemd-like hosts) keeps the systemd unit; macOS gets the
        // launchd equivalent; Windows has no POSIX user service to install.
        default: { label: "Install locally (npm + systemd user unit)", steps: ANTIGRAVITY_SYSTEMD_STEPS },
        linux: { label: "Install locally (npm + systemd user unit)", steps: ANTIGRAVITY_SYSTEMD_STEPS },
        darwin: {
          label: "Install locally (npm + launchd agent)",
          deps: ["Node.js >= 18", "macOS 11+ (launchd)"],
          diskHint: "~23 MB install, ~78\u2013150 MB RAM, no GPU; logs in ~/Library/Logs",
          steps: ANTIGRAVITY_LAUNCHD_STEPS
        },
        win32: {
          label: "Not supported on Windows",
          unsupported: "The antigravity proxy local install needs a POSIX user service (systemd or launchd) to keep the proxy running; this profile has no supported Windows provisioning path. Install the npm package and run `antigravity-claude-proxy` yourself, or run the proxy on another machine and add it as a custom route.",
          steps: []
        }
      },
      health: { url: "http://127.0.0.1:8082/health", timeoutMs: 5e3 }
    },
    removal: {
      // Platform-neutral on purpose: the same teardown runs on Linux and macOS
      // and touches whichever user-service file the platform used. Loginctl
      // lingering is deliberately never disabled: it is a per-user setting the
      // provider does not own.
      steps: [
        {
          label: "Stop and disable the user service",
          optional: true,
          command: `if command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now antigravity-proxy.service 2>/dev/null || true; fi; if command -v launchctl >/dev/null 2>&1; then launchctl bootout gui/$(id -u)/${ANTIGRAVITY_LAUNCHD_LABEL} 2>/dev/null || true; fi; if command -v antigravity-claude-proxy >/dev/null 2>&1; then antigravity-claude-proxy stop >/dev/null 2>&1 || true; fi`
        },
        {
          label: "Remove the user service file",
          optional: true,
          command: `rm -f {config}/systemd/user/antigravity-proxy.service {home}/Library/LaunchAgents/${ANTIGRAVITY_LAUNCHD_LABEL}.plist; if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload 2>/dev/null || true; fi`
        },
        // The package can sit in the install's fixed prefix, npm's own global
        // prefix, a version-manager prefix, or a system prefix; the sweep
        // uninstalls every one of them, fail-soft, and reports anything it
        // could not remove (a system prefix may need sudo).
        {
          label: "Uninstall the package from every npm prefix",
          optional: true,
          command: ANTIGRAVITY_PREFIX_SWEEP_COMMAND
        },
        // The launchd agent redirects stdout/stderr into ~/Library/Logs; the
        // step is a no-op on every other platform.
        {
          label: "Remove the macOS agent logs",
          optional: true,
          command: 'test "$(uname -s)" = Darwin || exit 0; rm -rf "{home}/Library/Logs/antigravity-proxy"*; exit 0'
        },
        // The package's full state directory: config.json, accounts.json
        // (every Google OAuth refresh token), usage-history.json, and the two
        // presets files. Required, not optional: a failure here means user
        // data survived the removal and must be reported.
        {
          label: "Remove the config directory (accounts.json OAuth tokens, usage history, presets)",
          command: "rm -rf {config}/antigravity-proxy"
        },
        // npm's content-addressed cache is shared with every other package and
        // self-pruning, so it is never wiped; an npx throwaway tree is
        // package-owned residue and is removed.
        {
          label: "Remove npm npx cache residue",
          optional: true,
          command: `rm -rf "{home}/.npm/_npx"/*/node_modules/${ANTIGRAVITY_PACKAGE} 2>/dev/null || true; exit 0`
        }
      ],
      warnings: [
        "Any other tool configured against the same proxy stops working when the service is removed",
        "If a dotfiles/config repository manages the service file (systemd unit or launchd plist), remove it there too or the next sync resurrects it",
        "The proxy state directory ~/.config/antigravity-proxy is deleted in full: accounts.json (every Google OAuth refresh token), usage-history.json, config.json, claude-presets.json, and server-presets.json are unrecoverable afterwards \u2014 back them up first if the accounts are shared elsewhere",
        "The Google Antigravity app's own database (~/.config/Antigravity) is only read by the proxy and is never touched by this removal",
        "loginctl lingering is left enabled \u2014 it is a per-user setting this teardown does not own",
        "npm's shared content-addressed cache (~/.npm/_cacache) still holds the downloaded tarball; it is shared with other packages, holds no account data, and is left in place",
        "DSH route, credential, pool state, discovered cache, and chain links are removed separately by this teardown"
      ]
    },
    fallbackModel: "gemini-2.5-flash"
  },
  {
    id: "commandcode",
    label: "Command Code",
    summary: "Command Code's CLI-shaped API at api.commandcode.ai, served by the DSH provider package and its native multi-key pool \u2014 no proxy.",
    protocol: "commandcode/alpha-generate",
    // The vendor is reached directly. The route profile carries its own key
    // pool: identities and priorities live in this route's settings namespace
    // (commandcode-provider) and the secrets live in the credentials store
    // (Settings → Models Keys card) or the environment. The provider package
    // injects the four CLI headers and rotates identities itself; the
    // standalone keypool proxy is not involved.
    auth: { kind: "unified", apiKeyEnv: "COMMANDCODE_KEY_1", keyless: false },
    delivery: "direct",
    docsUrl: "https://commandcode.ai",
    defaultPort: 443,
    // Served by `dsh-enpoi-commandcode-provider` (ctx.llm.registerAdapter), not
    // llm-pi-ai: the CLI-shaped protocol has no llm-pi-ai entry, so the route
    // profile must never be written into the llm-pi-ai schema.
    settingsNs: "commandcode-provider",
    // The route is pooled from its first request: an anonymous request cannot
    // pass the vendor gate, so the shipped starter identity gives the Keys
    // card its first key slot and a credential-less request fails with the
    // MISSING_CREDENTIAL action instead of falling back to keyless.
    pool: {
      strategy: "priority-sticky",
      identities: [{ id: "key-1", credentialRef: "COMMANDCODE_KEY_1", priority: 1 }]
    },
    // Browser badges belong only to account flows that cannot complete without
    // a browser (antigravity's Google OAuth); the vendor dashboard is an
    // ordinary quirk here, not an operator-blocking browser requirement.
    requiresBrowser: [],
    quirks: [
      "Local install dependencies: Node.js 22 (the setup step links and builds the provider package); Docker is never required, and no proxy or user service runs \u2014 the route talks to the vendor directly",
      'The vendor endpoint rejects generic HTTP clients ("Proxy use detected") \u2014 the provider package injects the four CLI headers itself; no proxy is required',
      "Keys are managed as pool identities on the Settings \u2192 Models Keys card: the route ships one starter identity (COMMANDCODE_KEY_1) and rotates identities in priority order",
      "The vendor account and quota dashboard live at commandcode.ai (browser)",
      "DSH speaks this protocol through the dsh-enpoi-commandcode-provider adapter; llm-pi-ai cannot declare it",
      "Migration: scripts/import-keypool-keys.mjs turns the old keypool pools.json commandcode keys into a settings pool block; it reads the old file but never prints key material",
      "An existing route still pointed at a loopback keypool keeps working until it is switched: set its baseURL to https://api.commandcode.ai, add the imported pool identities, then retire the proxy",
      "The provider package owns the request sanitizer (embedded-base64 scrub, 200k text cap, 413 strip-oldest retry) \u2014 clients must not duplicate it",
      'Quota is per key and real: the native pool rotates on exhaustion, and a QUOTA failure ("weekly usage limit" / "insufficient credits") appears only when every pooled identity is spent \u2014 a normal state, not a routing defect',
      "A route whose identities resolve no credential fails with MISSING_CREDENTIAL naming the Keys card; there is no anonymous fallback"
    ],
    reuse: {
      label: "Use the vendor endpoint now",
      baseURL: "https://api.commandcode.ai",
      note: "Writes the route at the vendor endpoint after confirming it answers; run the local setup first when the provider package is not linked yet.",
      health: COMMANDCODE_HEALTH
    },
    local: {
      label: "Link the provider package, then use the vendor endpoint",
      baseURL: "https://api.commandcode.ai",
      deps: ["Node.js 22"],
      diskHint: "~5 MB provider package; no local service, no GPU",
      runtime: "node",
      install: {
        // The setup is one shared, idempotent step; there is no service to
        // wrap and no proxy to deploy on any platform.
        default: { steps: [COMMANDCODE_INSTALL_STEP] },
        linux: { steps: [COMMANDCODE_INSTALL_STEP] },
        darwin: { steps: [COMMANDCODE_INSTALL_STEP] },
        win32: {
          label: "Not supported on Windows",
          unsupported: "The provider-package setup step runs through /bin/bash, which this profile does not provide on Windows. Link the package manually: from the profile root (normally ~/.dsh/profiles/web) run `node packages/enpoi-commandcode-provider/scripts/install.mjs .`, or run the harness on Linux/macOS.",
          steps: []
        }
      },
      health: COMMANDCODE_HEALTH
    },
    removal: {
      // No local service exists: the vendor endpoint needs no teardown and the
      // provider package is part of the shipped profile.
      steps: [],
      warnings: [
        "Removal drops only DSH state \u2014 the route, its COMMANDCODE_KEY_1 credential reference, its pool state, and its cache entry; no local service exists to stop",
        "Vendor keys stored under other pool identities (for example COMMANDCODE_KEY_2) are not deleted by removal \u2014 delete them on the Keys card",
        "Vendor account state and quota live at commandcode.ai and are never touched"
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
      const variantWhere = `${where}: platform install variant ${String(index)}`;
      if (variant.unsupported !== void 0 && variant.unsupported.trim() === "") {
        problems.push(`${variantWhere} declares an empty unsupported reason`);
      }
      if (variant.steps.length === 0 && variant.unsupported === void 0 && manifest.unsupported === void 0) {
        problems.push(`${variantWhere} has no steps`);
      }
      for (const requirement of variant.requiresFiles ?? []) {
        if (requirement.paths.length === 0 || requirement.hint.trim() === "") {
          problems.push(`${variantWhere} file requirement needs at least one path and a hint`);
        }
      }
      if (variant.unsupported !== void 0) continue;
      const runtime = variant.runtime ?? manifest.local.runtime;
      const declared = runtime === void 0 ? void 0 : RUNTIME_TOOL_RE[runtime];
      if (declared === void 0 || variant.steps.length === 0) continue;
      const commands = variant.steps.map((step) => step.command).join("\n");
      if (declared.test(commands)) continue;
      const conflicting = Object.keys(RUNTIME_TOOL_RE).filter((other) => other !== runtime && RUNTIME_TOOL_RE[other]?.test(commands) === true);
      if (conflicting.length > 0) {
        problems.push(`${variantWhere} declares runtime "${String(runtime)}" but its steps invoke ${conflicting.join("/")} tooling instead`);
      }
    }
    if (manifest.settingsNs !== void 0 && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.settingsNs)) {
      problems.push(`${where}: settingsNs must be a lowercase plugin entry id`);
    }
    if (manifest.unsupported === void 0 && !LLM_PI_AI_PROTOCOLS.includes(manifest.protocol) && manifest.settingsNs === void 0) {
      problems.push(`${where}: protocol "${manifest.protocol}" is not served by llm-pi-ai and needs an explicit settingsNs`);
    }
    if (manifest.delivery === "direct" && manifest.unsupported === void 0 && manifest.pool === void 0 && manifest.auth.kind === "none") {
      problems.push(`${where}: a direct route must declare a key pool or a non-keyless auth kind`);
    }
    if (manifest.pool !== void 0) {
      if (manifest.settingsNs === void 0) {
        problems.push(`${where}: a key pool needs its own settingsNs; llm-pi-ai routes must not declare one`);
      }
      if (manifest.pool.identities.length === 0) problems.push(`${where}: the key pool declares no identities`);
      const identityIds = /* @__PURE__ */ new Set();
      for (const identity of manifest.pool.identities) {
        if (identity.id === "") problems.push(`${where}: a key-pool identity has an empty id`);
        if (identityIds.has(identity.id)) problems.push(`${where}: key-pool identity id "${identity.id}" is duplicated`);
        identityIds.add(identity.id);
        if (!/^[A-Z_][A-Z0-9_]*$/.test(identity.credentialRef)) {
          problems.push(`${where}: key-pool identity "${identity.id}" credentialRef must be an uppercase credential reference`);
        }
        if (identity.priority !== void 0 && (!Number.isSafeInteger(identity.priority) || identity.priority < 0)) {
          problems.push(`${where}: key-pool identity "${identity.id}" priority must be a non-negative integer`);
        }
        if (identity.enabled !== void 0 && typeof identity.enabled !== "boolean") {
          problems.push(`${where}: key-pool identity "${identity.id}" enabled must be a boolean`);
        }
      }
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
function instanceBaseURLFromInput(value) {
  const trimmed = value.trim();
  if (trimmed === "") return void 0;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return void 0;
    if (parsed.username !== "" || parsed.password !== "") return void 0;
    if (parsed.search !== "" || parsed.hash !== "") return void 0;
    if (parsed.port !== "" && Number(parsed.port) < 1) return void 0;
    return parsed.origin;
  } catch {
    return void 0;
  }
}
function instanceCandidates(manifest, configuredBaseURL) {
  if (manifest.delivery === "direct") return [];
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
  if (manifest.delivery === "direct") {
    return {
      ok: false,
      baseURL: manifest.reuse.baseURL,
      url: manifest.reuse.health.url,
      health: { ok: false, error: "direct vendor endpoint \u2014 no local instance to detect", checkedAt: Date.now() }
    };
  }
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
      label: "Detect local runtimes",
      command: "command -v docker >/dev/null 2>&1 && echo available:docker; command -v podman >/dev/null 2>&1 && echo available:podman; command -v node >/dev/null 2>&1 && echo available:node; command -v node >/dev/null 2>&1 && node -v 2>/dev/null | cut -d. -f1 | tr -d v | sed 's/^/node-major:/'; systemctl --user show-environment >/dev/null 2>&1 && echo available:systemd-user; exit 0"
    });
    const nodeMajor = /(^|\n)node-major:(\d+)(\n|$)/.exec(outcome.output)?.[2];
    return {
      docker: /(^|\n)available:docker(\n|$)/.test(outcome.output),
      podman: /(^|\n)available:podman(\n|$)/.test(outcome.output),
      node: /(^|\n)available:node(\n|$)/.test(outcome.output),
      ...nodeMajor === void 0 ? {} : { nodeMajor: Number(nodeMajor) },
      systemdUser: /(^|\n)available:systemd-user(\n|$)/.test(outcome.output)
    };
  } catch {
    return { docker: false, podman: false, node: false, systemdUser: false };
  }
}
function missingFileRequirement(requirements, context) {
  if (context === void 0) return void 0;
  for (const requirement of requirements ?? []) {
    if (requirement.paths.some((path) => existsSync(substitute(path, context.home, context.dshHome)))) continue;
    return requirement.hint;
  }
  return void 0;
}
function declaredRuntime(manifest, platform) {
  const variant = platform === "linux" || platform === "darwin" || platform === "win32" ? manifest.local.install[platform] : void 0;
  return variant?.runtime ?? manifest.local.runtime ?? "node";
}
function declaredNodeMajor(deps) {
  for (const dep of deps) {
    const match = /^Node\.js\s*(?:>=\s*)?(\d+)/.exec(dep.trim());
    if (match?.[1] !== void 0) return Number(match[1]);
  }
  return void 0;
}
function chooseLocalPath(manifest, platform, runtime, detectedPort, context) {
  const resolved = resolveHeavyInstall(manifest.local, platform);
  if (detectedPort !== void 0) {
    return { path: "detected", label: "Use the detected instance", deps: [], diskHint: "", steps: [], requires: [], missing: [] };
  }
  const base = { deps: resolved.deps, diskHint: resolved.diskHint, steps: resolved.steps };
  const blocked = platformUnsupported(manifest, platform);
  if (blocked !== void 0) {
    return { path: "unsupported", label: resolved.label, ...base, requires: [], missing: [blocked] };
  }
  const missingFile = missingFileRequirement(platformInstallVariant(manifest.local, platform).requiresFiles, context);
  if (missingFile !== void 0) {
    return { path: "unsupported", label: resolved.label, ...base, requires: [], missing: [missingFile] };
  }
  switch (declaredRuntime(manifest, platform)) {
    case "docker":
      if (runtime.docker) return { path: "docker", label: resolved.label, ...base, requires: ["docker"], missing: [] };
      if (runtime.podman) return { path: "podman", label: resolved.label, ...base, requires: ["podman"], missing: [] };
      return { path: "unsupported", label: resolved.label, ...base, requires: ["docker"], missing: ["Docker Engine + Compose (or Podman)"] };
    case "podman":
      return runtime.podman ? { path: "podman", label: resolved.label, ...base, requires: ["podman"], missing: [] } : { path: "unsupported", label: resolved.label, ...base, requires: ["podman"], missing: ["Podman"] };
    case "vendor-app":
      return { path: "vendor-app", label: resolved.label, ...base, requires: [], missing: [] };
    case "node": {
      if (!runtime.node) {
        return { path: "unsupported", label: resolved.label, ...base, requires: [], missing: [resolved.deps[0] ?? "Node.js"] };
      }
      const requiredNodeMajor = declaredNodeMajor(resolved.deps);
      if (requiredNodeMajor !== void 0 && runtime.nodeMajor !== void 0 && runtime.nodeMajor < requiredNodeMajor) {
        return { path: "unsupported", label: resolved.label, ...base, requires: [], missing: [`Node.js >= ${String(requiredNodeMajor)}`] };
      }
      const needsSystemdUser = resolved.steps.some((step) => step.command.includes("systemctl --user"));
      if (needsSystemdUser && !runtime.systemdUser) {
        return {
          path: "unsupported",
          label: resolved.label,
          ...base,
          requires: [],
          missing: ["A reachable systemd user session (`systemctl --user`)"]
        };
      }
      return { path: "node", label: resolved.label, ...base, requires: [], missing: [] };
    }
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
  const list = models.length > 0 ? models.map((model) => ({
    id: model.id,
    ...model.name === void 0 ? {} : { name: model.name },
    ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
    ...model.input === void 0 || model.input.length === 0 ? {} : { input: [...model.input] }
  })) : manifest.fallbackModel === void 0 ? [] : [{ id: manifest.fallbackModel }];
  const suffix = manifest.delivery === "direct" ? " (direct)" : mode === "local" ? " (local)" : " (detected)";
  return {
    displayName: `${manifest.label}${suffix}`,
    api: manifest.protocol,
    baseURL: overrides.baseURL ?? modeBaseURL(manifest, mode),
    ...manifest.auth.apiKeyEnv === void 0 ? {} : { apiKeyEnv: manifest.auth.apiKeyEnv },
    ...manifest.auth.kind === "none" ? { keyless: true } : {},
    ...manifest.pool === void 0 ? {} : {
      pool: {
        ...manifest.pool.strategy === void 0 ? {} : { strategy: manifest.pool.strategy },
        identities: manifest.pool.identities.map((identity) => ({ ...identity }))
      }
    },
    models: list
  };
}
async function probeHealth(probe, fetchImpl = globalThis.fetch, now = Date.now) {
  const checkedAt = now();
  try {
    const response = await fetchImpl(probe.url, {
      ...probe.headers === void 0 ? {} : { headers: { ...probe.headers } },
      signal: AbortSignal.timeout(probe.timeoutMs ?? 5e3)
    });
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
var ANTHROPIC_VERSION = "2023-06-01";
function modelListingUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, "");
  if (api !== "anthropic-messages") return `${base}/models`;
  const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
  return `${root}/v1/models?limit=1000`;
}
function listingLabel(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 200) return candidate;
  }
  return void 0;
}
function listingCapacity(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  return void 0;
}
function readModelListing(body) {
  const listing = body;
  let rows;
  if (Array.isArray(body)) {
    rows = body.map((raw) => ({ raw }));
  } else if (Array.isArray(listing?.data)) {
    rows = listing.data.map((raw) => ({ raw }));
  } else if (listing?.models !== null && typeof listing?.models === "object" && !Array.isArray(listing.models)) {
    rows = Object.entries(listing.models).filter(([, raw]) => raw !== null && typeof raw === "object" && !Array.isArray(raw)).map(([key, raw]) => ({ key, raw }));
  } else {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const models = [];
  for (const { key, raw } of rows.slice(0, 2e3)) {
    const entry = raw;
    const id = listingLabel(key, entry?.id);
    if (id === void 0 || seen.has(id)) continue;
    seen.add(id);
    const name2 = listingLabel(entry?.name, entry?.displayName, entry?.display_name, entry?.description);
    const contextWindow = listingCapacity(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context
    );
    const maxTokens = listingCapacity(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens
    );
    models.push({
      id,
      ...name2 === void 0 || name2 === id ? {} : { name: name2 },
      ...contextWindow === void 0 ? {} : { contextWindow },
      ...maxTokens === void 0 ? {} : { maxTokens }
    });
  }
  return models;
}
async function discoverModels(baseURL, apiKey, fetchImpl = globalThis.fetch, api) {
  const url = modelListingUrl(baseURL, api);
  const headers = { accept: "application/json" };
  if (api === "anthropic-messages") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (apiKey !== void 0 && apiKey.length > 0) headers["x-api-key"] = apiKey;
  } else if (apiKey !== void 0 && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15e3) });
    if (!response.ok) return [];
    return readModelListing(JSON.parse(await response.text()));
  } catch {
    return [];
  }
}
async function discoverRouteModels(deps, manifest, baseURL, apiKey) {
  const llm = deps.llm;
  if (llm === void 0) return [];
  try {
    const found = await llm.discoverModels(routeSettingsNs(manifest), {
      provider: manifest.id,
      baseURL,
      api: manifest.protocol,
      ...apiKey === void 0 || apiKey.length === 0 ? {} : { apiKey }
    });
    return found.flatMap((model) => {
      if (model.id === "") return [];
      const input = (model.inputModalities ?? []).filter((modality) => typeof modality === "string" && modality !== "");
      return [{
        id: model.id,
        ...model.name === void 0 || model.name === model.id ? {} : { name: model.name },
        ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
        ...input.length === 0 ? {} : { input }
      }];
    });
  } catch {
    return [];
  }
}
async function discoverServiceModels(deps, manifest, baseURL, apiKey) {
  if (manifest.delivery === "direct") return discoverRouteModels(deps, manifest, baseURL, apiKey);
  let key = apiKey;
  const ref = manifest.auth.apiKeyEnv;
  if (key === void 0 && ref !== void 0 && deps.credentials !== void 0) {
    try {
      key = (await deps.credentials.resolve(ref))?.value;
    } catch {
      key = void 0;
    }
  }
  const listed = await discoverModels(baseURL, key, deps.fetchImpl, manifest.protocol);
  return listed.length > 0 ? listed : discoverRouteModels(deps, manifest, baseURL, key);
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
var PLACEHOLDER_CREDENTIAL = "placeholder";
async function commitRoute(deps, manifest, mode, models, key, overrides = {}) {
  if (deps.settings === void 0) throw new Error("settings seam absent \u2014 cannot write the route");
  const pending = pendingRestartForManifest(deps, manifest);
  if (pending !== void 0) throw new Error(pending.message);
  const credentials = deps.credentials;
  const ref = manifest.pool?.identities[0]?.credentialRef ?? manifest.auth.apiKeyEnv;
  let value = key?.trim() ?? "";
  let previous;
  if (value === "" && ref !== void 0 && manifest.auth.kind === "placeholder") {
    if (credentials === void 0) throw new Error("credentials seam absent \u2014 cannot store the placeholder credential");
    previous = await credentials.resolve(ref);
    if (previous?.value === void 0) value = PLACEHOLDER_CREDENTIAL;
  }
  const store = value !== "" && ref !== void 0;
  if (store) {
    if (credentials === void 0) throw new Error("credentials seam absent \u2014 cannot store the key");
    previous ??= await credentials.resolve(ref);
    await credentials.set(ref, value);
  }
  let route;
  try {
    route = await writeRoute(deps, manifest, mode, models, overrides);
  } catch (error) {
    if (store && credentials !== void 0) {
      try {
        if (previous?.value !== void 0) await credentials.set(ref, previous.value);
        else await credentials.unset(ref);
      } catch (rollbackError) {
        const cause = error instanceof Error ? error.message : String(error);
        const failed2 = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${cause} (credential rollback also failed: ${failed2})`);
      }
    }
    throw error;
  }
  return { route, credentialStored: store };
}
async function useDetectedInstance(deps, manifest, key, options = {}) {
  const direct = manifest.delivery === "direct";
  const typedOrigin = options.baseURL === void 0 ? void 0 : instanceBaseURLFromInput(options.baseURL);
  if (options.baseURL !== void 0 && typedOrigin === void 0) {
    throw new Error("invalid custom instance base URL");
  }
  const customBase = typedOrigin === void 0 ? void 0 : `${typedOrigin}${urlPath(manifest.reuse.baseURL)}`;
  const profile = configuredProfile(deps, manifest.id, routeSettingsNs(manifest));
  const configuredBase = typeof profile?.baseURL === "string" ? profile.baseURL : void 0;
  const detection = direct || customBase !== void 0 ? void 0 : await detectInstance(deps, manifest, configuredBase);
  const endpoint = direct ? manifest.reuse.baseURL : customBase ?? (detection.ok ? detection.baseURL : manifest.reuse.baseURL);
  const models = await discoverServiceModels(deps, manifest, endpoint, key);
  const health = direct ? await probeHealth(manifest.reuse.health, deps.fetchImpl) : typedOrigin !== void 0 ? await probeHealth(healthForBase(manifest, typedOrigin), deps.fetchImpl) : detection.health;
  const { route, credentialStored } = await commitRoute(deps, manifest, "reuse", models, key, { baseURL: endpoint });
  const customPort = typedOrigin === void 0 ? void 0 : urlPort(typedOrigin);
  return {
    route,
    health,
    models,
    credentialStored,
    ...detection?.ok === true && detection.port !== void 0 ? { port: detection.port } : customPort === void 0 ? {} : { port: customPort },
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
function credentialRefInUse(deps, manifest, ref) {
  const entries = deps.settings?.describe?.();
  if (entries === void 0) return false;
  const removedNs = routeSettingsNs(manifest);
  for (const entry of entries) {
    const value = entry.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const providers = value.providers;
    if (providers === null || typeof providers !== "object" || Array.isArray(providers)) continue;
    for (const [id, raw] of Object.entries(providers)) {
      if (entry.ns === removedNs && id === manifest.id) continue;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const route = raw;
      if (route.apiKeyEnv === ref) return true;
      const pool = route.pool;
      if (pool === null || typeof pool !== "object" || Array.isArray(pool)) continue;
      const identities = pool.identities;
      if (!Array.isArray(identities)) continue;
      if (identities.some((identity) => identity !== null && typeof identity === "object" && !Array.isArray(identity) && identity.credentialRef === ref)) return true;
    }
  }
  return false;
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
  const warnings = [];
  let credentialRemoved = false;
  const credentialRef = manifest.auth.apiKeyEnv;
  if (deps.credentials !== void 0 && credentialRef !== void 0) {
    if (credentialRefInUse(deps, manifest, credentialRef)) {
      warnings.push(`credential ${credentialRef} kept: another configured route references it`);
    } else {
      try {
        await deps.credentials.unset(credentialRef);
        credentialRemoved = true;
      } catch (error) {
        errors.push(`credential: ${error instanceof Error ? error.message : String(error)}`);
      }
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
  return { routeRemoved, credentialRemoved, poolStateRemoved, cacheEntryRemoved, chainLinksRemoved, teardown, warnings, errors };
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
var MAX_BASE_URL_CHARS = 2048;
function optionalBaseURL(value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw new RemoteError("gateway/bad-request", "enpoiHeavy: baseURL must be a string", {});
  if (value.trim() === "") return void 0;
  if (value.length > MAX_BASE_URL_CHARS) throw new RemoteError("gateway/bad-request", "enpoiHeavy: baseURL is too long", {});
  const normalized = instanceBaseURLFromInput(value);
  if (normalized === void 0) {
    throw new RemoteError("gateway/bad-request", "enpoiHeavy: baseURL must be an absolute http(s) URL", {});
  }
  return normalized;
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
    const direct = manifest.delivery === "direct";
    const detection = direct ? void 0 : await detectInstance(deps, manifest, configuredBase);
    const runtime = await this.runtime();
    const preflight = chooseLocalPath(
      manifest,
      process.platform,
      runtime,
      detection?.ok === true ? detection.port : void 0,
      { home: deps.home, dshHome: deps.dshHome }
    );
    const health = configuredBase !== void 0 ? await probeHealth(healthForBase(manifest, configuredBase), deps.fetchImpl) : direct ? await probeHealth(manifest.reuse.health, deps.fetchImpl) : detection.health;
    const settingsReady = settingsNamespaceReady(deps, settingsNs);
    const job = visibleJobSnapshot(this.options.jobs.snapshot(manifest.id), configured);
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
      ...detection?.ok === true && detection.port !== void 0 ? { detectedPort: detection.port } : {},
      ...detection?.ok === true ? { detectedEndpoint: detection.baseURL } : {},
      ...manifest.unsupported === void 0 ? {} : { unsupported: manifest.unsupported },
      ...job === void 0 ? {} : { job }
    };
  }
  async reuse(request) {
    const manifest = this.effectiveManifest(requireManifest(request?.id));
    const key = optionalKey(request?.key);
    const baseURL = optionalBaseURL(request?.baseURL);
    if (baseURL !== void 0 && manifest.delivery === "direct") {
      throw new RemoteError(
        "gateway/bad-request",
        `enpoiHeavy: "${manifest.id}" is a direct vendor route; a custom instance URL does not apply`,
        {}
      );
    }
    if (manifest.unsupported !== void 0) {
      return { ok: false, blocked: { reason: manifest.unsupported.reason, plannedWith: manifest.unsupported.plannedWith } };
    }
    const deps = this.options.deps();
    const pendingRestart = pendingRestartForManifest(deps, manifest);
    if (pendingRestart !== void 0) {
      this.options.log?.(`reuse ${manifest.id}: waiting for restart (${pendingRestart.ns} is not mounted)`);
      return { ok: false, pendingRestart };
    }
    const outcome = await useDetectedInstance(deps, manifest, key, baseURL === void 0 ? {} : { baseURL });
    this.options.log?.(`detected ${manifest.id}: health=${outcome.health.ok ? "ok" : "down"} endpoint=${outcome.endpoint} models=${String(outcome.models.length)}`);
    return { ok: true, ...outcome };
  }
  install(request) {
    const manifest = requireManifest(request?.id);
    const key = optionalKey(request?.key);
    if (manifest.unsupported !== void 0) {
      return { ok: false, blocked: { reason: manifest.unsupported.reason, plannedWith: manifest.unsupported.plannedWith } };
    }
    const platformBlocked = platformUnsupported(manifest, process.platform);
    if (platformBlocked !== void 0) {
      this.options.log?.(`install ${manifest.id}: refused on ${process.platform} (${platformBlocked})`);
      return { ok: false, blocked: { reason: platformBlocked, plannedWith: 'run the service manually and add it with "Use a detected instance"' } };
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
      const models = await discoverServiceModels(current, manifest, modeBaseURL(manifest, "local"), key);
      await commitRoute(current, manifest, "local", models, key);
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
  try {
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
  } catch (error) {
    throw new Error(
      `could not start (${error instanceof Error ? error.message : String(error)}). Heavy-provider install steps run as POSIX shell with /bin/bash \u2014 on Windows install Git Bash, or run the service manually and add it with "Use a detected instance".`
    );
  }
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
      llm: ctx.get("llm"),
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
