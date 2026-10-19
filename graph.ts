import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { parseLog } from "./logParser.js";
import { validateDiagnosis } from "./validate.js";
import type { Diagnosis, ParsedLog, Provider } from "./types.js";

const State = Annotation.Root({
  rawLog: Annotation<string>(),
  diff: Annotation<string | undefined>(),
  parsed: Annotation<ParsedLog | undefined>(),
  attempts: Annotation<number>(),
  feedback: Annotation<string | undefined>(),
  raw: Annotation<unknown>(),
  providerError: Annotation<string | undefined>(),
  diagnosis: Annotation<Diagnosis | undefined>(),
  status: Annotation<"pending" | "diagnosed" | "abstained">(),
  reason: Annotation<string | undefined>(),
  trace: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

export interface AgentOptions {
  provider: Provider;
  /** Total provider calls allowed, including the first. */
  maxAttempts?: number;
  minConfidence?: number;
  /** Per-call time limit, so a hung provider cannot hang the CI job. */
  timeoutMs?: number;
}

export interface AgentResult {
  status: "diagnosed" | "abstained";
  diagnosis?: Diagnosis;
  reason?: string;
  attempts: number;
  trace: string[];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`provider timed out after ${ms}ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/**
 * parse -> diagnose -> validate -> (report | retry with feedback | abstain)
 * The agent speaks only when the output is well-formed, grounded in the log and confident.
 */
export function buildAgent(opts: AgentOptions) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const minConfidence = opts.minConfidence ?? 0.6;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const graph = new StateGraph(State)
    .addNode("parse", (s) => ({ parsed: parseLog(s.rawLog), trace: ["parse"] }))
    .addNode("diagnose", async (s) => {
      const attempt = s.attempts + 1;
      try {
        const raw = await withTimeout(
          opts.provider.diagnose({ parsed: s.parsed!, diff: s.diff, attempt, feedback: s.feedback }),
          timeoutMs,
        );
        return { attempts: attempt, raw, providerError: undefined, trace: [`diagnose#${attempt}`] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { attempts: attempt, raw: undefined, providerError: msg, trace: [`diagnose#${attempt}:error`] };
      }
    })
    .addNode("validate", (s) => {
      if (s.providerError) return { feedback: `provider error: ${s.providerError}`, trace: ["validate:provider-error"] };
      const v = validateDiagnosis(s.raw, s.parsed!, { minConfidence });
      if (v.ok) return { diagnosis: v.diagnosis, status: "diagnosed" as const, feedback: undefined, trace: ["validate:ok"] };
      return { feedback: v.reason, trace: [`validate:rejected(${v.reason.split(":")[0]})`] };
    })
    .addNode("abstain", (s) => ({
      status: "abstained" as const,
      reason: s.feedback ?? "no diagnosis",
      trace: ["abstain"],
    }))
    .addEdge(START, "parse")
    .addEdge("parse", "diagnose")
    .addEdge("diagnose", "validate")
    .addConditionalEdges("validate", (s) => {
      if (s.status === "diagnosed") return END;
      // Retrying cannot fix a log that simply does not contain the cause, so only retry
      // when the failure was a provider error or a malformed/ungrounded answer.
      const retryable = !s.feedback?.startsWith("confidence:");
      return retryable && s.attempts < maxAttempts ? "diagnose" : "abstain";
    })
    .addEdge("abstain", END)
    .compile();

  return {
    async run(rawLog: string, diff?: string): Promise<AgentResult> {
      const out = await graph.invoke({ rawLog, diff, attempts: 0, status: "pending" });
      return { status: out.status === "diagnosed" ? "diagnosed" : "abstained", diagnosis: out.diagnosis, reason: out.reason, attempts: out.attempts, trace: out.trace };
    },
  };
}
