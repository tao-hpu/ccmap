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
