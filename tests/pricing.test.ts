import assert from "node:assert/strict";
import test from "node:test";
import { costOf, priceFor, type Price } from "../src/pricing.js";

test("matches Codex model prices before the gpt-5 fallback", () => {
  assert.deepEqual(priceFor("gpt-5.3-codex"), {
    in: 1.75,
    out: 14,
    cw: 0,
    cr: 0.175,
    cw1h: 0,
  });
  assert.deepEqual(priceFor("gpt-5.2-codex"), priceFor("gpt-5.2"));
  assert.equal(priceFor("gpt-5.4").out, 15);
  assert.equal(priceFor("gpt-5.5").in, 5);
  assert.equal(priceFor("gpt-5.5").cw, 0);
  assert.equal(priceFor("gpt-5.6-sol").cr, 0.4);
  assert.equal(priceFor("gpt-5.6-sol").cw, 5);
  assert.equal(priceFor("gpt-5.6-terra").out, 12);
  assert.equal(priceFor("gpt-5.6-terra").cw, 2.5);
  assert.equal(priceFor("gpt-5.6-luna").in, 0.2);
  assert.equal(priceFor("gpt-5.6-luna").cw, 0.25);
  assert.equal(priceFor("gpt-6-astra").out, 50);
  assert.equal(priceFor("gpt-6-astra").cw, 12.5);
});

test("matches the built-in Codex price table", () => {
  const prices: Record<string, [number, number, number, number]> = {
    "gpt-6-astra": [10, 1, 12.5, 50],
    "gpt-6.1-sol": [2, 0.1, 2.5, 10],
    "gpt-6-sol": [2, 0.2, 2.5, 10],
    "gpt-6-luna": [0.1, 0.01, 0.125, 0.5],
    "gpt-5.6-sol": [4, 0.4, 5, 20],
    "gpt-5.6-terra": [2, 0.2, 2.5, 12],
    "gpt-5.6-luna": [0.2, 0.02, 0.25, 1.2],
    "gpt-5.5": [5, 0.5, 0, 30],
    "gpt-5.4": [2.5, 0.25, 0, 15],
    "gpt-5.4-mini": [0.75, 0.075, 0, 4.5],
    "gpt-5.2": [1.75, 0.175, 0, 14],
    "gpt-5.1": [1.25, 0.125, 0, 10],
    "gpt-5": [1.25, 0.125, 0, 10],
  };
  for (const [model, [input, cached, writes, output]] of Object.entries(prices)) {
    assert.deepEqual(
      priceFor(model),
      { in: input, out: output, cw: writes, cr: cached, cw1h: writes },
      model
    );
  }
});

test("matches the built-in Grok price table", () => {
  const prices: Record<string, [number, number, number]> = {
    "grok-4.7": [2, 0.5, 6],
    "grok-4.6": [2, 0.5, 6],
    "grok-4.5": [2, 0.3, 6],
  };
  for (const [model, [input, cached, output]] of Object.entries(prices)) {
    assert.deepEqual(
      priceFor(model),
      { in: input, out: output, cw: input, cr: cached, cw1h: input },
      model
    );
  }
});

test("uses gpt-5 pricing as the fallback for unknown GPT-5 variants", () => {
  assert.deepEqual(priceFor("gpt-5-experimental"), priceFor("gpt-5"));
});

test("does not inherit built-in prices for API-only OpenAI models", () => {
  const fallback = {
    in: 3,
    out: 15,
    cw: 3.75,
    cr: 0.3,
    cw1h: 6,
  };
  for (const model of [
    "gpt-4o",
    "gpt-5-pro",
    "gpt-5-mini",
    "gpt-5.2-pro",
    "gpt-5.4-pro",
    "gpt-5.4-nano",
    "gpt-5.5-pro",
    "gpt-5.5-cyber",
    "gpt-5.6-cyber",
    "gpt-5-search-api",
  ]) {
    assert.deepEqual(priceFor(model), fallback, model);
  }
});

test("calculates input, output, and cached input costs", () => {
  const cost = costOf("gpt-6-astra", {
    input: 1_000_000,
    output: 100_000,
    cacheWrite: 1_000_000,
    cacheRead: 500_000,
  });
  assert.equal(cost, 28);
});

test("config pricing overrides take precedence over built-in prices", () => {
  const override: Price = { in: 9, out: 8, cw: 7, cr: 6, cw1h: 5 };
  assert.deepEqual(priceFor("gpt-5.3-codex", { "gpt-5.3-codex": override }), override);
  assert.deepEqual(priceFor("gpt-5.3-codex", { "gpt-5": override }), override);
  assert.deepEqual(priceFor("gpt-5.4-pro", { "gpt-5.4-pro": override }), override);
  assert.equal(
    costOf(
      "gpt-5.3-codex",
      { input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 },
      { "gpt-5.3-codex": override }
    ),
    9
  );
});

