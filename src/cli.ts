#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { userInfo, homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scan, currentStreak, type ScanResult } from "./parse.js";
import { renderSVG, resolveTheme } from "./render.js";
import { renderReport } from "./report.js";
import type { DayStat } from "./parse.js";
import { loadConfig, saveConfig, CONFIG_PATH, type Config } from "./config.js";

// Read from package.json at runtime so the version never drifts from npm.
// dist/cli.js lives one level under the package root, next to package.json.
const VERSION: string = (() => {
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkg, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const PKG = "@tao-hpu/ccmap"; // npm package name (scoped; the CLI command is still `ccmap`)
// Public service URL baked in so newcomers can `ccmap push` with zero setup.
// Override with the CCMAP_ENDPOINT env var or `ccmap login --endpoint <url>`.
const DEFAULT_ENDPOINT = process.env.CCMAP_ENDPOINT ?? "https://ccmap.fim.ai";

// Public usernames are restricted to a URL-safe slug (they appear in /u/<name>.svg).
function cleanName(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 39);
}

function deriveUsername(): string {
  let name = "user";
  try {
    name = userInfo().username || "user";
  } catch {}
  return cleanName(name) || "user";
}

// Minimal one-line prompt (only used on an interactive TTY).
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
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

// Ask npm itself for the latest version rather than fetch()ing the registry
// directly: `npm` honors the user's proxy/registry config (HTTP_PROXY, .npmrc),
// while Node's global fetch ignores it and fails behind a corporate proxy/VPN.
function latestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn("npm", ["view", PKG, "version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
    p.on("error", () => resolve(null));
  });
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
  // default: no border, square corners (opt in with --border / --rounded;
  // --hide-border kept as a no-op alias since border is now off by default)
  const border = args.includes("--border");
  const rounded = args.includes("--rounded");
  const res = scan({ pricing: cfg.pricing });
  const svg = renderSVG(
    res.days,
    { totalTokens: res.totalTokens, totalCost: res.totalCost, streak: currentStreak(res.days) },
    { weeks, metric, theme, anim, border, rounded, title: cfg.user ? `${cfg.user} · coding heatmap` : "Coding heatmap" }
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
async function ensureOnboarded(cfg: Config, explicitUser?: string): Promise<Config | null> {
  if (cfg.user && cfg.token && cfg.endpoint) return cfg;
  const endpoint = cfg.endpoint || DEFAULT_ENDPOINT;
  if (!endpoint) {
    console.error("No badge endpoint configured. Point at a server with:");
    console.error("  ccmap login --user <name> --endpoint <url>");
    return null;
  }
  // Name precedence: --user flag > CCMAP_USER env > saved config > OS username.
  const override = cleanName(explicitUser || process.env.CCMAP_USER || "");
  const fallback = override || cfg.user || deriveUsername();
  const key = cfg.token || randomBytes(24).toString("hex");

  // The name is public and permanent (it's in your badge URL, no rename in v0),
  // so on a first interactive run confirm it up front instead of silently taking
  // the OS username. Non-TTY (CI, pipes, `start` in background) keeps the default.
  const interactive = !override && !cfg.user && !!process.stdin.isTTY && !!process.stdout.isTTY;
  let user = fallback;
  if (interactive) {
    console.log("This name is public and goes in your badge URL: <host>/u/<name>.svg");
    const ans = cleanName(await promptLine(`Pick your ccmap username [${fallback}]: `));
    user = ans || fallback;
  }

  let res = await claimName(endpoint, user, key);
  while (interactive && res.status === 409) {
    const ans = cleanName(await promptLine(`"${user}" is already taken — try another (blank to give up): `));
    if (!ans) break;
    user = ans;
    res = await claimName(endpoint, user, key);
  }
  if (res.status === 409) {
    console.error(`name "${user}" is taken. Pick another:`);
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
  const base = endpoint.replace(/\/$/, "");
  console.log(`✓ claimed "${user}"  ·  badge ${base}/u/${user}.svg`);
  if (!interactive) console.log(`  not the name you want? change it: ccmap login --user <name>`);
  return cfg;
}

function postAggregates(base: string, token: string | undefined, payload: unknown) {
  return fetch(base + "/api/push", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
}

async function cmdPush(cfgIn: Config, hint = false, explicitUser?: string) {
  const cfg = await ensureOnboarded(cfgIn, explicitUser);
  if (!cfg) process.exit(1);
  if (explicitUser && cleanName(explicitUser) !== cfg.user) {
    console.log(`note: already configured as "${cfg.user}". To switch names: ccmap login --user ${cleanName(explicitUser)}`);
  }
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
    if (hint) {
      console.log(`\n💡 want to embed it in GitHub / X? open the report above — copy-paste\n   snippets (incl. auto light/dark for GitHub) are at the bottom.`);
    }
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

function humanInterval(min: number): string {
  if (min % 1440 === 0) return min / 1440 === 1 ? "day" : `${min / 1440} days`;
  if (min % 60 === 0) return min / 60 === 1 ? "hour" : `${min / 60}h`;
  return `${min} min`;
}

// ---- daemon: OS-level scheduling (launchd on macOS, cron elsewhere) ----
// A once-a-day push doesn't warrant a resident process, so `ccmap start` registers
// a scheduled job instead. It survives logout/reboot natively — no `save` needed.
const SCHED_LABEL = "ai.ccmap.push";
const CRON_BEGIN = "# >>> ccmap >>>";
const CRON_END = "# <<< ccmap <<<";

function daemonLog(): string {
  return join(dirname(CONFIG_PATH), "daemon.log");
}
function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${SCHED_LABEL}.plist`);
}
function cliEntry(): string {
  return fileURLToPath(import.meta.url);
}
// cron can't express arbitrary minute intervals > 1h cleanly; map sensibly.
function cronExpr(min: number): string {
  if (min < 60) return `*/${Math.max(1, min)} * * * *`;
  if (min < 1440 && min % 60 === 0) return `0 */${min / 60} * * *`;
  return `0 9 * * *`; // daily at 09:00
}

function readCrontab(): string {
  const r = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}
function writeCrontab(content: string): void {
  const r = spawnSync("crontab", ["-"], { input: content.trim() === "" ? "\n" : content });
  if (r.status !== 0) throw new Error("crontab write failed");
}
function stripCcmapBlock(s: string): string {
  const re = new RegExp(`${CRON_BEGIN}[\\s\\S]*?${CRON_END}\\n?`, "g");
  return s.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

function installSchedule(cfg: Config): string {
  const node = process.execPath;
  const cli = cliEntry();
  const log = daemonLog();
  const min = cfg.intervalMin ?? 1440;
  try { mkdirSync(dirname(log), { recursive: true }); } catch {}

  if (process.platform === "darwin") {
    const p = plistPath();
    try { mkdirSync(dirname(p), { recursive: true }); } catch {}
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SCHED_LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${cli}</string><string>push</string></array>
  <key>StartInterval</key><integer>${min * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
    writeFileSync(p, plist);
    spawnSync("launchctl", ["unload", p], { stdio: "ignore" });
    const r = spawnSync("launchctl", ["load", p], { stdio: "ignore" });
    if (r.status !== 0) throw new Error("launchctl load failed");
    return "launchd";
  }

  // Linux / other: cron (@reboot for boot + recurring schedule)
  const block = [
    CRON_BEGIN,
    `@reboot ${node} ${cli} push >> ${log} 2>&1`,
    `${cronExpr(min)} ${node} ${cli} push >> ${log} 2>&1`,
    CRON_END,
  ].join("\n");
  const cleaned = stripCcmapBlock(readCrontab()).replace(/\s*$/, "");
  writeCrontab(`${cleaned ? cleaned + "\n\n" : ""}${block}\n`);
  return "cron";
}

function removeSchedule(): boolean {
  if (process.platform === "darwin") {
    const p = plistPath();
    if (!existsSync(p)) return false;
    spawnSync("launchctl", ["unload", p], { stdio: "ignore" });
    try { unlinkSync(p); } catch {}
    return true;
  }
  const cur = readCrontab();
  if (!cur.includes(CRON_BEGIN)) return false;
  writeCrontab(stripCcmapBlock(cur));
  return true;
}
function scheduleActive(): boolean {
  return process.platform === "darwin" ? existsSync(plistPath()) : readCrontab().includes(CRON_BEGIN);
}

async function cmdStart(cfg: Config, args: string[]) {
  if (args.includes("--foreground") || args.includes("-f")) return cmdStartForeground(cfg);
  // push once now for instant feedback (also validates onboarding/config)
  process.stdout.write("first push… ");
  const ok = await cmdPush(cfg, false);
  if (!ok) {
    console.error("\nnot scheduling until a push succeeds — fix the error above and re-run `ccmap start`.");
    process.exit(1);
  }
  let how: string;
  try {
    how = installSchedule(cfg);
  } catch (e) {
    console.error(`\ncould not register the scheduler (${(e as Error).message}).`);
    console.error("run it attached instead:  ccmap start --foreground");
    process.exit(1);
  }
  const min = cfg.intervalMin ?? 1440;
  console.log(`\n✓ scheduled via ${how} — pushes every ${humanInterval(min)}, survives logout/reboot.`);
  console.log(`  no terminal needed. logs: ${daemonLog()}`);
  console.log(`  stop: ccmap stop   ·   status: ccmap status`);
}

// The old attached loop, kept for containers / debugging via `ccmap start --foreground`.
async function cmdStartForeground(cfg: Config) {
  const min = cfg.intervalMin ?? 1440;
  console.log(`ccmap daemon (foreground) — pushing every ${humanInterval(min)}. Ctrl-C to stop.`);
  let first = true;
  const tick = async () => {
    const ts = new Date().toLocaleTimeString();
    process.stdout.write(`[${ts}] `);
    await cmdPush(cfg, first);
    first = false;
  };
  await tick();
  setInterval(tick, min * 60 * 1000);
  await checkUpdateNotice(cfg);
  setInterval(() => void checkUpdateNotice(cfg), 24 * 60 * 60 * 1000);
}

function cmdStop() {
  if (removeSchedule()) console.log("✓ stopped — ccmap will no longer push on a schedule.");
  else console.log("nothing to stop (no ccmap schedule was installed).");
}

function cmdStatus(cfg: Config) {
  const active = scheduleActive();
  const min = cfg.intervalMin ?? 1440;
  console.log(`schedule: ${active ? `active (${process.platform === "darwin" ? "launchd" : "cron"}, every ${humanInterval(min)})` : "not running"}`);
  if (active) console.log(`  ${process.platform === "darwin" ? plistPath() : "crontab block"}`);
  console.log(`user:     ${cfg.user ?? "(unset)"}`);
  console.log(`endpoint: ${cfg.endpoint ?? DEFAULT_ENDPOINT}`);
  if (existsSync(daemonLog())) {
    const lines = readFileSync(daemonLog(), "utf8").trim().split("\n");
    if (lines[0]) console.log(`last log: ${lines[lines.length - 1]}`);
  }
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
                [--metric tokens|cost] [--weeks 26] [--border] [--rounded]
                [--theme claude|github-dark|github-light|tokyo-night|dracula|nord]
                [--anim none|ember|wave|cascade]
  ccmap report [--out f.html]      Render a full shareable HTML report locally
  ccmap login --user <name> --endpoint <url> [--invite <code>]
                                   Claim a specific username (optional — push auto-claims).
  ccmap push [--user <name>]       Push aggregates. First run picks a username
                                   (prompts on a terminal; --user / CCMAP_USER to set it)
  ccmap start [--foreground]       Schedule pushes via launchd/cron (survives reboot,
                                   no terminal needed). --foreground runs an attached loop.
  ccmap stop                       Remove the scheduled job
  ccmap status                     Show schedule + last push
  ccmap config [--interval <min>] [--metric tokens|cost] [--theme dark|light]
                                   (--interval is minutes between scheduled pushes; default 1440 = daily)
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
      await cmdPush(cfg, true, argVal(args, "--user"));
      break;
    case "start":
      await cmdStart(cfg, args);
      break;
    case "stop":
      cmdStop();
      break;
    case "status":
      cmdStatus(cfg);
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
