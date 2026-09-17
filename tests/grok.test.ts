import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/parse.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccmap-grok-"));
}

// Local noon, so the day never straddles a timezone boundary during the test.
const MS = new Date(2026, 0, 15, 12, 0, 0).getTime();
const DAY = "2026-01-15";

function turn(promptId: string, usage: unknown, ms = MS): string {
  return JSON.stringify({
    timestamp: Math.floor(ms / 1000),
    method: "_x.ai/session/update",
    params: {
      sessionId: "sess-1",
      update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn", usage },
      _meta: { agentTimestampMs: ms },
    },
  });
}

function usage(over: Record<string, unknown> = {}) {
  const base = {
    inputTokens: 1000, // includes the cached portion, as Grok reports it
    outputTokens: 100,
    totalTokens: 1100,
    cachedReadTokens: 800,
    costUsdTicks: 2_500_000_000, // = $2.50
    ...over,
  };
  return { ...base, modelUsage: { "grok-4.5-build": { ...base } } };
}

function session(root: string, lines: string[], id = "sess-1"): string {
  const dir = join(root, "%2FUsers%2Fme%2Fproj", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "updates.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

// Non-turn traffic the real log is mostly made of, to prove the prefilter and
// the sessionUpdate check both hold.
const NOISE = JSON.stringify({
  timestamp: Math.floor(MS / 1000),
  method: "session/update",
  params: { sessionId: "sess-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "turn_completed appears here as plain text" } } },
});

test("grok turns roll up into tokens, cost and model mix", () => {
  const root = tmp();
  const empty = tmp();
  session(root, [NOISE, turn("p1", usage()), NOISE]);
  const r = scan({ deepseekDir: empty, claudeDir: empty, codexDir: empty, grokDir: root });
  assert.equal(r.totalTokens, 1100);
  assert.equal(r.bySource.grok, 1100);
  assert.equal(r.bySource.claude, 0);
  assert.equal(r.byModel["grok-4.5-build"], 1100);
  // the CLI's own billed figure wins over our price table
  assert.equal(Math.round(r.totalCost * 100) / 100, 2.5);
  assert.equal(r.days.get(DAY)?.sessions.size, 1);
});

test("a repeated prompt_id is counted once", () => {
  const root = tmp();
  const empty = tmp();
  session(root, [turn("p1", usage()), turn("p1", usage()), turn("p2", usage())]);
  const r = scan({ deepseekDir: empty, claudeDir: empty, codexDir: empty, grokDir: root });
  assert.equal(r.totalTokens, 2200);
});

test("a turn with no reported cost falls back to the price table", () => {
  const root = tmp();
  const empty = tmp();
  session(root, [turn("p1", usage({ costUsdTicks: undefined }))]);
  const r = scan({ deepseekDir: empty, claudeDir: empty, codexDir: empty, grokDir: root });
  assert.equal(r.totalTokens, 1100);
  // grok-4.5: 200 fresh in @ $5/M + 100 out @ $25/M + 800 cache read @ $1.25/M
  assert.ok(Math.abs(r.totalCost - (200 * 5 + 100 * 25 + 800 * 1.25) / 1e6) < 1e-9, `got ${r.totalCost}`);
});

test("cancelled turns (no usage) are skipped", () => {
  const root = tmp();
  const empty = tmp();
  session(root, [
    JSON.stringify({
      timestamp: Math.floor(MS / 1000),
      params: { sessionId: "sess-1", update: { sessionUpdate: "turn_completed", prompt_id: "p0" }, _meta: { agentTimestampMs: MS } },
    }),
    turn("p1", usage()),
  ]);
  const r = scan({ deepseekDir: empty, claudeDir: empty, codexDir: empty, grokDir: root });
  assert.equal(r.totalTokens, 1100);
});

test("the scan cache replays an unchanged log and drops deleted ones", () => {
  const root = tmp();
  const empty = tmp();
  const cachePath = join(tmp(), "scan-cache.json");
  const file = session(root, [turn("p1", usage())]);

  const cold = scan({ deepseekDir: empty, claudeDir: empty, codexDir: empty, grokDir: root, cachePath });
  const cached = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.ok(cached.files[file], "the session log should be cached by path");

  // Corrupt the log: a warm scan must not re-read it, so the totals hold.
  writeFileSync(file, "");
  const warmFiles = JSON.parse(readFileSync(cachePath, "utf8")).files;
  assert.equal(warmFiles[file].days[DAY].m["grok-4.5-build"].t, 1100);

  // …but a real size/mtime change does invalidate it.
  const warm = scan({ deepseekDir: empty, claudeDir: empty, codexDir: empty, grokDir: root, cachePath });
  assert.equal(warm.totalTokens, 0);
  assert.equal(cold.totalTokens, 1100);

  // and a log Grok has deleted leaves no cache entry behind
  const gone = scan({ deepseekDir: empty, claudeDir: empty, codexDir: empty, grokDir: empty, cachePath });
  assert.equal(gone.totalTokens, 0);
  assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")).files, {});
});
