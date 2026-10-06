// src/index.ts
import { readOrchestrationDocument } from "dsh-enpoi-contracts";

// src/rules.ts
var SEED_PRIVACY = Object.freeze({
  providers: Object.freeze({
    google: "trains",
    "google-ai-studio": "trains",
    antigravity: "trains",
    kilo: "trains",
    "kilo-code": "trains",
    mistral: "trains",
    groq: "no-train"
  }),
  models: Object.freeze({
    "mistral/mistral-large-latest": "no-train",
    "mistral/mistral-medium-latest": "no-train",
    "mistral/mistral-small-latest": "no-train",
    "mistral/codestral-latest": "no-train"
  })
});
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed === "" ? void 0 : trimmed;
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function privacyPolicy(value) {
  return value === "trains" || value === "no-train" ? value : void 0;
}
function effectivePrivacy(overrides) {
  const providers = { ...SEED_PRIVACY.providers };
  const models = { ...SEED_PRIVACY.models };
  if (overrides?.providers !== void 0 && isRecord(overrides.providers)) {
    for (const [key, value] of Object.entries(overrides.providers)) {
      const policy = privacyPolicy(value);
      if (policy !== void 0) providers[key] = policy;
    }
  }
  if (overrides?.models !== void 0 && isRecord(overrides.models)) {
    for (const [key, value] of Object.entries(overrides.models)) {
      const policy = privacyPolicy(value);
      if (policy !== void 0) models[key] = policy;
    }
  }
  return { providers, models };
}
function resolvePrivacy(provider, modelId, overrides) {
  const { providers, models } = effectivePrivacy(overrides);
  return models[`${provider}/${modelId}`] ?? models[modelId] ?? providers[provider] ?? "unknown";
}
function globMatches(pattern, value) {
  let source = "";
  for (const character of pattern) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, "i").test(value);
  } catch {
    return false;
  }
}
function knownCosts(entry) {
  const values = [entry.cost?.input, entry.cost?.output].filter((value) => typeof value === "number" && Number.isFinite(value));
  return values;
}
function isKnownZeroPrice(entry) {
  const costs = knownCosts(entry);
  return costs.length > 0 && costs.every((cost) => cost === 0);
}
function hasVision(entry) {
  return Array.isArray(entry.input) && (entry.input.includes("image") || entry.input.includes("vision"));
}
function evaluatePredicate(entry, predicate, privacy) {
  let clauses = 0;
  const fail = (failed) => ({ matched: false, failed });
  if (predicate.zeroPrice !== void 0) {
    clauses += 1;
    if (predicate.zeroPrice !== isKnownZeroPrice(entry)) return fail("zero-price");
  }
  if (predicate.maxPrice !== void 0) {
    clauses += 1;
    const costs = knownCosts(entry);
    const limit = predicate.maxPrice;
    if (costs.length === 0 || !costs.every((cost) => cost <= limit)) return fail(`price \u2264 ${String(limit)}`);
  }
  if (predicate.tools !== void 0) {
    clauses += 1;
    if (predicate.tools !== (entry.tools === true)) return fail(predicate.tools ? "tool-calling" : "no tool-calling");
  }
  if (predicate.vision !== void 0) {
    clauses += 1;
    if (predicate.vision !== hasVision(entry)) return fail(predicate.vision ? "vision" : "no vision");
  }
  if (predicate.reasoning !== void 0) {
    clauses += 1;
    if (predicate.reasoning !== (entry.reasoning === true)) return fail(predicate.reasoning ? "reasoning" : "no reasoning");
  }
  if (predicate.minContextWindow !== void 0) {
    clauses += 1;
    const context = entry.contextWindow;
    if (context === void 0 || context < predicate.minContextWindow) return fail(`context \u2265 ${String(predicate.minContextWindow)}`);
  }
  if (predicate.provider !== void 0) {
    clauses += 1;
    if (entry.provider !== predicate.provider) return fail(`provider ${predicate.provider}`);
  }
  if (predicate.providerGlob !== void 0) {
    clauses += 1;
    if (!globMatches(predicate.providerGlob, entry.provider)) return fail(`provider ~ ${predicate.providerGlob}`);
  }
  if (predicate.idGlob !== void 0) {
    clauses += 1;
    if (!globMatches(predicate.idGlob, entry.id)) return fail(`id ~ ${predicate.idGlob}`);
  }
  if (predicate.nameGlob !== void 0) {
    clauses += 1;
    if (entry.name === void 0 || !globMatches(predicate.nameGlob, entry.name)) return fail(`name ~ ${predicate.nameGlob}`);
  }
  if (predicate.noTraining !== void 0) {
    clauses += 1;
    const wanted = predicate.noTraining ? "no-train" : "trains";
    if (privacy !== wanted) return fail(predicate.noTraining ? "no-training" : "trains-on-content");
  }
  if (predicate.gated !== void 0) {
    clauses += 1;
    if (predicate.gated !== (entry.gated === true)) return fail(predicate.gated ? "gated" : "not gated");
  }
  return clauses === 0 ? fail("empty predicate") : { matched: true };
}
function describePredicate(predicate) {
  const parts = [];
  if (predicate.zeroPrice === true) parts.push("zero-price");
  else if (predicate.zeroPrice === false) parts.push("not zero-price");
  if (predicate.maxPrice !== void 0) parts.push(`price \u2264 ${String(predicate.maxPrice)}`);
  if (predicate.tools !== void 0) parts.push(predicate.tools ? "tool-calling" : "no tool-calling");
  if (predicate.vision !== void 0) parts.push(predicate.vision ? "vision" : "no vision");
  if (predicate.reasoning !== void 0) parts.push(predicate.reasoning ? "reasoning" : "no reasoning");
  if (predicate.minContextWindow !== void 0) parts.push(`context \u2265 ${String(predicate.minContextWindow)}`);
  if (predicate.provider !== void 0) parts.push(`provider ${predicate.provider}`);
  if (predicate.providerGlob !== void 0) parts.push(`provider ~ ${predicate.providerGlob}`);
  if (predicate.idGlob !== void 0) parts.push(`id ~ ${predicate.idGlob}`);
  if (predicate.nameGlob !== void 0) parts.push(`name ~ ${predicate.nameGlob}`);
  if (predicate.noTraining === true) parts.push("no-training");
  else if (predicate.noTraining === false) parts.push("trains-on-content");
  if (predicate.gated === true) parts.push("gated");
  else if (predicate.gated === false) parts.push("not gated");
  return parts.length > 0 ? parts.join(" + ") : "empty predicate";
}
function parseCatalogPredicate(raw, context, warnings) {
  if (!isRecord(raw)) {
    warnings.push(`${context}: "when" is not an object \u2014 rule ignored`);
    return {};
  }
  const predicate = {};
  const booleanKeys = ["zeroPrice", "tools", "vision", "reasoning", "noTraining", "gated"];
  for (const key of booleanKeys) {
    const value = raw[key];
    if (value === void 0) continue;
    if (typeof value === "boolean") predicate[key] = value;
    else warnings.push(`${context}: predicate "${key}" is not a boolean \u2014 ignored`);
  }
  const numberKeys = ["maxPrice", "minContextWindow"];
  for (const key of numberKeys) {
    const value = raw[key];
    if (value === void 0) continue;
    const parsed = finiteNumber(value);
    if (parsed !== void 0) predicate[key] = parsed;
    else warnings.push(`${context}: predicate "${key}" is not a number \u2014 ignored`);
  }
  const stringKeys = ["provider", "providerGlob", "idGlob", "nameGlob"];
  for (const key of stringKeys) {
    const value = raw[key];
    if (value === void 0) continue;
    const parsed = nonEmptyString(value);
    if (parsed !== void 0) predicate[key] = parsed;
    else warnings.push(`${context}: predicate "${key}" is not a non-empty string \u2014 ignored`);
  }
  return predicate;
}
function parseStringMap(raw, context, warnings) {
  if (raw === void 0) return {};
  if (!isRecord(raw)) {
    warnings.push(`${context} is not a map \u2014 ignored`);
    return {};
  }
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      warnings.push(`${context}.${key} is not an array \u2014 ignored`);
      continue;
    }
    result[key] = value.filter((item) => typeof item === "string" && item.trim() !== "");
  }
  return result;
}
function parseStringArray(raw) {
  return Array.isArray(raw) ? raw.filter((item) => typeof item === "string" && item.trim() !== "") : [];
}
function parseRulesDocument(raw) {
  const warnings = [];
  const source = isRecord(raw) ? raw : {};
  if (raw !== void 0 && !isRecord(raw)) warnings.push("catalogRules is not an object \u2014 using defaults");
  const hide = [];
  const visibility = source.visibility;
  if (visibility !== void 0 && !isRecord(visibility)) {
    warnings.push("catalogRules.visibility is not an object \u2014 no hide rules");
  } else if (isRecord(visibility)) {
    const rawHide = visibility.hide;
    if (rawHide !== void 0 && !Array.isArray(rawHide)) {
      warnings.push("catalogRules.visibility.hide is not an array \u2014 no hide rules");
    } else if (Array.isArray(rawHide)) {
      rawHide.forEach((candidate, index) => {
        const context = `hide rule #${String(index + 1)}`;
        if (!isRecord(candidate)) {
          warnings.push(`${context} is not an object \u2014 ignored`);
          return;
        }
        if (candidate.when === void 0) {
          warnings.push(`${context} has no "when" \u2014 ignored`);
          return;
        }
        const when = parseCatalogPredicate(candidate.when, context, warnings);
        if (describePredicate(when) === "empty predicate") {
          warnings.push(`${context} has no recognized predicate clauses \u2014 ignored`);
          return;
        }
        hide.push(Object.freeze({
          ...nonEmptyString(candidate.id) !== void 0 ? { id: nonEmptyString(candidate.id) } : {},
          ...nonEmptyString(candidate.label) !== void 0 ? { label: nonEmptyString(candidate.label) } : {},
          ...nonEmptyString(candidate.reason) !== void 0 ? { reason: nonEmptyString(candidate.reason) } : {},
          when: Object.freeze(when)
        }));
      });
    }
  }
  const privacyRaw = isRecord(source.privacy) ? source.privacy : void 0;
  if (source.privacy !== void 0 && !isRecord(source.privacy)) warnings.push("catalogRules.privacy is not an object \u2014 ignored");
  const overridesRaw = isRecord(source.overrides) ? source.overrides : {};
  const gatedRaw = isRecord(overridesRaw.gated) ? overridesRaw.gated : {};
  const version = finiteNumber(source.version) ?? 1;
  return Object.freeze({
    version,
    privacy: privacyRaw ?? {},
    hide: Object.freeze(hide),
    overrides: Object.freeze({
      hidden: Object.freeze(parseStringMap(overridesRaw.hidden, "overrides.hidden", warnings)),
      shown: Object.freeze(parseStringMap(overridesRaw.shown, "overrides.shown", warnings)),
      gatedProviders: Object.freeze(new Set(parseStringArray(gatedRaw.providers))),
      gatedModels: Object.freeze(new Set(parseStringArray(gatedRaw.models)))
    }),
    warnings: Object.freeze(warnings)
  });
}
function listHas(list, provider, modelId) {
  return list?.[provider]?.includes(modelId) === true;
}
function isGated(entry, rules) {
  if (entry.gated === true) return true;
  if (rules.overrides.gatedProviders.has(entry.provider)) return true;
  return rules.overrides.gatedModels.has(`${entry.provider}/${entry.id}`) || rules.overrides.gatedModels.has(entry.id);
}
function withHiddenPins(rules, hiddenModels) {
  if (!isRecord(hiddenModels)) return rules;
  const merged = { ...rules.overrides.hidden };
  let changed = false;
  for (const [provider, models] of Object.entries(hiddenModels)) {
    if (!Array.isArray(models)) continue;
    const current = new Set(merged[provider] ?? []);
    for (const model of models) {
      if (typeof model === "string" && model.trim() !== "") current.add(model);
    }
    const next = [...current];
    if (next.length !== (merged[provider]?.length ?? 0)) {
      merged[provider] = Object.freeze(next);
      changed = true;
    }
  }
  if (!changed) return rules;
  return Object.freeze({
    ...rules,
    overrides: Object.freeze({ ...rules.overrides, hidden: Object.freeze(merged) })
  });
}
function ruleText(rule) {
  return rule.reason ?? rule.label ?? rule.id ?? describePredicate(rule.when);
}
function decideVisibility(entry, rules, privacy) {
  const manualHidden = listHas(rules.overrides.hidden, entry.provider, entry.id);
  const manualShown = listHas(rules.overrides.shown, entry.provider, entry.id);
  const gated = isGated(entry, rules);
  const hit = rules.hide.find((rule) => evaluatePredicate(entry, rule.when, privacy).matched);
  if (manualHidden) {
    return {
      provider: entry.provider,
      model: entry.id,
      state: "hidden",
      source: "manual",
      reason: "hidden manually",
      ...hit !== void 0 ? { overriddenRule: ruleText(hit) } : {}
    };
  }
  if (manualShown) {
    if (hit !== void 0) {
      return {
        provider: entry.provider,
        model: entry.id,
        state: "visible",
        source: "manual",
        reason: `pinned visible (rule: ${ruleText(hit)})`,
        overriddenRule: ruleText(hit)
      };
    }
    if (gated) {
      return { provider: entry.provider, model: entry.id, state: "visible", source: "manual", reason: "pinned visible (gated)" };
    }
    return { provider: entry.provider, model: entry.id, state: "visible", source: "manual", reason: "pinned visible" };
  }
  if (gated) {
    return {
      provider: entry.provider,
      model: entry.id,
      state: "hidden",
      source: "gated",
      reason: entry.gateReason ?? "gated"
    };
  }
  if (hit !== void 0) {
    return { provider: entry.provider, model: entry.id, state: "hidden", source: "rule", reason: `hidden by rule: ${ruleText(hit)}`, rule: ruleText(hit) };
  }
  return { provider: entry.provider, model: entry.id, state: "visible", source: "default", reason: null };
}
function formatHiddenReason(decision) {
  return decision.state === "hidden" ? decision.reason : null;
}
function buildResolvedVisibility(decisions) {
  const resolved = {};
  for (const decision of [...decisions].sort((left, right) => `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))) {
    if (decision.state === "visible" && decision.source !== "manual") continue;
    resolved[`${decision.provider}/${decision.model}`] = {
      state: decision.state,
      reason: decision.reason,
      source: decision.source,
      ...decision.rule !== void 0 ? { rule: decision.rule } : {},
      ...decision.overriddenRule !== void 0 ? { overriddenRule: decision.overriddenRule } : {}
    };
  }
  return resolved;
}
function evaluateVisibility(entries, rules) {
  const decisions = [];
  for (const entry of entries) {
    const verdict = resolvePrivacy(entry.provider, entry.id, rules.privacy);
    decisions.push(decideVisibility(entry, rules, verdict));
  }
  const warnings = [];
  rules.hide.forEach((rule, index) => {
    const matches = entries.filter((entry) => evaluatePredicate(entry, rule.when, resolvePrivacy(entry.provider, entry.id, rules.privacy)).matched);
    if (matches.length === 0) {
      const name2 = rule.label ?? rule.id ?? `#${String(index + 1)}`;
      warnings.push(`hide rule "${name2}" (${describePredicate(rule.when)}) matched no catalogue entries \u2014 nothing is hidden by it`);
    }
  });
  for (const [provider, models] of Object.entries(rules.overrides.hidden)) {
    for (const model of models) {
      if (!entries.some((entry) => entry.provider === provider && entry.id === model)) {
        warnings.push(`manual hidden pin "${provider}/${model}" matches no catalogue entry`);
      }
    }
  }
  for (const [provider, models] of Object.entries(rules.overrides.shown)) {
    for (const model of models) {
      if (!entries.some((entry) => entry.provider === provider && entry.id === model)) {
        warnings.push(`manual visible pin "${provider}/${model}" matches no catalogue entry`);
      }
    }
  }
  return { decisions: Object.freeze(decisions), warnings: Object.freeze(warnings) };
}
function visibilityKeys(entries, rules) {
  const hidden = /* @__PURE__ */ new Set();
  const gated = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const verdict = resolvePrivacy(entry.provider, entry.id, rules.privacy);
    const decision = decideVisibility(entry, rules, verdict);
    if (decision.state === "hidden") hidden.add(`${entry.provider}/${entry.id}`);
    if (isGated(entry, rules) && !listHas(rules.overrides.shown, entry.provider, entry.id)) gated.add(`${entry.provider}/${entry.id}`);
  }
  return { hidden, gated };
}
function diffRules(before, after, entries) {
  const from = visibilityKeys(entries, before);
  const to = visibilityKeys(entries, after);
  const added = (next, previous) => [...next].filter((key) => !previous.has(key)).sort();
  const removed = (next, previous) => [...previous].filter((key) => !next.has(key)).sort();
  return {
    hiddenAdded: Object.freeze(added(to.hidden, from.hidden)),
    hiddenRemoved: Object.freeze(removed(to.hidden, from.hidden)),
    gatedAdded: Object.freeze(added(to.gated, from.gated)),
    gatedRemoved: Object.freeze(removed(to.gated, from.gated)),
    warnings: Object.freeze([...after.warnings, ...evaluateVisibility(entries, after).warnings])
  };
}

