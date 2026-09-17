import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.js";
import {
  SOURCES,
  emptySrc,
  fromSrc,
  sourceOfModel,
  toBySource,
  type DayStat,
  type Source,
  type SourceStat,
} from "./sources.js";

// Persistent daily rollup. Claude Code prunes session transcripts after
// `cleanupPeriodDays` (default 30), and Codex has its own retention — so the
// raw logs are a rolling window. We snapshot each day's aggregates here so the
// heatmap keeps a day forever once we've seen it, without touching CC's config
// or hoarding the (large) raw transcripts. The file is tiny: a few KB/year.
export const ROLLUP_PATH = join(CONFIG_DIR, "history.json");

// A JSON-serializable snapshot of one day. Mirrors DayStat but stores the
// session *count* — the Set members are irrelevant once a day is frozen.
//
// `src` (the per-engine split) is what merging actually works on; the flat
// fields alongside it are kept so a ccmap older than 0.2.0 can still read the
// file it shares. Records written before 0.2.0 have no `src` and are split on
// read by `srcOfRecord`.
export interface DayRecord {
  date: string;
  tokens: number;
  cost: number;
  bySource: Partial<Record<Source, number>>;
  byModel: Record<string, number>;
  sessions: number;
  src?: Partial<Record<Source, SourceStat>>;
}

interface RollupFile {
  v: number;
  days: DayRecord[];
}

export function dayStatToRecord(d: DayStat): DayRecord {
  const src: Partial<Record<Source, SourceStat>> = {};
  for (const s of SOURCES) {
    const v = d.src?.[s];
    if (v && v.tokens > 0) src[s] = { ...v, byModel: { ...v.byModel } };
  }
  return {
    date: d.date,
    tokens: d.tokens,
    cost: d.cost,
    bySource: { ...d.bySource },
    byModel: { ...d.byModel },
    sessions: d.sessions.size,
    src,
  };
}

// Recover the per-engine split from a stored record. Post-0.2.0 records carry
// it verbatim. Older ones don't, so we reconstruct: token counts come from
// `bySource` (exact), models are attributed by name (also exact — no engine
// shares a model prefix with another), and the day's cost is apportioned by
// token share, which is the one approximation and only ever touches days that
// were already frozen before the split existed.
function srcOfRecord(r: DayRecord): Record<Source, SourceStat> {
  const out = emptySrc();
  if (r.src) {
    for (const s of SOURCES) {
      const v = r.src[s];
      if (v) out[s] = { tokens: v.tokens || 0, cost: v.cost || 0, byModel: { ...(v.byModel ?? {}) },
        ...(v.unpricedTokens ? { unpricedTokens: v.unpricedTokens } : {}) };
    }
    return out;
  }
  const by = toBySource(r.bySource);
  let total = 0;
  for (const s of SOURCES) total += by[s];
  // A record so old it predates bySource entirely: file it all under Claude,
  // the only engine ccmap scanned back then.
  const fallback: Source = total > 0 ? SOURCES.reduce((a, b) => (by[a] >= by[b] ? a : b)) : "claude";
  if (total <= 0) {
    out[fallback] = { tokens: r.tokens || 0, cost: r.cost || 0, byModel: { ...(r.byModel ?? {}) } };
    return out;
  }
  for (const s of SOURCES) {
    out[s].tokens = by[s];
    out[s].cost = ((r.cost || 0) * by[s]) / total;
  }
  for (const [m, v] of Object.entries(r.byModel ?? {})) {
    const s = sourceOfModel(m) ?? fallback;
    out[s].byModel[m] = (out[s].byModel[m] || 0) + v;
  }
  return out;
}

// Rebuild a DayStat from a frozen record. The original session ids are gone, so
// we synthesize placeholders — only `.size` is ever read downstream.
export function recordToDayStat(r: DayRecord): DayStat {
  const sessions = new Set<string>();
  for (let i = 0; i < (r.sessions || 0); i++) sessions.add(`_${i}`);
  return fromSrc(r.date, srcOfRecord(r), sessions);
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

// Monotonic-max merge, per engine. A given day's usage for a given engine only
// grows as sessions accrue, so whichever side reports more tokens for that
// engine is the more complete record of it. Live reflects logs still on disk;
// stored preserves days the CLIs have since pruned.
//
// Doing this per engine matters once more than one is in play: a day where
// Claude's transcripts were pruned but Grok's survive would otherwise be
// resolved in whole-record favour of one side, silently discarding the other's
// history for that day.
export function mergeDays(
  live: Map<string, DayStat>,
  stored: Map<string, DayRecord>
): Map<string, DayStat> {
  const out = new Map<string, DayStat>();
  for (const date of new Set([...stored.keys(), ...live.keys()])) {
    const l = live.get(date);
    const s = stored.get(date);
    const ls = l?.src ?? emptySrc();
    const ss = s ? srcOfRecord(s) : emptySrc();
    const merged = emptySrc();
    for (const k of SOURCES) {
      // live wins ties — it carries real session ids
      const win = ls[k].tokens >= ss[k].tokens ? ls[k] : ss[k];
      merged[k] = { ...win, byModel: { ...win.byModel } };
    }
    const sessions = new Set<string>(l?.sessions ?? []);
    for (let i = 0; sessions.size < (s?.sessions ?? 0); i++) sessions.add(`_${i}`);
    out.set(date, fromSrc(date, merged, sessions));
  }
  return out;
}
