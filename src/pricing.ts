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
  // OpenAI / Codex (gpt-5.x family). OpenAI bills no separate cache-write; cached read = 0.1x in.
  "gpt-5": { in: 1.25, out: 10, cw: 1.25, cr: 0.125, cw1h: 1.25 },
  "codex": { in: 1.25, out: 10, cw: 1.25, cr: 0.125, cw1h: 1.25 },
};

const FALLBACK: Price = { in: 3, out: 15, cw: 3.75, cr: 0.3, cw1h: 6 };

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
