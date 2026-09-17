import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, type ScanOptions } from "../src/parse.js";
import { TIME, USAGE, event, header, call, session, zstdFrame } from "./helpers/deepseek-fixture.js";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ccmap-deepseek-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logs = join(root, "logs");
  const empty = join(root, "missing");
  const options: ScanOptions = { claudeDir: empty, codexDir: empty, grokDir: empty, deepseekDir: logs };
  return { root, logs, options };
}

for (const version of [0, 1, 2, 3]) {
  test(`DeepSeek v${version} counts disjoint token buckets once in plain and compressed logs`, t => {
    const { logs, options } = setup(t);
    session(logs, [header(version, "a"), ...call()], "a", version);
    session(logs, [header(version, "b"), ...call()], "b", version, true);
    const r = scan(options);
    assert.equal(r.totalTokens, 2000);
    assert.equal(r.bySource.deepseek, 2000);
    assert.equal(r.byModel["deepseek-flash"], 2000);
    assert.equal([...r.days.values()][0].sessions.size, 2);
    assert.ok(Math.abs(r.totalCost - 2 * (100 * .3 + 800 * .006 + 100 * 1.2) / 1e6) < 1e-12);
    assert.deepEqual(r.warnings, []);
  });
}

test("legacy usage chunks, final messages, retries and cancelled calls are not double counted", t => {
  const { logs, options } = setup(t);
  const key = { turn: 1, step: 1 };
  const rows = [header(), event(0, "step/start", key),
    event(1, "request/context", { provider: "deepseek-official", model: "deepseek-v4-pro" }),
    event(2, "assistant/chunk", { ...key, chunk: { type: "usage", usage: { ...USAGE, inputTokens: 20 } } }),
    event(3, "assistant/chunk", { ...key, chunk: { type: "usage", usage: USAGE } }),
    event(4, "llm/retry", key), event(5, "llm/retry-started", key),
    event(6, "assistant/chunk", { ...key, chunk: { type: "usage", usage: USAGE } }),
    event(7, "assistant/message", { ...key, usage: USAGE, message: {} }),
    event(7, "assistant/message", { ...key, usage: USAGE, message: {} }),
    event(8, "step/end", key),
    event(9, "step/start", { turn: 2, step: 1 }),
    event(10, "assistant/chunk", { turn: 2, step: 1, chunk: { type: "usage", usage: USAGE } }),
    event(11, "turn/end", { turn: 2, reason: "cancelled" }),
  ];
  session(logs, rows);
  assert.equal(scan(options).totalTokens, 3000);
});

test("modern attempt streams use the last usage and message usage takes precedence", t => {
  const { logs, options } = setup(t);
  const stream = [
    { type: "chunk", time: TIME, chunk: { type: "usage", usage: { ...USAGE, inputTokens: 1 } } },
    { type: "chunk", time: TIME + 1, chunk: { type: "usage", usage: USAGE } },
  ];
  session(logs, [header(3), event(0, "step/start", { turn: 1, step: 1 }),
    event(1, "request/context", { provider: "deepseek-official", model: "deepseek-flash" }),
    event(2, "assistant/attempt", { turn: 1, step: 1, stream }),
    event(3, "llm/retry", { turn: 1, step: 1 }),
    event(4, "llm/retry-started", { turn: 1, step: 1 }),
    event(5, "assistant/message", { turn: 1, step: 1, stream, usage: { ...USAGE, inputTokens: 200 },
      message: { source: { provider: "deepseek-official", model: "deepseek-v4-pro" } } }),
  ], "one", 3);
  const r = scan(options);
  assert.equal(r.totalTokens, 2100);
  assert.equal(r.byModel["deepseek-flash"], 1000);
  assert.equal(r.byModel["deepseek-v4-pro"], 1100);
});

test("fork prefixes are excluded in all formats while independent subagent calls count", t => {
  const { logs, options } = setup(t);
  for (const v of [0, 1, 2, 3]) {
    const inherited = v < 2 ? { seedLength: 4 } : { isSeeded: true };
    session(logs, [header(v, `child-${v}`, { parentSession: "parent", ...inherited }),
      ...call(), ...(v < 2 ? [] : [event(4, "session/end-seed", { inherited: true })]),
      ...call(5), event(9, "session/end-seed", {}), ...call(10),
    ], `child-${v}`, v);
  }
  session(logs, [header(0, "subagent", { origin: "subagent", parentSession: "parent" }), ...call()], "subagent");
  assert.equal(scan(options).totalTokens, 9000);
});

