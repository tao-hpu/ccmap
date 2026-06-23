import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Price } from "./pricing.js";

export interface Config {
  user?: string; // your handle, used as badge id
  endpoint?: string; // base URL of badge server, e.g. https://ccmap.dev
  token?: string; // auth token for push
  intervalMin?: number; // resident push interval
  autoUpdate?: boolean; // daemon auto-installs new versions when found
  metric?: "tokens" | "cost";
  weeks?: number;
  theme?: string; // named theme, see src/render.ts THEMES
  pricing?: Record<string, Price>; // model -> price override
}

export const CONFIG_DIR = join(homedir(), ".ccmap");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULTS: Config = {
  intervalMin: 1440, // once a day — usage is aggregated per-day, so more is pointless
  metric: "tokens",
  weeks: 26,
  theme: "claude",
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
