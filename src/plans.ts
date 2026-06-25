// Subscription plans + "amplifier power" — how much metered-API value your flat
// monthly plan returns. The active plan CANNOT be detected from logs (Claude only
// exposes usage.service_tier="standard"; Codex only model_provider), so it's a
// config choice — see Config.plans / Config.planPrices. Monthly figures are public
// list prices in USD as of 2026; override per-id via config.planPrices.

export interface Plan {
  id: string;
  provider: "claude" | "codex";
  name: string;
  monthly: number; // USD / month (list price)
}

export const PLANS: Plan[] = [
  { id: "claude-pro", provider: "claude", name: "Claude Pro", monthly: 20 },
  { id: "claude-max-5", provider: "claude", name: "Claude Max 5×", monthly: 100 },
  { id: "claude-max-20", provider: "claude", name: "Claude Max 20×", monthly: 200 },
  { id: "codex-plus", provider: "codex", name: "ChatGPT Plus", monthly: 20 },
  { id: "codex-pro", provider: "codex", name: "ChatGPT Pro", monthly: 200 },
  { id: "codex-business", provider: "codex", name: "ChatGPT Business", monthly: 30 },
];

export function planById(id: string, overrides?: Record<string, number>): Plan | undefined {
  const p = PLANS.find((x) => x.id === id);
  if (!p) return undefined;
  const o = overrides?.[id];
  return o != null ? { ...p, monthly: o } : p;
}

// Resolve the user's active plan(s). When unset, assume the common heavy-user plan
// for whichever provider has usage (flagged `assumed` so the UI can prompt config).
export function resolvePlans(
  ids: string[] | undefined,
  overrides: Record<string, number> | undefined,
  hasClaude: boolean,
  hasCodex: boolean
): { plans: Plan[]; assumed: boolean } {
  if (ids && ids.length) {
    const plans = ids.map((id) => planById(id, overrides)).filter((p): p is Plan => !!p);
    return { plans, assumed: false };
  }
  const def: Plan[] = [];
  if (hasClaude) def.push(planById("claude-max-20", overrides)!);
  if (hasCodex && !hasClaude) def.push(planById("codex-pro", overrides)!);
  return { plans: def, assumed: true };
}

export interface AmplifierDay {
  date: string;
  cost: number;
}

export interface Amplifier {
  plans: Plan[];
  assumed: boolean;
  monthlyCost: number; // what you pay per month (sum of selected plans)
  // headline (a representative month)
  headlineValue: number; // API-equivalent $ for the month used in the ratio
  basis: "last 30 days" | "monthly average"; // which month headlineValue reflects
  amplifier: number; // headlineValue / monthlyCost
  savedPerMonth: number; // headlineValue - monthlyCost
  last30Value: number; // trailing-30-day API-equivalent $
  avgMonthValue: number; // lifetime value / months elapsed
  // lifetime
  monthsElapsed: number;
  lifetimeValue: number; // all-time API-equivalent $
  lifetimePaid: number; // monthsElapsed * monthlyCost
  lifetimeSaved: number;
}

const DAY = 86_400_000;

export function computeAmplifier(
  days: AmplifierDay[],
  totalCost: number,
  firstDay: string | undefined,
  lastDay: string | undefined,
  selected: { plans: Plan[]; assumed: boolean },
  now = new Date()
): Amplifier | null {
  if (!selected.plans.length) return null;
  const monthlyCost = selected.plans.reduce((s, p) => s + p.monthly, 0);

  // trailing 30 days, anchored to today
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const cutoff = today.getTime() - 29 * DAY;
  let last30Value = 0;
  for (const d of days) {
    const t = new Date(`${d.date}T00:00:00`).getTime();
    if (!isNaN(t) && t >= cutoff) last30Value += d.cost;
  }

  // lifetime span in months (>= 1)
  let monthsElapsed = 1;
  if (firstDay && lastDay) {
    const f = new Date(`${firstDay}T00:00:00`).getTime();
    const l = new Date(`${lastDay}T00:00:00`).getTime();
    if (!isNaN(f) && !isNaN(l) && l >= f) monthsElapsed = Math.max(1, (l - f) / DAY / 30.437);
  }
  const avgMonthValue = totalCost / monthsElapsed;

  // Headline uses the real trailing month when there's recent activity; otherwise
  // falls back to the lifetime monthly average so an idle stretch doesn't read as $0.
  const useLast30 = last30Value > 0;
  const headlineValue = useLast30 ? last30Value : avgMonthValue;

  const lifetimePaid = monthsElapsed * monthlyCost;
  return {
    plans: selected.plans,
    assumed: selected.assumed,
    monthlyCost,
    headlineValue,
    basis: useLast30 ? "last 30 days" : "monthly average",
    amplifier: monthlyCost ? headlineValue / monthlyCost : 0,
    savedPerMonth: headlineValue - monthlyCost,
    last30Value,
    avgMonthValue,
    monthsElapsed,
    lifetimeValue: totalCost,
    lifetimePaid,
    lifetimeSaved: totalCost - lifetimePaid,
  };
}