test("only the last inherited marker owns the modern fork cut", t => {
  const { logs, options } = setup(t);
  session(logs, [header(3, "fork", { isSeeded: true }), ...call(),
    event(4, "session/end-seed", { inherited: true }), ...call(5),
    event(9, "session/end-seed", { inherited: true }), ...call(10),
  ], "fork", 3);
  assert.equal(scan(options).totalTokens, 1000);
});

test("highest generation and duplicate session copies are counted once", t => {
  const { logs, options } = setup(t);
  session(logs, [header(), ...call()]);
  session(logs, [header(3), ...call(), ...call(4)], "one", 3);
  session(logs, [header(3), ...call(), ...call(4)], "copy", 3);
  const r = scan(options);
  assert.equal(r.totalTokens, 2000);
  assert.ok(r.warnings.length > 0);
});

test("unsupported generations and missing inherited cuts do not fall back or count inherited work", t => {
  const { logs, options } = setup(t);
  session(logs, [header(), ...call()]);
  session(logs, [header(4), ...call()], "one", 4);
  session(logs, [header(3, "seed", { isSeeded: true }), ...call()], "seed", 3);
  const r = scan(options);
  assert.equal(r.totalTokens, 0);
  assert.ok(r.warnings.length >= 2);
});

test("unpriced models preserve tokens and mark incomplete costs through history", t => {
  const { root, logs, options } = setup(t);
  session(logs, [header(), ...call(0, USAGE, "custom-model")]);
  const rollupPath = join(root, "history.json");
  const r = scan({ ...options, rollupPath });
  assert.equal(r.totalTokens, 1000);
  assert.equal(r.totalCost, 0);
  assert.equal(r.unpricedTokens, 1000);
  assert.equal([...r.days.values()][0].src.deepseek.unpricedTokens, 1000);
  const override = scan({ ...options, rollupPath, pricing: { "custom-model": { in: 1, out: 2, cr: .1, cw: 1 } } });
  assert.equal(override.unpricedTokens, 0);
  assert.ok(Math.abs(override.totalCost - .00038) < 1e-12);
  rmSync(logs, { recursive: true });
  assert.equal(scan({ ...options, rollupPath }).totalTokens, 1000);
});

test("invalid usage is diagnosed; missing usage is not estimated", t => {
  const { logs, options } = setup(t);
  session(logs, [header(), ...call(0, { ...USAGE, inputTokens: -1 }),
    ...call(4, { ...USAGE, totalTokens: 999 }), ...call(8, { ...USAGE, reasoningTokens: 101 }),
    ...call(12, undefined), ...call(16, USAGE),
  ]);
  // call's default is a valid usage, so explicitly remove usage for the missing case.
  const file = join(logs, "project/one/session.jsonl");
  const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  delete rows.find(row => row.seq === 14).data.usage;
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const r = scan(options);
  assert.equal(r.totalTokens, 1000);
  assert.ok(r.warnings.length > 0);
});

test("concatenated frames, growing files and truncated tails keep completed usage", t => {
  const { logs, options } = setup(t);
  const file = session(logs, [header(), ...call()], "one", 0, true);
  appendFileSync(file, zstdFrame(call(4).map(row => JSON.stringify(row)).join("\n") + "\n"));
  assert.equal(scan(options).totalTokens, 2000);
  appendFileSync(file, zstdFrame(JSON.stringify(event(8, "step/start", { turn: 1, step: 9 }))).subarray(0, 15));
  const r = scan(options);
  assert.equal(r.totalTokens, 2000);
  assert.ok(r.warnings.length > 0);
});

test("compressed frames spanning read buffers retain their data and UTF-8 lines", t => {
  const { logs, options } = setup(t);
  const rows = [header(), ...call(), event(4, "user/message", { content: "你好🙂".repeat(100000) }), ...call(5)];
  session(logs, rows, "large", 0, true);
  const r = scan(options);
  assert.equal(r.totalTokens, 2000);
  assert.deepEqual(r.warnings, []);
});

