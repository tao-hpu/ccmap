import { renderSVG, resolveTheme } from "./render.js";
import { qrMatrix } from "./qr.js";

// Render a URL as a self-contained "scan me" SVG chip: a light rounded card
// (QR must be dark-on-light to scan reliably) with the QR drawn as <rect>s.
function qrChip(url: string, x: number, y: number, size: number): string {
  const m = qrMatrix(url, 1);
  const n = m.length;
  const quiet = 2; // modules of margin inside the white card
  const card = size;
  const unit = card / (n + quiet * 2);
  const ox = x + quiet * unit;
  const oy = y + quiet * unit;
  const cell = Math.ceil(unit * 100) / 100;
  let dots = "";
  for (let r = 0; r < n; r++)
    for (let col = 0; col < n; col++)
      if (m[r][col])
        dots += `<rect x="${(ox + col * unit).toFixed(2)}" y="${(oy + r * unit).toFixed(2)}" width="${cell}" height="${cell}" fill="#0a0a0a"/>`;
  const rad = Math.round(card * 0.08);
  return `<rect x="${x}" y="${y}" width="${card}" height="${card}" rx="${rad}" fill="#ffffff"/><g shape-rendering="crispEdges">${dots}</g>`;
}

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
  share?: boolean; // include the "Customize & share" embed section (hosted report only)
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
function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
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
  var rest='';
  if(a!=='none')rest+='&anim='+a;
  if(m!=='tokens')rest+='&metric='+m;
  if(w!=='26')rest+='&weeks='+w;
  if(hb)rest+='&hide_border=true';
  var U=BASE+'/u/'+USER+'.svg?theme=';
  var svg=U+t+rest;
  // cache-bust tag so X (and any cache) always re-fetches the freshest card
  var cb=Date.now().toString(36)+Math.floor(Math.random()*1296).toString(36);
  var hasQ=(t!=='claude');
  var report=BASE+'/u/'+USER+(hasQ?'?theme='+t:'')+(hasQ?'&':'?')+'v='+cb;
  if($('cb-note'))$('cb-note').textContent='?v='+cb;
  if($('dl'))$('dl').href=BASE+'/u/'+USER+'.png?shape=portrait'+(t!=='claude'?'&theme='+t:'')+'&v='+cb;
  $('preview').src=svg;
  var dark=(t==='claude-light')?'claude':t;
  var light=(t==='claude'||t==='claude-light')?'claude-light':'github-light';
  setText('s-md','![my coding heatmap]('+svg+')');
  setText('s-pic','<div align="center">\\n  <picture>\\n    <source media="(prefers-color-scheme: dark)" srcset="'+U+dark+rest+'" />\\n    <source media="(prefers-color-scheme: light)" srcset="'+U+light+rest+'" />\\n    <img src="'+U+dark+rest+'" alt="coding heatmap" />\\n  </picture>\\n</div>');
  setText('s-url',report);
  $('tweet').href='https://twitter.com/intent/tweet?text='+encodeURIComponent('My Claude + Codex coding heatmap')+'&url='+encodeURIComponent(report);
}
function copy(id,btn){navigator.clipboard.writeText($(id).textContent).then(function(){var o=btn.textContent;btn.textContent='✓ copied';setTimeout(function(){btn.textContent=o},1200)})}
build();
`;

// Interactive hover layer — always included (works with or without the customizer).
const TOOLTIP_JS = `
(function(){
  var tip=document.getElementById('tip');
  if(!tip)return;
  // Promote every chart <title> to a data-tip on its parent and drop the native
  // <title> (kills the slow grey browser tooltip), then drive one styled box.
  document.querySelectorAll('.card svg title').forEach(function(t){
    if(t.parentNode){t.parentNode.setAttribute('data-tip',t.textContent);t.parentNode.removeChild(t);}
  });
  var prev=null;
  function setCross(el){
    document.querySelectorAll('.crosshair').forEach(function(g){g.style.opacity=0;});
    if(el&&el.classList.contains('band')){
      var svg=el.ownerSVGElement,g=svg&&svg.querySelector('.crosshair');
      if(g){
        var cx=el.getAttribute('data-cx'),cy=el.getAttribute('data-cy');
        var ln=g.querySelector('line'),ci=g.querySelector('circle');
        ln.setAttribute('x1',cx);ln.setAttribute('x2',cx);
        ci.setAttribute('cx',cx);ci.setAttribute('cy',cy);
        g.style.opacity=1;
      }
    }
  }
  function clear(){if(prev){prev.classList.remove('cm-active');prev=null;}setCross(null);tip.classList.remove('on');}
  function move(e){
    var el=e.target.closest?e.target.closest('[data-tip]'):null;
    if(el!==prev){if(prev)prev.classList.remove('cm-active');if(el)el.classList.add('cm-active');prev=el;setCross(el);}
    if(!el){tip.classList.remove('on');return;}
    tip.textContent=el.getAttribute('data-tip');
    tip.classList.add('on');
    var pad=14,w=tip.offsetWidth,h=tip.offsetHeight,x=e.clientX+pad,y=e.clientY+pad;
    if(x+w>window.innerWidth)x=e.clientX-w-pad;
    if(y+h>window.innerHeight)y=e.clientY-h-pad;
    tip.style.left=x+'px';tip.style.top=y+'px';
  }
  document.addEventListener('mousemove',move);
  document.addEventListener('mouseleave',clear);
})();
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
    <div class="snip"><div class="snip-h"><span>GitHub README · adaptive light/dark ★</span><button onclick="copy('s-pic',this)">copy</button></div><pre><code id="s-pic"></code></pre><div class="note">Follows the viewer's GitHub theme automatically — dark side uses your selected theme above.</div></div>
    <div class="snip"><div class="snip-h"><span>Simple markdown (any host)</span><button onclick="copy('s-md',this)">copy</button></div><pre><code id="s-md"></code></pre></div>
    <div class="snip"><div class="snip-h"><span>Share link (X / anywhere)</span><button onclick="copy('s-url',this)">copy</button></div><pre><code id="s-url"></code></pre>
      <div class="share-actions">
        <a id="tweet" class="xbtn" href="#" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"/></svg>Post on X</a><a id="dl" class="dlbtn" download="ccmap-${user}.png" href="#"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14"/></svg>Download card</a>
      </div>
      <div class="note">Post on X unfurls a full image card (mascot + heatmap); Download saves a tall portrait PNG (with a scannable QR back to your page) for X, stories, or anywhere. Each share link carries a fresh tag (<code id="cb-note" style="color:var(--accent)"></code>) so caches never go stale — GitHub, Slack and Discord render the SVG badge inline.</div>
    </div>
  </div>`;
}

// Stacked SVG bar chart of the last `n` days — Codex on the bottom, Claude on top.
function dailyChart(days: ReportData["days"], n: number, c: ReturnType<typeof resolveTheme>): string {
  const tail = days.slice(-n);
  const max = Math.max(1, ...tail.map((d) => d.claude + d.codex));
  const W = 760, H = 160, pad = 8, plot = H - 12;
  const bw = (W - pad * 2) / Math.max(1, tail.length);
  const cClaude = c.scale[3], cCodex = c.scale[1];
  const bars = tail
    .map((d, i) => {
      const x = pad + i * bw;
      const w = (bw - 2).toFixed(1);
      const hCo = (d.codex / max) * plot;
      const hCl = (d.claude / max) * plot;
      const yCo = H - 4 - hCo;
      const yCl = yCo - hCl;
      const title = `<title>${d.date}: ${fmt(d.tokens)} tok · $${d.cost.toFixed(2)}  (claude ${fmt(d.claude)} · codex ${fmt(d.codex)})</title>`;
      let r = "";
      if (hCo > 0.3) r += `<rect class="bar" x="${x.toFixed(1)}" y="${yCo.toFixed(1)}" width="${w}" height="${hCo.toFixed(1)}" rx="1.5" fill="${cCodex}">${title}</rect>`;
      if (hCl > 0.3) r += `<rect class="bar" x="${x.toFixed(1)}" y="${yCl.toFixed(1)}" width="${w}" height="${hCl.toFixed(1)}" rx="1.5" fill="${cClaude}">${title}</rect>`;
      return r;
    })
    .join("");
  const legend = `<div class="legend"><span><i style="background:${cClaude}"></i>Claude</span><span><i style="background:${cCodex}"></i>Codex</span></div>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="display:block">${bars}</svg>${legend}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Longest run of consecutive active days in the (chronologically sorted) series.
