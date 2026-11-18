// src/index.ts
import Schema from "@deepseek-ai/schemastery";

// src/util.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function trimmedString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed === "" ? void 0 : trimmed;
}

// src/chains.ts
var RESOLVED_GROUPS_ARTIFACT = "modelChains.resolved";
function readChainArtifact(settings) {
  try {
    return settings?.readArtifact?.(RESOLVED_GROUPS_ARTIFACT)?.value;
  } catch {
    return void 0;
  }
}
function parseMembers(raw) {
  if (!Array.isArray(raw)) return [];
  const members = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const provider = trimmedString(candidate.provider);
    const model = trimmedString(candidate.model);
    if (provider === void 0 || model === void 0) continue;
    const effort = trimmedString(candidate.effort);
    members.push(Object.freeze({
      provider,
      model,
      ...effort === void 0 ? {} : { effort }
    }));
  }
  return members;
}
function hasAdoptedSelector(raw) {
  for (const field of ["selectors", "selectorMatches"]) {
    const list = raw[field];
    if (!Array.isArray(list)) continue;
    if (list.some((item) => isRecord(item) && item.adopt === true)) return true;
  }
  return false;
}
function parseResolvedChains(value) {
  const chains = /* @__PURE__ */ new Map();
  if (!isRecord(value)) return chains;
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw) || raw.disabled === true) continue;
    const members = parseMembers(raw.members);
    if (members.length === 0) continue;
    const label = trimmedString(raw.label);
    chains.set(id, {
      id,
      ...label === void 0 ? {} : { label },
      dynamic: hasAdoptedSelector(raw),
      members
    });
  }
  return chains;
}
function readCoolingRoutes(view, now) {
  const cooling = /* @__PURE__ */ new Map();
  for (const raw of view) {
    if (!isRecord(raw)) continue;
    const provider = trimmedString(raw.provider);
    const model = trimmedString(raw.model);
    const until = raw.coolingUntil;
    if (provider === void 0 || model === void 0) continue;
    if (typeof until !== "number" || !Number.isFinite(until) || until <= now) continue;
    const key = `${provider}/${model}`;
    const current = cooling.get(key);
    if (current === void 0 || until > current) cooling.set(key, until);
  }
  return cooling;
}

// src/facts.ts
import {
  parseRulesDocument,
  readCatalogue,
  resolvePrivacy
} from "dsh-enpoi-catalog-rules";
import { readOrchestrationDocument, readSettingsDocument } from "dsh-enpoi-contracts";
function routeKey(provider, model) {
  return `${provider}/${model}`;
}
function knownCosts(entry) {
  return [entry.cost?.input, entry.cost?.output].filter((value) => typeof value === "number" && Number.isFinite(value));
}
function visionOf(entry) {
  if (entry.input === void 0) return "unknown";
  return entry.input.includes("image") || entry.input.includes("vision");
}
function trainsOnDataOf(verdict) {
  if (verdict === "no-train") return "no";
  if (verdict === "trains") return "yes";
  return "unknown";
}
function projectReasoningEfforts(raw) {
  if (Array.isArray(raw)) {
    return Object.freeze(raw.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item !== "").sort());
  }
  if (isRecord(raw)) return Object.freeze(Object.keys(raw).filter((key) => key.trim() !== "").sort());
  return Object.freeze([]);
}
function readRawEfforts(settings) {
  const efforts = /* @__PURE__ */ new Map();
  const document = readSettingsDocument(settings, "llm-pi-ai");
  const providers = document?.providers;
  if (!isRecord(providers)) return efforts;
  for (const [provider, profile] of Object.entries(providers)) {
    if (!isRecord(profile) || !Array.isArray(profile.models)) continue;
    for (const raw of profile.models) {
      if (!isRecord(raw)) continue;
      const id = trimmedString(raw.id);
      if (id === void 0) continue;
      const key = routeKey(provider, id);
      if (!efforts.has(key)) efforts.set(key, raw.reasoningEfforts);
    }
  }
  return efforts;
}
function readGatedCatalogue(rules, settings) {
  if (rules !== void 0) {
    try {
      return rules.catalogue?.() ?? [];
    } catch {
      return [];
    }
  }
  return readCatalogue(settings);
}
function zeroPriceKeysOf(expansion) {
  if (expansion === void 0) return void 0;
  return new Set(expansion.links.map((link) => routeKey(link.provider, link.model)));
}
function readZeroPriceKeys(rules) {
  if (rules?.expandRawSelector === void 0) return void 0;
  try {
    return zeroPriceKeysOf(rules.expandRawSelector({ when: { zeroPrice: true } }));
  } catch {
    return void 0;
  }
}
function readPrivacyOverrides(settings) {
  return parseRulesDocument(readOrchestrationDocument(settings)?.catalogRules).privacy;
}
function projectRouteFacts(options) {
  const facts = /* @__PURE__ */ new Map();
  for (const entry of options.entries) {
    const key = routeKey(entry.provider, entry.id);
    if (facts.has(key)) continue;
    const costs = knownCosts(entry);
    facts.set(key, {
      provider: entry.provider,
      model: entry.id,
      tools: entry.tools === true ? true : entry.tools === false ? false : "unknown",
      vision: visionOf(entry),
      ...entry.contextWindow === void 0 ? {} : { contextWindow: entry.contextWindow },
      zeroPrice: costs.length === 0 || options.zeroPriceKeys === void 0 ? "unknown" : options.zeroPriceKeys.has(key),
      gated: entry.gated === true,
      deprecated: entry.deprecated === true,
      trainsOnData: trainsOnDataOf(resolvePrivacy(entry.provider, entry.id, options.privacy)),
      reasoningEfforts: projectReasoningEfforts(options.rawEfforts.get(key))
    });
  }
  return facts;
}

