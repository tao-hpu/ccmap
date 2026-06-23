// ccmap badge service — standalone Node http server.
//
// A direct port of the Cloudflare Worker (server/src/index.ts) to plain Node:
// zero runtime deps, JSON-file storage instead of KV. Same routes, same
// trust-on-first-use auth (client mints a secret; we only ever store its sha256).
//
//   POST /api/claim   { user, key }      -> bind a name to sha256(key) (first-claim-wins)
//   POST /api/push    Bearer <key>       -> store per-day aggregates for the holder
//   GET  /u/:user.svg                    -> heatmap badge
//   GET  /u/:user[.html]                 -> shareable HTML report
//   GET  /health                         -> ok
//
// Run:  CCMAP_DATA=/var/lib/ccmap/data.json PORT=3006 node dist/server.js
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSVG, resolveTheme } from "./render.js";
import { renderReport, renderSocialCard } from "./report.js";

const PORT = Number(process.env.PORT || 3006);
const DATA = process.env.CCMAP_DATA || "./ccmap-data.json";
// Optional invite gate: if set, /api/claim requires header `x-invite: <secret>`.
const INVITE = process.env.PUSH_SECRET || "";

const USER_RE = /^[a-zA-Z0-9_-]{1,39}$/;

interface PushDay {
  date: string;
  tokens: number;
  cost: number;
  claude: number;
  codex: number;
  sessions: number;
}
interface PushPayload {
  v: string;
  user: string;
  generatedAt: string;
  totals: { tokens: number; cost: number; streak: number; bySource: { claude: number; codex: number } };
  byModel: Record<string, number>;
  days: PushDay[];
}

// ---- storage: a flat key->string map, persisted atomically to one JSON file ----
const store: Record<string, string> = (() => {
  try {
    return JSON.parse(readFileSync(DATA, "utf8"));
  } catch {
    return {};
  }
})();

let writeTimer: NodeJS.Timeout | null = null;
function flush(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    mkdirSync(dirname(DATA), { recursive: true });
  } catch {}
  const tmp = `${DATA}.tmp`;
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, DATA); // atomic swap
}
function persist(): void {
  // debounce: batch bursts of writes into one fsync within 200ms
  if (writeTimer) return;
  writeTimer = setTimeout(flush, 200);
}
// never lose the last write on a clean shutdown (systemd stop, Ctrl-C)
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}
function kvGet(k: string): string | undefined {
  return store[k];
}
function kvPut(k: string, v: string): void {
  store[k] = v;
  persist();
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---- tiny http helpers ----
function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers);
  res.end(body);
}
function json(res: ServerResponse, data: unknown, status = 200): void {
  send(res, status, JSON.stringify(data), { "content-type": "application/json" });
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1_000_000) reject(new Error("too large")); // 1MB cap
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}
function bearer(req: IncomingMessage): string {
  const a = (req.headers["authorization"] as string) || "";
  return a.startsWith("Bearer ") ? a.slice(7) : "";
}

// Build the Map shape renderSVG expects from a stored payload.
function daysToMap(p: PushPayload): Map<string, any> {
  const m = new Map<string, any>();
  for (const d of p.days) {
    m.set(d.date, {
      date: d.date,
      tokens: d.tokens,
      cost: d.cost,
      bySource: { claude: d.claude, codex: d.codex },
      byModel: {},
      sessions: new Set(),
    });
  }
  return m;
}

// ---- handlers ----
async function handleClaim(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (INVITE && req.headers["x-invite"] !== INVITE) return json(res, { error: "invite required" }, 403);
  let body: { user?: string; key?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, { error: "invalid json" }, 400);
  }
  const user = (body.user || "").trim();
  const key = body.key || "";
  if (!USER_RE.test(user)) return json(res, { error: "invalid user (use a-z 0-9 _ -, 1-39 chars)" }, 400);
  if (key.length < 16) return json(res, { error: "key too short" }, 400);
  const hash = sha256(key);
  const existing = kvGet(`auth:${user}`);
  if (existing && existing !== hash) return json(res, { error: "username taken" }, 409);
  if (!existing) kvPut(`auth:${user}`, hash);
  json(res, { ok: true, user, badge: `/u/${user}.svg`, claimed: !existing });
}

async function handlePush(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let p: PushPayload;
  try {
    p = JSON.parse(await readBody(req));
  } catch {
    return json(res, { error: "invalid json" }, 400);
  }
  if (!p.user || !USER_RE.test(p.user)) return json(res, { error: "invalid user" }, 400);
  const expected = kvGet(`auth:${p.user}`);
  if (!expected) return json(res, { error: "user not claimed — run `ccmap login` first" }, 403);
  if (sha256(bearer(req)) !== expected) return json(res, { error: "bad token" }, 401);
  if (!Array.isArray(p.days)) return json(res, { error: "missing days" }, 400);
  p.days = p.days.slice(-400); // cap to keep the value small
  kvPut(`user:${p.user}`, JSON.stringify(p));
  json(res, { ok: true, user: p.user, days: p.days.length, badge: `/u/${p.user}.svg` });
}

function handleBadge(user: string, url: URL, res: ServerResponse): void {
  if (!USER_RE.test(user)) return send(res, 400, "bad user");
  const raw = kvGet(`user:${user}`);
  if (!raw) return send(res, 404, "not found");
  const p = JSON.parse(raw) as PushPayload;
  const metric = (url.searchParams.get("metric") as "tokens" | "cost") || "tokens";
  const theme = url.searchParams.get("theme") || "claude";
  const weeks = Number(url.searchParams.get("weeks") || 26);
  const hideBorder = url.searchParams.get("hide_border") === "true";
  const anim = url.searchParams.get("anim") || "none";
  const svg = renderSVG(
    daysToMap(p),
    { totalTokens: p.totals.tokens, totalCost: p.totals.cost, streak: p.totals.streak },
    { metric, theme, weeks, anim, border: !hideBorder, title: `${user} · coding heatmap` }
  );
  send(res, 200, svg, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  });
}

