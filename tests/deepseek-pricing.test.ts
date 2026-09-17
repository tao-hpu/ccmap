import { test } from "node:test";
import assert from "node:assert/strict";
import { deepSeekCost } from "../src/pricing.js";

const tokens = { input: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6 };
const cost = (time: string, model = "deepseek-flash") => deepSeekCost(model, "deepseek-official", tokens, Date.parse(time));

test("official USD estimates use UTC weekday peak boundaries", () => {
  for (const time of ["01:00:00", "03:59:59", "06:00:00", "09:59:59"]) {
    assert.equal(cost(`2026-09-14T${time}Z`), 1.506);
  }
  for (const time of ["00:59:59", "04:00:00", "05:59:59", "10:00:00"]) {
    assert.equal(cost(`2026-09-14T${time}Z`), .753);
  }
  assert.equal(cost("2026-09-19T02:00:00Z"), .753);
  assert.equal(cost("2026-09-20T07:00:00Z"), .753);
});

test("known Flash aliases and V4 Pro use their own rates", () => {
  for (const model of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    assert.equal(cost("2026-09-14T02:00:00Z", model), 1.506);
  }
  assert.equal(cost("2026-09-14T02:00:00Z", "deepseek-v4-pro"), 5.324);
  assert.equal(cost("2026-09-14T02:00:00Z", "deepseek-unknown"), undefined);
  assert.equal(deepSeekCost("deepseek-flash", "third-party", tokens, Date.now()), undefined);
});

test("the most specific custom price takes precedence and is not discounted", () => {
  const custom = { deepseek: { in: 10, out: 10, cr: 10, cw: 0 }, "DeepSeek-Flash": { in: 1, out: 2, cr: .5, cw: 1 } };
  for (const time of ["2026-09-14T02:00:00Z", "2026-09-19T02:00:00Z"]) {
    assert.equal(deepSeekCost("deepseek-flash", "third-party", tokens, Date.parse(time), custom), 3.5);
  }
  assert.equal(deepSeekCost("deepseek-flash", "deepseek-official", { ...tokens, cacheWrite: 10 }, Date.now()), undefined);
});
