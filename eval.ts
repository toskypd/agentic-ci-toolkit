import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { anthropicProvider } from "./anthropic.js";
import { buildAgent } from "./graph.js";
import { heuristicProvider } from "./heuristic.js";

const dir = join(process.cwd(), "fixtures", "logs");
const provider = process.env.ANTHROPIC_API_KEY
  ? anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.CI_AGENT_MODEL ?? "claude-sonnet-4-5" })
  : heuristicProvider;
const agent = buildAgent({ provider });

let correct = 0, wrong = 0, abstainedRight = 0, abstainedWrong = 0;
const rows: string[] = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".log")).sort()) {
  const expected = JSON.parse(readFileSync(join(dir, file.replace(".log", ".expected.json")), "utf8")).category as string;
  const r = await agent.run(readFileSync(join(dir, file), "utf8"));
  const got = r.status === "diagnosed" ? r.diagnosis!.category : "abstain";
  let verdict: string;
  if (got === "abstain") {
    if (expected === "unknown") (abstainedRight++, (verdict = "ok (correctly abstained)"));
    else (abstainedWrong++, (verdict = "missed (abstained)"));
  } else if (got === expected) (correct++, (verdict = "ok"));
  else (wrong++, (verdict = "WRONG"));
  rows.push(`${file.padEnd(22)} expected=${expected.padEnd(19)} got=${got.padEnd(19)} ${verdict}`);
}
const total = correct + wrong + abstainedRight + abstainedWrong;
const answered = correct + wrong;
console.log(`provider: ${provider.name}\n${rows.join("\n")}\n`);
console.log(`logs: ${total}`);
console.log(`answered correctly: ${correct}`);
console.log(`answered wrongly: ${wrong}`);
console.log(`abstained correctly: ${abstainedRight}`);
console.log(`abstained but a cause was present: ${abstainedWrong}`);
console.log(`precision when it answers: ${answered ? ((correct / answered) * 100).toFixed(0) + "%" : "n/a"}`);
