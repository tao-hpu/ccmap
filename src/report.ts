import { renderSVG, resolveTheme } from "./render.js";

// Normalized input shared by CLI (buildPayload) and Worker (PushPayload).
export interface ReportData {
  user?: string;
  totals: { tokens: number; cost: number; streak: number; bySource: { claude: number; codex: number } };
  byModel: Record<string, number>;
  days: { date: string; tokens: number; cost: number; claude: number; codex: number }[];
}

export interface ReportOptions {
  theme?: string;
  origin?: string; // public base URL, for OG tags / badge embed
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const GITHUB = "https://github.com/tao-hpu/ccmap";
const THEME_NAMES = ["claude", "claude-light", "github-dark", "github-light", "tokyo-night", "dracula", "nord"];

// Vanilla client JS for the live customizer. Plain string (no template literals /
// ${ } inside) so it survives being embedded in the outer template literal.
const SHARE_JS = `
function $(id){return document.getElementById(id)}
function setText(id,v){$(id).textContent=v}
function build(){
  var t=$('t').value,a=$('a').value,m=$('m').value,w=$('w').value,hb=$('hb').checked;
  var q='?theme='+t;
  if(a!=='none')q+='&anim='+a;
  if(m!=='tokens')q+='&metric='+m;
  if(w!=='26')q+='&weeks='+w;
  if(hb)q+='&hide_border=true';
  var svg=BASE+'/u/'+USER+'.svg'+q;
  var report=BASE+'/u/'+USER+(t!=='claude'?'?theme='+t:'');
  $('preview').src=svg;
  var dark=(t==='claude-light')?'claude':t;
  var light=(t==='claude'||t==='claude-light')?'claude-light':'github-light';
  setText('s-md','![my coding heatmap]('+svg+')');
  setText('s-pic','<picture>\\n  <source media="(prefers-color-scheme: dark)" srcset="'+BASE+'/u/'+USER+'.svg?theme='+dark+'">\\n  <source media="(prefers-color-scheme: light)" srcset="'+BASE+'/u/'+USER+'.svg?theme='+light+'">\\n  <img src="'+svg+'" alt="coding heatmap">\\n</picture>');
  setText('s-url',report);
  $('tweet').href='https://twitter.com/intent/tweet?text='+encodeURIComponent('My Claude + Codex coding heatmap')+'&url='+encodeURIComponent(report);
}
function copy(id,btn){navigator.clipboard.writeText($(id).textContent).then(function(){var o=btn.textContent;btn.textContent='✓ copied';setTimeout(function(){btn.textContent=o},1200)})}
build();
`;

function shareCard(base: string, user: string): string {
  const opts = THEME_NAMES.map((t) => `<option${t === "claude" ? " selected" : ""}>${t}</option>`).join("");
  return `<div class="card"><h2>Customize &amp; share</h2>
    <div class="ctl">
      <label>theme <select id="t" oninput="build()">${opts}</select></label>
      <label>anim <select id="a" oninput="build()"><option>none</option><option>ember</option><option>wave</option><option>cascade</option></select></label>
      <label>metric <select id="m" oninput="build()"><option>tokens</option><option>cost</option></select></label>
      <label>weeks <select id="w" oninput="build()"><option>26</option><option>53</option></select></label>
      <label class="cb"><input type="checkbox" id="hb" oninput="build()"> hide border</label>
    </div>
    <img id="preview" class="preview" alt="badge preview">
    <div class="snip"><div class="snip-h"><span>GitHub README · markdown</span><button onclick="copy('s-md',this)">copy</button></div><pre><code id="s-md"></code></pre></div>
    <div class="snip"><div class="snip-h"><span>GitHub README · auto light/dark</span><button onclick="copy('s-pic',this)">copy</button></div><pre><code id="s-pic"></code></pre></div>
    <div class="snip"><div class="snip-h"><span>Share link (X / anywhere)</span><a id="tweet" href="#" target="_blank" rel="noopener">post on X →</a><button onclick="copy('s-url',this)">copy</button></div><pre><code id="s-url"></code></pre>
      <div class="note">X shows the link as a text card (SVG previews aren't rendered by X yet — PNG cards coming). GitHub, Slack &amp; Discord render the badge inline.</div>
    </div>
  </div>`;
}

// Inline SVG bar chart of the last `n` days (token volume).
function dailyChart(days: ReportData["days"], n: number, c: ReturnType<typeof resolveTheme>): string {
  const tail = days.slice(-n);
  const max = Math.max(1, ...tail.map((d) => d.tokens));
  const W = 760, H = 160, pad = 8;
  const bw = (W - pad * 2) / Math.max(1, tail.length);
  const bars = tail
    .map((d, i) => {
      const h = (d.tokens / max) * (H - 24);
      const x = pad + i * bw;
      const y = H - h - 4;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${c.scale[2]}"><title>${d.date}: ${fmt(d.tokens)} tok · $${d.cost.toFixed(2)}</title></rect>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="display:block">${bars}</svg>`;
}

function bars(items: [string, number][], total: number, c: ReturnType<typeof resolveTheme>): string {
  return items
    .map(([label, v]) => {
      const p = total ? (v / total) * 100 : 0;
      return `<div class="row">
        <div class="lbl">${esc(label)}</div>
        <div class="track"><div class="fill" style="width:${p.toFixed(1)}%"></div></div>
        <div class="val">${p.toFixed(0)}% · ${fmt(v)}</div>
      </div>`;
    })
    .join("");
}

export function renderReport(d: ReportData, opts: ReportOptions = {}): string {
  const c = resolveTheme(opts.theme ?? "claude");
  const user = d.user ?? "anon";
  const activeDays = d.days.filter((x) => x.tokens > 0).length;
  const range = d.days.length ? `${d.days[0].date} → ${d.days[d.days.length - 1].date}` : "—";

  // heatmap reuses the badge renderer (full year, cascade flourish)
  const daysMap = new Map<string, any>();
  for (const x of d.days)
    daysMap.set(x.date, { date: x.date, tokens: x.tokens, cost: x.cost, bySource: { claude: x.claude, codex: x.codex }, byModel: {}, sessions: new Set() });
  const heat = renderSVG(daysMap, { totalTokens: d.totals.tokens, totalCost: d.totals.cost, streak: d.totals.streak }, { theme: opts.theme ?? "claude", weeks: 53, anim: "cascade", border: false, title: "" });

  const topModels = Object.entries(d.byModel).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const src = d.totals.bySource;
  const badge = opts.origin ? `${opts.origin}/u/${user}.svg` : "";

  const stat = (label: string, value: string) =>
    `<div class="stat"><div class="num">${value}</div><div class="cap">${label}</div></div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(user)} · ccmap report</title>
<meta property="og:title" content="${esc(user)} — Claude + Codex coding report">
<meta property="og:description" content="${fmt(d.totals.tokens)} tokens · $${d.totals.cost.toFixed(0)} · ${d.totals.streak}-day streak">
${badge ? `<meta property="og:image" content="${badge}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<style>
  :root{--bg:${c.bg};--fg:${c.text};--sub:${c.sub};--card:${c.empty};--accent:${c.scale[2]};--line:${c.border}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}
  .wrap{max-width:860px;margin:0 auto;padding:40px 20px 64px}
  h1{font-size:24px;margin:0 0 4px} .muted{color:var(--sub)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:24px 0}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
  .num{font-size:26px;font-weight:700} .cap{color:var(--sub);font-size:12px;margin-top:2px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:18px 0}
  .card h2{font-size:14px;margin:0 0 14px;color:var(--sub);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
  .row{display:flex;align-items:center;gap:10px;margin:7px 0}
  .lbl{width:200px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .track{flex:1;height:8px;background:rgba(128,128,128,.18);border-radius:5px;overflow:hidden}
  .fill{height:100%;background:var(--accent);border-radius:5px}
  .val{width:120px;text-align:right;font-size:12px;color:var(--sub)}
  footer{color:var(--sub);font-size:12px;margin-top:28px;text-align:center}
  a{color:var(--accent)}
  .ctl{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:14px;align-items:center}
  .ctl label{font-size:12px;color:var(--sub);display:flex;gap:6px;align-items:center}
  .ctl select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:5px 8px;font:13px inherit}
  .ctl .cb{cursor:pointer}
  .preview{display:block;max-width:100%;margin:6px 0 18px;border-radius:8px}
  .snip{margin:12px 0}
  .snip-h{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--sub);margin-bottom:6px}
  .snip-h span{flex:1}
  .snip-h button,.snip-h a{font:12px inherit;background:none;border:1px solid var(--line);color:var(--accent);border-radius:6px;padding:2px 10px;cursor:pointer;text-decoration:none}
  .note{font-size:11px;color:var(--sub);margin-top:8px;line-height:1.5}
  pre{margin:0;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto}
  code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);white-space:pre}
</style></head><body><div class="wrap">
  <h1>${esc(user)} <span class="muted">· coding report</span></h1>
  <div class="muted">Claude + Codex · ${range}</div>

  <div class="grid">
    ${stat("tokens", fmt(d.totals.tokens))}
    ${stat("est. cost", "$" + d.totals.cost.toFixed(0))}
    ${stat("streak", d.totals.streak + "d")}
    ${stat("active days", String(activeDays))}
  </div>

  <div class="card"><h2>Activity</h2>${heat}</div>

  <div class="card"><h2>Daily tokens · last 30 days</h2>${dailyChart(d.days, 30, c)}</div>

  <div class="card"><h2>Models</h2>${bars(topModels, d.totals.tokens, c)}</div>

  <div class="card"><h2>Engine split</h2>${bars(
    [["Claude", src.claude], ["Codex", src.codex]],
    src.claude + src.codex,
    c
  )}</div>

  ${shareCard(opts.origin || "https://YOUR-CCMAP-HOST", user)}

  <footer>generated by <a href="${GITHUB}">ccmap</a> · <a href="https://www.npmjs.com/package/ccmap">npm</a>${
    badge ? ` · <a href="${badge}">badge</a>` : ""
  }</footer>
</div>
<script>const BASE=${JSON.stringify(opts.origin || "https://YOUR-CCMAP-HOST")},USER=${JSON.stringify(user)};${SHARE_JS}</script>
</body></html>`;
}
