#!/usr/bin/env node
/**
 * Offline per-preset tool-roster diff.
 *
 * Prints the accepted roster for every preset and diffs it against a frozen
 * baseline JSON, so a future sync/merge can see exactly which tools appeared
 * or disappeared since the last intentional baseline bump.
 *
 * This is the offline companion to `scripts/preset-tool-inventory.mjs` (doc 50
 * safeguard 12): that one diffs LIVE wire rosters against `expected-<preset>.json`
 * and exits 1 on drift; this one diffs the (updated) fixtures against a stored
 * baseline and exits 1 on drift, answering "what changed since <date>?".
 *
 * Usage:
 *   node scripts/tool-roster-diff.mjs                     # fixtures vs baseline
 *   node scripts/tool-roster-diff.mjs --json              # machine-readable
 *   node scripts/tool-roster-diff.mjs --preset sysadmin   # one preset
 *   node scripts/tool-roster-diff.mjs --current <dir|file>  # e.g. fresh live probe output dir
 *   node scripts/tool-roster-diff.mjs --baseline <file>
 *
 * Current input: for each preset, `<dir>/expected-<preset>.json` (fixture shape
 * `{preset,tools:[...]}`) or `<dir>/<preset>.json`; or, if --current points at
 * a file, that file in fixture/baseline shape.
 * Baseline shape: `{capturedAt, source, presets:{<name>:{tools:[...]}}}` or the
 * plain `{<name>:[...]}` map. Extra keys are ignored.
 *
 * Exit codes: 0 = match, 1 = drift (printed as `+ added` / `- removed`), 2 = usage/IO error.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = join(SCRIPT_DIR, "tool-inventory", "roster-baseline.json");
const DEFAULT_CURRENT = join(SCRIPT_DIR, "tool-inventory");

function parseArgs(argv) {
  const out = { current: DEFAULT_CURRENT, baseline: DEFAULT_BASELINE, preset: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--current") out.current = argv[++i];
    else if (a === "--baseline") out.baseline = argv[++i];
    else if (a === "--preset") out.preset = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") { console.log("usage: node scripts/tool-roster-diff.mjs [--current <dir|file>] [--baseline <file>] [--preset <name>] [--json]"); process.exit(0); }
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  return out;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { console.error(`[tool-roster-diff] cannot read ${path}: ${e.message}`); process.exit(2); }
}

function namesOf(value) {
  if (Array.isArray(value)) return value.slice().sort();
  if (value && Array.isArray(value.tools)) return value.tools.slice().sort();
  return null;
}

function baselinePresets(doc) {
  const src = doc && doc.presets ? doc.presets : doc;
  if (!src || typeof src !== "object") { console.error("[tool-roster-diff] baseline has no presets map"); process.exit(2); }
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const names = namesOf(v);
    if (names) out[k] = names;
  }
  return out;
}

function currentFor(preset, current) {
  // A directory: expected-<preset>.json preferred, else <preset>.json.
  if (existsSync(current) && statSync(current).isDirectory()) {
    for (const f of [`expected-${preset}.json`, `${preset}.json`]) {
      const p = join(current, f);
      if (existsSync(p)) { const n = namesOf(readJson(p)); if (n) return { names: n, from: p }; }
    }
    return null;
  }
  // A single file: try baseline shape first, then array/fixture shape.
  const doc = readJson(current);
  const map = namesOf((doc && doc.presets && doc.presets[preset]) ?? (doc && doc[preset]));
  if (map) return { names: map, from: current };
  if (Array.isArray(doc)) return { names: namesOf(doc), from: current };
  return null;
}

const args = parseArgs(process.argv.slice(2));
const baselineDoc = readJson(resolve(args.baseline));
const baseline = baselinePresets(baselineDoc);
const presets = Object.keys(baseline).filter((p) => !args.preset || p === args.preset);
if (!presets.length) { console.error(`[tool-roster-diff] no preset ${args.preset ? `"${args.preset}"` : ""} in baseline`); process.exit(2); }

const report = { baseline: resolve(args.baseline), capturedAt: baselineDoc.capturedAt ?? null, current: resolve(args.current), presets: {} };
let drift = 0;
for (const preset of presets) {
  const cur = currentFor(preset, resolve(args.current));
  if (!cur) { console.error(`[tool-roster-diff] no current roster found for preset "${preset}" under ${resolve(args.current)}`); process.exit(2); }
  const base = baseline[preset];
  const added = cur.names.filter((n) => !base.includes(n));
  const removed = base.filter((n) => !cur.names.includes(n));
  const unchanged = cur.names.filter((n) => base.includes(n));
  if (added.length || removed.length) drift += 1;
  report.presets[preset] = { baselineCount: base.length, currentCount: cur.names.length, added, removed, unchangedCount: unchanged.length };
}
report.drift = drift;
report.match = drift === 0;
if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`tool-roster-diff · baseline ${report.capturedAt ?? report.baseline}`);
  for (const [preset, r] of Object.entries(report.presets)) {
    console.log(`\n${preset}: ${r.baselineCount} -> ${r.currentCount}${r.added.length || r.removed.length ? "  DRIFT" : "  match"}`);
    for (const n of r.added) console.log(`  + ${n}`);
    for (const n of r.removed) console.log(`  - ${n}`);
  }
  console.log(`\n${report.match ? "MATCH" : "DRIFT"} — ${Object.keys(report.presets).length} preset(s), ${report.presets ? Object.values(report.presets).reduce((a, r) => a + r.added.length, 0) : 0} added, ${report.presets ? Object.values(report.presets).reduce((a, r) => a + r.removed.length, 0) : 0} removed vs baseline`);
}
process.exit(report.match ? 0 : 1);
