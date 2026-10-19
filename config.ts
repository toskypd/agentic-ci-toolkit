import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GateConfig {
  maxFileLines: number;
  maxFunctionLines: number;
  maxComplexity: number;
  failOnCycles: boolean;
  ignore: string[];
}

export const defaultConfig: GateConfig = {
  maxFileLines: 400,
  maxFunctionLines: 60,
  maxComplexity: 10,
  failOnCycles: true,
  ignore: ["node_modules", "dist", "build", "coverage", ".git"],
};

/** Loads .qualitygate.json from the project root and merges it over the defaults. */
export function loadConfig(root: string): GateConfig {
  const file = join(root, ".qualitygate.json");
  if (!existsSync(file)) return { ...defaultConfig };
  const user = JSON.parse(readFileSync(file, "utf8")) as Partial<GateConfig>;
  return { ...defaultConfig, ...user };
}
