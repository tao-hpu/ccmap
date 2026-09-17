import { readdirSync, statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { costOf, DEEPSEEK_PRICE_REVISION, type Price } from "./pricing.js";
import { SOURCES, emptyBySource, emptySrc, fromSrc, type DayStat, type Source } from "./sources.js";
import { eachLineMatching } from "./lines.js";
import { findDeepSeekSessions, readDeepSeekSession } from "./deepseek.js";
import { loadRollup, saveRollup, mergeDays, dayStatToRecord, type DayRecord } from "./rollup.js";
import {
  fresh,
  loadScanCache,
  saveScanCache,
  stampOf,
  type CachedDay,
  type CachedFile,
} from "./filecache.js";

export { SOURCES, emptyBySource, toBySource, type Source, type DayStat, type SourceStat } from "./sources.js";

export interface ScanResult {
  days: Map<string, DayStat>;
  totalTokens: number;
  totalCost: number;
  unpricedTokens: number;
  warnings: string[];
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
  return dateKey(d);
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureDay(days: Map<string, DayStat>, date: string): DayStat {
  let d = days.get(date);
  if (!d) {
    d = fromSrc(date, emptySrc(), new Set());
    days.set(date, d);
  }
  return d;
}

// Record usage against one engine, keeping the per-source split (which the
// rollup merges on) and the flat totals (which everything else reads) in step.
function add(
  days: Map<string, DayStat>,
  date: string,
  source: Source,
  model: string,
  tokens: number,
  cost: number,
  session: string,
  unpricedTokens = 0
) {
  if (!date) return;
  const d = ensureDay(days, date);
  const s = d.src[source];
  s.tokens += tokens;
  s.cost += cost;
  if (unpricedTokens) s.unpricedTokens = (s.unpricedTokens ?? 0) + unpricedTokens;
  s.byModel[model] = (s.byModel[model] || 0) + tokens;
  d.tokens += tokens;
  d.cost += cost;
  if (unpricedTokens) d.unpricedTokens = (d.unpricedTokens ?? 0) + unpricedTokens;
  d.bySource[source] += tokens;
  d.byModel[model] = (d.byModel[model] || 0) + tokens;
  if (session) d.sessions.add(session);
}

export interface ScanOptions {
  claudeDir?: string;
  codexDir?: string;
  grokDir?: string;
  deepseekDir?: string;
  pricing?: Record<string, Price>;
  // Path to the persistent daily rollup. When set, scan merges the live log
  // scan with previously-seen days (so pruned history survives) and writes the
  // merged result back. Omit it (e.g. in tests) for a pure, side-effect-free scan.
  rollupPath?: string;
  // Grok uses this file; DeepSeek uses a separate `${cachePath}.deepseek`
  // namespace. Omit for a cold scan without cache writes.
  cachePath?: string;
}

// Roll a day map up into the report-level totals.
function summarize(days: Map<string, DayStat>) {
  let totalTokens = 0;
  let totalCost = 0;
  let unpricedTokens = 0;
  const byModel: Record<string, number> = Object.create(null);
  const bySource = emptyBySource();
  const dates = [...days.keys()].sort();
  for (const d of days.values()) {
    totalTokens += d.tokens;
    totalCost += d.cost;
    unpricedTokens += d.unpricedTokens ?? 0;
    for (const s of SOURCES) bySource[s] += d.bySource[s] ?? 0;
    for (const [m, v] of Object.entries(d.byModel)) byModel[m] = (byModel[m] || 0) + v;
  }
  return { totalTokens, totalCost, unpricedTokens, byModel, bySource, firstDay: dates[0], lastDay: dates[dates.length - 1] };
}

// The Grok CLI reports the cost it billed for each turn in `costUsdTicks`.
// A tick is a nano-dollar: turns that cost a few hundred million ticks line up
// with the sub-dollar requests they came from, and no other scale lands inside
// an order of magnitude of the token counts on the same record.
const GROK_TICKS_PER_USD = 1e9;

function scanClaude(days: Map<string, DayStat>, dir: string, pricing?: Record<string, Price>) {
  const seen = new Set<string>();
  for (const file of walk(dir, (f) => f.endsWith(".jsonl"))) {
    eachLineMatching(file, '"type":"assistant"', (line) => {
      if (!line || line[0] !== "{") return;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      if (o.type !== "assistant") return;
      const msg = o.message;
      const u = msg?.usage;
      if (!u) return;
      const key = `${msg.id ?? ""}:${o.requestId ?? ""}`;
      if (key !== ":" && seen.has(key)) return;
      if (key !== ":") seen.add(key);
      const model = msg.model ?? "unknown";
      // Cache writes come in two tiers: 5-minute (1.25x input) and 1-hour (2x input).
      // The usage record breaks them out under cache_creation; fall back to all-5m.
      const cc = u.cache_creation || {};
      const totalCw = u.cache_creation_input_tokens || 0;
      const cw1h = cc.ephemeral_1h_input_tokens || 0;
      const cw5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : totalCw - cw1h;
      const t = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: cw5m,
        cacheWrite1h: cw1h,
        cacheRead: u.cache_read_input_tokens || 0,
      };
      const tokens = t.input + t.output + t.cacheWrite + t.cacheWrite1h + t.cacheRead;
      if (tokens === 0) return;
      add(days, localDate(o.timestamp), "claude", model, tokens, costOf(model, t, pricing), o.sessionId ?? "");
    });
  }
}

function scanCodex(days: Map<string, DayStat>, dir: string, pricing?: Record<string, Price>) {
  for (const file of walk(dir, (f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))) {
    let model = "codex";
    let sessionId = file;
    eachLineMatching(file, "", (line) => {
      if (!line || line[0] !== "{") return;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      if (o.type === "session_meta") {
        sessionId = o.payload?.id ?? sessionId;
        return;
      }
      if (o.type === "turn_context" && o.payload?.model) {
        model = o.payload.model;
        return;
      }
      if (o.type !== "event_msg") return;
      const p = o.payload;
      if (p?.type !== "token_count") return;
      const last = p.info?.last_token_usage;
      if (!last) return;
      const cached = last.cached_input_tokens || 0;
      const t = {
        input: Math.max(0, (last.input_tokens || 0) - cached),
        output: last.output_tokens || 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        cacheRead: cached,
      };
      const tokens = (last.total_tokens as number) || t.input + t.output + cached;
      if (tokens === 0) return;
      add(days, localDate(o.timestamp), "codex", model, tokens, costOf(model, t, pricing), sessionId);
    });
  }
}

// Read one Grok session log into a per-day aggregate.
//
// `~/.grok/sessions/<url-encoded project>/<session id>/updates.jsonl` is the
// append-only ACP stream for a single session. Every user prompt closes with a
// `turn_completed` update carrying that prompt's whole usage roll-up (all the
// model calls the agent made to answer it), so one line per prompt is the
// complete picture — and sub-agents get their own session directory, so nothing
// is counted twice. Sub-second logs run to hundreds of MB, hence the prefilter.
function readGrokSession(file: string, pricing?: Record<string, Price>): Record<string, CachedDay> {
  const out: Record<string, CachedDay> = {};
  const seen = new Set<string>();
  const sessionFallback = basename(join(file, ".."));
  eachLineMatching(file, '"turn_completed"', (line) => {
    if (!line || line[0] !== "{") return;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const up = o.params?.update;
    if (up?.sessionUpdate !== "turn_completed") return;
    const u = up.usage;
    if (!u) return;
    const pid = up.prompt_id;
    if (pid) {
      if (seen.has(pid)) return;
      seen.add(pid);
    }
    const ms = o.params?._meta?.agentTimestampMs ?? (o.timestamp ? o.timestamp * 1000 : 0);
    if (!ms) return;
    const date = dateKey(new Date(ms));
    const session = o.params?.sessionId ?? sessionFallback;
    // Prefer the per-model split; a turn can hand off between models.
    const perModel: [string, any][] =
      u.modelUsage && typeof u.modelUsage === "object" && Object.keys(u.modelUsage).length
        ? Object.entries(u.modelUsage)
        : [["grok", u]];
    for (const [model, mv] of perModel) {
      const cacheRead = mv.cachedReadTokens || 0;
      const cacheWrite = mv.cacheCreationTokens || 0;
      const t = {
        // inputTokens is the full prompt, cached portions included
        input: Math.max(0, (mv.inputTokens || 0) - cacheRead - cacheWrite),
        output: mv.outputTokens || 0,
        cacheWrite,
        cacheWrite1h: 0,
        cacheRead,
      };
      const tokens = (mv.totalTokens as number) || t.input + t.output + cacheWrite + cacheRead;
      if (tokens === 0) continue;
      const ticks = mv.costUsdTicks;
      const cost = typeof ticks === "number" && ticks > 0 ? ticks / GROK_TICKS_PER_USD : costOf(model, t, pricing);
      const day = (out[date] ??= { m: {}, s: [] });
      const slot = (day.m[model] ??= { t: 0, c: 0 });
      slot.t += tokens;
      slot.c += cost;
      if (session && !day.s.includes(session)) day.s.push(session);
    }
  });
  return out;
}

function scanGrok(
  days: Map<string, DayStat>,
  dir: string,
  pricing: Record<string, Price> | undefined,
  cache: Map<string, CachedFile> | null
) {
  const stillThere = new Set<string>();
  for (const file of walk(dir, (f) => f === "updates.jsonl")) {
    stillThere.add(file);
    const hit = cache ? fresh(cache.get(file), file) : null;
    let byDay: Record<string, CachedDay>;
    if (hit) {
      byDay = hit.days;
    } else {
      byDay = readGrokSession(file, pricing);
      if (cache) {
        const stamp = stampOf(file);
        if (stamp) cache.set(file, { ...stamp, days: byDay });
      }
    }
    for (const [date, d] of Object.entries(byDay)) {
      for (const [model, v] of Object.entries(d.m)) add(days, date, "grok", model, v.t, v.c, "");
      const target = ensureDay(days, date);
      for (const s of d.s) target.sessions.add(s);
    }
  }
  // Drop entries for logs Grok has since deleted, so the cache can't grow forever.
  if (cache) for (const key of [...cache.keys()]) if (!stillThere.has(key)) cache.delete(key);
}

interface DeepSeekSessionCache extends CachedFile {
  id: string;
  fingerprint: string;
}

function scanDeepSeek(
  days: Map<string, DayStat>,
  dir: string,
  pricing: Record<string, Price> | undefined,
  cache: Map<string, CachedFile> | null
): string[] {
  const fingerprint = createHash("sha256").update(JSON.stringify([
    1, DEEPSEEK_PRICE_REVISION, Intl.DateTimeFormat().resolvedOptions().timeZone,
    Object.entries(pricing ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ])).digest("hex");
  const warnings: string[] = [];
  const seen = new Set<string>();
  const retained = new Set<string>();
  const files = findDeepSeekSessions(dir, warnings)
    .sort((a, b) => b.version - a.version || a.file.localeCompare(b.file));
  for (const candidate of files) {
    const before = cache ? stampOf(candidate.file) : null;
    const hit = (cache ? fresh(cache.get(candidate.file), candidate.file) : null) as DeepSeekSessionCache | null;
    const result = hit?.fingerprint === fingerprint && typeof hit.id === "string"
      ? { id: hit.id, days: hit.days, warnings: [] }
      : readDeepSeekSession(candidate, pricing);
    warnings.push(...result.warnings);
    if (!result.id) continue;
    if (seen.has(result.id)) { warnings.push(`DeepSeek: duplicate session ${result.id} skipped`); continue; }
    seen.add(result.id);
    for (const [date, d] of Object.entries(result.days)) {
      for (const [model, v] of Object.entries(d.m)) add(days, date, "deepseek", model, v.t, v.c, "", v.u);
      const target = ensureDay(days, date);
      for (const s of d.s) target.sessions.add(s);
    }
    const after = cache ? stampOf(candidate.file) : null;
    // Partial or changing logs must be read again on the next scan.
    if (cache && !result.warnings.length && before && after && before.size === after.size && before.mtime === after.mtime) {
      cache.set(candidate.file, { ...after, days: result.days, id: result.id, fingerprint } as DeepSeekSessionCache);
      retained.add(candidate.file);
    }
  }
  // Also evict superseded generations and duplicate copies, not just deleted logs.
  if (cache) for (const key of [...cache.keys()]) if (!retained.has(key)) cache.delete(key);
  return warnings;
}

export function scan(opts: ScanOptions = {}): ScanResult {
  const days = new Map<string, DayStat>();
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude", "projects");
  const codexDir = opts.codexDir ?? join(homedir(), ".codex", "sessions");
  const grokDir = opts.grokDir ?? join(homedir(), ".grok", "sessions");
  const deepseekDir = opts.deepseekDir ?? join(process.env.DSH_HOME || join(homedir(), ".dsh"), "sessions");
  const warnings: string[] = [];

  if (existsSync(claudeDir)) scanClaude(days, claudeDir, opts.pricing);
  if (existsSync(codexDir)) scanCodex(days, codexDir, opts.pricing);
  if (existsSync(grokDir)) {
    const cache = opts.cachePath ? loadScanCache(opts.cachePath) : null;
    scanGrok(days, grokDir, opts.pricing, cache);
    if (cache && opts.cachePath) saveScanCache(cache, opts.cachePath);
  }
  if (existsSync(deepseekDir)) {
    // Reuse the per-file cache helpers in a separate namespace so Grok's
    // deleted-file cleanup cannot evict DeepSeek sessions, or vice versa.
    const cachePath = opts.cachePath ? `${opts.cachePath}.deepseek` : undefined;
    const cache = cachePath ? loadScanCache(cachePath) : null;
    warnings.push(...scanDeepSeek(days, deepseekDir, opts.pricing, cache));
    if (cache && cachePath) saveScanCache(cache, cachePath);
  }

  // --- merge with the persistent rollup so pruned days survive ---
  let result = days;
  if (opts.rollupPath) {
    result = mergeDays(days, loadRollup(opts.rollupPath));
    const rec = new Map<string, DayRecord>();
    for (const [date, d] of result) rec.set(date, dayStatToRecord(d));
    saveRollup(rec, opts.rollupPath);
  }

  return { days: result, ...summarize(result), warnings };
}

// Longest run of consecutive active days ending at `today`.
export function currentStreak(days: Map<string, DayStat>, today = new Date()): number {
  let streak = 0;
  const d = new Date(today);
  // allow today to be empty without breaking streak
  let started = false;
  for (let i = 0; i < 3650; i++) {
    const key = dateKey(d);
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
