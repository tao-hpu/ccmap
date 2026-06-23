// Approximate USD pricing per 1M tokens. Estimates only — tweak in ~/.ccmap/config.json -> pricing.
// Fields: in (input), out (output), cw (cache write/creation), cr (cache read).

export interface Price {
  in: number;
  out: number;
  cw: number;
  cr: number;
}

const TABLE: Record<string, Price> = {
  // Claude
  "claude-opus": { in: 15, out: 75, cw: 18.75, cr: 1.5 },
  "claude-sonnet": { in: 3, out: 15, cw: 3.75, cr: 0.3 },
  "claude-haiku": { in: 0.8, out: 4, cw: 1.0, cr: 0.08 },
  // OpenAI / Codex (gpt-5.x family, rough)
  "gpt-5": { in: 1.25, out: 10, cw: 1.25, cr: 0.125 },
  "codex": { in: 1.25, out: 10, cw: 1.25, cr: 0.125 },
};

const FALLBACK: Price = { in: 3, out: 15, cw: 3.75, cr: 0.3 };

export function priceFor(model: string, overrides?: Record<string, Price>): Price {
  const m = (model || "").toLowerCase();
  const tbl = { ...TABLE, ...(overrides || {}) };
  // longest-key match wins
  let best: Price | null = null;
  let bestLen = -1;
  for (const [key, price] of Object.entries(tbl)) {
    if (m.includes(key) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best ?? FALLBACK;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export function costOf(model: string, t: TokenBreakdown, overrides?: Record<string, Price>): number {
  const p = priceFor(model, overrides);
  return (
    (t.input * p.in + t.output * p.out + t.cacheWrite * p.cw + t.cacheRead * p.cr) / 1_000_000
  );
}
