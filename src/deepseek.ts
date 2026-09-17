import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readDeepSeekLines } from "./deepseek-log.js";
import { deepSeekCost, type Price, type TokenBreakdown } from "./pricing.js";
import type { CachedDay } from "./filecache.js";

type ObjectRecord = Record<string, unknown>;
function record(value: unknown): ObjectRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectRecord : {};
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function timestamp(value: unknown): value is number {
  return count(value) && Number.isFinite(new Date(value).getTime());
}
function dateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Usage {
  tokens: number;
  breakdown?: TokenBreakdown;
}

function usageOf(value: unknown): Usage | undefined {
  const u = record(value);
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"]) {
    if (u[key] !== undefined && !count(u[key])) return undefined;
  }
  if (typeof u.reasoningTokens === "number" && typeof u.outputTokens === "number" && u.reasoningTokens > u.outputTokens) return undefined;
  const input = u.inputTokens;
  const output = u.outputTokens;
  const cacheRead = (u.cacheReadTokens ?? 0) as number;
  const cacheWrite = (u.cacheWriteTokens ?? 0) as number;
  const known = (typeof input === "number" ? input : 0) + (typeof output === "number" ? output : 0) + cacheRead + cacheWrite;
  if (!count(known)) return undefined;
  if (u.totalTokens !== undefined && (u.totalTokens as number) < known) return undefined;
  if (typeof input !== "number" || typeof output !== "number") {
    return count(u.totalTokens) ? { tokens: u.totalTokens } : undefined;
  }
  // Harness adapters already separate cached input from inputTokens. Reasoning
  // is a subset of output, never another billable bucket.
  if (u.totalTokens !== undefined && u.totalTokens !== known) return undefined;
  return { tokens: known, breakdown: { input, output, cacheRead, cacheWrite, cacheWrite1h: 0 } };
}

interface Attempt {
  seq: number;
  time: number;
  endTime: number;
  turn: number;
  step: number;
  model: string;
  provider: string;
  usage?: unknown;
  settled: boolean;
}
interface SessionResult {
  id: string;
  days: Record<string, CachedDay>;
  warnings: string[];
}
export interface DeepSeekSessionFile { file: string; version: number }

export function findDeepSeekSessions(dir: string, warnings: string[]): DeepSeekSessionFile[] {
  const out: DeepSeekSessionFile[] = [];
  const visit = (path: string) => {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); }
    catch { warnings.push(`DeepSeek: cannot read directory ${path}`); return; }
    const logs: DeepSeekSessionFile[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) visit(join(path, entry.name));
      else if (entry.isFile()) {
        const match = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/.exec(entry.name);
        if (match) logs.push({ file: join(path, entry.name), version: Number(match[1] ?? 0) });
      }
    }
    if (!logs.length) return;
    const latest = Math.max(...logs.map(log => log.version));
    const selected = logs.filter(log => log.version === latest);
    if (latest > 3) warnings.push(`DeepSeek: unsupported session format v${latest} in ${path}`);
    else if (selected.length !== 1) warnings.push(`DeepSeek: conflicting session log encodings in ${path}`);
    else out.push(selected[0]);
  };
  visit(dir);
  return out;
}

