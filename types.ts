import { z } from "zod";

export const CATEGORIES = [
  "missing-dependency",
  "type-error",
  "test-assertion",
  "timeout",
  "lint",
  "env-config",
  "network",
  "out-of-memory",
  "unknown",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** The shape every provider must return. Anything else is rejected by validation. */
export const DiagnosisSchema = z.object({
  category: z.enum(CATEGORIES),
  cause: z.string().min(10).max(600),
  /** Exact lines copied from the log. Each one is checked against the real log text. */
  evidence: z.array(z.string().min(3)).min(1).max(6),
  confidence: z.number().min(0).max(1),
  suggestedFix: z.string().min(5).max(800),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export interface ParsedLog {
  lines: string[];
  failedStep?: string;
  /** Lines that look like errors, with 1-based line numbers. */
  errorLines: { n: number; text: string }[];
}

export interface DiagnoseInput {
  parsed: ParsedLog;
  diff?: string;
  attempt: number;
  /** Why the previous attempt was rejected, so the next attempt can correct it. */
  feedback?: string;
}

export interface Provider {
  name: string;
  /** Returns untrusted output. The graph validates it, so providers can return anything. */
  diagnose(input: DiagnoseInput): Promise<unknown>;
}
