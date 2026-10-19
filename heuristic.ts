import type { Category, DiagnoseInput, Provider } from "./types.js";

interface Rule {
  category: Category;
  match: RegExp;
  confidence: number;
  cause: (line: string) => string;
  fix: string;
}

// Order matters: more specific signals come first.
const RULES: Rule[] = [
  {
    category: "out-of-memory",
    match: /heap out of memory|JavaScript heap|ENOMEM|Killed\b.*memory/i,
    confidence: 0.9,
    cause: () => "The process ran out of memory during the job.",
    fix: "Raise the Node heap limit (NODE_OPTIONS=--max-old-space-size=4096) or reduce parallel workers in the test runner.",
  },
  {
    category: "missing-dependency",
    match: /Cannot find (?:module|package) ['"`]([^'"`]+)['"`]|Module not found: .*Can't resolve ['"]([^'"]+)['"]/i,
    confidence: 0.9,
    cause: (l) => `A module could not be resolved: ${l.trim().slice(0, 120)}.`,
    fix: "Add the missing package to package.json (or fix the import path), then regenerate the lockfile and reinstall.",
  },
  {
    category: "type-error",
    match: /\bTS\d{4}\b/,
    confidence: 0.85,
    cause: (l) => `TypeScript compilation failed: ${l.trim().slice(0, 140)}.`,
    fix: "Fix the type error at the reported location, or correct the type that the changed code now violates.",
  },
  {
    category: "timeout",
    match: /Exceeded timeout of \d+ ?ms|Test timed out|timed out after \d+/i,
    confidence: 0.8,
    cause: (l) => `A test or step exceeded its time limit: ${l.trim().slice(0, 120)}.`,
    fix: "Check for an unresolved promise or a slow dependency. Raise the timeout only if the work is legitimately slow.",
  },
  {
    category: "network",
    match: /ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|503 Service Unavailable|socket hang up/i,
    confidence: 0.75,
    cause: (l) => `A network call failed: ${l.trim().slice(0, 120)}.`,
    fix: "Retry the job. If it repeats, check the registry or service status and add retry/backoff to the failing step.",
  },
  {
    category: "env-config",
    // Two alternatives with different case rules: prose is case-insensitive, but a variable name
    // must be UPPER_SNAKE_CASE. A single /i flag made "expected undefined" look like a variable.
    match: /(?:[Ee]nvironment variable|[Ee]nv var) .*(?:missing|not set|required)|\b[A-Z][A-Z0-9_]{3,} (?:is )?(?:not set|undefined|missing)\b/,
    confidence: 0.7,
    cause: (l) => `A required configuration value is missing: ${l.trim().slice(0, 120)}.`,
    fix: "Define the variable in the workflow's env or repository secrets, and fail fast with a clear message when it is absent.",
  },
  {
    category: "lint",
    match: /✖ \d+ problems?|\d+ errors?, \d+ warnings?|eslint.*(?:error|failed)/i,
    confidence: 0.75,
    cause: (l) => `The linter reported errors: ${l.trim().slice(0, 120)}.`,
    fix: "Run the linter locally with --fix and resolve what remains.",
  },
  {
    category: "test-assertion",
    match: /AssertionError|expected .* (?:to (?:equal|be|match|contain)|received)|Expected:.*|FAIL .*\.test\./,
    confidence: 0.7,
    cause: (l) => `A test assertion failed: ${l.trim().slice(0, 120)}.`,
    fix: "Compare the expected and received values in the log, then fix the code or update the test if the behavior change is intended.",
  },
];

/** Deterministic baseline. Useful offline, and as a floor to compare an LLM provider against. */
export const heuristicProvider: Provider = {
  name: "heuristic",
  async diagnose({ parsed }: DiagnoseInput) {
    const lines = parsed.errorLines.map((e) => e.text);
    for (const rule of RULES) {
      const hits = lines.filter((l) => rule.match.test(l));
      if (hits.length === 0) continue;
      return {
        category: rule.category,
        cause: rule.cause(hits[0]),
        evidence: hits.slice(0, 3).map((h) => h.trim()),
        confidence: rule.confidence,
        suggestedFix: rule.fix,
      };
    }
    return {
      category: "unknown",
      cause: "No known failure signature matched the error lines in this log.",
      evidence: (lines[0] ?? parsed.lines[0] ?? "empty log").trim() || "empty log",
      confidence: 0.1,
      suggestedFix: "Open the full log and inspect the first failing step.",
    };
  },
};
