// Approximate USD pricing per 1M tokens. Estimates only — tweak in ~/.ccmap/config.json -> pricing.
// Fields: in (input), out (output), cw (cache write/creation), cr (cache read).

export interface Price {
  in: number;
  out: number;
  cw: number; // cache write, 5-minute TTL (= 1.25x input on Claude)
  cr: number; // cache read (= 0.1x input)
  cw1h?: number; // cache write, 1-hour TTL (= 2x input on Claude); defaults to 2x in
}

const TABLE: Record<string, Price> = {
  // Claude (current Opus 4.5/4.6/4.7/4.8 = $5/$25; cw = 1.25x in, cw1h = 2x in, cr = 0.1x in)
  "claude-fable": { in: 10, out: 50, cw: 12.5, cr: 1.0, cw1h: 20 },
  "claude-mythos": { in: 10, out: 50, cw: 12.5, cr: 1.0, cw1h: 20 },
  "claude-opus": { in: 5, out: 25, cw: 6.25, cr: 0.5, cw1h: 10 },
  "claude-sonnet": { in: 3, out: 15, cw: 3.75, cr: 0.3, cw1h: 6 },
  "claude-haiku": { in: 1, out: 5, cw: 1.25, cr: 0.1, cw1h: 2 },
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
