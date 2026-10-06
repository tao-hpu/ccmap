// Approximate USD pricing per 1M tokens. Estimates only — tweak in ~/.ccmap/config.json -> pricing.
// Fields: in (input), out (output), cw (cache write/creation), cr (cache read).

export interface Price {
  in: number;
  out: number;
  cw: number; // cache write, 5-minute TTL (= 1.25x input on Claude)
  cr: number; // cache read (0.1x input on most Claude models)
  cw1h?: number; // cache write, 1-hour TTL (= 2x input on Claude); defaults to 2x in
}

// Claude list prices: https://platform.claude.com/docs/en/about-claude/pricing
// (checked 2026-10-06). cw = 1.25x in, cw1h = 2x in; cr = 0.1x in except
// Fable/Mythos 5.1 (0.025x) and Opus 5.5 (0.05x).
const FABLE_5: Price = { in: 10, out: 50, cw: 12.5, cr: 1, cw1h: 20 };
const FABLE_5_1: Price = { in: 10, out: 50, cw: 12.5, cr: 0.25, cw1h: 20 };
const OPUS_4: Price = { in: 15, out: 75, cw: 18.75, cr: 1.5, cw1h: 30 };
const OPUS_4_5: Price = { in: 5, out: 25, cw: 6.25, cr: 0.5, cw1h: 10 };
const OPUS_5_5: Price = { in: 4, out: 20, cw: 5, cr: 0.2, cw1h: 8 };
const SONNET_4: Price = { in: 3, out: 15, cw: 3.75, cr: 0.3, cw1h: 6 };
const SONNET_5: Price = { in: 2, out: 10, cw: 2.5, cr: 0.2, cw1h: 4 };
const HAIKU_3_5: Price = { in: 0.8, out: 4, cw: 1, cr: 0.08, cw1h: 1.6 };
const HAIKU_4_5: Price = { in: 1, out: 5, cw: 1.25, cr: 0.1, cw1h: 2 };

// Each family lists the versions where its price changed, oldest first. A model
// takes the entry with the highest version at or below its own, so Opus 4.1
// uses Opus 4 and Opus 5 / 4.6-4.8 use Opus 4.5. A version newer than the list
// uses the newest entry. Versions older than the first entry (Claude 3 Opus,
// Claude 3 Haiku, Claude 3.x Sonnet) are not on the current price page and use
// the generic fallback.
// Versions are encoded as major * 100 + minor, so 4.10 sorts after 4.9.
const FABLE_STEPS: [number, Price][] = [[500, FABLE_5], [501, FABLE_5_1]];
const CLAUDE: Record<string, [version: number, price: Price][]> = {
  fable: FABLE_STEPS,
  mythos: FABLE_STEPS, // same tier and prices as Fable
  opus: [[400, OPUS_4], [405, OPUS_4_5], [505, OPUS_5_5]],
  sonnet: [[400, SONNET_4], [500, SONNET_5]],
  haiku: [[305, HAIKU_3_5], [405, HAIKU_4_5]],
};

// Accepts claude-opus-4-1-20250805, claude-opus-4@20250514, claude-opus-4.6,
// anthropic.claude-opus-5-5, claude-opus-5-5[1m] and the Claude 3 order
// (claude-3-5-haiku-20241022). A minor version is one or two digits not
// followed by another digit, so a date suffix is never read as one.
const CLAUDE_NEW = /claude-(fable|mythos|opus|sonnet|haiku)(?:-(\d+)(?:[-.](\d{1,2})(?!\d))?)?/;
const CLAUDE_OLD = /claude-(\d+)(?:[-.](\d))?-(opus|sonnet|haiku)/;

function claudePrice(model: string): Price | null | undefined {
  let family: string;
  let version: number | undefined;
  const n = CLAUDE_NEW.exec(model);
  const o = n ? null : CLAUDE_OLD.exec(model);
  if (n) {
    family = n[1];
    if (n[2] !== undefined) version = Number(n[2]) * 100 + Number(n[3] ?? 0);
  } else if (o) {
    family = o[3];
    version = Number(o[1]) * 100 + Number(o[2] ?? 0);
  } else {
    return undefined; // not a Claude model
  }
  const steps = CLAUDE[family];
  if (version === undefined) return steps[steps.length - 1][1];
  let hit: Price | null = null;
  for (const [v, price] of steps) if (v <= version) hit = price;
  return hit; // null: an older Claude model with no known price
}

