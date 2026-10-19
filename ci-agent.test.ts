import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { anthropicProvider } from "../src/ci-agent/anthropic.js";
import { toComment } from "../src/ci-agent/comment.js";
import { buildAgent } from "../src/ci-agent/graph.js";
import { heuristicProvider } from "../src/ci-agent/heuristic.js";
import { parseLog } from "../src/ci-agent/logParser.js";
import type { Provider } from "../src/ci-agent/types.js";

const log = (name: string) => readFileSync(new URL(`../fixtures/logs/${name}`, import.meta.url), "utf8");
const good = {
  category: "missing-dependency",
  cause: "A module could not be resolved during the test run.",
  evidence: ["Error: Cannot find module 'decimal.js' imported from /home/runner/work/app/src/payments.ts"],
  confidence: 0.9,
  suggestedFix: "Add decimal.js to package.json and reinstall.",
};
const scripted = (...answers: (unknown | Error)[]): Provider & { calls: number } => {
  const p = {
    name: "scripted",
    calls: 0,
    async diagnose() {
      const a = answers[Math.min(p.calls++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return p;
};

describe("validation gates", () => {
  it("accepts a grounded, confident diagnosis", async () => {
    const r = await buildAgent({ provider: scripted(good) }).run(log("01-missing-dep.log"));
    expect(r.status).toBe("diagnosed");
    expect(r.attempts).toBe(1);
  });

  it("rejects an evidence quote that is not in the log, then retries with feedback", async () => {
    const invented = { ...good, evidence: ["Error: Cannot find module 'left-pad'"] };
    const p = scripted(invented, good);
    const r = await buildAgent({ provider: p }).run(log("01-missing-dep.log"));
    expect(r.status).toBe("diagnosed");
    expect(r.attempts).toBe(2);
    expect(r.trace).toContain("validate:rejected(grounding)");
  });

  it("abstains when every attempt is hallucinated", async () => {
    const invented = { ...good, evidence: ["totally made up line"] };
    const r = await buildAgent({ provider: scripted(invented), maxAttempts: 3 }).run(log("01-missing-dep.log"));
    expect(r.status).toBe("abstained");
    expect(r.attempts).toBe(3);
    expect(r.reason).toMatch(/grounding/);
  });

  it("retries on malformed output (schema gate)", async () => {
    const r = await buildAgent({ provider: scripted({ nonsense: true }, good) }).run(log("01-missing-dep.log"));
    expect(r.status).toBe("diagnosed");
    expect(r.trace).toContain("validate:rejected(schema)");
  });

  it("does not retry on low confidence, and stays silent", async () => {
    const p = scripted({ ...good, confidence: 0.3 });
    const r = await buildAgent({ provider: p }).run(log("01-missing-dep.log"));
    expect(r.status).toBe("abstained");
    expect(p.calls).toBe(1);
  });

  it("recovers from a provider error and from a hung provider", async () => {
    const r1 = await buildAgent({ provider: scripted(new Error("boom"), good) }).run(log("01-missing-dep.log"));
    expect(r1.status).toBe("diagnosed");
    expect(r1.trace).toContain("diagnose#1:error");

    const hung: Provider = { name: "hung", diagnose: () => new Promise(() => {}) };
    const r2 = await buildAgent({ provider: hung, maxAttempts: 2, timeoutMs: 20 }).run(log("01-missing-dep.log"));
    expect(r2.status).toBe("abstained");
    expect(r2.reason).toMatch(/timed out/);
  });

  it("matches whitespace differences in quotes but not different text", async () => {
    const spaced = { ...good, evidence: ["Error:   Cannot find module 'decimal.js'   imported from /home/runner/work/app/src/payments.ts"] };
    expect((await buildAgent({ provider: scripted(spaced) }).run(log("01-missing-dep.log"))).status).toBe("diagnosed");
  });
});

describe("heuristic provider", () => {
  it("regression: 'expected undefined' is not an env var", async () => {
    const r = await buildAgent({ provider: heuristicProvider }).run(log("10-mixed.log"));
    expect(r.diagnosis?.category).toBe("test-assertion");
  });

  it("abstains on a log with no cause", async () => {
    const r = await buildAgent({ provider: heuristicProvider }).run(log("09-opaque.log"));
    expect(r.status).toBe("abstained");
  });
});

describe("comment", () => {
  it("cites line numbers for evidence", async () => {
    const raw = log("01-missing-dep.log");
    const r = await buildAgent({ provider: scripted(good) }).run(raw);
    const md = toComment(r, parseLog(raw), "https://example.test/run/1");
    expect(md).toContain("missing-dependency (confidence 90%)");
    expect(md).toMatch(/line 5: `Error: Cannot find module/);
    expect(md).toContain("[Full log](https://example.test/run/1)");
  });
});

describe("anthropic provider", () => {
  const fakeFetch = (status: number, text: string) =>
    vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status }));

  it("parses a JSON reply wrapped in prose", async () => {
    const f = fakeFetch(200, `Here you go:\n${JSON.stringify(good)}\nDone.`);
    const p = anthropicProvider({ apiKey: "k", model: "m", fetchImpl: f as unknown as typeof fetch });
    const r = await buildAgent({ provider: p }).run(log("01-missing-dep.log"));
    expect(r.status).toBe("diagnosed");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("sends the rejection reason back on retry", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ ...good, evidence: ["invented"] }) }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(good) }] })));
    const p = anthropicProvider({ apiKey: "k", model: "m", fetchImpl: f as unknown as typeof fetch });
    const r = await buildAgent({ provider: p }).run(log("01-missing-dep.log"));
    expect(r.attempts).toBe(2);
    const body = JSON.parse(((f.mock.calls[1] as [string, RequestInit])[1].body as string));
    expect(body.messages[0].content).toContain("grounding");
  });

  it("treats an HTTP error as a provider error and abstains", async () => {
    const p = anthropicProvider({ apiKey: "k", model: "m", fetchImpl: fakeFetch(500, "") as unknown as typeof fetch });
    const r = await buildAgent({ provider: p, maxAttempts: 2 }).run(log("01-missing-dep.log"));
    expect(r.status).toBe("abstained");
    expect(r.reason).toMatch(/500/);
  });
});
