import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/quality-gate/config.js";
import { findCycles } from "../src/quality-gate/cycles.js";
import { runGate } from "../src/quality-gate/run.js";
import { toMarkdown } from "../src/quality-gate/report.js";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gate-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const branchy = (n: number) =>
  `export function f(x: number) {\n${Array.from({ length: n }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n")}\n  return -1;\n}\n`;

describe("quality gate", () => {
  it("passes a clean project", () => {
    const root = project({ "a.ts": "export const a = 1;\n", "b.ts": 'import { a } from "./a.js";\nexport const b = a + 1;\n' });
    const r = runGate(root);
    expect(r.failed).toBe(false);
    expect(r.violations).toEqual([]);
    expect(r.filesChecked).toBe(2);
  });

  it("flags high cyclomatic complexity with the function name and line", () => {
    const root = project({ "c.ts": branchy(12) });
    const r = runGate(root);
    const v = r.violations.find((x) => x.kind === "complexity");
    expect(v).toBeDefined();
    expect(v!.message).toContain("Function f");
    expect(v!.value).toBe(13);
    expect(v!.line).toBe(1);
    expect(r.failed).toBe(true);
  });

  it("does not count nested functions toward the outer complexity", () => {
    const body = `export function outer() {\n  const inner = (x: number) => { ${Array.from({ length: 15 }, () => "if (x) {}").join(" ")} };\n  return inner;\n}\n`;
    const r = runGate(project({ "n.ts": body }));
    const names = r.violations.map((v) => v.message);
    expect(names.some((m) => m.includes("outer"))).toBe(false);
    expect(names.some((m) => m.includes("inner"))).toBe(true);
  });

  it("flags long functions and large files using config limits", () => {
    const longFn = `export function g() {\n${"  const x = 1;\n".repeat(70)}}\n`;
    const root = project({ "g.ts": longFn });
    const r = runGate(root, { config: { ...defaultConfig, maxFileLines: 50 } });
    expect(r.violations.map((v) => v.kind).sort()).toEqual(["file-size", "function-size"]);
  });

});

describe("quality gate: cycles and reports", () => {
  it("detects circular dependencies, including ESM .js specifiers", () => {
    const root = project({
      "x.ts": 'import { y } from "./y.js";\nexport const x = () => y;\n',
      "y.ts": 'import { x } from "./x.js";\nexport const y = () => x;\n',
      "z.ts": "export const z = 1;\n",
    });
    const r = runGate(root);
    const cycle = r.violations.find((v) => v.kind === "cycle");
    expect(cycle?.message).toContain("x.ts <-> y.ts");
  });

  it("ignores type-only imports, which are erased at runtime", () => {
    const root = project({
      "p.ts": 'import type { Q } from "./q.js";\nexport interface P { q: Q }\n',
      "q.ts": 'import { type P } from "./p.js";\nimport type { P as P2 } from "./p.js";\nexport interface Q { p?: P2 }\n',
    });
    expect(runGate(root).violations.filter((v) => v.kind === "cycle")).toEqual([]);
  });

  it("findCycles returns nothing for a DAG", () => {
    const g = new Map([["a", ["b"]], ["b", ["c"]], ["c", []]]);
    expect(findCycles(g)).toEqual([]);
  });

  it("renders a markdown report grouped by kind", () => {
    const root = project({ "c.ts": branchy(12) });
    const md = toMarkdown(runGate(root).violations, 1);
    expect(md).toContain("Quality gate: 1 issue found");
    expect(md).toContain("**High complexity** (1)");
  });
});