const TABLE: Record<string, Price> = {
  // Official Codex CLI models, including historical GPT-5 variants still
  // present in local logs. Prices are Standard short-context API rates per 1M
  // tokens: https://developers.openai.com/api/docs/pricing
  // GPT-5.3/5.2 Codex rates: https://developers.openai.com/api/docs/models/gpt-5.3-codex
  // and https://developers.openai.com/api/docs/models/gpt-5.2-codex
  // Codex does not report separate cache-write TTL tiers, so cw1h matches cw.
  "gpt-6-astra": { in: 10, out: 50, cw: 12.5, cr: 1, cw1h: 12.5 },
  "gpt-5.6-sol": { in: 4, out: 20, cw: 5, cr: 0.4, cw1h: 5 },
  "gpt-5.6-terra": { in: 2, out: 12, cw: 2.5, cr: 0.2, cw1h: 2.5 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2, cw: 0.25, cr: 0.02, cw1h: 0.25 },
  "gpt-5.5": { in: 5, out: 30, cw: 0, cr: 0.5, cw1h: 0 },
  "gpt-5.4": { in: 2.5, out: 15, cw: 0, cr: 0.25, cw1h: 0 },
  "gpt-5.4-mini": { in: 0.75, out: 4.5, cw: 0, cr: 0.075, cw1h: 0 },
  "gpt-5.3-codex": { in: 1.75, out: 14, cw: 0, cr: 0.175, cw1h: 0 },
  "gpt-5.2-codex": { in: 1.75, out: 14, cw: 0, cr: 0.175, cw1h: 0 },
  "gpt-5.2": { in: 1.75, out: 14, cw: 0, cr: 0.175, cw1h: 0 },
  "gpt-5.1": { in: 1.25, out: 10, cw: 0, cr: 0.125, cw1h: 0 },
  "gpt-5": { in: 1.25, out: 10, cw: 0, cr: 0.125, cw1h: 0 },
  // Generic Codex records without a model name retain the GPT-5 baseline.
  "codex": { in: 1.25, out: 10, cw: 0, cr: 0.125, cw1h: 0 },
  // xAI / Grok CLI. Rarely consulted: the Grok CLI reports its own billed cost
  // per turn and we use that when present, so these only cover turns that
  // logged tokens without a cost (interrupted turns, older CLI builds).
  "grok-4.6": { in: 2, out: 10, cw: 2, cr: 0.5, cw1h: 2 },
  "grok-4.5": { in: 5, out: 25, cw: 5, cr: 1.25, cw1h: 5 },
  "grok": { in: 3, out: 15, cw: 3, cr: 0.75, cw1h: 3 },
};

const FALLBACK: Price = { in: 3, out: 15, cw: 3.75, cr: 0.3, cw1h: 6 };

// These API-only models share a prefix with a supported Codex model. Keep them
// on the generic fallback unless the user supplies an explicit pricing rule.
const OPENAI_MODEL_EXCLUSIONS = [
  "gpt-5.6-cyber",
  "gpt-5.5-cyber",
  "gpt-5.5-pro",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.2-pro",
  "gpt-5-search-api",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
];

function longestMatch(model: string, prices: Record<string, Price>): Price | null {
  let best: Price | null = null;
  let bestLen = -1;
  for (const [rawKey, price] of Object.entries(prices)) {
    const key = rawKey.toLowerCase();
    if (model.includes(key) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best;
}

export function priceFor(model: string, overrides?: Record<string, Price>): Price {
  const m = (model || "").toLowerCase();
  const override = longestMatch(m, overrides || {});
  if (override) return override;
  if (OPENAI_MODEL_EXCLUSIONS.some((key) => m.includes(key))) return FALLBACK;
  const claude = claudePrice(m);
  if (claude !== undefined) return claude ?? FALLBACK;
  return longestMatch(m, TABLE) ?? FALLBACK;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheWrite: number; // 5-minute TTL cache write
  cacheRead: number;
  cacheWrite1h?: number; // 1-hour TTL cache write (Claude only)
}

export function costOf(model: string, t: TokenBreakdown, overrides?: Record<string, Price>): number {
  const p = priceFor(model, overrides);
  const cw1h = p.cw1h ?? p.in * 2;
  return (
    (t.input * p.in +
      t.output * p.out +
      t.cacheWrite * p.cw +
      (t.cacheWrite1h ?? 0) * cw1h +
      t.cacheRead * p.cr) /
    1_000_000
  );
}

// Current USD estimates, not reconstruction of historical invoices.
// https://api-docs.deepseek.com/quick_start/pricing/ (2026-09-17)
export const DEEPSEEK_PRICE_REVISION = "2026-09-17";
const DEEPSEEK_FLASH: Price = { in: .3, cr: .006, out: 1.2, cw: 0, cw1h: 0 };
const DEEPSEEK_PRO: Price = { in: 1.32, cr: .044, out: 3.96, cw: 0, cw1h: 0 };
const DEEPSEEK_PRICES: Record<string, Price> = {
  "deepseek-flash": DEEPSEEK_FLASH,
  "deepseek-v4-flash": DEEPSEEK_FLASH,
  "deepseek-v4-flash-vision-exp": DEEPSEEK_FLASH,
  "deepseek-v4-pro": DEEPSEEK_PRO,
};

export function deepSeekCost(
  model: string,
  provider: string,
  tokens: TokenBreakdown,
  startedAt: number,
  overrides?: Record<string, Price>,
): number | undefined {
  const name = model.toLowerCase();
  const rule = Object.entries(overrides ?? {})
    .filter(([key]) => key.length > 0 && name.includes(key.toLowerCase()))
    .sort(([a], [b]) => b.length - a.length)[0]?.[1];
  const price = rule ?? (provider === "deepseek-official" ? DEEPSEEK_PRICES[name] : undefined);
  // Official DeepSeek usage has no separately billed cache-write bucket.
  // A custom provider that reports one needs an explicit user price.
  if (!price || (!rule && tokens.cacheWrite > 0)) return undefined;
  if ([price.in, price.out, price.cr, price.cw].some(value => !Number.isFinite(value) || value < 0)) return undefined;
  const date = new Date(startedAt);
  const hour = date.getUTCHours();
  const weekday = date.getUTCDay();
  const peak = weekday >= 1 && weekday <= 5 && (hour >= 1 && hour < 4 || hour >= 6 && hour < 10);
  const multiplier = rule || peak ? 1 : .5;
  return multiplier * (tokens.input * price.in + tokens.output * price.out
    + tokens.cacheRead * price.cr + tokens.cacheWrite * price.cw) / 1e6;
}