// src/policy.ts
var REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/gu;
function matchesPattern(pattern, value) {
  const source = pattern.split("*").map((part) => part.replace(REGEX_METACHARACTERS, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "u").test(value);
}
function policyAllowsChain(policy, id) {
  return policy.allowChains?.includes(id) === true;
}
function policyAllowsModel(policy, provider, model) {
  const patterns = policy.allowModels;
  if (patterns === void 0 || patterns.length === 0) return false;
  return patterns.some((pattern) => matchesPattern(pattern, `${provider}/${model}`));
}
function policyAllowsEffort(policy, effort) {
  const allowed = policy.allowReasoningEfforts;
  if (allowed === void 0) return true;
  return allowed.includes(effort);
}

// src/engine.ts
function checkEffort(facts, policy, effort) {
  if (!policyAllowsEffort(policy, effort)) return { allowed: false, reason: "effort-not-allowed", denied: effort };
  if (!facts.reasoningEfforts.includes(effort)) return { allowed: false, reason: "effort-not-allowed", denied: effort };
  return void 0;
}
function checkRouteFacts(facts, policy, options) {
  const key = routeKey(facts.provider, facts.model);
  if (facts.gated === true) return { allowed: false, reason: "model-not-allowed", denied: key };
  if (facts.deprecated === true) return { allowed: false, reason: "model-not-allowed", denied: key };
  if (options.requireExplicitModel) {
    if (!policyAllowsModel(policy, facts.provider, facts.model)) {
      return { allowed: false, reason: "model-not-allowed", denied: key };
    }
  } else if (policy.allowModels !== void 0 && policy.allowModels.length > 0) {
    if (!policyAllowsModel(policy, facts.provider, facts.model)) {
      return { allowed: false, reason: "model-not-allowed", denied: key };
    }
  }
  if (policy.requireZeroPrice === true && facts.zeroPrice !== true) {
    return { allowed: false, reason: "price-unproven", denied: key };
  }
  if (policy.requireNoTraining === true && facts.trainsOnData !== "no") {
    return { allowed: false, reason: "training-unproven", denied: key };
  }
  if (policy.requireTools === true && facts.tools !== true) {
    return { allowed: false, reason: "tools-unproven", denied: key };
  }
  if (options.effort !== void 0) {
    const denied = checkEffort(facts, policy, options.effort);
    if (denied !== void 0) return denied;
  }
  return { allowed: true };
}
function toPeerModelInfo(facts) {
  return {
    provider: facts.provider,
    model: facts.model,
    tools: facts.tools,
    vision: facts.vision,
    ...facts.contextWindow === void 0 ? {} : { contextWindow: facts.contextWindow },
    zeroPrice: facts.zeroPrice,
    gated: facts.gated,
    trainsOnData: facts.trainsOnData,
    reasoningEfforts: [...facts.reasoningEfforts]
  };
}
function passesFilter(info, filter) {
  if (filter === void 0) return true;
  if (filter.zeroPrice !== void 0 && info.zeroPrice !== filter.zeroPrice) return false;
  if (filter.tools !== void 0 && info.tools !== filter.tools) return false;
  if (filter.gated !== void 0 && info.gated !== filter.gated) return false;
  const minContextWindow = filter.minContextWindow;
  if (typeof minContextWindow === "number" && Number.isFinite(minContextWindow) && minContextWindow > 0) {
    if (info.contextWindow === void 0 || info.contextWindow < minContextWindow) return false;
  }
  return true;
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function compareRoutes(left, right) {
  return compareText(left.provider, right.provider) || compareText(left.model, right.model);
}
function encodeCursor(position) {
  return Buffer.from(JSON.stringify([position.provider, position.model]), "utf8").toString("base64url");
}
function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("invalid cursor");
  const provider = trimmedString(parsed[0]);
  const model = trimmedString(parsed[1]);
  if (provider === void 0 || model === void 0) throw new Error("invalid cursor");
  return { provider, model };
}
function firstAfter(models, position) {
  for (let index = 0; index < models.length; index += 1) {
    if (compareRoutes(models[index], position) > 0) return index;
  }
  return models.length;
}
var PeerRoutingEngine = class _PeerRoutingEngine {
  /**
   * @param sources - every external read, called fresh per request.
   * @param limits - page-size bounds from the plugin config.
   */
  constructor(sources, limits) {
    this.sources = sources;
    this.maxLimit = limits.maxLimit > 0 ? limits.maxLimit : 1;
    this.defaultLimit = limits.defaultLimit > 0 ? Math.min(limits.defaultLimit, this.maxLimit) : this.maxLimit;
  }
  defaultLimit;
  maxLimit;
  /** Read the catalogue, chains, and route health once for one request. */
  snapshot() {
    const now = this.sources.now();
    return {
      facts: projectRouteFacts({
        entries: this.sources.catalogue(),
        rawEfforts: this.sources.rawEfforts(),
        zeroPriceKeys: this.sources.zeroPriceKeys(),
        privacy: this.sources.privacy()
      }),
      chains: parseResolvedChains(this.sources.chains()),
      cooling: readCoolingRoutes(this.sources.routeHealth(), now),
      now
    };
  }
  /**
   * Resolve the first ready member of a chain, falling back to the first
   * declared member when every member is cooling.
   * @param chain - resolved chain.
   * @param cooling - cooling keys for this snapshot.
   * @returns the member to select.
   */
  static firstReady(chain, cooling) {
    for (const member of chain.members) {
      if (!cooling.has(routeKey(member.provider, member.model))) return member;
    }
    return chain.members[0];
  }
  /** Build one successful verdict with its concrete selection. */
  static allow(provider, model, chain, effort) {
    return {
      allowed: true,
      selection: {
        provider,
        model,
        ...chain === void 0 ? {} : { chain },
        ...effort === void 0 ? {} : { reasoningEffort: effort }
      }
    };
  }
  /**
   * Validate the EFFECTIVE effort of a concrete chain member (caller-named,
   * else the chain link's declared effort) and build the verdict. A chain link
   * effort is operator configuration, but the caller selects the chain, so it
   * still has to sit inside the policy's effort allowlist.
   * @param member - concrete chain member.
   * @param facts - member facts from the same snapshot.
   * @param policy - pairing routing policy.
   * @param chainId - selected chain id.
   * @param effort - caller-named effort, when supplied.
   * @returns the verdict.
   */
  static allowMember(member, facts, policy, chainId, effort) {
    const effective = effort ?? member.effort;
    if (effective !== void 0) {
      const denied = checkEffort(facts, policy, effective);
      if (denied !== void 0) return denied;
    }
    return _PeerRoutingEngine.allow(member.provider, member.model, chainId, effective);
  }
  /**
   * Evaluate one requested selection against a pairing's routing policy.
   *
   * Cases: chain only (membership grant), pinned provider/model (allowModels
   * grant), and pinned provider/model plus chain (both). Every member of a
   * selected chain is re-checked against the policy at call time so a dynamic
   * chain that drifted to include a paid, training, gated, or disallowed model
   * is refused before the host applies it.
   * @param policy - pairing routing policy.
   * @param selection - caller-requested route or chain.
   * @returns allowed with the concrete selection, or the refusal.
   */
  async evaluate(policy, selection) {
    const provider = trimmedString(selection.provider);
    const model = trimmedString(selection.model);
    const chainId = trimmedString(selection.chain);
    const effort = trimmedString(selection.reasoningEffort);
    const snapshot = this.snapshot();
    if (chainId !== void 0) {
      if (!policyAllowsChain(policy, chainId)) return { allowed: false, reason: "chain-not-allowed", denied: chainId };
      const chain = snapshot.chains.get(chainId);
      if (chain === void 0) return { allowed: false, reason: "unknown-route", denied: chainId };
      for (const member of chain.members) {
        const key2 = routeKey(member.provider, member.model);
        const facts3 = snapshot.facts.get(key2);
        if (facts3 === void 0) return { allowed: false, reason: "unknown-route", denied: key2 };
        const check2 = checkRouteFacts(facts3, policy, { requireExplicitModel: false });
        if (!check2.allowed) return check2;
      }
      if (provider !== void 0 || model !== void 0) {
        if (provider === void 0 || model === void 0) {
          return { allowed: false, reason: "unknown-route", denied: routeKey(provider ?? "", model ?? "") };
        }
        const key2 = routeKey(provider, model);
        const member = chain.members.find((candidate) => candidate.provider === provider && candidate.model === model);
        if (member === void 0) return { allowed: false, reason: "model-not-allowed", denied: key2 };
        const facts3 = snapshot.facts.get(key2);
        const check2 = checkRouteFacts(facts3, policy, { requireExplicitModel: true });
        if (!check2.allowed) return check2;
        return _PeerRoutingEngine.allowMember(member, facts3, policy, chain.id, effort);
      }
      const chosen = _PeerRoutingEngine.firstReady(chain, snapshot.cooling);
      const facts2 = snapshot.facts.get(routeKey(chosen.provider, chosen.model));
      return _PeerRoutingEngine.allowMember(chosen, facts2, policy, chain.id, effort);
    }
    if (provider === void 0 || model === void 0) {
      return { allowed: false, reason: "unknown-route", denied: routeKey(provider ?? "", model ?? "") };
    }
    const key = routeKey(provider, model);
    const facts = snapshot.facts.get(key);
    if (facts === void 0) return { allowed: false, reason: "unknown-route", denied: key };
    const check = checkRouteFacts(facts, policy, {
      requireExplicitModel: true,
      ...effort === void 0 ? {} : { effort }
    });
    if (!check.allowed) return check;
    return _PeerRoutingEngine.allow(provider, model, void 0, effort);
  }
  /** Discovery chains: every allowed and resolvable chain, with live member state. */
  chainInfos(policy, snapshot) {
    const chains = [];
    const seen = /* @__PURE__ */ new Set();
    for (const id of policy.allowChains ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const chain = snapshot.chains.get(id);
      if (chain === void 0) continue;
      chains.push({
        id: chain.id,
        ...chain.label === void 0 ? {} : { label: chain.label },
        dynamic: chain.dynamic,
        members: chain.members.map((member) => {
          const key = routeKey(member.provider, member.model);
          if (snapshot.facts.get(key)?.deprecated === true) {
            return { provider: member.provider, model: member.model, state: "deprecated" };
          }
          const until = snapshot.cooling.get(key);
          return until === void 0 ? { provider: member.provider, model: member.model, state: "ready" } : { provider: member.provider, model: member.model, state: "cooldown", cooldownUntil: until };
        })
      });
    }
    return chains;
  }
  /** Discovery rows: every route the pinned predicate accepts, sorted. */
  modelInfos(policy, snapshot, filter) {
    const models = [];
    for (const facts of snapshot.facts.values()) {
      const check = checkRouteFacts(facts, policy, { requireExplicitModel: true });
      if (!check.allowed) continue;
      const info = toPeerModelInfo(facts);
      if (!passesFilter(info, filter)) continue;
      models.push(info);
    }
    models.sort(compareRoutes);
    return models;
  }
  /** Effective page size: bounded, with the configured default for a bad request. */
  pageLimit(limit) {
    if (limit === void 0 || !Number.isSafeInteger(limit) || limit <= 0) return this.defaultLimit;
    return Math.min(limit, this.maxLimit);
  }
  /**
   * Policy-filtered discovery. Chains carry their full resolved membership (so
   * a controller can see cooldowns); models carry only routes the pinned policy
   * predicate accepts. Results are ordered `(provider, model)` and paginated by
   * an opaque cursor.
   * @param policy - pairing routing policy.
   * @param request - optional filter, cursor, and page size.
   * @returns the page and an optional continuation cursor.
   * @throws Error `invalid cursor` when `request.cursor` was not minted here.
   */
  async discover(policy, request) {
    const snapshot = this.snapshot();
    const chains = this.chainInfos(policy, snapshot);
    const models = this.modelInfos(policy, snapshot, request.filter);
    const start = request.cursor === void 0 ? 0 : firstAfter(models, decodeCursor(request.cursor));
    const limit = this.pageLimit(request.limit);
    const page = models.slice(start, start + limit);
    const nextCursor = start + limit < models.length ? encodeCursor(page[page.length - 1]) : void 0;
    return { chains, models: page, ...nextCursor === void 0 ? {} : { nextCursor } };
  }
};

// src/index.ts
var name = "enpoi-peer-routing";
var inject = ["settings"];
var DEFAULT_PAGE_LIMIT = 100;
var MAX_PAGE_LIMIT = 500;
var Config = Schema.object({
  defaultLimit: Schema.natural().min(1).default(DEFAULT_PAGE_LIMIT),
  maxLimit: Schema.natural().min(1).default(MAX_PAGE_LIMIT)
});
function apply(ctx, config = {}) {
  const settings = () => ctx.get("settings");
  const sources = {
    catalogue: () => readGatedCatalogue(
      ctx.get("catalogRules"),
      settings()
    ),
    zeroPriceKeys: () => readZeroPriceKeys(ctx.get("catalogRules")),
    privacy: () => readPrivacyOverrides(settings()),
    rawEfforts: () => readRawEfforts(settings()),
    chains: () => readChainArtifact(ctx.get("settings")),
    routeHealth: () => {
      try {
        const view = ctx.get("llm")?.routeHealth?.();
        return Array.isArray(view) ? view : [];
      } catch {
        return [];
      }
    },
    now: () => Date.now()
  };
  const engine = new PeerRoutingEngine(sources, {
    defaultLimit: config.defaultLimit ?? DEFAULT_PAGE_LIMIT,
    maxLimit: config.maxLimit ?? MAX_PAGE_LIMIT
  });
  const service = {
    evaluate: (policy, selection) => engine.evaluate(policy, selection),
    discover: (policy, request) => engine.discover(policy, request)
  };
  ctx.provide("peerRouting", service);
  process.stderr.write("[enpoi-peer-routing] mounted\n");
}
export {
  Config,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PeerRoutingEngine,
  RESOLVED_GROUPS_ARTIFACT,
  apply,
  checkEffort,
  checkRouteFacts,
  decodeCursor,
  encodeCursor,
  inject,
  matchesPattern,
  name,
  parseResolvedChains,
  passesFilter,
  policyAllowsChain,
  policyAllowsEffort,
  policyAllowsModel,
  projectReasoningEfforts,
  projectRouteFacts,
  readChainArtifact,
  readCoolingRoutes,
  readGatedCatalogue,
  readPrivacyOverrides,
  readRawEfforts,
  readZeroPriceKeys,
  routeKey,
  toPeerModelInfo,
  zeroPriceKeysOf
};
