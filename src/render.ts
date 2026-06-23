import type { DayStat } from "./parse.js";

export interface RenderOptions {
  weeks?: number; // how many weeks back to show
  metric?: "tokens" | "cost"; // what the color intensity represents
  title?: string;
  theme?: string; // named theme, see THEMES
  border?: boolean; // draw the card border (default true; ?hide_border=true to drop)
  anim?: string; // "none" | "ember" | "wave" | "cascade"
}

// CSS animation injected into the SVG. Works as an <img> in GitHub READMEs
// (SMIL/CSS animate; only <script> is stripped — so autonomous motion is fine).
function animCss(anim: string): string {
  switch (anim) {
    case "wave":
      return `<style>.g{animation:cmw 2.6s ease-in-out infinite}@keyframes cmw{0%,100%{opacity:1}50%{opacity:.45}}</style>`;
    case "ember":
      return `<style>.g{transform-box:fill-box;transform-origin:center;animation:cme 1.9s ease-in-out infinite}@keyframes cme{0%,100%{opacity:.72}50%{opacity:1;filter:brightness(1.35)}}</style>`;
    case "cascade":
      return `<style>.g{transform-box:fill-box;transform-origin:center;animation:cmc .55s cubic-bezier(.2,.8,.2,1) both}@keyframes cmc{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}</style>`;
    default:
      return "";
  }
}

export interface Theme {
  bg: string;
  text: string;
  sub: string;
  empty: string;
  scale: string[]; // 4 colors, low -> high
  border: string;
}

// Named theme registry. Add palettes here and they're instantly usable as ?theme=<name>.
export const THEMES: Record<string, Theme> = {
  "github-dark": {
    bg: "#0d1117", text: "#c9d1d9", sub: "#8b949e", empty: "#161b22",
    scale: ["#0e4429", "#006d32", "#26a641", "#39d353"], border: "#30363d",
  },
  "github-light": {
    bg: "#ffffff", text: "#24292f", sub: "#57606a", empty: "#ebedf0",
    scale: ["#9be9a8", "#40c463", "#30a14e", "#216e39"], border: "#d0d7de",
  },
  "tokyo-night": {
    bg: "#1a1b27", text: "#c0caf5", sub: "#a9b1d6", empty: "#23243a",
    scale: ["#0f3d4a", "#1f6f7a", "#2db3a3", "#41dcc4"], border: "#2a2e45",
  },
  dracula: {
    bg: "#282a36", text: "#f8f8f2", sub: "#6272a4", empty: "#3a3d52",
    scale: ["#1d4d33", "#2e8a52", "#41c97a", "#50fa7b"], border: "#44475a",
  },
  nord: {
    bg: "#2e3440", text: "#eceff4", sub: "#9aa5b8", empty: "#3b4252",
    scale: ["#3b5a52", "#4f8a76", "#74b39b", "#a3be8c"], border: "#434c5e",
  },
  // Anthropic / Claude brand: coral on warm charcoal
  claude: {
    bg: "#1f1e1d", text: "#faf9f5", sub: "#b0aba1", empty: "#2d2b28",
    scale: ["#5e3a2e", "#9c5640", "#d97757", "#ee9a78"], border: "#3a3633",
  },
  "claude-light": {
    bg: "#faf9f5", text: "#1f1e1d", sub: "#6b6862", empty: "#ece7dd",
    scale: ["#f0c9b6", "#e3a184", "#d97757", "#bc5739"], border: "#e5ded2",
  },
};

const THEME_ALIASES: Record<string, string> = { dark: "github-dark", light: "github-light" };

export function resolveTheme(name?: string): Theme {
  const key = (name && (THEME_ALIASES[name] ?? name)) || "github-dark";
  return THEMES[key] ?? THEMES["github-dark"];
}

const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

