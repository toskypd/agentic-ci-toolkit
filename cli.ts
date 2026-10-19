import { writeFileSync } from "node:fs";
import { changedFiles, runGate } from "./run.js";
import { toMarkdown } from "./report.js";

// Usage: gate [root] [--base origin/main] [--markdown out.md] [--json]
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))) ?? ".";
const base = flag("--base");
const mdPath = flag("--markdown");

const only = base ? changedFiles(root, base) : undefined;
const result = runGate(root, { only });

if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
else console.log(toMarkdown(result.violations, result.filesChecked));
if (mdPath) writeFileSync(mdPath, toMarkdown(result.violations, result.filesChecked));
process.exit(result.failed ? 1 : 0);