// resvg-wasm ships no fonts, so SVG text renders blank unless we feed it font
// buffers. Read TTFs once (DejaVu by default; override with CCMAP_FONTS).
let FONTS: Uint8Array[] | null = null;
function fontBuffers(): Uint8Array[] {
  if (FONTS) return FONTS;
  const paths = (
    process.env.CCMAP_FONTS ||
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf,/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
  ).split(",");
  const bufs: Uint8Array[] = [];
  for (const p of paths) {
    try {
      bufs.push(new Uint8Array(readFileSync(p.trim())));
    } catch {}
  }
  FONTS = bufs;
  return bufs;
}

// Build the public origin, honoring the reverse proxy's X-Forwarded-Proto so
// social tags get https:// (the backend itself only sees http).
function originOf(req: IncomingMessage, url: URL): string {
  const proto = ((req.headers["x-forwarded-proto"] as string) || "").split(",")[0].trim() || url.protocol.replace(":", "");
  return `${proto}://${req.headers.host || url.host}`;
}

// Lazy-load @resvg/resvg-wasm (optional dep; only the server needs it). Cached.
let resvgMod: Promise<any> | null = null;
function getResvg(): Promise<any> {
  if (!resvgMod) {
    resvgMod = (async () => {
      const spec = "@resvg/resvg-wasm"; // non-literal: keeps it out of tsc's module resolution
      const mod: any = await import(spec);
      const wasm = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@resvg", "resvg-wasm", "index_bg.wasm");
      await mod.initWasm(readFileSync(wasm));
      return mod;
    })();
  }
  return resvgMod;
}

// PNG badge — social cards (X/Twitter, etc.) can't render SVG, so rasterize it.
async function handlePng(user: string, url: URL, res: ServerResponse): Promise<void> {
  if (!USER_RE.test(user)) return send(res, 400, "bad user");
  const raw = kvGet(`user:${user}`);
  if (!raw) return send(res, 404, "not found");
  const p = JSON.parse(raw) as PushPayload;
  const theme = url.searchParams.get("theme") || "claude";
  // ?card=badge → rasterize the heatmap badge; default → the tier-mascot OG card.
  const svg =
    url.searchParams.get("card") === "badge"
      ? renderSVG(
          daysToMap(p),
          { totalTokens: p.totals.tokens, totalCost: p.totals.cost, streak: p.totals.streak },
          { metric: "tokens", theme, weeks: 26, border: true, title: `${user} · coding heatmap` }
        )
      : renderSocialCard({ user, totals: p.totals, byModel: p.byModel, days: p.days }, { theme });
  // Strip emoji (🔥 etc.) for the raster path — resvg has no emoji font (tofu).
  const pngSvg = svg.replace(/\p{Extended_Pictographic}️?\s?/gu, "");
  try {
    const { Resvg } = await getResvg();
    const png = new Resvg(pngSvg, {
      fitTo: { mode: "width", value: 1200 },
      background: resolveTheme(theme).bg,
      font: { fontBuffers: fontBuffers(), defaultFontFamily: "DejaVu Sans", loadSystemFonts: false },
    })
      .render()
      .asPng();
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    });
    res.end(png);
  } catch {
    // resvg unavailable → degrade to the SVG so the route never hard-fails
    res.writeHead(302, { location: `/u/${encodeURIComponent(user)}.svg` });
    res.end();
  }
}

function handleReport(req: IncomingMessage, user: string, url: URL, res: ServerResponse): void {
  if (!USER_RE.test(user)) return send(res, 400, "bad user");
  const raw = kvGet(`user:${user}`);
  if (!raw) return send(res, 404, "not found");
  const p = JSON.parse(raw) as PushPayload;
  const theme = url.searchParams.get("theme") || "claude";
  const html = renderReport(
    { user, totals: p.totals, byModel: p.byModel, days: p.days },
    { theme, origin: originOf(req, url), share: true }
  );
  send(res, 200, html, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    const method = req.method || "GET";

    if (method === "POST" && path === "/api/claim") return await handleClaim(req, res);
    if (method === "POST" && path === "/api/push") return await handlePush(req, res);

    const pngM = path.match(/^\/u\/([^/]+)\.png$/);
    if (method === "GET" && pngM) return await handlePng(decodeURIComponent(pngM[1]), url, res);

    const m = path.match(/^\/u\/([^/]+)\.svg$/);
    if (method === "GET" && m) return handleBadge(decodeURIComponent(m[1]), url, res);

    const h = path.match(/^\/u\/([^/]+?)(?:\.html)?$/);
    if (method === "GET" && h) return handleReport(req, decodeURIComponent(h[1]), url, res);

    if (path === "/health") return send(res, 200, "ok");
    if (path === "/") {
      return send(
        res,
        200,
        "ccmap — coding heatmap for Claude Code + Codex\n\nGET /u/<user>.svg   badge\nGET /u/<user>       HTML report\nPOST /api/claim     claim a name\nPOST /api/push      push aggregates (Bearer <key>)\n",
        { "content-type": "text/plain; charset=utf-8" }
      );
    }
    send(res, 404, "not found");
  } catch (e) {
    send(res, 500, "internal error");
  }
});

server.listen(PORT, () => {
  console.log(`ccmap server on :${PORT} · data=${DATA}${INVITE ? " · invite-gated" : ""}`);
});