// src/selectors.ts
function parseGroupSelector(raw, warn) {
  if (!isRecord(raw)) {
    warn("selector is not an object \u2014 ignored\n");
    return void 0;
  }
  if (!isRecord(raw.when)) {
    warn('selector has no "when" object \u2014 ignored\n');
    return void 0;
  }
  const label = typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label.trim() : void 0;
  const warnings = [];
  const when = parseCatalogPredicate(raw.when, "selector", warnings);
  if (describePredicate(when) === "empty predicate") {
    warn("selector has no recognized predicate clauses \u2014 ignored\n");
    return void 0;
  }
  for (const line of warnings) warn(`${line}
`);
  return Object.freeze({
    when: Object.freeze(when),
    adopt: raw.adopt === true,
    ...label !== void 0 ? { label } : {}
  });
}
function knownPrice(entry) {
  const values = [entry.cost?.input, entry.cost?.output].filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length === 0 ? void 0 : Math.max(...values);
}
function compareMatches(left, right) {
  const leftPrice = knownPrice(left.entry);
  const rightPrice = knownPrice(right.entry);
  if (leftPrice !== rightPrice) {
    if (leftPrice === void 0) return 1;
    if (rightPrice === void 0) return -1;
    return leftPrice - rightPrice;
  }
  const leftContext = left.entry.contextWindow;
  const rightContext = right.entry.contextWindow;
  if (leftContext !== rightContext) {
    if (leftContext === void 0) return 1;
    if (rightContext === void 0) return -1;
    return rightContext - leftContext;
  }
  if (left.entry.provider !== right.entry.provider) return left.entry.provider.localeCompare(right.entry.provider);
  return left.entry.id.localeCompare(right.entry.id);
}
function expandSelector(selector, entries, privacy) {
  const matched = [];
  for (const entry of entries) {
    const verdict = resolvePrivacy(entry.provider, entry.id, privacy);
    if (evaluatePredicate(entry, selector.when, verdict).matched) matched.push(entry);
  }
  const unique = /* @__PURE__ */ new Map();
  for (const entry of matched) {
    const key = `${entry.provider}/${entry.id}`;
    if (!unique.has(key)) unique.set(key, entry);
  }
  const ranked = [...unique.values()].sort((left, right) => compareMatches({ entry: left }, { entry: right }));
  const links = ranked.map((entry) => Object.freeze({ provider: entry.provider, model: entry.id }));
  const warnings = [];
  if (links.length === 0) {
    const name2 = selector.label ?? describePredicate(selector.when);
    warnings.push(`selector "${name2}" (${describePredicate(selector.when)}) matched no catalogue entries \u2014 group unchanged`);
  }
  return { links: Object.freeze(links), matched: matched.length, warnings: Object.freeze(warnings) };
}

