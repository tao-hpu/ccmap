#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { scan, currentStreak, type ScanResult } from "./parse.js";
import { renderSVG, resolveTheme } from "./render.js";
import { renderReport } from "./report.js";
import type { DayStat } from "./parse.js";
import { loadConfig, saveConfig, CONFIG_PATH, type Config } from "./config.js";

const VERSION = "0.1.0";
const PKG = "ccmap"; // npm package name — change to "@you/ccmap" if scoped
// Public service URL baked in so newcomers can `ccmap push` with zero setup.
// Set this to your deployed Worker (e.g. https://ccmap.fim.ai) before publishing.
const DEFAULT_ENDPOINT = process.env.CCMAP_ENDPOINT ?? "";

function deriveUsername(): string {
  let name = "user";
  try {
    name = userInfo().username || "user";
  } catch {}
  const clean = name.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 39);
  return clean || "user";
}

interface ClaimResult {
  ok: boolean;
  status: number;
  body: any;
}
async function claimName(endpoint: string, user: string, key: string, invite?: string): Promise<ClaimResult> {
  const url = endpoint.replace(/\/$/, "") + "/api/claim";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(invite ? { "x-invite": invite } : {}) },
      body: JSON.stringify({ user, key }),
    });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, status: 0, body: { error: (e as Error).message } };
  }
}

function cmpVer(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

async function latestVersion(): Promise<string | null> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${PKG}/latest`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { version?: string };
    return j.version ?? null;
  } catch {
    return null;
  }
}

function runNpmUpdate(): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("npm", ["install", "-g", `${PKG}@latest`], { stdio: "inherit" });
    p.on("close", (code) => resolve(code ?? 1));
    p.on("error", () => resolve(1));
  });
}

async function cmdUpdate() {
  const latest = await latestVersion();
  if (!latest) {
    console.error("could not reach npm registry");
    process.exit(1);
  }
  if (cmpVer(latest, VERSION) <= 0) {
    console.log(`ccmap is up to date (${VERSION})`);
    return;
  }
  console.log(`updating ccmap ${VERSION} → ${latest} ...`);
  const code = await runNpmUpdate();
  if (code === 0) console.log("updated. re-run your command (restart `ccmap start` if it was running).");
  else {
    console.error("update failed. try manually:  npm i -g " + PKG + "@latest");
    process.exit(code);
  }
}

function buildPayload(res: ScanResult, cfg: Config) {
  const days = [...res.days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      tokens: d.tokens,
      cost: Math.round(d.cost * 100) / 100,
      claude: d.bySource.claude,
      codex: d.bySource.codex,
      sessions: d.sessions.size,
    }));
  return {
    v: VERSION,
    user: cfg.user,
    generatedAt: new Date().toISOString(),
    totals: {
      tokens: res.totalTokens,
      cost: Math.round(res.totalCost * 100) / 100,
      streak: currentStreak(res.days),
      bySource: res.bySource,
    },
    byModel: res.byModel, // tokens per model (no content, no project names)
    days,
  };
}

function pct(part: number, total: number) {
  return total ? ((part / total) * 100).toFixed(0) + "%" : "0%";
}

function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function blk(hex: string): string {
  const [r, g, b] = hexRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m  \x1b[0m`;
}

// ANSI true-color heatmap for the terminal (mirrors the SVG grid).
function termHeatmap(days: Map<string, DayStat>, theme: string, metric: "tokens" | "cost", weeks = 26): string {
  const c = resolveTheme(theme);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks - 1) * 7 - today.getDay());
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const valOf = (k: string) => {
    const ds = days.get(k);
    return ds ? (metric === "cost" ? ds.cost : ds.tokens) : 0;
  };
  const vals: number[] = [];
  for (const cur = new Date(start); cur <= today; cur.setDate(cur.getDate() + 1)) {
    const v = valOf(key(cur));
    if (v > 0) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const q = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0);
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  const lvl = (v: number) => (v <= 0 ? -1 : v <= t1 ? 0 : v <= t2 ? 1 : v <= t3 ? 2 : 3);

  const rows = ["", "", "", "", "", "", ""];
  let row = start.getDay();
  for (const cur = new Date(start); cur <= today; cur.setDate(cur.getDate() + 1)) {
    const l = lvl(valOf(key(cur)));
    rows[row] += blk(l < 0 ? c.empty : c.scale[l]);
    row = (row + 1) % 7;
  }
  const legend = `  less ${c.scale.map(blk).join("")} more`;
  return rows.join("\n") + "\n" + legend;
}

function sparkline(days: Map<string, DayStat>, n = 30): string {
  const chars = " ▁▂▃▄▅▆▇█";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const series: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    series.push(days.get(k)?.tokens ?? 0);
  }
  const max = Math.max(1, ...series);
  return series.map((v) => chars[Math.round((v / max) * (chars.length - 1))]).join("");
}

