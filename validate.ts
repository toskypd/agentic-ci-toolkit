import { appearsInLog } from "./logParser.js";
import { DiagnosisSchema, type Diagnosis, type ParsedLog } from "./types.js";

export type Validation = { ok: true; diagnosis: Diagnosis } | { ok: false; reason: string };

export interface ValidateOptions {
  /** Below this the agent stays silent rather than posting a weak guess. */
  minConfidence: number;
}

/**
 * Three gates, in order:
 *  1. schema: the output must be well-formed.
 *  2. grounding: every evidence quote must exist verbatim in the log.
 *  3. confidence: the provider must be sure enough to speak.
 * The reason string is fed back to the provider on a retry.
 */
export function validateDiagnosis(raw: unknown, parsed: ParsedLog, opts: ValidateOptions): Validation {
  const schema = DiagnosisSchema.safeParse(raw);
  if (!schema.success) {
    const issue = schema.error.issues[0];
    return { ok: false, reason: `schema: ${issue.path.join(".") || "root"} ${issue.message}` };
  }
  const d = schema.data;
  const missing = d.evidence.filter((q) => !appearsInLog(q, parsed.lines));
  if (missing.length > 0) {
    return { ok: false, reason: `grounding: quote not found in log: "${missing[0].slice(0, 80)}"` };
  }
  if (d.category === "unknown") {
    return { ok: false, reason: "confidence: category unknown" };
  }
  if (d.confidence < opts.minConfidence) {
    return { ok: false, reason: `confidence: ${d.confidence} is below ${opts.minConfidence}` };
  }
  return { ok: true, diagnosis: d };
}
