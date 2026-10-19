import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Violation } from "./analyze.js";

const CANDIDATE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Resolves a relative import specifier to a file in the analysed set, or undefined. */
export function resolveImport(from: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(from), spec);
  // Allow TypeScript ESM style imports like "./x.js" that point at "./x.ts".
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const tries = [
    base,
    ...CANDIDATE_EXT.map((e) => base + e),
    ...CANDIDATE_EXT.map((e) => stripped + e),
    ...CANDIDATE_EXT.map((e) => join(base, "index" + e)),
  ];
  return tries.find((p) => known.has(p) && existsSync(p));
}

function importOrExportSpecifier(n: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
  const spec = n.moduleSpecifier;
  if (!spec || !ts.isStringLiteral(spec)) return undefined;
  // Type-only imports are erased at runtime, so they cannot cause runtime cycles.
  const typeOnly = ts.isImportDeclaration(n) ? n.importClause?.isTypeOnly : n.isTypeOnly;
  return typeOnly ? undefined : spec.text;
}

function requireSpecifier(n: ts.Node): string | undefined {
  if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== "require") return undefined;
  const arg = n.arguments[0];
  return arg && ts.isStringLiteral(arg) ? arg.text : undefined;
}

/** Returns the module specifier a node loads at runtime, if any. */
function runtimeSpecifier(n: ts.Node): string | undefined {
  if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return importOrExportSpecifier(n);
  return requireSpecifier(n);
}

export function importsOf(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (n: ts.Node) => {
    const spec = runtimeSpecifier(n);
    if (spec !== undefined) specs.push(spec);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return specs;
}

export function buildGraph(files: string[]): Map<string, string[]> {
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const f of files) {
    const deps = importsOf(f)
      .map((s) => resolveImport(f, s, known))
      .filter((d): d is string => !!d && d !== f);
    graph.set(f, [...new Set(deps)]);
  }
  return graph;
}

/** Tarjan's algorithm. Returns strongly connected components with more than one node. */
export function findCycles(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const result: string[][] = [];

  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) result.push(comp.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) strong(v);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

export function cycleViolations(files: string[], root: string): Violation[] {
  return findCycles(buildGraph(files)).map((comp) => ({
    kind: "cycle" as const,
    file: relative(root, comp[0]),
    message: `Circular dependency: ${comp.map((c) => relative(root, c)).join(" <-> ")}`,
  }));
}
