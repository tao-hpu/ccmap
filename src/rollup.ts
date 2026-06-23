import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.js";
import type { DayStat, Source } from "./parse.js";

// Persistent daily rollup. Claude Code prunes session transcripts after
// `cleanupPeriodDays` (default 30), and Codex has its own retention — so the
// raw logs are a rolling window. We snapshot each day's aggregates here so the
// heatmap keeps a day forever once we've seen it, without touching CC's config
// or hoarding the (large) raw transcripts. The file is tiny: a few KB/year.
export const ROLLUP_PATH = join(CONFIG_DIR, "history.json");

// A JSON-serializable snapshot of one day. Mirrors DayStat but stores the
// session *count* — the Set members are irrelevant once a day is frozen.
export interface DayRecord {
  date: string;
  tokens: number;
  cost: number;
  bySource: Record<Source, number>;
  byModel: Record<string, number>;
  sessions: number;
}

interface RollupFile {
  v: number;
  days: DayRecord[];
}

export function dayStatToRecord(d: DayStat): DayRecord {
  return {
    date: d.date,
    tokens: d.tokens,
    cost: d.cost,
    bySource: { claude: d.bySource.claude, codex: d.bySource.codex },
    byModel: { ...d.byModel },
    sessions: d.sessions.size,
  };
}

// Rebuild a DayStat from a frozen record. The original session ids are gone, so
// we synthesize placeholders — only `.size` is ever read downstream.
export function recordToDayStat(r: DayRecord): DayStat {
  const sessions = new Set<string>();
  for (let i = 0; i < (r.sessions || 0); i++) sessions.add(`_${i}`);
  return {
    date: r.date,
    tokens: r.tokens || 0,
    cost: r.cost || 0,
    sessions,
    bySource: { claude: r.bySource?.claude ?? 0, codex: r.bySource?.codex ?? 0 },
    byModel: { ...(r.byModel ?? {}) },
  };
}

export function loadRollup(path: string = ROLLUP_PATH): Map<string, DayRecord> {
  const map = new Map<string, DayRecord>();
  if (!existsSync(path)) return map;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RollupFile;
    for (const d of parsed?.days ?? []) {
      if (d && typeof d.date === "string") map.set(d.date, d);
    }
  } catch {
    // corrupt cache → start fresh; a stats tool must never throw on read
  }
  return map;
}

export function saveRollup(days: Map<string, DayRecord>, path: string = ROLLUP_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    const out: RollupFile = { v: 1, days: sorted };
    writeFileSync(path, JSON.stringify(out));
  } catch {
    // best-effort: a failed write just means no caching this run
  }
}

// Monotonic-max merge: for each date keep the record with the most tokens.
// Live reflects logs still on disk; stored preserves days CC has since pruned.
// A day's token count only grows as sessions accrue, so "max tokens" wins are
// stable and never double-count. Live wins ties (it carries real session ids).
export function mergeDays(
  live: Map<string, DayStat>,
  stored: Map<string, DayRecord>
): Map<string, DayStat> {
  const out = new Map<string, DayStat>();
  for (const [date, rec] of stored) out.set(date, recordToDayStat(rec));
  for (const [date, d] of live) {
    const prev = out.get(date);
    if (!prev || d.tokens >= prev.tokens) out.set(date, d);
  }
  return out;
}
