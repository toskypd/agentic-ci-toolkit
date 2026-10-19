import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { analyzeFile, listSourceFiles, type Violation } from "./analyze.js";
import { loadConfig, type GateConfig } from "./config.js";
import { cycleViolations } from "./cycles.js";

export interface GateResult {
  violations: Violation[];
  filesChecked: number;
  failed: boolean;
}

/** Files changed against a base ref, used so a PR is only judged on what it touched. */
export function changedFiles(root: string, base: string): string[] {
  const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`], { cwd: root, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((f) => resolve(root, f));
}

export function runGate(rootArg: string, opts: { config?: GateConfig; only?: string[] } = {}): GateResult {
  const root = resolve(rootArg);
  const config = opts.config ?? loadConfig(root);
  const all = listSourceFiles(root, config.ignore);
  const only = opts.only ? new Set(opts.only) : undefined;
  const target = only ? all.filter((f) => only.has(f)) : all;

  const violations: Violation[] = [];
  for (const f of target) violations.push(...analyzeFile(f, root, config));
  // Cycles are a whole-project property, so the graph always uses every file.
  const cycles = cycleViolations(all, root);
  violations.push(...(only ? cycles.filter((c) => c.message.split(": ")[1]?.split(" <-> ").some((p) => [...only].some((o) => o.endsWith(p)))) : cycles));

  const failing = violations.filter((v) => v.kind !== "cycle" || config.failOnCycles);
  return { violations, filesChecked: target.length, failed: failing.length > 0 };
}
