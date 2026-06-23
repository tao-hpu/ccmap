import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRollup,
  saveRollup,
  mergeDays,
  recordToDayStat,
  dayStatToRecord,
  type DayRecord,
} from "../src/rollup.js";
import { scan, type DayStat } from "../src/parse.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ccmap-"));
}

function dayStat(date: string, tokens: number, sessions = 1): DayStat {
  const s = new Set<string>();
  for (let i = 0; i < sessions; i++) s.add(`s${i}`);
  return { date, tokens, cost: tokens / 1000, sessions: s, bySource: { claude: tokens, codex: 0 }, byModel: { m: tokens } };
}
function rec(date: string, tokens: number, sessions = 1): DayRecord {
  return { date, tokens, cost: tokens / 1000, sessions, bySource: { claude: tokens, codex: 0 }, byModel: { m: tokens } };
}

test("recordToDayStat reconstructs session count", () => {
  const d = recordToDayStat(rec("2026-01-01", 100, 3));
  assert.equal(d.sessions.size, 3);
  assert.equal(d.tokens, 100);
});

test("save/load rollup round-trips", () => {
  const path = join(tmp(), "history.json");
  const m = new Map<string, DayRecord>([["2026-01-01", rec("2026-01-01", 100, 2)]]);
  saveRollup(m, path);
  const loaded = loadRollup(path);
  assert.equal(loaded.get("2026-01-01")?.tokens, 100);
  assert.equal(loaded.get("2026-01-01")?.sessions, 2);
});

test("loadRollup tolerates a missing or corrupt file", () => {
  assert.equal(loadRollup(join(tmp(), "nope.json")).size, 0);
  const path = join(tmp(), "bad.json");
  writeFileSync(path, "{not json");
  assert.equal(loadRollup(path).size, 0);
});

test("mergeDays keeps the max-token record per date", () => {
  const live = new Map<string, DayStat>([
    ["2026-01-01", dayStat("2026-01-01", 100)], // live > stored → live wins
    ["2026-01-02", dayStat("2026-01-02", 30)], // live < stored → stored wins
  ]);
  const stored = new Map<string, DayRecord>([
    ["2026-01-01", rec("2026-01-01", 50)],
    ["2026-01-02", rec("2026-01-02", 80)],
    ["2025-12-31", rec("2025-12-31", 200)], // only in stored (pruned from logs) → survives
  ]);
  const merged = mergeDays(live, stored);
  assert.equal(merged.get("2026-01-01")?.tokens, 100);
  assert.equal(merged.get("2026-01-02")?.tokens, 80);
  assert.equal(merged.get("2025-12-31")?.tokens, 200);
});

test("scan persists days and they survive after raw logs are pruned", () => {
  const logDir = tmp();
  const emptyDir = tmp();
  const rollupPath = join(tmp(), "history.json");
  const projDir = join(logDir, "proj");
  mkdirSync(projDir, { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-01-15T10:00:00.000Z",
    sessionId: "s1",
    requestId: "r1",
    message: { id: "m1", model: "claude-sonnet-4-6", usage: { input_tokens: 100, output_tokens: 50 } },
  });
  writeFileSync(join(projDir, "session.jsonl"), line + "\n");

  // first scan sees the live log and freezes it into the rollup
  const r1 = scan({ claudeDir: logDir, codexDir: emptyDir, rollupPath });
  assert.equal(r1.totalTokens, 150);
  const date = [...r1.days.keys()][0];
  assert.ok(date);

  // logs pruned: scan an empty dir — the day must still come from the rollup
  const r2 = scan({ claudeDir: emptyDir, codexDir: emptyDir, rollupPath });
  assert.ok(r2.days.has(date), "pruned day should survive in rollup");
  assert.equal(r2.totalTokens, 150);
});

test("scan without rollupPath stays pure (no merge, no persistence)", () => {
  const emptyDir = tmp();
  const r = scan({ claudeDir: emptyDir, codexDir: emptyDir });
  assert.equal(r.totalTokens, 0);
  assert.equal(r.days.size, 0);
});

test("dayStatToRecord drops session ids to a count", () => {
  const r = dayStatToRecord(dayStat("2026-01-01", 100, 4));
  assert.equal(r.sessions, 4);
  assert.equal(r.bySource.claude, 100);
});