// src/catalogue.ts
import { readSettingsDocument } from "dsh-enpoi-contracts";
var MAX_ID_CHARS = 512;
function idString(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > MAX_ID_CHARS ? void 0 : trimmed;
}
function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function parseModel(provider, raw) {
  if (!isRecord(raw)) return void 0;
  const id = idString(raw.id);
  if (id === void 0) return void 0;
  const name2 = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : void 0;
  const contextWindow = optionalNumber(raw.contextWindow);
  const maxTokens = optionalNumber(raw.maxTokens);
  const input = Array.isArray(raw.input) ? raw.input.filter((item) => typeof item === "string") : void 0;
  const reasoning = typeof raw.reasoning === "boolean" ? raw.reasoning : void 0;
  const tools = typeof raw.tools === "boolean" ? raw.tools : void 0;
  const cost = isRecord(raw.cost) ? {
    ...optionalNumber(raw.cost.input) !== void 0 ? { input: optionalNumber(raw.cost.input) } : {},
    ...optionalNumber(raw.cost.output) !== void 0 ? { output: optionalNumber(raw.cost.output) } : {}
  } : void 0;
  const gateReason = raw.gated === true && typeof raw.gateReason === "string" && raw.gateReason.trim() !== "" ? raw.gateReason.trim() : void 0;
  return {
    provider,
    id,
    ...name2 !== void 0 ? { name: name2 } : {},
    ...contextWindow !== void 0 ? { contextWindow } : {},
    ...maxTokens !== void 0 ? { maxTokens } : {},
    ...input !== void 0 ? { input } : {},
    ...reasoning !== void 0 ? { reasoning } : {},
    ...tools !== void 0 ? { tools } : {},
    ...cost !== void 0 && Object.keys(cost).length > 0 ? { cost } : {},
    ...raw.gated === true ? { gated: true } : {},
    ...gateReason === void 0 ? {} : { gateReason }
  };
}
function readCatalogue(settings) {
  const document = readSettingsDocument(settings, "llm-pi-ai");
  if (document === void 0) return [];
  const providers = document.providers;
  if (!isRecord(providers)) return [];
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [provider, profile] of Object.entries(providers)) {
    if (!isRecord(profile) || !Array.isArray(profile.models)) continue;
    for (const raw of profile.models) {
      const entry = parseModel(provider, raw);
      if (entry === void 0) continue;
      const key = `${entry.provider}/${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries;
}

// src/index.ts
var name = "enpoi-catalog-rules";
var inject = ["settings"];
var ORCH_NS = "enpoi-orchestration";
var RESOLVED_ARTIFACT = "catalogRules.resolved";
var CatalogRulesEngine = class {
  /**
   * @param readRules - reads the raw `catalogRules` value (ctx-bound in production).
   * @param readCatalogue - reads the live catalogue snapshot (ctx-bound in production).
   * @param readHiddenPins - reads `uiPreferences.hiddenModels`, the picker's manual pins.
   */
  constructor(readRules, readCatalogue2, readHiddenPins = () => void 0) {
    this.readRules = readRules;
    this.readCatalogue = readCatalogue2;
    this.readHiddenPins = readHiddenPins;
    this.rules = parseRulesDocument(void 0);
    this.entries = [];
    this.report = { decisions: [], warnings: [] };
    this.refresh();
  }
  rules;
  entries;
  report;
  decisions = /* @__PURE__ */ new Map();
  /** Re-read the rules document and catalogue; rebuilding every derived view. */
  refresh() {
    this.rules = withHiddenPins(parseRulesDocument(this.readRules()), this.readHiddenPins());
    const entries = this.readCatalogue().map((entry) => ({
      ...entry,
      ...isGated(entry, this.rules) ? { gated: true } : {}
    }));
    this.entries = entries;
    this.report = evaluateVisibility(entries, this.rules);
    this.decisions = new Map(this.report.decisions.map((decision) => [`${decision.provider}/${decision.model}`, decision]));
  }
  /** Current parsed document (exposed for callers that need the raw clauses). */
  parsed() {
    return this.rules;
  }
  /** Current catalogue snapshot with gated markers merged in. */
  catalogue() {
    return this.entries;
  }
  visibility() {
    return this.report;
  }
  decide(provider, modelId) {
    return this.decisions.get(`${provider}/${modelId}`);
  }
  expandSelector(selector) {
    return expandSelector(selector, this.entries, this.rules.privacy);
  }
  expandRawSelector(raw) {
    const warnings = [];
    const selector = parseGroupSelector(raw, (line) => warnings.push(line));
    if (selector === void 0) {
      return { links: [], matched: 0, warnings: Object.freeze(warnings.length > 0 ? warnings : ["selector ignored"]) };
    }
    const expansion = expandSelector(selector, this.entries, this.rules.privacy);
    return { ...expansion, warnings: Object.freeze([...warnings, ...expansion.warnings]) };
  }
  previewRulesChange(nextRaw) {
    const next = withHiddenPins(parseRulesDocument(nextRaw), this.readHiddenPins());
    return diffRules(this.rules, next, this.entries);
  }
  warnings() {
    return this.report.warnings;
  }
};
function apply(ctx) {
  const settings = () => ctx.get("settings");
  const engine = new CatalogRulesEngine(
    () => {
      const document = readOrchestrationDocument(settings());
      return document?.catalogRules;
    },
    () => readCatalogue(settings()),
    () => {
      const document = readOrchestrationDocument(settings());
      const preferences = document?.uiPreferences;
      return isRecord(preferences) ? preferences.hiddenModels : void 0;
    }
  );
  const emitted = /* @__PURE__ */ new Set();
  const emitWarnings = () => {
    for (const warning of engine.warnings()) {
      if (emitted.has(warning)) continue;
      emitted.add(warning);
      process.stderr.write(`[enpoi-catalog-rules] ${warning}
`);
    }
  };
  let lastPublished;
  const publishResolved = () => {
    const next = buildResolvedVisibility(engine.visibility().decisions);
    const serialized = JSON.stringify(next);
    if (serialized === lastPublished) return;
    const writer = ctx.get("settings");
    if (writer?.publishArtifact !== void 0) {
      lastPublished = serialized;
      writer.publishArtifact(RESOLVED_ARTIFACT, next);
      return;
    }
    void publishResolvedDocument(writer, next, serialized);
  };
  const publishResolvedDocument = async (writer, next, serialized) => {
    if (writer?.mutate === void 0) return;
    const document = readOrchestrationDocument(ctx.get("settings"));
    const rules = document?.catalogRules;
    const current = isRecord(rules) ? rules.resolved : void 0;
    if (JSON.stringify(current ?? null) === serialized) {
      lastPublished = serialized;
      return;
    }
    const revision = writer.describe?.().find((entry) => entry.ns === ORCH_NS)?.revision;
    lastPublished = serialized;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await writer.mutate(ORCH_NS, [{ op: "set", path: ["catalogRules", "resolved"], value: next }], revision);
        return;
      } catch (error) {
        const conflict = error;
        if ((conflict?.code === "SETTINGS_CONFLICT" || conflict?.code === "settings/conflict") && attempt < 2) continue;
        lastPublished = void 0;
        process.stderr.write(`[enpoi-catalog-rules] resolved map publish failed: ${error instanceof Error ? error.message : String(error)}
`);
        return;
      }
    }
  };
  let removalWarned = false;
  const removeDocumentMap = () => {
    const writer = ctx.get("settings");
    if (writer?.publishArtifact === void 0 || writer.mutate === void 0) return;
    const document = readOrchestrationDocument(ctx.get("settings"));
    const rules = document?.catalogRules;
    if (!isRecord(rules) || rules.resolved === void 0) return;
    const revision = writer.describe?.().find((entry) => entry.ns === ORCH_NS)?.revision;
    void writer.mutate(ORCH_NS, [{ op: "unset", path: ["catalogRules", "resolved"] }], revision).catch((error) => {
      if (removalWarned) return;
      removalWarned = true;
      process.stderr.write(`[enpoi-catalog-rules] resolved map removal failed: ${error instanceof Error ? error.message : String(error)}
`);
    });
  };
  ctx.provide("catalogRules", engine);
  emitWarnings();
  removeDocumentMap();
  publishResolved();
  const onNamespaceChange = ((ns) => {
    if (String(ns) !== ORCH_NS && String(ns) !== "llm-pi-ai") return;
    engine.refresh();
    emitWarnings();
    removeDocumentMap();
    publishResolved();
  });
  ctx.on("settings/document-updated", onNamespaceChange);
  ctx.on("settings/updated", onNamespaceChange);
  process.stderr.write("[enpoi-catalog-rules] mounted\n");
}
export {
  CatalogRulesEngine,
  apply,
  buildResolvedVisibility,
  diffRules,
  evaluateVisibility,
  expandSelector,
  formatHiddenReason,
  inject,
  name,
  parseGroupSelector,
  parseRulesDocument,
  readCatalogue,
  resolvePrivacy,
  withHiddenPins
};
