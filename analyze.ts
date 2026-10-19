import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import type { GateConfig } from "./config.js";

export type ViolationKind = "file-size" | "function-size" | "complexity" | "cycle";

export interface Violation {
  kind: ViolationKind;
  file: string;
  line?: number;
  message: string;
  value?: number;
  limit?: number;
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export function listSourceFiles(root: string, ignore: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (ignore.includes(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (SOURCE_EXT.test(name) && !name.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

const DECISION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

const SHORT_CIRCUIT_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function isDecisionPoint(node: ts.Node): boolean {
  if (DECISION_KINDS.has(node.kind)) return true;
  return ts.isBinaryExpression(node) && SHORT_CIRCUIT_OPS.has(node.operatorToken.kind);
}

/** Cyclomatic complexity: 1 + number of decision points inside the function body. */
export function cyclomaticComplexity(fn: ts.FunctionLikeDeclaration): number {
  let score = 1;
  const visit = (node: ts.Node) => {
    // Do not count nested functions toward the outer function.
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (isDecisionPoint(node)) score++;
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return score;
}

function functionName(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string {
  if (fn.name) return fn.name.getText(sf);
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name.getText(sf);
  return "<anonymous>";
}

export function analyzeFile(path: string, root: string, config: GateConfig): Violation[] {
  const text = readFileSync(path, "utf8");
  const file = relative(root, path);
  const violations: Violation[] = [];

  const lineCount = text.split("\n").length;
  if (lineCount > config.maxFileLines) {
    violations.push({
      kind: "file-size",
      file,
      message: `File has ${lineCount} lines (limit ${config.maxFileLines})`,
      value: lineCount,
      limit: config.maxFileLines,
    });
  }

  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body) {
      const fn = node as ts.FunctionLikeDeclaration;
      const start = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(fn.getEnd()).line + 1;
      const length = end - start + 1;
      const name = functionName(fn, sf);
      if (length > config.maxFunctionLines) {
        violations.push({
          kind: "function-size",
          file,
          line: start,
          message: `Function ${name} is ${length} lines (limit ${config.maxFunctionLines})`,
          value: length,
          limit: config.maxFunctionLines,
        });
      }
      const complexity = cyclomaticComplexity(fn);
      if (complexity > config.maxComplexity) {
        violations.push({
          kind: "complexity",
          file,
          line: start,
          message: `Function ${name} has complexity ${complexity} (limit ${config.maxComplexity})`,
          value: complexity,
          limit: config.maxComplexity,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}
