import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport, type ReportData } from "../src/report.js";

// These totals reproduce the original 9.52 / 480.57 closing-dash artifact.
const REPORT_SHARES = {
  claude: 195_300_000,
  codex: 10_750_000_000,
  grok: 1_600_000,
  deepseek: 216_800_000,
};
const TAU = 2 * Math.PI;

function renderDonut(bySource: ReportData["totals"]["bySource"]) {
  const html = renderReport({
    totals: {
      tokens: Object.values(bySource).reduce((sum, value) => sum + value, 0),
      cost: 0,
      streak: 0,
      bySource,
    },
    byModel: {},
    days: [],
  });
  const donut = html.match(/<div class="donut">([\s\S]*?)<div class="donut-legend">([\s\S]*?)<\/div><\/div>/);
  assert.ok(donut, "report includes an engine donut");
  const center = donut[1].match(/<text\b[^>]*>([^<]*)<\/text>/);
  assert.ok(center, "donut includes a center percentage");
  const titles = Object.fromEntries(
    [...donut[1].matchAll(/<title>([^<]+): ([^<]+%) · [^<]*<\/title>/g)]
      .map((match) => [match[1], match[2]]),
  );
  const legend = Object.fromEntries(
    [...donut[2].matchAll(/<span><i\b[^>]*><\/i>([^<]+) · ([^<]+%) · [^<]*<\/span>/g)]
      .map((match) => [match[1], match[2]]),
  );
  const shapes = [...donut[1].matchAll(/<(path|circle)\b([^>]*\bclass="arc"[^>]*)>/g)]
    .map((match) => ({
      tag: match[1],
      attrs: Object.fromEntries(
        [...match[2].matchAll(/([a-z-]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]]),
      ),
    }));
  return { center: center[1], titles, legend, shapes };
}

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} should be close to ${expected}`);
}

function arcGeometry(shape: ReturnType<typeof renderDonut>["shapes"][number]) {
  assert.equal(shape.tag, "path");
  const commands = shape.attrs.d.trim().split(/[\s,]+/);
  assert.equal(commands.length, 11, "each segment is one open arc");
  assert.equal(commands[0], "M");
  assert.equal(commands[3], "A");
  const [x1, y1, rx, ry, rotation, large, sweep, x2, y2] =
    [1, 2, 4, 5, 6, 7, 8, 9, 10].map((index) => Number(commands[index]));
  assert.ok([x1, y1, rx, ry, rotation, large, sweep, x2, y2].every(Number.isFinite));
  assert.equal(rx, 78);
  assert.equal(ry, 78);
  assert.equal(rotation, 0);
  assert.equal(sweep, 1, "segments run clockwise");
  assert.equal(shape.attrs["stroke-dasharray"], undefined);
  const start = [x1, y1];
  const end = [x2, y2];
  for (const [x, y] of [start, end]) near(Math.hypot(x - 100, y - 100), 78);
  let angle = Math.atan2(y2 - 100, x2 - 100) - Math.atan2(y1 - 100, x1 - 100);
  if (angle <= 0) angle += TAU;
  return { start, end, angle, large };
}

test("donut percentages agree across the center, legend, and tooltips", () => {
  const donut = renderDonut(REPORT_SHARES);
  const expected = {
    Claude: "1.7%",
    Codex: "96.3%",
    Grok: "&lt;0.1%",
    "DeepSeek Harness": "1.9%",
  };
  assert.equal(donut.center, expected.Codex);
  assert.deepEqual(donut.legend, expected);
  assert.deepEqual(donut.titles, expected);
});

test("empty usage displays a true zero percentage", () => {
  const donut = renderDonut({ claude: 0, codex: 0, grok: 0, deepseek: 0 });
  assert.equal(donut.center, "0%");
  assert.deepEqual(donut.legend, { Claude: "0%" });
  assert.deepEqual(donut.titles, {});
  assert.deepEqual(donut.shapes, []);
});

test("a single active engine displays a true full percentage", () => {
  const donut = renderDonut({ claude: 0, codex: 36, grok: 0, deepseek: 0 });
  assert.equal(donut.center, "100%");
  assert.deepEqual(donut.legend, { Codex: "100%" });
  assert.deepEqual(donut.titles, { Codex: "100%" });
  assert.equal(donut.shapes.length, 1);
  const circle = donut.shapes[0];
  assert.equal(circle.tag, "circle", "a full share paints a complete circle");
  assert.deepEqual([circle.attrs.cx, circle.attrs.cy, circle.attrs.r].map(Number), [100, 100, 78]);
  assert.equal(circle.attrs["stroke-dasharray"], undefined);
});

test("tiny nonzero shares do not round to zero or a full percentage", () => {
  const donut = renderDonut({ claude: 1, codex: 9_999 });
  const expected = { Claude: "&lt;0.1%", Codex: "&gt;99.9%" };
  assert.equal(donut.center, expected.Codex);
  assert.deepEqual(donut.legend, expected);
  assert.deepEqual(donut.titles, expected);
});

test("report shares form adjacent arcs with proportional coverage and a closed seam", () => {
  const arcs = renderDonut(REPORT_SHARES).shapes.map(arcGeometry);
  const values = Object.values(REPORT_SHARES);
  const total = values.reduce((sum, value) => sum + value, 0);
  assert.equal(arcs.length, values.length);
  near(arcs[0].start[0], 100);
  near(arcs[0].start[1], 22);
  arcs.forEach((arc, index) => {
    near(arc.angle / TAU, values[index] / total);
    assert.equal(arc.large, values[index] > total / 2 ? 1 : 0);
    const next = arcs[(index + 1) % arcs.length];
    near(arc.end[0], next.start[0]);
    near(arc.end[1], next.start[1]);
  });
  near(arcs.reduce((sum, arc) => sum + arc.angle, 0), TAU);
});

test("equal shares paint two complementary semicircles", () => {
  const arcs = renderDonut({ claude: 50, codex: 50 }).shapes.map(arcGeometry);
  assert.equal(arcs.length, 2);
  for (const arc of arcs) {
    near(arc.angle, Math.PI);
    assert.equal(arc.large, 0);
    near(arc.start[0] + arc.end[0], 200);
    near(arc.start[1] + arc.end[1], 200);
  }
  assert.deepEqual(arcs[0].end, arcs[1].start);
  assert.deepEqual(arcs[1].end, arcs[0].start);
});

test("tiny and near-full shares retain distinct endpoints and correct coverage", () => {
  const arcs = renderDonut({ claude: 1, codex: 9_999 }).shapes.map(arcGeometry);
  assert.equal(arcs.length, 2);
  assert.deepEqual(arcs.map((arc) => arc.large), [0, 1]);
  arcs.forEach((arc, index) => {
    assert.notDeepEqual(arc.start, arc.end);
    near(arc.angle / TAU, index === 0 ? 0.0001 : 0.9999);
  });
  assert.deepEqual(arcs[0].end, arcs[1].start);
  assert.deepEqual(arcs[1].end, arcs[0].start);
});
