import type { ParsedLog } from "./types.js";

const ERROR_HINTS =
  /(error|failed|failure|cannot find|not found|exception|timeout|timed out|ECONN|ENOTFOUND|ENOENT|heap out of memory|AssertionError|expected .* (to|but)|undefined|exit code [1-9])/i;

// GitHub Actions style group headers: "##[group]Run npm test" or "Run npm test"
const STEP = /^(?:##\[group\]|Run )(.+)$/;

export function parseLog(raw: string): ParsedLog {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const errorLines: ParsedLog["errorLines"] = [];
  let currentStep: string | undefined;
  let failedStep: string | undefined;

  lines.forEach((text, i) => {
    const step = STEP.exec(text.trim());
    if (step) currentStep = step[1].trim();
    if (ERROR_HINTS.test(text) && text.trim().length > 0) {
      errorLines.push({ n: i + 1, text });
      failedStep ??= currentStep;
    }
  });
  return { lines, failedStep, errorLines };
}

/** Whitespace-insensitive check that a quoted line really appears in the log. */
export function appearsInLog(quote: string, lines: string[]): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const q = norm(quote);
  if (q.length < 3) return false;
  const whole = norm(lines.join("\n"));
  return whole.includes(q);
}