function longestStreak(days: ReportData["days"]): number {
  let best = 0, cur = 0;
  for (const d of days) {
    if (d.tokens > 0) { cur++; if (cur > best) best = cur; }
    else cur = 0;
  }
  return best;
}

function peakDay(days: ReportData["days"]): { date: string; tokens: number } | null {
  let peak: ReportData["days"][number] | null = null;
  for (const d of days) if (!peak || d.tokens > peak.tokens) peak = d;
  return peak && peak.tokens > 0 ? { date: peak.date, tokens: peak.tokens } : null;
}

// % change of the last 7 active-window days vs the 7 before that.
function weekTrend(days: ReportData["days"]): number | null {
  if (days.length < 8) return null;
  const sum = (arr: ReportData["days"]) => arr.reduce((s, d) => s + d.tokens, 0);
  const cur = sum(days.slice(-7));
  const prev = sum(days.slice(-14, -7));
  if (prev === 0) return cur > 0 ? 100 : null;
  return ((cur - prev) / prev) * 100;
}

// Donut chart for a small set of proportions. parts: [label, value, color].
function donut(parts: [string, number, string][], c: ReturnType<typeof resolveTheme>): string {
  const total = parts.reduce((s, p) => s + p[1], 0) || 1;
  const D = 200, cx = D / 2, cy = D / 2, r = 78, sw = 30, C = 2 * Math.PI * r;
  let off = 0;
  const rings = parts
    .map(([label, v, color]) => {
      const frac = v / total, len = frac * C;
      const el = `<circle class="arc" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${esc(label)}: ${((frac) * 100).toFixed(1)}% · ${fmt(v)}</title></circle>`;
      off += len;
      return el;
    })
    .join("");
  const top = parts.slice().sort((a, b) => b[1] - a[1])[0];
  const topPct = ((top[1] / total) * 100).toFixed(0);
  const legend = parts
    .map(([label, v, color]) => `<span><i style="background:${color}"></i>${esc(label)} · ${((v / total) * 100).toFixed(0)}% · ${fmt(v)}</span>`)
    .join("");
  return `<div class="donut"><svg viewBox="0 0 ${D} ${D}" width="${D}" height="${D}" style="max-width:100%">${rings}<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="34" font-weight="800" fill="${c.text}">${topPct}%</text><text x="${cx}" y="${cy + 20}" text-anchor="middle" font-size="14" fill="${c.sub}">${esc(top[0])}</text></svg><div class="donut-legend">${legend}</div></div>`;
}