test("prices each Claude version at its own list rate", () => {
  // [in, out, 5m cache write, cache read, 1h cache write]
  const prices: Record<string, [number, number, number, number, number]> = {
    "claude-fable-5-1": [10, 50, 12.5, 0.25, 20],
    "claude-fable-5": [10, 50, 12.5, 1, 20],
    "claude-mythos-5-1": [10, 50, 12.5, 0.25, 20],
    "claude-mythos-5": [10, 50, 12.5, 1, 20],
    "claude-opus-5-5": [4, 20, 5, 0.2, 8],
    "claude-opus-5": [5, 25, 6.25, 0.5, 10],
    "claude-opus-4-8": [5, 25, 6.25, 0.5, 10],
    "claude-opus-4-7": [5, 25, 6.25, 0.5, 10],
    "claude-opus-4-6": [5, 25, 6.25, 0.5, 10],
    "claude-opus-4-5-20251101": [5, 25, 6.25, 0.5, 10],
    "claude-opus-4-1-20250805": [15, 75, 18.75, 1.5, 30],
    "claude-opus-4-0": [15, 75, 18.75, 1.5, 30],
    "claude-opus-4-20250514": [15, 75, 18.75, 1.5, 30],
    "claude-sonnet-5-5": [2, 10, 2.5, 0.2, 4],
    "claude-sonnet-5": [2, 10, 2.5, 0.2, 4],
    "claude-sonnet-4-6": [3, 15, 3.75, 0.3, 6],
    "claude-sonnet-4-5-20250929": [3, 15, 3.75, 0.3, 6],
    "claude-sonnet-4-20250514": [3, 15, 3.75, 0.3, 6],
    "claude-haiku-4-5-20251001": [1, 5, 1.25, 0.1, 2],
    "claude-3-5-haiku-20241022": [0.8, 4, 1, 0.08, 1.6],
  };
  for (const [model, [input, output, cw, cr, cw1h]] of Object.entries(prices)) {
    assert.deepEqual(priceFor(model), { in: input, out: output, cw, cr, cw1h }, model);
  }
});

test("prices unknown Claude versions at the newest rate of their family", () => {
  assert.deepEqual(priceFor("claude-opus-6"), priceFor("claude-opus-5-5"));
  assert.deepEqual(priceFor("claude-sonnet-6"), priceFor("claude-sonnet-5-5"));
  assert.deepEqual(priceFor("claude-fable-6"), priceFor("claude-fable-5-1"));
});

test("matches provider-prefixed Claude model ids", () => {
  assert.deepEqual(priceFor("anthropic.claude-opus-5-5"), priceFor("claude-opus-5-5"));
  assert.deepEqual(priceFor("us.anthropic.claude-opus-4-1-20250805-v1:0"), priceFor("claude-opus-4-1"));
});

test("resolves Claude ids in provider and dotted forms by version", () => {
  const cases: Record<string, string> = {
    "claude-opus-4": "claude-opus-4-0",
    "claude-opus-4@20250514": "claude-opus-4-0",
    "claude-opus-4.1": "claude-opus-4-1",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-fable-5.1": "claude-fable-5-1",
    "claude-opus-5-5[1m]": "claude-opus-5-5",
    "claude-sonnet-4-5@20250929": "claude-sonnet-4-5",
  };
  for (const [model, same] of Object.entries(cases)) {
    assert.deepEqual(priceFor(model), priceFor(same), model);
  }
});

test("prices a newer minor version at the newest known rate, not an older prefix", () => {
  assert.deepEqual(priceFor("claude-fable-5-2"), priceFor("claude-fable-5-1"));
  assert.deepEqual(priceFor("claude-opus-5-6"), priceFor("claude-opus-5-5"));
  assert.deepEqual(priceFor("claude-opus-4-10"), priceFor("claude-opus-4-5"));
  assert.deepEqual(priceFor("claude-opus"), priceFor("claude-opus-5-5"));
});

test("leaves Claude models older than the price page on the generic fallback", () => {
  const fallback = { in: 3, out: 15, cw: 3.75, cr: 0.3, cw1h: 6 };
  for (const model of ["claude-3-opus-20240229", "claude-3-haiku-20240307", "claude-3-7-sonnet-20250219"]) {
    assert.deepEqual(priceFor(model), fallback, model);
  }
});

test("user overrides keyed on a Claude family beat built-in versions", () => {
  const own: Price = { in: 1, out: 1, cw: 1, cr: 1, cw1h: 1 };
  assert.deepEqual(priceFor("claude-opus-5-5", { "claude-opus": own }), own);
});
