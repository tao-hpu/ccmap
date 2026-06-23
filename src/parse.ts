import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { costOf, type Price } from "./pricing.js";
import { loadRollup, saveRollup, mergeDays, dayStatToRecord, type DayRecord } from "./rollup.js";

export type Source = "claude" | "codex";

export interface DayStat {
  date: string; // local YYYY-MM-DD
  tokens: number; // total tokens (all kinds)
  cost: number; // estimated USD
  sessions: Set<string>;
  bySource: Record<Source, number>; // tokens per source
  byModel: Record<string, number>; // tokens per model
}

export interface ScanResult {
  days: Map<string, DayStat>;
  totalTokens: number;
  totalCost: number;
  byModel: Record<string, number>;
  bySource: Record<Source, number>;
  firstDay?: string;
  lastDay?: string;
}

function* walk(dir: string, match: (f: string) => boolean): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full, match);
    else if (match(e)) yield full;
  }
}

function localDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureDay(days: Map<string, DayStat>, date: string): DayStat {
  let d = days.get(date);
  if (!d) {
    d = {
      date,
      tokens: 0,
      cost: 0,
      sessions: new Set(),
      bySource: { claude: 0, codex: 0 },
      byModel: {},
    };
    days.set(date, d);
  }
  return d;
}

function add(
  days: Map<string, DayStat>,
  date: string,
  source: Source,
  model: string,
  tokens: number,
  cost: number,
  session: string
) {
  if (!date) return;
  const d = ensureDay(days, date);
  d.tokens += tokens;
  d.cost += cost;
  d.bySource[source] += tokens;
  d.byModel[model] = (d.byModel[model] || 0) + tokens;
  if (session) d.sessions.add(session);
}

export interface ScanOptions {
  claudeDir?: string;
  codexDir?: string;
  pricing?: Record<string, Price>;
  // Path to the persistent daily rollup. When set, scan merges the live log
  // scan with previously-seen days (so pruned history survives) and writes the
  // merged result back. Omit it (e.g. in tests) for a pure, side-effect-free scan.
  rollupPath?: string;
}

// Roll a day map up into the report-level totals.
function summarize(days: Map<string, DayStat>) {
  let totalTokens = 0;
  let totalCost = 0;
  const byModel: Record<string, number> = {};
  const bySource: Record<Source, number> = { claude: 0, codex: 0 };
  const dates = [...days.keys()].sort();
  for (const d of days.values()) {
    totalTokens += d.tokens;
    totalCost += d.cost;
    bySource.claude += d.bySource.claude;
    bySource.codex += d.bySource.codex;
    for (const [m, v] of Object.entries(d.byModel)) byModel[m] = (byModel[m] || 0) + v;
  }
  return { totalTokens, totalCost, byModel, bySource, firstDay: dates[0], lastDay: dates[dates.length - 1] };
}

export function scan(opts: ScanOptions = {}): ScanResult {
  const days = new Map<string, DayStat>();
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude", "projects");
  const codexDir = opts.codexDir ?? join(homedir(), ".codex", "sessions");
  const seen = new Set<string>(); // dedup keys

  // --- Claude ---
  if (existsSync(claudeDir)) {
    for (const file of walk(claudeDir, (f) => f.endsWith(".jsonl"))) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line || line[0] !== "{") continue;
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type !== "assistant") continue;
        const msg = o.message;
        const u = msg?.usage;
        if (!u) continue;
        const key = `${msg.id ?? ""}:${o.requestId ?? ""}`;
        if (key !== ":" && seen.has(key)) continue;
        if (key !== ":") seen.add(key);
        const model = msg.model ?? "unknown";
        const t = {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
        };
        const tokens = t.input + t.output + t.cacheWrite + t.cacheRead;
        if (tokens === 0) continue;
        const cost = costOf(model, t, opts.pricing);
        add(days, localDate(o.timestamp), "claude", model, tokens, cost, o.sessionId ?? "");
      }
    }
  }

  // --- Codex ---
  if (existsSync(codexDir)) {
    for (const file of walk(codexDir, (f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let model = "codex";
      let sessionId = file;
      for (const line of text.split("\n")) {
        if (!line || line[0] !== "{") continue;
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type === "session_meta") {
          sessionId = o.payload?.id ?? sessionId;
          continue;
        }
        if (o.type === "turn_context" && o.payload?.model) {
          model = o.payload.model;
          continue;
        }
        if (o.type !== "event_msg") continue;
        const p = o.payload;
        if (p?.type !== "token_count") continue;
        const last = p.info?.last_token_usage;
        if (!last) continue;
        const cached = last.cached_input_tokens || 0;
        const t = {
          input: Math.max(0, (last.input_tokens || 0) - cached),
          output: last.output_tokens || 0,
          cacheWrite: 0,
          cacheRead: cached,
        };
        const tokens = (last.total_tokens as number) || t.input + t.output + cached;
        if (tokens === 0) continue;
        const cost = costOf(model, t, opts.pricing);
        add(days, localDate(o.timestamp), "codex", model, tokens, cost, sessionId);
      }
    }
  }

  // --- merge with the persistent rollup so pruned days survive ---
  let result = days;
  if (opts.rollupPath) {
    result = mergeDays(days, loadRollup(opts.rollupPath));
    const rec = new Map<string, DayRecord>();
    for (const [date, d] of result) rec.set(date, dayStatToRecord(d));
    saveRollup(rec, opts.rollupPath);
  }

  return { days: result, ...summarize(result) };
}

// Longest run of consecutive active days ending at `today`.
export function currentStreak(days: Map<string, DayStat>, today = new Date()): number {
  let streak = 0;
  const d = new Date(today);
  // allow today to be empty without breaking streak
  let started = false;
  for (let i = 0; i < 3650; i++) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const active = (days.get(key)?.tokens ?? 0) > 0;
    if (active) {
      streak++;
      started = true;
    } else if (started || i > 0) {
      break;
    }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}