test("native compressed multi-frame fixture matches the documented JSONL records", t => {
  const { logs, options } = setup(t);
  // Synthetic fixture encoded with Node's reference Zstandard encoder. Tests
  // only decode it, so the production Node 18 minimum does not need an encoder.
  const compressed = readFileSync(new URL("./fixtures/deepseek-v3.jsonl.zstd", import.meta.url));
  const plain = readFileSync(new URL("./fixtures/deepseek-v3.jsonl", import.meta.url), "utf8");
  const path = session(logs, [], "fixture", 3, true);
  writeFileSync(path, compressed);
  const result = scan(options);
  rmSync(path);
  const plainPath = session(logs, [], "fixture", 3);
  writeFileSync(plainPath, plain);
  assert.deepEqual(scan(options), result);
  assert.equal(result.totalTokens, 1000);
  assert.deepEqual(result.warnings, []);
});

test("DeepSeek cache respects log changes, pricing overrides and parser fingerprints", t => {
  const { root, logs, options } = setup(t);
  const file = session(logs, [header(), ...call()]);
  const cachePath = join(root, "cache.json");
  const cold = scan({ ...options, cachePath });
  assert.deepEqual(scan({ ...options, cachePath }), cold);
  const stale = JSON.parse(readFileSync(`${cachePath}.deepseek`, "utf8"));
  stale.files[file].fingerprint = "old-parser-revision";
  stale.files[file].days = {};
  writeFileSync(`${cachePath}.deepseek`, JSON.stringify(stale));
  assert.deepEqual(scan({ ...options, cachePath }), cold);
  const repriced = scan({ ...options, cachePath, pricing: { deepseek: { in: 1, out: 1, cr: 1, cw: 1 } } });
  assert.equal(repriced.totalCost, .001);
  appendFileSync(file, call(4).map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(scan({ ...options, cachePath }).totalTokens, 2000);
  rmSync(logs, { recursive: true });
  assert.equal(scan({ ...options, cachePath }).totalTokens, 0);
});

test("Grok and DeepSeek cache cleanup preserves the other source's entries", t => {
  const { root, logs, options } = setup(t);
  const deepseekFile = session(logs, [header(), ...call()]);
  const grokDir = join(root, "grok");
  mkdirSync(grokDir);
  const grokFile = join(grokDir, "updates.jsonl");
  const grokRecord = JSON.stringify({
    timestamp: Math.floor(TIME / 1000),
    params: {
      sessionId: "grok-session",
      update: { sessionUpdate: "turn_completed", prompt_id: "p1",
        usage: { inputTokens: 1000, cachedReadTokens: 800, outputTokens: 100, totalTokens: 1100, costUsdTicks: 2_500_000_000 } },
      _meta: { agentTimestampMs: TIME },
    },
  }) + "\n";
  writeFileSync(grokFile, grokRecord);
  const cachePath = join(root, "cache.json");
  const mixedOptions = { ...options, grokDir, cachePath };
  const cold = scan(mixedOptions);
  assert.equal(cold.totalTokens, 2100);
  assert.deepEqual(scan(mixedOptions), cold);
  const grokCache = readFileSync(cachePath, "utf8");
  const deepseekCache = readFileSync(`${cachePath}.deepseek`, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(grokCache).files), [grokFile]);
  assert.deepEqual(Object.keys(JSON.parse(deepseekCache).files), [deepseekFile]);

  rmSync(grokFile);
  assert.equal(scan(mixedOptions).totalTokens, 1000);
  assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")).files, {});
  assert.equal(readFileSync(`${cachePath}.deepseek`, "utf8"), deepseekCache);

  writeFileSync(grokFile, grokRecord);
  scan(mixedOptions);
  const restoredGrokCache = readFileSync(cachePath, "utf8");
  rmSync(deepseekFile);
  assert.equal(scan(mixedOptions).totalTokens, 1100);
  assert.deepEqual(JSON.parse(readFileSync(`${cachePath}.deepseek`, "utf8")).files, {});
  assert.equal(readFileSync(cachePath, "utf8"), restoredGrokCache);
});
