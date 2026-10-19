import type { DiagnoseInput, Provider } from "./types.js";
import { CATEGORIES } from "./types.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const SYSTEM = `You investigate failed CI runs. Reply with ONE JSON object and nothing else:
{"category": one of ${JSON.stringify(CATEGORIES)}, "cause": string, "evidence": string[], "confidence": number between 0 and 1, "suggestedFix": string}
Rules:
- "evidence" must be lines copied EXACTLY from the log. Never paraphrase them.
- If the log does not show the cause, use category "unknown" and a low confidence.
- Do not invent file names, versions or commands that are not in the log or diff.`;

/** LLM provider over the Messages API. Its output is untrusted and is validated by the graph. */
export function anthropicProvider(opts: AnthropicOptions): Provider {
  const f = opts.fetchImpl ?? fetch;
  return {
    name: `anthropic:${opts.model}`,
    async diagnose(input: DiagnoseInput) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
      try {
        const tail = input.parsed.lines.slice(-200).join("\n");
        const user = [
          input.parsed.failedStep ? `Failed step: ${input.parsed.failedStep}` : "",
          input.feedback ? `Your previous answer was rejected: ${input.feedback}. Fix that.` : "",
          input.diff ? `Diff:\n${input.diff.slice(0, 6000)}` : "",
          `Log (last 200 lines):\n${tail}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        const res = await f("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: ctl.signal,
          headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: opts.model, max_tokens: 800, system: SYSTEM, messages: [{ role: "user", content: user }] }),
        });
        if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
        const body = (await res.json()) as { content?: { type: string; text?: string }[] };
        const text = body.content?.find((c) => c.type === "text")?.text ?? "";
        const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
        return JSON.parse(json);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