function cmdScan(cfg: Config) {
  const res = scan({ pricing: cfg.pricing });
  const streak = currentStreak(res.days);
  console.log(`ccmap ${VERSION} — local scan`);
  console.log(`  range:    ${res.firstDay ?? "-"} → ${res.lastDay ?? "-"}  (${res.days.size} active days)`);
  console.log(`  tokens:   ${res.totalTokens.toLocaleString()}`);
  console.log(`  cost~:    $${res.totalCost.toFixed(2)}  (estimate)`);
  console.log(`  streak:   ${streak} day(s)`);
  console.log(`  source:   claude ${pct(res.bySource.claude, res.totalTokens)} · codex ${pct(res.bySource.codex, res.totalTokens)}`);
  const top = Object.entries(res.byModel).sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`  models:`);
  for (const [m, v] of top) console.log(`    ${m.padEnd(28)} ${pct(v, res.totalTokens).padStart(4)}  ${v.toLocaleString()}`);

  // graphical render (only on an interactive terminal, unless --no-graph)
  if (process.stdout.isTTY && !process.argv.includes("--no-graph")) {
    const theme = cfg.theme ?? "claude";
    console.log(`\n  30-day tokens  ${sparkline(res.days)}`);
    console.log("");
    for (const line of termHeatmap(res.days, theme, (cfg.metric as any) ?? "tokens").split("\n")) {
      console.log("  " + line);
    }
  }
}

function cmdRender(cfg: Config, args: string[]) {
  const out = argVal(args, "--out") ?? "ccmap.svg";
  const metric = (argVal(args, "--metric") as "tokens" | "cost") ?? cfg.metric ?? "tokens";
  const weeks = Number(argVal(args, "--weeks") ?? cfg.weeks ?? 26);
  const theme = argVal(args, "--theme") ?? cfg.theme ?? "claude";
  const anim = argVal(args, "--anim") ?? "none";
  const border = !args.includes("--hide-border");
  const res = scan({ pricing: cfg.pricing });
  const svg = renderSVG(
    res.days,
    { totalTokens: res.totalTokens, totalCost: res.totalCost, streak: currentStreak(res.days) },
    { weeks, metric, theme, anim, border, title: cfg.user ? `${cfg.user} · coding heatmap` : "Coding heatmap" }
  );
  writeFileSync(out, svg);
  console.log(`wrote ${out}  (${metric}, ${weeks}w, ${theme})`);
}

function cmdReport(cfg: Config, args: string[]) {
  const out = argVal(args, "--out") ?? "ccmap-report.html";
  const theme = argVal(args, "--theme") ?? cfg.theme ?? "claude";
  const res = scan({ pricing: cfg.pricing });
  const payload = buildPayload(res, cfg);
  const html = renderReport({ user: cfg.user, totals: payload.totals, byModel: payload.byModel, days: payload.days }, { theme, origin: cfg.endpoint });
  writeFileSync(out, html);
  console.log(`wrote ${out}  (open in a browser)`);
}

async function cmdLogin(args: string[]) {
  const cfg = loadConfig();
  const user = argVal(args, "--user") ?? cfg.user;
  const endpoint = argVal(args, "--endpoint") ?? cfg.endpoint;
  const invite = argVal(args, "--invite");
  if (!user || !endpoint) {
    console.error("usage: ccmap login --user <name> --endpoint <url> [--invite <code>]");
    process.exit(1);
  }
  // reuse existing key if re-logging in as the same user, else mint a new one
  const key = cfg.user === user && cfg.token ? cfg.token : randomBytes(24).toString("hex");
  const res = await claimName(endpoint, user, key, invite);
  if (!res.ok) {
    console.error(`login failed: ${res.status} ${res.body.error ?? ""}`);
    if (res.status === 409) console.error("that username is taken — pick another with --user");
    process.exit(1);
  }
  cfg.user = user;
  cfg.endpoint = endpoint;
  cfg.token = key;
  saveConfig(cfg);
  console.log(`logged in as "${user}" ${res.body.claimed ? "(name claimed)" : "(already yours)"}`);
  console.log(`badge:  ${endpoint.replace(/\/$/, "")}/u/${user}.svg`);
  console.log(`next:   ccmap push   (or)   ccmap start`);
}

// One-stop: if not configured, auto-claim a name silently so `ccmap push` just works.
async function ensureOnboarded(cfg: Config): Promise<Config | null> {
  if (cfg.user && cfg.token && cfg.endpoint) return cfg;
  const endpoint = cfg.endpoint || DEFAULT_ENDPOINT;
  if (!endpoint) {
    console.error("no endpoint set. Either this build has no default service, or run once:");
    console.error("  ccmap login --user <name> --endpoint <url>");
    return null;
  }
  const user = cfg.user || deriveUsername();
  const key = cfg.token || randomBytes(24).toString("hex");
  const res = await claimName(endpoint, user, key);
  if (res.status === 409) {
    console.error(`auto-picked name "${user}" is taken. Choose your own once:`);
    console.error(`  ccmap login --user <name> --endpoint ${endpoint}`);
    return null;
  }
  if (!res.ok) {
    console.error(`onboarding failed: ${res.status} ${res.body.error ?? ""}`);
    return null;
  }
  cfg.user = user;
  cfg.endpoint = endpoint;
  cfg.token = key;
  saveConfig(cfg);
  console.log(`first run — claimed "${user}"  ·  badge ${endpoint.replace(/\/$/, "")}/u/${user}.svg`);
  return cfg;
}