// Cumulative token total over the whole window — an area/line trajectory.
function cumulativeArea(days: ReportData["days"], c: ReturnType<typeof resolveTheme>): string {
  if (!days.length) return "";
  let acc = 0;
  const pts = days.map((d) => { acc += d.tokens; return { date: d.date, c: acc, day: d.tokens }; });
  const max = pts[pts.length - 1].c || 1;
  const W = 760, H = 170, padB = 22, padT = 8, plot = H - padB - padT, n = pts.length;
  const X = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * (W - 2)) + 1;
  const Y = (v: number) => padT + (1 - v / max) * plot;
  let line = "M" + X(0).toFixed(1) + "," + Y(pts[0].c).toFixed(1);
  for (let i = 1; i < n; i++) line += " L" + X(i).toFixed(1) + "," + Y(pts[i].c).toFixed(1);
  const area = line + " L" + X(n - 1).toFixed(1) + "," + (H - padB) + " L" + X(0).toFixed(1) + "," + (H - padB) + " Z";
  const labels: string[] = [];
  let lastM = "", lastX = -1e9;
  pts.forEach((p, i) => {
    const m = p.date.slice(0, 7);
    const x = X(i);
    if (m !== lastM && x - lastX >= 46) { lastM = m; lastX = x; const mi = parseInt(p.date.slice(5, 7), 10) - 1; labels.push(`<text x="${x.toFixed(1)}" y="${H - 6}" font-size="10" fill="${c.sub}" text-anchor="middle">${MONTHS[mi]}</text>`); }
    else if (m !== lastM) lastM = m;
  });
  // A crosshair (dashed guide line + marker dot) that JS snaps to the hovered day.
  const crosshair = `<g class="crosshair"><line x1="0" y1="${padT}" x2="0" y2="${(H - padB).toFixed(1)}"/><circle cx="0" cy="0" r="4.5"/></g>`;
  // Invisible full-height hit bands (one per day) so the whole curve is hoverable.
  const bandW = (W - 2) / Math.max(1, n);
  const bands = pts
    .map((p, i) => {
      const bx = Math.max(0, X(i) - bandW / 2);
      const tip = `${p.date} · ${fmt(p.c)} tok total${p.day > 0 ? ` · +${fmt(p.day)} that day` : ""}`;
      return `<rect class="band" data-cx="${X(i).toFixed(1)}" data-cy="${Y(p.c).toFixed(1)}" x="${bx.toFixed(1)}" y="${padT}" width="${bandW.toFixed(1)}" height="${(plot).toFixed(1)}" fill="transparent" pointer-events="all"><title>${tip}</title></rect>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block"><path d="${area}" fill="${c.scale[2]}" opacity="0.16" pointer-events="none"/><path d="${line}" fill="none" stroke="${c.scale[3]}" stroke-width="2" pointer-events="none"/><circle cx="${X(n - 1).toFixed(1)}" cy="${Y(pts[n - 1].c).toFixed(1)}" r="3.5" fill="${c.scale[3]}" pointer-events="none"/>${labels.join("")}${crosshair}${bands}</svg>`;
}

// Per-weekday totals with active-day counts, for the radar chart's tooltips.
function weekdayDetail(days: ReportData["days"]): { name: string; total: number; count: number; avg: number }[] {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const sum = [0, 0, 0, 0, 0, 0, 0], cnt = [0, 0, 0, 0, 0, 0, 0];
  for (const d of days) {
    const wd = (new Date(d.date + "T00:00:00Z").getUTCDay() + 6) % 7;
    sum[wd] += d.tokens;
    if (d.tokens > 0) cnt[wd]++;
  }
  return names.map((n, i) => ({ name: n, total: sum[i], count: cnt[i], avg: cnt[i] ? sum[i] / cnt[i] : 0 }));
}

// Radar (heptagon) of weekday rhythm — a cyclical fit that bars can't express.
function radarWeekday(days: ReportData["days"], c: ReturnType<typeof resolveTheme>): string {
  const wd = weekdayDetail(days);
  const total = wd.reduce((s, x) => s + x.total, 0) || 1;
  const max = Math.max(1, ...wd.map((x) => x.total));
  const cx = 150, cy = 140, R = 104, N = 7;
  const ang = (i: number) => -Math.PI / 2 + i * ((2 * Math.PI) / N);
  const P = (i: number, rad: number): [number, number] => [cx + Math.cos(ang(i)) * rad, cy + Math.sin(ang(i)) * rad];
  let rings = "";
  [0.25, 0.5, 0.75, 1].forEach((f) => {
    const pl = wd.map((_, i) => { const [x, y] = P(i, R * f); return x.toFixed(1) + "," + y.toFixed(1); }).join(" ");
    rings += `<polygon points="${pl}" fill="none" stroke="${c.border}" stroke-width="1"/>`;
  });
  let axes = "", labels = "";
  wd.forEach((x, i) => {
    const [ex, ey] = P(i, R);
    axes += `<line x1="${cx}" y1="${cy}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${c.border}" stroke-width="1"/>`;
    const [lx, ly] = P(i, R + 16);
    labels += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="${c.sub}">${x.name}</text>`;
  });
  const dp = wd.map((x, i) => { const [px, py] = P(i, R * (x.total / max)); return px.toFixed(1) + "," + py.toFixed(1); }).join(" ");
  const dots = wd
    .map((x, i) => {
      const [px, py] = P(i, R * (x.total / max));
      const pct = ((x.total / total) * 100).toFixed(0);
      const tip = `${x.name} · ${fmt(x.total)} tok · ${pct}% · avg ${fmt(x.avg)}/active day · ${x.count} active days`;
      return `<circle class="hit" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="12" fill="transparent" pointer-events="all"><title>${tip}</title></circle><circle class="dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.4" fill="${c.scale[3]}" pointer-events="none"/>`;
    })
    .join("");
  return `<div style="display:flex;justify-content:center"><svg viewBox="0 0 300 290" width="300" height="290">${rings}${axes}<polygon points="${dp}" fill="${c.scale[2]}" fill-opacity="0.22" stroke="${c.scale[3]}" stroke-width="2"/>${dots}${labels}</svg></div>`;
}

// Cohesive 16×16 stroke icon set for the stat cards.
const ICONS: Record<string, string> = {
  tokens: '<ellipse cx="8" cy="4.5" rx="5" ry="2.2"/><path d="M3 4.5v7c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2v-7"/><path d="M3 8c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2"/>',
  cost: '<circle cx="8" cy="8" r="6"/><path d="M8 4.3v7.4M9.9 5.8c-.4-.7-1.1-1-1.9-1-1 0-1.8.6-1.8 1.4 0 2 3.7 1 3.7 3 0 .9-.8 1.5-1.9 1.5-.8 0-1.5-.4-1.8-1"/>',
  flame: '<path d="M8 1.6s3.4 2.8 3.4 6.4a3.4 3.4 0 1 1-6.8 0c0-1.1.5-1.9.5-1.9.3 1 1 1.5 1 1.5C6 6 8 4.6 8 1.6z"/>',
  trophy: '<path d="M5 2.3h6v3.2a3 3 0 0 1-6 0V2.3zM5 3.3H2.8v1A2 2 0 0 0 5 6.3M11 3.3h2.2v1A2 2 0 0 1 11 6.3M6.4 8.6h3.2M8 8.6v2.2M5.8 13.5h4.4"/>',
  calendar: '<rect x="2.5" y="3" width="11" height="10.5" rx="1.6"/><path d="M2.5 6.4h11M5.4 1.8v2.4M10.6 1.8v2.4"/>',
  gauge: '<path d="M3 13.2V8.2M7 13.2V4.4M11 13.2v-3"/>',
  peak: '<path d="M9 1.7 3.4 9H8l-1 5.3L12.6 7H8z"/>',
  trend: '<path d="M2 11.2l4-4 3 3 5-5M10 5.2h4v4"/>',
};

// ── Rank system ─────────────────────────────────────────────────────────────
// Rule-based tier from total token consumption. Each tier carries a hand-drawn
// 8×8 pixel sprite (`.`=transparent, `X`=accent, `o`=highlight, `#`=outline).
const SPROUT = ["....X...", "..X.X.X.", ".X..X..X", "..X.X.X.", "....X...", "....X...", "...XXX..", "..#####."];
const GEAR = ["..X..X..", ".XXXXXX.", ".X.XX.X.", "XXX..XXX", "XXX..XXX", ".X.XX.X.", ".XXXXXX.", "..X..X.."];
const BOLT = ["....XX..", "...XX...", "..XXX...", ".XXXXX..", "...XXo..", "..XX....", ".XX.....", ".X......"];
const FLAME = ["...X....", "...XX...", "..X.X...", "..X.XX..", ".X...X..", ".X.o.X..", ".Xo.oX..", "..XXX..."];
const CROWN = ["X..X..X.", "X..X..X.", "Xo.X.oX.", "XXXXXXXX", "Xo.X.oX.", "XXXXXXXX", ".XXXXXX.", ".X#XX#X."];
const STAR = ["...XX...", "...XX...", "XX.XX.XX", ".XXXXXX.", "..oXXo..", ".XX..XX.", "XX....XX", "X......X"];

interface Tier { min: number; title: string; sprite: string[] }
const TIERS: Tier[] = [
  { min: 0, title: "Curious Tinkerer", sprite: SPROUT },
  { min: 20e6, title: "Prompt Apprentice", sprite: GEAR },
  { min: 100e6, title: "Power User", sprite: BOLT },
  { min: 500e6, title: "Token Wizard", sprite: FLAME },
  { min: 2e9, title: "Token Titan", sprite: CROWN },
  { min: 8e9, title: "Singularity", sprite: STAR },
];

function rankFor(tokens: number): { idx: number; tier: Tier; next: Tier | null } {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) if (tokens >= TIERS[i].min) idx = i;
  return { idx, tier: TIERS[idx], next: TIERS[idx + 1] ?? null };
}

function pixelSprite(rows: string[], c: ReturnType<typeof resolveTheme>, px = 9): string {
  const n = rows.length;
  const palette: Record<string, string> = { X: c.scale[3], o: c.scale[1], "#": c.sub };
  let rects = "";
  for (let y = 0; y < n; y++)
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      const fill = palette[ch];
      if (fill) rects += `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${fill}"/>`;
    }
  const dim = n * px;
  return `<svg viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges" style="image-rendering:pixelated">${rects}</svg>`;
}

function rankCard(tokens: number, c: ReturnType<typeof resolveTheme>): string {
  const { idx, tier, next } = rankFor(tokens);
  const sprite = pixelSprite(tier.sprite, c, 10);
  const prog = next ? Math.min(100, ((tokens - tier.min) / (next.min - tier.min)) * 100) : 100;
  const progLine = next
    ? `<div class="rk-track"><div class="rk-fill" style="width:${prog.toFixed(0)}%"></div></div>
       <div class="rk-scale"><span>${fmt(tier.min)}</span><span>${prog.toFixed(0)}% through this tier</span><span>${fmt(next.min)}</span></div>
       <div class="rk-next"><b>${fmt(next.min - tokens)}</b> more tokens → <b>${esc(next.title)}</b> (unlocks at ${fmt(next.min)})</div>`
    : `<div class="rk-next">top tier — you've hit ${fmt(tier.min)}+ tokens and ascended 🛸</div>`;
  const ladder = `<div class="rk-ladder">${TIERS.map((t, i) => {
    const cls = i === idx ? "cur" : i < idx ? "done" : "";
    const tip = i < idx ? "unlocked" : i === idx ? "you are here" : `${fmt(t.min - tokens)} tokens to go`;
    return `<div class="rk-step ${cls}" data-tip="Tier ${i + 1}: ${esc(t.title)} · unlocks at ${fmt(t.min)} tokens · ${tip}">
      <div class="px">${pixelSprite(t.sprite, c, 4)}</div>
      <div class="nm">${esc(t.title)}</div>
      <div class="th">${i === 0 ? "0" : fmt(t.min)}</div>
    </div>`;
  }).join("")}</div>`;
  return `<div class="rank">
    <div class="rk-icon">${sprite}</div>
    <div class="rk-body">
      <div class="rk-lv">RANK ${idx + 1} / ${TIERS.length} · by total tokens</div>
      <div class="rk-title">${esc(tier.title)}</div>
      <div class="rk-sub">${fmt(tokens)} tokens consumed across Claude + Codex</div>
      ${progLine}
    </div>
  </div>${ladder}`;
}

// A bespoke 1200×630 social/OG card: the user's tier pixel-mascot as the hero,
// rank title, and headline stats. Served (rasterized) at /u/<user>.png so X,
// Slack, etc. unfurl a braggable image instead of a bare grid.
function dKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function renderSocialCard(d: ReportData, opts: ReportOptions = {}): string {
  const c = resolveTheme(opts.theme);
  const user = d.user || "you";
  const { idx, tier, next } = rankFor(d.totals.tokens);
  const W = 1200, H = 630;
  const font = "-apple-system,Segoe UI,Helvetica,Arial,sans-serif";

  // hero mascot on a rounded tile (top-left)
  const palette: Record<string, string> = { X: c.scale[3], o: c.scale[1], "#": c.sub };
  const tile = { x: 64, y: 56, s: 232 };
  const px = 24, sprite = 8 * px, ox = tile.x + (tile.s - sprite) / 2, oy = tile.y + (tile.s - sprite) / 2;
  let mascot = "";
  for (let y = 0; y < tier.sprite.length; y++)
    for (let x = 0; x < tier.sprite[y].length; x++) {
      const fill = palette[tier.sprite[y][x]];
      if (fill) mascot += `<rect x="${ox + x * px}" y="${oy + y * px}" width="${px}" height="${px}" fill="${fill}"/>`;
    }

  // the actual heatmap — a full-year strip across the bottom (the "map")
  const weeks = 53, gcell = 17, ggap = 3, gstep = gcell + ggap;
  const gx = 64, gy = 388;
  const byDate = new Map<string, number>(d.days.map((x) => [x.date, x.tokens]));
  const vals = d.days.map((x) => x.tokens).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0);
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  const lvl = (v: number) => (v <= 0 ? -1 : v <= t1 ? 0 : v <= t2 ? 1 : v <= t3 ? 2 : 3);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - (weeks - 1) * 7 - today.getDay());
  let grid = "";
  const cur = new Date(start);
  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      if (cur <= today) {
        const v = byDate.get(dKey(cur)) || 0;
        const l = lvl(v);
        grid += `<rect x="${gx + col * gstep}" y="${gy + row * gstep}" width="${gcell}" height="${gcell}" rx="3" fill="${l < 0 ? c.empty : c.scale[l]}"/>`;
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  const tx = 330; // right of mascot
  const titleSize = tier.title.length > 14 ? 54 : tier.title.length > 11 ? 64 : 80;
  const cost = `$${Math.round(d.totals.cost).toLocaleString()}`;
  const sub = `${cost} · ${d.totals.streak}-day streak · ${d.days.length} active days`;
  const goal = next ? `${fmt(next.min - d.totals.tokens)} tokens to ${esc(next.title)}` : "top tier — ascended";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${font}" xml:space="preserve">
  <rect width="${W}" height="${H}" fill="${c.bg}"/>
  <rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="30" fill="none" stroke="${c.border}" stroke-width="2"/>
  <rect x="${tile.x}" y="${tile.y}" width="${tile.s}" height="${tile.s}" rx="24" fill="${c.empty}"/>
  <g shape-rendering="crispEdges">${mascot}</g>
  <text x="${tx}" y="104" font-size="26" font-weight="700" fill="${c.scale[2]}">cc<tspan fill="${c.sub}">▪</tspan>map<tspan fill="${c.sub}" font-weight="400">  ·  RANK ${idx + 1} / ${TIERS.length}</tspan></text>
  <text x="${tx}" y="${104 + titleSize + 6}" font-size="${titleSize}" font-weight="700" fill="${c.text}">${esc(tier.title)}</text>
  <text x="${tx}" y="${104 + titleSize + 52}" font-size="30" fill="${c.sub}">@${esc(user)} · Claude + Codex heatmap</text>
  <text x="${tx}" y="328" font-size="44" font-weight="700" fill="${c.scale[2]}">${fmt(d.totals.tokens)} tokens<tspan font-size="26" font-weight="400" fill="${c.sub}">  · ${goal}</tspan></text>
  <text x="${tx}" y="366" font-size="28" fill="${c.sub}">${sub}</text>
  <g>${grid}</g>
  <text x="${gx}" y="588" font-size="24" fill="${c.sub}">see your own → <tspan fill="${c.text}" font-weight="700">npm i -g @tao-hpu/ccmap</tspan>   ·   ccmap.fim.ai   ·   github.com/tao-hpu/ccmap</text>
</svg>`;
}

// A 1080×1350 portrait card for social feeds / 朋友圈 / X — downloadable.
// Same data as the wide card but stacked, heatmap included.
export function renderPortraitCard(d: ReportData, opts: ReportOptions = {}): string {
  const c = resolveTheme(opts.theme);
  const user = d.user || "you";
  const { idx, tier, next } = rankFor(d.totals.tokens);
  const W = 1080, H = 1350, cx = W / 2;
  const font = "-apple-system,Segoe UI,Helvetica,Arial,sans-serif";
  const palette: Record<string, string> = { X: c.scale[3], o: c.scale[1], "#": c.sub };

  // mascot, centered
  const tile = { s: 340, y: 150 };
  const tx0 = (W - tile.s) / 2;
  const px = 36, sprite = 8 * px, ox = tx0 + (tile.s - sprite) / 2, oy = tile.y + (tile.s - sprite) / 2;
  let mascot = "";
  for (let y = 0; y < tier.sprite.length; y++)
    for (let x = 0; x < tier.sprite[y].length; x++) {
      const fill = palette[tier.sprite[y][x]];
      if (fill) mascot += `<rect x="${ox + x * px}" y="${oy + y * px}" width="${px}" height="${px}" fill="${fill}"/>`;
    }

  // heatmap, centered
  const weeks = 53, gcell = 14, ggap = 3, gstep = gcell + ggap;
  const gw = weeks * gstep, gx = (W - gw) / 2, gy = 905;
  const byDate = new Map<string, number>(d.days.map((x) => [x.date, x.tokens]));
  const vals = d.days.map((x) => x.tokens).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0);
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  const lvl = (v: number) => (v <= 0 ? -1 : v <= t1 ? 0 : v <= t2 ? 1 : v <= t3 ? 2 : 3);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - (weeks - 1) * 7 - today.getDay());
  let grid = "";
  const cur = new Date(start);
  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      if (cur <= today) {
        const v = byDate.get(dKey(cur)) || 0, l = lvl(v);
        grid += `<rect x="${gx + col * gstep}" y="${gy + row * gstep}" width="${gcell}" height="${gcell}" rx="3" fill="${l < 0 ? c.empty : c.scale[l]}"/>`;
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  const cost = `$${Math.round(d.totals.cost).toLocaleString()}`;
  const sub = `${cost} · ${d.totals.streak}-day streak · ${d.days.length} active days`;
  const goal = next ? `${fmt(next.min - d.totals.tokens)} tokens to ${esc(next.title)}` : "top tier — ascended";

  // QR linking back to this page — scan it to open the live report.
  const base = (opts.origin || "https://ccmap.fim.ai").replace(/\/$/, "");
  const pageUrl = `${base}/u/${encodeURIComponent(user)}`;
  const qs = 150, qx = (W - qs) / 2, qy = 1132;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${font}" xml:space="preserve">
  <rect width="${W}" height="${H}" fill="${c.bg}"/>
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="36" fill="none" stroke="${c.border}" stroke-width="2"/>
  <text x="${cx}" y="96" text-anchor="middle" font-size="40" font-weight="700" fill="${c.scale[2]}">cc<tspan fill="${c.sub}">▪</tspan>map</text>
  <rect x="${tx0}" y="${tile.y}" width="${tile.s}" height="${tile.s}" rx="30" fill="${c.empty}"/>
  <g shape-rendering="crispEdges">${mascot}</g>
  <text x="${cx}" y="588" text-anchor="middle" font-size="26" font-weight="600" fill="${c.sub}" letter-spacing="2">RANK ${idx + 1} / ${TIERS.length} · BY TOTAL TOKENS</text>
  <text x="${cx}" y="666" text-anchor="middle" font-size="76" font-weight="700" fill="${c.text}">${esc(tier.title)}</text>
  <text x="${cx}" y="716" text-anchor="middle" font-size="30" fill="${c.sub}">@${esc(user)} · Claude + Codex heatmap</text>
  <text x="${cx}" y="812" text-anchor="middle" font-size="58" font-weight="700" fill="${c.scale[2]}">${fmt(d.totals.tokens)} tokens</text>
  <text x="${cx}" y="862" text-anchor="middle" font-size="28" fill="${c.sub}">${sub}</text>
  <g>${grid}</g>
  <text x="${cx}" y="1058" text-anchor="middle" font-size="26" fill="${c.sub}">${goal}</text>
  <text x="${cx}" y="1108" text-anchor="middle" font-size="32" font-weight="700" fill="${c.text}">Get your own coding heatmap</text>
  ${qrChip(pageUrl, qx, qy, qs)}
  <text x="${cx}" y="1322" text-anchor="middle" font-size="23" fill="${c.scale[2]}">scan to open · npm i -g @tao-hpu/ccmap</text>
</svg>`;
}

function bars(items: [string, number][], total: number, c: ReturnType<typeof resolveTheme>): string {
  const top = Math.max(1, ...items.map((it) => it[1]));
  return items
    .map(([label, v], i) => {
      const p = total ? (v / total) * 100 : 0;
      const rel = ((v / top) * 100).toFixed(0);
      const tip = `#${i + 1} · ${esc(label)} · ${p.toFixed(1)}% of total · ${fmt(v)} tokens · ${rel}% of the top model`;
      return `<div class="row" data-tip="${tip}">
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

  const longest = longestStreak(d.days);
  const peak = peakDay(d.days);
  const trend = weekTrend(d.days);
  const avgActive = activeDays ? d.totals.tokens / activeDays : 0;
  const words = Math.round(d.totals.tokens * 0.75);
  const novels = words / 100000;
  const { idx: tierIdx, tier } = rankFor(d.totals.tokens);
  const TIER_EMOJI = ["🌱", "⚙️", "⚡", "🔥", "👑", "⭐"];
  const emo = TIER_EMOJI[tierIdx] ?? "👾";
  const trendStr = trend === null ? "—" : (trend >= 0 ? "▲ " : "▼ ") + Math.abs(trend).toFixed(0) + "%";

  const stat = (label: string, value: string, icon: string) =>
    `<div class="stat"><div class="ico"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon] ?? ""}</svg></div><div class="num">${value}</div><div class="cap">${label}</div></div>`;

  const pageUrl = opts.origin ? `${opts.origin}/u/${user}` : "";
  // Social cards need a RASTER image — X/Twitter won't render SVG. Point at the
  // PNG route (the server rasterizes the badge); fall back to nothing locally.
  const ogImg = opts.origin ? `${opts.origin}/u/${user}.png` : "";
  const ogTitle = `${emo} ${esc(user)} — ${esc(tier.title)} on ccmap`;
  const ogDesc = `🔥 ${fmt(d.totals.tokens)} tokens · 💰 $${Math.round(d.totals.cost).toLocaleString()} · 🗓️ ${d.totals.streak}-day streak across Claude + Codex 🤖  👀 See your own coding heatmap → npm i -g @tao-hpu/ccmap`;
  const ogTags = !opts.origin
    ? ""
    : `<meta property="og:type" content="website">
<meta property="og:url" content="${pageUrl}">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDesc}">
<meta property="og:image" content="${ogImg}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="539">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image" content="${ogImg}">`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(user)} · ccmap report</title>
${ogTags}
<style>
  :root{--bg:${c.bg};--fg:${c.text};--sub:${c.sub};--card:${c.empty};--accent:${c.scale[2]};--accent-rgb:${rgbOf(c.scale[2])};--line:${c.border}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}
  .wrap{max-width:860px;margin:0 auto;padding:34px 20px 64px}
  h1{font-size:24px;margin:0 0 4px} .muted{color:var(--sub)}
  .head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px}
  .head h1{margin:0}
  .brand-mark{font-weight:800;font-size:20px;letter-spacing:-.02em;color:var(--fg);border:1px solid var(--line);background:var(--bg);border-radius:9px;padding:5px 11px;flex:none}
  .brand-dot{color:var(--accent)}
  .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:24px 0}
  @media(max-width:560px){.grid{grid-template-columns:repeat(2,1fr)}}
  .stat{position:relative;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;overflow:hidden}
  .ico{position:absolute;top:12px;right:12px;width:36px;height:36px;border-radius:11px;background:rgba(var(--accent-rgb),.14);color:var(--accent);display:flex;align-items:center;justify-content:center}
  .ico svg{width:21px;height:21px;display:block}
  .num{font-size:26px;font-weight:700} .cap{color:var(--sub);font-size:12px;margin-top:2px}
  .donut{display:flex;flex-direction:column;align-items:center;gap:14px}
  .donut-legend{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 18px;font-size:13px}
  .donut-legend span{display:flex;align-items:center;gap:7px}
  .donut-legend i{width:11px;height:11px;border-radius:3px;display:inline-block;flex:none}
  /* hover liveliness — driven by the .cm-active class the tooltip JS toggles */
  .card svg rect:not(.bar):not(.band).cm-active{stroke:var(--fg);stroke-width:1.4px;paint-order:stroke}
  .bar{transition:filter .1s}
  .bar.cm-active{filter:brightness(1.3)}
  .arc{transition:stroke-width .12s ease}
  .arc.cm-active{stroke-width:38}
  .dot{transition:transform .12s ease,filter .12s ease;transform-box:fill-box;transform-origin:center}
  .hit.cm-active + .dot{transform:scale(2);filter:brightness(1.3)}
  .crosshair{opacity:0;transition:opacity .08s}
  .crosshair line{stroke:var(--sub);stroke-width:1;stroke-dasharray:3 3}
  .crosshair circle{fill:var(--accent);stroke:var(--bg);stroke-width:2}
  .split{display:flex;gap:24px;flex-wrap:wrap;align-items:center}
  .half{flex:1;min-width:240px}
  .sub-h{font-size:11px;color:var(--sub);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em;font-weight:600;text-align:center}
  .rk-scale{display:flex;justify-content:space-between;font-size:10px;color:var(--sub);margin-top:4px}
  .tip{position:fixed;z-index:50;pointer-events:none;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 9px;font-size:12px;opacity:0;transition:opacity .08s;max-width:300px;line-height:1.45}
  .tip.on{opacity:1}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:18px 0}
  .card h2{font-size:14px;margin:0 0 14px;color:var(--sub);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
  .row{display:flex;align-items:center;gap:10px;margin:4px -8px;padding:3px 8px;border-radius:7px;transition:background .1s}
  .row.cm-active{background:rgba(var(--accent-rgb),.09)}
  .lbl{width:200px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .track{flex:1;height:8px;background:rgba(128,128,128,.18);border-radius:5px;overflow:hidden}
  .fill{height:100%;background:var(--accent);border-radius:5px;transition:filter .1s}
  .row.cm-active .fill{filter:brightness(1.3)}
  .val{width:120px;text-align:right;font-size:12px;color:var(--sub)}
  .rank{display:flex;gap:18px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:22px 0 6px}
  .rk-icon{flex:none;line-height:0;padding:6px;background:var(--bg);border:1px solid var(--line);border-radius:10px}
  .rk-body{flex:1;min-width:0}
  .rk-lv{font-size:11px;letter-spacing:.12em;color:var(--sub);font-weight:600}
  .rk-title{font-size:22px;font-weight:800;margin:1px 0 3px}
  .rk-sub{font-size:12px;color:var(--sub);margin-bottom:9px}
  .rk-track{height:7px;background:rgba(128,128,128,.18);border-radius:5px;overflow:hidden}
  .rk-fill{height:100%;background:var(--accent);border-radius:5px}
  .rk-next{font-size:11px;color:var(--sub);margin-top:6px}
  .rk-ladder{display:flex;gap:8px;margin:10px 0 6px}
  .rk-step{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;padding:9px 4px;border-radius:10px;border:1px solid var(--line);background:var(--card);opacity:.45;transition:opacity .15s,transform .15s}
  .rk-step .px{line-height:0;filter:grayscale(.7)}
  .rk-step.done{opacity:.8}
  .rk-step.done .px{filter:none}
  .rk-step.cur{opacity:1;border-color:var(--accent);background:rgba(var(--accent-rgb),.12)}
  .rk-step.cur .px{filter:none}
  .rk-step .nm{font-size:9.5px;color:var(--sub);text-align:center;line-height:1.15}
  .rk-step.cur .nm{color:var(--fg);font-weight:700}
  .rk-step .th{font-size:9px;color:var(--sub);font-variant-numeric:tabular-nums}
  .rk-step.cm-active{transform:translateY(-2px)}
  .hl{font-size:13.5px;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 14px;margin:6px 0 2px;line-height:1.6}
  .hl b{color:var(--accent)}
  .legend{display:flex;gap:16px;font-size:11px;color:var(--sub);margin-top:8px}
  .legend span{display:flex;align-items:center;gap:5px}
  .legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
  footer{color:var(--sub);font-size:12px;margin-top:28px;text-align:center}
  a{color:var(--accent)}
  .ctl{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:14px;align-items:center}
  .ctl label{font-size:12px;color:var(--sub);display:flex;gap:6px;align-items:center}
  .ctl select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:5px 8px;font:13px inherit}
  .ctl .cb{cursor:pointer}
  .preview{display:block;max-width:100%;margin:6px auto 18px;border-radius:8px}
  .snip{margin:12px 0}
  .snip-h{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--sub);margin-bottom:6px}
  .snip-h span{flex:1}
  .snip-h button,.snip-h a{font:12px inherit;background:none;border:1px solid var(--line);color:var(--accent);border-radius:6px;padding:2px 10px;cursor:pointer;text-decoration:none}
  .note{font-size:11px;color:var(--sub);margin-top:8px;line-height:1.5}
  .share-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}
  .xbtn,.dlbtn{display:inline-flex;align-items:center;justify-content:center;gap:9px;height:48px;padding:0 24px;font-size:15px;font-weight:700;border:1.5px solid transparent;border-radius:11px;text-decoration:none;cursor:pointer;transition:background .12s,filter .12s}
  .xbtn{background:var(--accent);color:#fff}
  .xbtn:hover{filter:brightness(1.06)}
  .xbtn svg{width:20px;height:20px;fill:currentColor}
  .dlbtn{background:transparent;color:var(--accent);border-color:var(--accent)}
  .dlbtn:hover{background:rgba(var(--accent-rgb),.1)}
  .dlbtn svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .cta{margin:32px 0 8px;padding:28px 26px;border:1px solid var(--line);border-radius:16px;background:var(--card);text-align:center}
  .cta-h{font-size:25px;font-weight:800}
  .cta-sub{font-size:14px;color:var(--sub);margin:7px 0 18px}
  .cta-row{display:flex;gap:14px;justify-content:center;align-items:center;flex-wrap:wrap}
  .cta-btn{display:inline-flex;align-items:center;justify-content:center;height:48px;padding:0 26px;background:var(--accent);color:#fff;font-size:16px;font-weight:700;border:1.5px solid transparent;border-radius:11px;text-decoration:none;transition:filter .12s}
  .cta-btn:hover{filter:brightness(1.06)}
  .cta-code{display:inline-flex;align-items:center;height:48px;font:13px ui-monospace,Menlo,monospace;background:var(--bg);border:1px solid var(--line);border-radius:11px;padding:0 16px;color:var(--fg)}
  .getyours{position:fixed;right:18px;bottom:18px;z-index:50;display:inline-flex;align-items:center;gap:7px;padding:12px 19px;background:var(--accent);color:#fff;font-size:14px;font-weight:700;border-radius:999px;text-decoration:none;border:1px solid rgba(0,0,0,.15)}
  .getyours:hover{filter:brightness(1.06)}
  @media(max-width:560px){.getyours{right:10px;bottom:10px;padding:10px 15px;font-size:13px}}
  pre{margin:0;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--accent) transparent}
  pre::-webkit-scrollbar{height:8px}
  pre::-webkit-scrollbar-track{background:transparent;border-radius:8px}
  pre::-webkit-scrollbar-thumb{background:var(--accent);border-radius:8px;border:2px solid var(--bg)}
  pre::-webkit-scrollbar-thumb:hover{filter:brightness(1.15)}
  code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);white-space:pre}
</style></head><body><div class="wrap">
  <div class="head"><span class="brand-mark">cc<span class="brand-dot">▪</span>map</span><h1>${esc(user)} <span class="muted">· coding report</span></h1></div>
  <div class="muted">Claude + Codex coding heatmap · ${range}</div>

  ${rankCard(d.totals.tokens, c)}

  <div class="hl">≈ <b>${fmt(words)}</b> words written with AI${
    novels >= 1 ? ` — about <b>${novels >= 10 ? Math.round(novels) : novels.toFixed(1)}</b> novels' worth` : ""
  }.${peak ? ` Busiest day <b>${peak.date}</b> at <b>${fmt(peak.tokens)}</b> tokens.` : ""} Longest run: <b>${longest}</b> days straight.</div>

  <div class="grid">
    ${stat("tokens", fmt(d.totals.tokens), "tokens")}
    ${stat("est. cost", "$" + d.totals.cost.toFixed(0), "cost")}
    ${stat("current streak", d.totals.streak + "d", "flame")}
    ${stat("longest streak", longest + "d", "trophy")}
    ${stat("active days", String(activeDays), "calendar")}
    ${stat("avg / active day", fmt(avgActive), "gauge")}
    ${peak ? stat("busiest day", fmt(peak.tokens), "peak") : ""}
    ${stat("7-day trend", trendStr, "trend")}
  </div>

  <div class="card"><h2>Activity</h2>${heat}</div>

  <div class="card"><h2>Daily volume · last 30 days</h2>${dailyChart(d.days, 30, c)}</div>

  <div class="card"><h2>Cumulative growth</h2>${cumulativeArea(d.days, c)}</div>

  <div class="card"><h2>Rhythm &amp; engine split</h2>
    <div class="split">
      <div class="half"><div class="sub-h">When you code · by weekday</div>${radarWeekday(d.days, c)}</div>
      <div class="half"><div class="sub-h">Claude vs Codex</div>${donut(
        [["Claude", src.claude, c.scale[3]], ["Codex", src.codex, c.scale[1]]],
        c
      )}</div>
    </div>
  </div>

  <div class="card"><h2>Models</h2>${bars(topModels, d.totals.tokens, c)}</div>

  ${opts.share ? shareCard(opts.origin || "https://YOUR-CCMAP-HOST", user) : ""}

  ${opts.share ? `<div class="cta">
    <div class="cta-h">Want your own? 🚀</div>
    <div class="cta-sub">A GitHub-style heatmap of your Claude Code + Codex usage — free, 100% local, set up in 30 seconds.</div>
    <div class="cta-row">
      <a class="cta-btn" href="${GITHUB}" target="_blank" rel="noopener">★ Get it on GitHub →</a>
      <code class="cta-code">npm i -g @tao-hpu/ccmap</code>
    </div>
  </div>` : ""}

  <div id="tip" class="tip"></div>

  <footer>generated by <a href="${GITHUB}">ccmap</a> · <a href="https://www.npmjs.com/package/@tao-hpu/ccmap">npm</a>${
    badge ? ` · <a href="${badge}">badge</a>` : ""
  }</footer>
</div>
${opts.share ? `<a class="getyours" href="${GITHUB}" target="_blank" rel="noopener">⚡ Get your own ↗</a>` : ""}
<script>${opts.share ? `const BASE=${JSON.stringify(opts.origin || "https://YOUR-CCMAP-HOST")},USER=${JSON.stringify(user)};${SHARE_JS}` : ""}${TOOLTIP_JS}</script>
</body></html>`;
}