export function readDeepSeekSession(candidate: DeepSeekSessionFile, prices?: Record<string, Price>): SessionResult {
  let days: Record<string, CachedDay> = {};
  let id = "";
  let first = true;
  let validHeader = false;
  let seeded = false;
  let inheritedCut = 0;
  let foundCut = false;
  let maxSeq = -1;
  let model = "unknown";
  let provider = "";
  let attempt: Attempt | undefined;
  const warnings = new Set<string>();
  const warn = (reason: string) => warnings.add(`DeepSeek: ${reason} (${candidate.file})`);

  const flush = () => {
    if (!attempt) return;
    const a = attempt;
    attempt = undefined;
    if (a.seq < inheritedCut || a.usage === undefined) return;
    const usage = usageOf(a.usage);
    if (!usage) { warn("invalid token usage skipped"); return; }
    if (!usage.tokens) return;
    const cost = usage.breakdown ? deepSeekCost(a.model, a.provider, usage.breakdown, a.time, prices) : undefined;
    const d = days[dateKey(a.endTime)] ??= { m: Object.create(null), s: [] };
    const slot = d.m[a.model] ??= { t: 0, c: 0 };
    slot.t += usage.tokens;
    slot.c += cost ?? 0;
    if (cost === undefined) slot.u = (slot.u ?? 0) + usage.tokens;
    if (!d.s.includes(`deepseek:${id}`)) d.s.push(`deepseek:${id}`);
  };

  const read = (line: string) => {
    if (!line.trim()) return;
    // Packed text/reasoning/tool-call chunks never contain billing records.
    if (!first && !/"type"\s*:\s*"(?:step\/start|step\/end|turn\/end|llm\/retry(?:-started)?|request\/context|assistant\/(?:chunk|message|attempt)|session\/end-seed)"/.test(line)) return;
    let o: ObjectRecord;
    try { o = record(JSON.parse(line)); }
    catch { warn("incomplete or malformed JSON record skipped"); return; }
    if (first) {
      first = false;
      if (o.type !== "session" || o.version !== candidate.version || typeof o.id !== "string" || !o.id) {
        warn("invalid session header"); return;
      }
      id = o.id;
      if (candidate.version < 2) {
        if (o.seedLength !== undefined && !count(o.seedLength)) { warn("invalid inherited prefix"); return; }
        inheritedCut = (o.seedLength ?? 0) as number;
      } else {
        if (typeof o.isSeeded !== "boolean") { warn("invalid seeded session header"); return; }
        seeded = o.isSeeded;
      }
      validHeader = true;
      return;
    }
    if (!validHeader) return;
    if (!count(o.seq) || !timestamp(o.time)) { warn("invalid event sequence or time skipped"); return; }
    if (o.seq <= maxSeq) return; // repeated physical records must not repeat usage
    maxSeq = o.seq;
    const d = record(o.data);
    if (o.type === "request/context") {
      model = typeof d.model === "string" && d.model ? d.model : "unknown";
      provider = typeof d.provider === "string" ? d.provider : "";
      if (attempt && !attempt.settled) { attempt.model = model; attempt.provider = provider; }
      return;
    }
    if (o.type === "session/end-seed") {
      if (candidate.version >= 2 && d.inherited === true) {
        if (!seeded) { validHeader = false; warn("unseeded session has an inherited marker"); return; }
        // Nested forks can contain ancestor markers. The last tagged marker
        // defines this session's own prefix; ordinary restore markers do not.
        days = {};
        attempt = undefined;
        inheritedCut = o.seq;
        foundCut = true;
      }
      return;
    }
    if (o.type === "step/start" || o.type === "llm/retry-started") {
      flush();
      if (!count(d.turn) || !count(d.step)) { warn("invalid attempt start"); return; }
      attempt = { seq: o.seq, time: o.time, endTime: o.time, turn: d.turn, step: d.step, model, provider, settled: false };
      return;
    }
    if (o.type === "step/end" || o.type === "turn/end" || o.type === "llm/retry") { flush(); return; }
    if (!attempt || attempt.turn !== d.turn || attempt.step !== d.step) {
      if (o.type === "assistant/message" || o.type === "assistant/attempt") warn("usage event without matching attempt skipped");
      return;
    }
    if (attempt.settled) return;
    if (o.type === "assistant/chunk" && candidate.version < 2) {
      const chunk = record(d.chunk);
      if (chunk.type === "usage") { attempt.usage = chunk.usage; attempt.endTime = o.time; }
    } else if (o.type === "assistant/message" || o.type === "assistant/attempt") {
      if (candidate.version >= 2 && Array.isArray(d.stream)) {
        for (const item of d.stream) {
          const row = record(item);
          const chunk = record(row.chunk);
          if (row.type === "chunk" && chunk.type === "usage") attempt.usage = chunk.usage;
        }
      }
      if (o.type === "assistant/message") {
        if (d.usage !== undefined) attempt.usage = d.usage;
        const source = record(record(d.message).source);
        if (typeof source.model === "string" && source.model) {
          attempt.model = source.model;
          attempt.provider = typeof source.provider === "string" ? source.provider : "";
        }
      }
      attempt.endTime = o.time;
      attempt.settled = true;
    }
  };
  try { readDeepSeekLines(candidate.file, read); }
  catch { warn("unreadable or truncated log; complete records retained"); }
  flush();
  if (first) warn("missing session header");
  if (seeded && !foundCut) warn("seeded session missing inherited boundary; skipped");
  if (inheritedCut > maxSeq + 1) { validHeader = false; warn("inherited prefix exceeds log; skipped"); }
  if (!validHeader || seeded && !foundCut) days = {};
  return { id, days, warnings: [...warnings] };
}
