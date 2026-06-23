import { renderSVG } from "../../src/render.js";
import { renderReport } from "../../src/report.js";

export interface Env {
  USERS: KVNamespace;
  // Optional invite gate: if set, /api/claim requires header `x-invite: <PUSH_SECRET>`.
  // Leave unset for a fully open service (anyone can `ccmap login`).
  PUSH_SECRET?: string;
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(req: Request): string {
  const a = req.headers.get("authorization") || "";
  return a.startsWith("Bearer ") ? a.slice(7) : "";
}

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

const USER_RE = /^[a-zA-Z0-9_-]{1,39}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
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

// Claim a username. Stores sha256(key) under auth:<user>. Idempotent for the holder.
async function handleClaim(req: Request, env: Env): Promise<Response> {
  if (env.PUSH_SECRET && req.headers.get("x-invite") !== env.PUSH_SECRET) {
    return json({ error: "invite required" }, 403);
  }
  let body: { user?: string; key?: string };
  try {
    body = (await req.json()) as any;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const user = (body.user || "").trim();
  const key = body.key || "";
  if (!USER_RE.test(user)) return json({ error: "invalid user (use a-z 0-9 _ -, 1-39 chars)" }, 400);
  if (key.length < 16) return json({ error: "key too short" }, 400);
  const hash = await sha256hex(key);
  const existing = await env.USERS.get(`auth:${user}`);
  if (existing && existing !== hash) return json({ error: "username taken" }, 409);
  if (!existing) await env.USERS.put(`auth:${user}`, hash);
  return json({ ok: true, user, badge: `/u/${user}.svg`, claimed: !existing });
}

async function handlePush(req: Request, env: Env): Promise<Response> {
  let p: PushPayload;
  try {
    p = (await req.json()) as PushPayload;
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!p.user || !USER_RE.test(p.user)) return json({ error: "invalid user" }, 400);
  // per-user auth: bearer key must hash to the stored claim
  const expected = await env.USERS.get(`auth:${p.user}`);
  if (!expected) return json({ error: "user not claimed — run `ccmap login` first" }, 403);
  if ((await sha256hex(bearer(req))) !== expected) return json({ error: "bad token" }, 401);
  if (!Array.isArray(p.days)) return json({ error: "missing days" }, 400);
  // store; cap days to keep value small
  p.days = p.days.slice(-400);
  await env.USERS.put(`user:${p.user}`, JSON.stringify(p));
  return json({
    ok: true,
    user: p.user,
    days: p.days.length,
    badge: `/u/${p.user}.svg`,
  });
}

async function handleBadge(user: string, url: URL, env: Env): Promise<Response> {
  if (!USER_RE.test(user)) return new Response("bad user", { status: 400 });
  const raw = await env.USERS.get(`user:${user}`);
  if (!raw) return new Response("not found", { status: 404 });
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
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}

async function handleReport(user: string, url: URL, env: Env): Promise<Response> {
  if (!USER_RE.test(user)) return new Response("bad user", { status: 400 });
  const raw = await env.USERS.get(`user:${user}`);
  if (!raw) return new Response("not found", { status: 404 });
  const p = JSON.parse(raw) as PushPayload;
  const theme = url.searchParams.get("theme") || "claude";
  const html = renderReport(
    { user, totals: p.totals, byModel: p.byModel, days: p.days },
    { theme, origin: url.origin }
  );
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && path === "/api/claim") return handleClaim(req, env);
    if (req.method === "POST" && path === "/api/push") return handlePush(req, env);

    const m = path.match(/^\/u\/([^/]+)\.svg$/);
    if (req.method === "GET" && m) return handleBadge(decodeURIComponent(m[1]), url, env);

    // HTML report: /u/<user> or /u/<user>.html
    const h = path.match(/^\/u\/([^/]+?)(?:\.html)?$/);
    if (req.method === "GET" && h) return handleReport(decodeURIComponent(h[1]), url, env);

    if (path === "/") {
      return new Response(
        "ccmap — coding heatmap for Claude Code + Codex\n\nGET /u/<user>.svg   badge\nPOST /api/push       push aggregates (Bearer PUSH_SECRET)\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
};