function postAggregates(base: string, token: string | undefined, payload: unknown) {
  return fetch(base + "/api/push", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
}

async function cmdPush(cfgIn: Config) {
  const cfg = await ensureOnboarded(cfgIn);
  if (!cfg) process.exit(1);
  const res = scan({ pricing: cfg.pricing });
  const payload = buildPayload(res, cfg);
  const base = (cfg.endpoint ?? "").replace(/\/$/, "");
  try {
    let r = await postAggregates(base, cfg.token, payload);
    // self-heal: if the server lost our claim (e.g. KV reset), re-claim with our
    // stored key and retry once.
    if (r.status === 403 && cfg.user && cfg.token) {
      const c = await claimName(base, cfg.user, cfg.token);
      if (c.ok) r = await postAggregates(base, cfg.token, payload);
    }
    if (!r.ok) {
      console.error(`push failed: ${r.status} ${await r.text()}`);
      return false;
    }
    console.log(`pushed ${payload.days.length} days · ${res.totalTokens.toLocaleString()} tok → ${base}/api/push`);
    console.log(`badge:  ${base}/u/${cfg.user}.svg`);
    console.log(`report: ${base}/u/${cfg.user}`);
    return true;
  } catch (e) {
    console.error(`push error: ${(e as Error).message}`);
    return false;
  }
}

async function checkUpdateNotice(cfg: Config) {
  const latest = await latestVersion();
  if (!latest || cmpVer(latest, VERSION) <= 0) return;
  if (cfg.autoUpdate) {
    console.log(`[ccmap] auto-updating ${VERSION} → ${latest} ...`);
    const code = await runNpmUpdate();
    console.log(code === 0 ? "[ccmap] updated — restart `ccmap start` to apply." : "[ccmap] auto-update failed.");
  } else {
    console.log(`[ccmap] update available: ${VERSION} → ${latest}. Run \`ccmap update\` (or set autoUpdate:true).`);
  }
}

async function cmdStart(cfg: Config) {
  const min = cfg.intervalMin ?? 15;
  console.log(`ccmap daemon — pushing every ${min} min. Ctrl-C to stop.`);
  const tick = async () => {
    const ts = new Date().toLocaleTimeString();
    process.stdout.write(`[${ts}] `);
    await cmdPush(cfg);
  };
  await tick();
  setInterval(tick, min * 60 * 1000);
  // check for a new version once now and then daily
  await checkUpdateNotice(cfg);
  setInterval(() => void checkUpdateNotice(cfg), 24 * 60 * 60 * 1000);
}

function cmdConfig(args: string[]) {
  const cfg = loadConfig();
  const keys: (keyof Config)[] = ["user", "endpoint", "token", "metric", "theme"];
  let changed = false;
  for (const k of keys) {
    const v = argVal(args, `--${k}`);
    if (v !== undefined) {
      (cfg as any)[k] = v;
      changed = true;
    }
  }
  const iv = argVal(args, "--interval");
  if (iv !== undefined) {
    cfg.intervalMin = Number(iv);
    changed = true;
  }
  const wk = argVal(args, "--weeks");
  if (wk !== undefined) {
    cfg.weeks = Number(wk);
    changed = true;
  }
  if (changed) {
    saveConfig(cfg);
    console.log(`saved ${CONFIG_PATH}`);
  }
  const redacted = { ...cfg, token: cfg.token ? "***" : undefined };
  console.log(JSON.stringify(redacted, null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}

function help() {
  console.log(`ccmap ${VERSION} — coding heatmap for Claude Code + Codex

Usage:
  ccmap scan                       Summarize local usage (no upload)
  ccmap render [--out f.svg]       Render a heatmap SVG locally
                [--metric tokens|cost] [--weeks 26] [--hide-border]
                [--theme claude|github-dark|github-light|tokyo-night|dracula|nord]
                [--anim none|ember|wave|cascade]
  ccmap report [--out f.html]      Render a full shareable HTML report locally
  ccmap login --user <name> --endpoint <url> [--invite <code>]
                                   Claim a specific username (optional — push auto-claims).
  ccmap push                       Push aggregates (first run auto-claims a name)
  ccmap start                      Resident: push on an interval
  ccmap config [--interval 15] [--metric tokens|cost] [--theme dark|light]
  ccmap update                     Self-update to the latest published version
  ccmap version

Privacy: only per-day token/cost counts and model names leave your machine.
Never your prompts, code, or project names. Config: ${CONFIG_PATH}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  switch (cmd) {
    case "scan":
      cmdScan(cfg);
      break;
    case "render":
      cmdRender(cfg, args);
      break;
    case "report":
      cmdReport(cfg, args);
      break;
    case "login":
      await cmdLogin(args);
      break;
    case "push":
      await cmdPush(cfg);
      break;
    case "start":
      await cmdStart(cfg);
      break;
    case "config":
      cmdConfig(args);
      break;
    case "update":
    case "upgrade":
      await cmdUpdate();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      help();
      process.exit(1);
  }
}

main();
