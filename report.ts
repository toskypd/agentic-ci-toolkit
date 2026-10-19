import type { Violation } from "./analyze.js";

const TITLES: Record<Violation["kind"], string> = {
  "file-size": "Large files",
  "function-size": "Long functions",
  complexity: "High complexity",
  cycle: "Circular dependencies",
};

/** One markdown comment, grouped by kind. Designed to be posted once per PR. */
export function toMarkdown(violations: Violation[], filesChecked: number): string {
  if (violations.length === 0) {
    return `### Quality gate: passed\n\nChecked ${filesChecked} files. No issues found.`;
  }
  const lines = [`### Quality gate: ${violations.length} issue${violations.length === 1 ? "" : "s"} found`, "", `Checked ${filesChecked} files.`, ""];
  for (const kind of Object.keys(TITLES) as Violation["kind"][]) {
    const group = violations.filter((v) => v.kind === kind);
    if (!group.length) continue;
    lines.push(`**${TITLES[kind]}** (${group.length})`, "");
    for (const v of group) lines.push(`- \`${v.file}${v.line ? ":" + v.line : ""}\` ${v.message}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
