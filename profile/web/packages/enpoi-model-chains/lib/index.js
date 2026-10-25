// src/index.ts
import { readOrchestrationDocument } from "dsh-enpoi-contracts";
var name = "enpoi-model-chains";
var inject = ["settings"];
var ORCH_NS = "enpoi-orchestration";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed === "" ? void 0 : trimmed;
}
function parseChainSelector(raw, warn) {
  if (!isRecord(raw)) {
    warn("selector is not an object \u2014 ignored\n");
    return void 0;
  }
  if (!isRecord(raw.when) || Object.keys(raw.when).length === 0) {
    warn('selector has no "when" object \u2014 ignored\n');
    return void 0;
  }
  const label = nonEmptyString(raw.label);
  return Object.freeze({
    when: Object.freeze({ ...raw.when }),
    adopt: raw.adopt === true,
    ...label !== void 0 ? { label } : {}
  });
}
function parseChainRaw(id, raw, warn) {
  if (raw === void 0 || raw === null) return void 0;
  if (!isRecord(raw)) {
    warn(`[enpoi-model-chains] chain "${id}" is not an object \u2014 ignored
`);
    return void 0;
  }
  const disabled = raw.disabled === true;
  const rawLinks = raw.links;
  if (rawLinks !== void 0 && !Array.isArray(rawLinks)) {
    warn(`[enpoi-model-chains] chain "${id}" has no links array \u2014 ignored
`);
    return void 0;
  }
  const links = [];
  let dropped = 0;
  for (const candidate of rawLinks ?? []) {
    if (!isRecord(candidate)) {
      dropped += 1;
      continue;
    }
    const provider = nonEmptyString(candidate.provider);
    const model = nonEmptyString(candidate.model);
    if (provider === void 0 || model === void 0) {
      dropped += 1;
      continue;
    }
    const effort = nonEmptyString(candidate.effort);
    links.push(Object.freeze({ provider, model, ...effort !== void 0 ? { effort } : {} }));
  }
  if (dropped > 0) {
    warn(`[enpoi-model-chains] chain "${id}": dropped ${dropped} malformed link(s) \u2014 provider and model are required
`);
  }
  const selectors = [];
  let droppedSelectors = 0;
  if (raw.selectors !== void 0) {
    if (!Array.isArray(raw.selectors)) {
      warn(`[enpoi-model-chains] chain "${id}": selectors is not an array \u2014 ignored
`);
    } else {
      for (const candidate of raw.selectors) {
        const selector = parseChainSelector(candidate, (line) => {
          warn(`[enpoi-model-chains] chain "${id}": ${line}`);
        });
        if (selector === void 0) {
          droppedSelectors += 1;
          continue;
        }
        selectors.push(selector);
      }
      if (droppedSelectors > 0) {
        warn(`[enpoi-model-chains] chain "${id}": dropped ${droppedSelectors} malformed selector(s)
`);
      }
    }
  }
  if (links.length === 0 && selectors.length === 0) {
    warn(`[enpoi-model-chains] chain "${id}" has no usable links or selectors \u2014 ignored
`);
    return void 0;
  }
  const label = nonEmptyString(raw.label);
  const attemptsValue = raw.attempts;
  const attempts = typeof attemptsValue === "number" && Number.isFinite(attemptsValue) && attemptsValue >= 1 ? Math.floor(attemptsValue) : void 0;
  const onCut = raw.onCut === "continue" ? "continue" : raw.onCut === "failover" ? "failover" : void 0;
  return {
    disabled,
    chain: Object.freeze({
      id,
      ...label !== void 0 ? { label } : {},
      links: Object.freeze(links),
      ...selectors.length > 0 ? { selectors: Object.freeze(selectors) } : {},
      ...attempts !== void 0 ? { attempts } : {},
      ...onCut !== void 0 ? { onCut } : {}
    })
  };
}
function parseChainEntry(id, raw, warn) {
  const parsed = parseChainRaw(id, raw, warn);
  if (parsed === void 0 || parsed.disabled) return void 0;
  return parsed.chain;
}
function readRawChains(ctx) {
  try {
    const doc = readOrchestrationDocument(ctx.get("settings"));
    if (!isRecord(doc)) return {};
    const chains = doc.chains;
    if (chains === void 0) return {};
    if (!isRecord(chains)) {
      process.stderr.write(`[enpoi-model-chains] "${ORCH_NS}.chains" is not a map \u2014 ignored
`);
      return {};
    }
    return chains;
  } catch (error) {
    process.stderr.write(`[enpoi-model-chains] cannot read "${ORCH_NS}.chains": ${String(error)}
`);
    return {};
  }
}
function linkKey(link) {
  return `${link.provider}/${link.model}`;
}
var ModelChainsResolver = class {
  /**
   * @param readRaw - reader for the raw `chains` map (ctx-bound in production).
   * @param options - optional selector expander and warning sink.
   */
  constructor(readRaw, options = {}) {
    this.readRaw = readRaw;
    this.options = options;
    this.raw = this.readRaw();
  }
  readRaw;
  options;
  raw;
  cache = /* @__PURE__ */ new Map();
  warned = /* @__PURE__ */ new Set();
  selectorWarned = /* @__PURE__ */ new Set();
  announced = /* @__PURE__ */ new Set();
  lastResolved = /* @__PURE__ */ new Map();
  baselines = /* @__PURE__ */ new Map();
  /** Memoized resolved-group projection; cleared whenever an input moves. */
  resolved;
  /** Re-read the settings document; the next resolve builds fresh snapshots. */
  refresh() {
    this.raw = this.readRaw();
    this.cache.clear();
    this.resolved = void 0;
    this.baselines.clear();
  }
  /**
   * Drop the memoized projection without re-baselining selectors. A catalogue
   * change moves what the selectors match but is not an operator adoption
   * decision, so `adopt: false` baselines must survive it.
   */
  invalidateResolvedGroups() {
    this.resolved = void 0;
  }
  /**
   * Project every stored group into its resolved state for the published
   * artifact. Disabled groups are included (clients render them as disabled)
   * and the projection never records an adoption baseline, so publishing it
   * cannot change what a later `resolve()` answers.
   * @returns the resolved state of every usable group, keyed by group id.
   */
  resolvedGroups() {
    if (this.resolved !== void 0) return this.resolved;
    const groups = {};
    for (const [id, raw] of Object.entries(this.raw)) {
      const parseWarnings = [];
      const parsed = parseChainRaw(id, raw, (line) => parseWarnings.push(line));
      if (parsed === void 0) continue;
      const { chain, disabled } = parsed;
      const expanded = this.expandChain(chain, false, false);
      groups[id] = Object.freeze({
        id,
        ...chain.label !== void 0 ? { label: chain.label } : {},
        links: chain.links,
        selectors: chain.selectors ?? Object.freeze([]),
        selectorMatches: Object.freeze(expanded.selectorMatches),
        members: Object.freeze(expanded.links),
        candidates: Object.freeze(expanded.candidates),
        warnings: Object.freeze([...parseWarnings, ...expanded.warnings]),
        ...chain.attempts !== void 0 ? { attempts: chain.attempts } : {},
        ...chain.onCut !== void 0 ? { onCut: chain.onCut } : {},
        disabled,
        source: "settings"
      });
    }
    this.resolved = Object.freeze(groups);
    return this.resolved;
  }
  /** The warning sink: injected in tests, stderr in production. */
  warn(line) {
    ;
    (this.options.warn ?? ((text) => {
      process.stderr.write(text);
    }))(line);
  }
  /** Parse (and cache) one chain, with per-id warning dedupe. */
  chainOf(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    let reported = false;
    const chain = parseChainEntry(key, this.raw[key], (line) => {
      if (reported || this.warned.has(key)) return;
      reported = true;
      this.warned.add(key);
      this.warn(line);
    });
    if (chain !== void 0) this.warned.delete(key);
    this.cache.set(key, chain);
    return chain;
  }
  /**
   * Merge explicit links with selector matches.
   * @param chain - parsed chain.
   * @param announce - whether newly joined links should be announced.
   * @param persist - whether an `adopt: false` baseline may be recorded (the
   *   published artifact projects without touching resolve state).
   * @returns merged links, candidates held back by `adopt: false`, warnings,
   *   and the per-selector expansion the artifact carries.
   */
  expandChain(chain, announce, persist = true) {
    const links = [];
    const seen = /* @__PURE__ */ new Set();
    const warnings = [];
    const candidates = [];
    const selectorMatches = [];
    const add = (link) => {
      const key = linkKey(link);
      if (seen.has(key)) return;
      seen.add(key);
      links.push(link);
    };
    for (const link of chain.links) add(link);
    const selectors = chain.selectors ?? [];
    selectors.forEach((selector, index) => {
      const selectorWarnings = [];
      if (this.options.expandSelector === void 0) {
        const line = `[enpoi-model-chains] chain "${chain.id}" selector #${String(index + 1)}: catalogRules service absent \u2014 selector ignored
`;
        selectorWarnings.push(line);
        warnings.push(line);
        selectorMatches.push(Object.freeze({
          index,
          when: selector.when,
          adopt: selector.adopt,
          ...selector.label !== void 0 ? { label: selector.label } : {},
          links: Object.freeze([]),
          warnings: Object.freeze(selectorWarnings)
        }));
        return;
      }
      const selectionKey = `${chain.id}#${String(index)}`;
      let expansion;
      try {
        expansion = this.options.expandSelector(selector, chain.id, index);
      } catch (error) {
        const line = `[enpoi-model-chains] chain "${chain.id}" selector #${String(index + 1)} failed: ${error instanceof Error ? error.message : String(error)}
`;
        selectorWarnings.push(line);
        warnings.push(line);
        selectorMatches.push(Object.freeze({
          index,
          when: selector.when,
          adopt: selector.adopt,
          ...selector.label !== void 0 ? { label: selector.label } : {},
          links: Object.freeze([]),
          warnings: Object.freeze(selectorWarnings)
        }));
        return;
      }
      for (const line of expansion.warnings ?? []) {
        selectorWarnings.push(line);
        warnings.push(line);
      }
      const matches = expansion.links.map((link) => Object.freeze({ provider: link.provider, model: link.model }));
      selectorMatches.push(Object.freeze({
        index,
        when: selector.when,
        adopt: selector.adopt,
        ...selector.label !== void 0 ? { label: selector.label } : {},
        links: Object.freeze(matches),
        warnings: Object.freeze(selectorWarnings)
      }));
      if (selector.adopt === false) {
        let baseline = this.baselines.get(selectionKey);
        if (baseline === void 0) {
          baseline = new Set(matches.map(linkKey));
          if (persist) this.baselines.set(selectionKey, baseline);
        }
        for (const link of matches) {
          if (baseline.has(linkKey(link))) add(link);
          else candidates.push(link);
        }
      } else {
        for (const link of matches) add(link);
      }
    });
    if (candidates.length > 0) {
      const names = candidates.map(linkKey).join(", ");
      warnings.push(`[enpoi-model-chains] chain "${chain.id}": ${String(candidates.length)} new selector match(es) awaiting adoption (adopt: false): ${names}
`);
    }
    if (announce) {
      const previous = this.lastResolved.get(chain.id);
      if (previous !== void 0) {
        const previousKeys = new Set(previous.map(linkKey));
        for (const link of links) {
          const key = linkKey(link);
          const memo = `${chain.id}\0${key}`;
          if (previousKeys.has(key) || this.announced.has(memo)) continue;
          this.announced.add(memo);
          warnings.push(`[enpoi-model-chains] a new model joined chain "${chain.id}": ${key}
`);
        }
      }
    }
    return { links, candidates, warnings, selectorMatches };
  }
  /** Write each expansion warning once per selector position. */
  reportWarnings(chainId, warnings) {
    for (const line of warnings) {
      if (this.selectorWarned.has(line)) continue;
      this.selectorWarned.add(line);
      this.warn(line);
    }
  }
  /**
   * Resolve one chain id against the current snapshot.
   * @param id - chain id.
   * @returns the frozen chain, or undefined (unknown/disabled/malformed).
   */
  resolve(id) {
    const key = typeof id === "string" ? id.trim() : "";
    if (key === "") return void 0;
    const chain = this.chainOf(key);
    if (chain === void 0) return void 0;
    if (chain.selectors === void 0) return chain;
    const expanded = this.expandChain(chain, true);
    this.reportWarnings(key, expanded.warnings);
    if (expanded.links.length === 0) {
      this.selectorWarned.add(key);
      this.warn(`[enpoi-model-chains] chain "${key}" has no usable links or selector matches \u2014 ignored
`);
      return void 0;
    }
    const frozenLinks = Object.freeze(expanded.links.map((link) => Object.freeze(link)));
    this.lastResolved.set(key, frozenLinks);
    return Object.freeze({ ...chain, links: frozenLinks });
  }
  /**
   * Preview one chain id without changing what the next resolve answers.
   * @param id - chain id.
   * @returns current/previous links, added/removed keys, held-back candidates.
   */
  preview(id) {
    const key = typeof id === "string" ? id.trim() : "";
    if (key === "") return void 0;
    const chain = this.chainOf(key);
    if (chain === void 0) return void 0;
    if (chain.selectors === void 0) {
      return Object.freeze({
        id: key,
        links: chain.links,
        previous: this.lastResolved.get(key) ?? null,
        added: Object.freeze([]),
        removed: Object.freeze([]),
        candidates: Object.freeze([]),
        warnings: Object.freeze([])
      });
    }
    const expanded = this.expandChain(chain, false);
    const previous = this.lastResolved.get(key) ?? null;
    const currentKeys = expanded.links.map(linkKey);
    const previousKeys = (previous ?? []).map(linkKey);
    const currentSet = new Set(currentKeys);
    const previousSet = new Set(previousKeys);
    return Object.freeze({
      id: key,
      links: Object.freeze(expanded.links.map((link) => Object.freeze(link))),
      previous,
      added: Object.freeze(currentKeys.filter((candidate) => !previousSet.has(candidate))),
      removed: Object.freeze(previousKeys.filter((candidate) => !currentSet.has(candidate))),
      candidates: Object.freeze(expanded.candidates.map((link) => Object.freeze(link))),
      warnings: Object.freeze(expanded.warnings)
    });
  }
};
var RESOLVED_GROUPS_ARTIFACT = "modelChains.resolved";
var CATALOG_NS = "llm-pi-ai";
function apply(ctx) {
  const expander = (selector, chainId, selectorIndex) => {
    const rules = ctx.get("catalogRules");
    if (rules?.expandRawSelector !== void 0) return rules.expandRawSelector(selector);
    if (rules?.expandSelector !== void 0) return rules.expandSelector(selector);
    return {
      links: [],
      warnings: [`[enpoi-model-chains] chain "${chainId}" selector #${String(selectorIndex + 1)}: catalogRules service absent \u2014 selector ignored
`]
    };
  };
  const resolver = new ModelChainsResolver(() => readRawChains(ctx), { expandSelector: expander });
  const publishResolvedGroups = () => {
    const writer = ctx.get("settings");
    writer?.publishArtifact?.(RESOLVED_GROUPS_ARTIFACT, resolver.resolvedGroups());
  };
  ctx.provide("modelChains", {
    resolve: (id) => {
      const resolved = resolver.resolve(id);
      publishResolvedGroups();
      return resolved;
    },
    preview: (id) => resolver.preview(id)
  });
  const onNamespaceChange = ((ns) => {
    const key = String(ns);
    if (key === ORCH_NS) {
      resolver.refresh();
      publishResolvedGroups();
      return;
    }
    if (key !== CATALOG_NS) return;
    resolver.invalidateResolvedGroups();
    queueMicrotask(publishResolvedGroups);
  });
  ctx.on("settings/document-updated", onNamespaceChange);
  ctx.on("settings/updated", onNamespaceChange);
  publishResolvedGroups();
  process.stderr.write("[enpoi-model-chains] mounted\n");
}
export {
  ModelChainsResolver,
  RESOLVED_GROUPS_ARTIFACT,
  apply,
  inject,
  name,
  parseChainEntry,
  parseChainSelector,
  readRawChains
};