// Render a GitHub-style contribution heatmap as a standalone SVG string.
export function renderSVG(
  days: Map<string, DayStat>,
  totals: { totalTokens: number; totalCost: number; streak: number },
  opts: RenderOptions = {}
): string {
  const weeks = opts.weeks ?? 26;
  const metric = opts.metric ?? "tokens";
  const c = resolveTheme(opts.theme);
  const border = opts.border !== false;

  // build grid ending today; columns = weeks, align so last column ends on today's weekday
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  // start = Sunday of (weeks-1) weeks ago
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks - 1) * 7 - today.getDay());

  // gather values for scaling (nonzero)
  const vals: number[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    const ds = days.get(dateKey(cur));
    const v = ds ? (metric === "cost" ? ds.cost : ds.tokens) : 0;
    if (v > 0) vals.push(v);
    cur.setDate(cur.getDate() + 1);
  }
  vals.sort((a, b) => a - b);
  // quartile thresholds
  const q = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0);
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);

  function level(v: number): number {
    if (v <= 0) return -1;
    if (v <= t1) return 0;
    if (v <= t2) return 1;
    if (v <= t3) return 2;
    return 3;
  }

  const padX = 16;
  const padTop = 64;
  const padBottom = 16;
  const gridW = weeks * STEP;
  const W = padX * 2 + gridW;
  const H = padTop + 7 * STEP + padBottom;

  const anim = opts.anim ?? "none";
  const cells: string[] = [];
  const cur2 = new Date(start);
  let col = 0;
  let row = cur2.getDay();
  let order = 0;
  while (cur2 <= end) {
    const key = dateKey(cur2);
    const ds = days.get(key);
    const v = ds ? (metric === "cost" ? ds.cost : ds.tokens) : 0;
    const lv = level(v);
    const fill = lv < 0 ? c.empty : c.scale[lv];
    const x = padX + col * STEP;
    const y = padTop + row * STEP;
    let tip = key;
    if (ds && ds.tokens > 0) {
      const parts = [`${fmt(ds.tokens)} tok`, `$${ds.cost.toFixed(2)}`];
      if (ds.bySource) parts.push(`claude ${fmt(ds.bySource.claude)} / codex ${fmt(ds.bySource.codex)}`);
      if (ds.sessions && ds.sessions.size) parts.push(`${ds.sessions.size} sessions`);
      tip = `${key} · ${parts.join(" · ")}`;
    }
    // cascade animates every cell (the grid "grows in"); wave/ember only lit cells
    const animated = anim === "cascade" ? true : anim !== "none" && lv >= 0;
    let delay = 0;
    if (anim === "wave") delay = col * 0.06;
    else if (anim === "ember") delay = (col + row) * 0.09;
    else if (anim === "cascade") delay = order * 0.012;
    const attr = animated ? ` class="g" style="animation-delay:${delay.toFixed(2)}s"` : "";
    cells.push(
      `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"${attr}><title>${tip}</title></rect>`
    );
    order++;
    row++;
    if (row > 6) {
      row = 0;
      col++;
    }
    cur2.setDate(cur2.getDate() + 1);
  }

  const title = opts.title ?? "Coding heatmap";
  const sub = `${fmt(totals.totalTokens)} tokens · $${totals.totalCost.toFixed(0)} · 🔥 ${totals.streak}d streak`;

  // month labels along the top
  const monthLabels: string[] = [];
  const cur3 = new Date(start);
  let lastMonth = -1;
  let lastLabelCol = -3;
  let cc = 0;
  while (cur3 <= end) {
    if (cur3.getDay() === 0) {
      if (cur3.getMonth() !== lastMonth && cc - lastLabelCol >= 3) {
        lastMonth = cur3.getMonth();
        lastLabelCol = cc;
        const x = padX + cc * STEP;
        monthLabels.push(
          `<text x="${x}" y="${padTop - 6}" fill="${c.sub}" font-size="10">${cur3.toLocaleString("en", { month: "short" })}</text>`
        );
      }
      cc++;
    }
    cur3.setDate(cur3.getDate() + 1);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
  ${animCss(anim)}
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="${c.bg}"${border ? ` stroke="${c.border}"` : ""}/>
  <text x="${padX}" y="26" fill="${c.text}" font-size="15" font-weight="600">${title}</text>
  <text x="${padX}" y="46" fill="${c.sub}" font-size="12">${sub}</text>
  ${monthLabels.join("\n  ")}
  ${cells.join("\n  ")}
</svg>`;
}
