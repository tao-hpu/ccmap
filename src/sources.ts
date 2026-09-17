// Engine vocabulary shared by the scanner, the renderers and the badge server.
// Deliberately free of any `node:` import — the Cloudflare Worker build pulls
// render.ts/report.ts in, and anything they touch has to run on that runtime too.

// Engines we scan; renderers derive their source lists from this registry.
export const SOURCES = ["claude", "codex", "grok", "deepseek"] as const;
export type Source = (typeof SOURCES)[number];

// One engine's slice of a day. This is the authoritative unit: totals, the
// source mix and the model mix are all derived from these.
export interface SourceStat {
  tokens: number;
  cost: number; // estimated USD
  unpricedTokens?: number; // usage without a known price; excluded from cost
  byModel: Record<string, number>;
}

export interface DayStat {
  src: Record<Source, SourceStat>;
  date: string; // local YYYY-MM-DD
  tokens: number; // total tokens (all kinds)
  cost: number; // estimated USD
  unpricedTokens?: number;
  sessions: Set<string>;
  bySource: Record<Source, number>; // tokens per source
  byModel: Record<string, number>; // tokens per model
}

export function emptyBySource(): Record<Source, number> {
  const o = {} as Record<Source, number>;
  for (const s of SOURCES) o[s] = 0;
  return o;
}

// Coerce a possibly-partial record (an older rollup file, an older push payload)
// into a full per-source map, so data written before a source existed still reads.
export function toBySource(v: Partial<Record<Source, number>> | undefined): Record<Source, number> {
  const o = emptyBySource();
  for (const s of SOURCES) o[s] = v?.[s] ?? 0;
  return o;
}

export function emptySrc(): Record<Source, SourceStat> {
  const o = {} as Record<Source, SourceStat>;
  for (const s of SOURCES) o[s] = { tokens: 0, cost: 0, byModel: Object.create(null) };
  return o;
}

// Rebuild the flat, widely-read fields from the per-source split. Everything
// downstream (badge, report, push payload) reads the flat view; `src` exists so
// the rollup can merge one engine's history without disturbing another's.
export function fromSrc(date: string, src: Record<Source, SourceStat>, sessions: Set<string>): DayStat {
  const d: DayStat = { date, src, tokens: 0, cost: 0, sessions, bySource: emptyBySource(), byModel: Object.create(null) };
  for (const s of SOURCES) {
    const v = src[s];
    d.tokens += v.tokens;
    d.cost += v.cost;
    if (v.unpricedTokens) d.unpricedTokens = (d.unpricedTokens ?? 0) + v.unpricedTokens;
    d.bySource[s] = v.tokens;
    for (const [m, n] of Object.entries(v.byModel)) d.byModel[m] = (d.byModel[m] || 0) + n;
  }
  return d;
}

// Which engine a model name belongs to. Only needed to split day records that
// were frozen before ccmap tracked the split; live scans know the source.
export function sourceOfModel(model: string): Source | null {
  const m = (model || "").toLowerCase();
  if (m.includes("claude")) return "claude";
  if (m.includes("grok")) return "grok";
  if (m.includes("gpt") || m.includes("codex") || /^o[134]\b/.test(m)) return "codex";
  return null;
}
