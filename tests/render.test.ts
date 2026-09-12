import { test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, renderSVG, resolveTheme, type Theme } from "../src/render.js";
import { renderReport } from "../src/report.js";
import {
  FIXTURE_TOTALS,
  createPushPayload,
  createThemeDays,
  geometrySignature,
  normalizeSvgDates,
  normalizeSvgPalette,
} from "./helpers/theme-fixture.js";

const EXPECTED: Record<"codex-light" | "codex-dark", Theme> = {
  "codex-light": {
    bg: "#FFFFFF",
    text: "#191C1F",
    sub: "#8E8F90",
    empty: "#F4F4F4",
    scale: ["#D2DDF3", "#A9C0E7", "#7398D9", "#2C67C5"],
    border: "#D9DEE5",
  },
  "codex-dark": {
    bg: "#191C1F",
    text: "#F4F4F4",
    sub: "#A0A4A8",
    empty: "#292E33",
    scale: ["#23416D", "#265494", "#2C67C5", "#7398D9"],
    border: "#3B424A",
  },
};

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + 0.05) / (dark + 0.05);
}

for (const name of ["codex-light", "codex-dark"] as const) {
  test(`${name} has the exact contracted palette and accessible text`, () => {
    const theme = THEMES[name];
    assert.deepEqual(theme, EXPECTED[name]);
    assert.equal(theme.scale.length, 4);
    assert.ok(contrast(theme.text, theme.bg) >= 4.5);
    assert.ok(contrast(theme.sub, theme.bg) >= 3);
    assert.notEqual(theme.empty, theme.bg);
    assert.notEqual(theme.empty, theme.scale[0]);
    assert.notEqual(theme.border, theme.bg);
    assert.notEqual(theme.border, theme.empty);

    const states = [theme.empty, ...theme.scale].map(luminance);
    for (let index = 1; index < states.length; index++) {
      if (name === "codex-light") assert.ok(states[index] < states[index - 1]);
      else assert.ok(states[index] > states[index - 1]);
    }
  });
}

test("Codex theme names are exact and case-sensitive", () => {
  assert.ok(THEMES["codex-light"]);
  assert.ok(THEMES["codex-dark"]);
  assert.equal(THEMES["Codex-light"], undefined);
  assert.equal(THEMES["CODEX-DARK"], undefined);
});

for (const name of ["codex-light", "codex-dark"] as const) {
  for (const border of [false, true]) {
    for (const rounded of [false, true]) {
      test(`${name} renderer applies border=${border} rounded=${rounded} only to stroke and radii`, () => {
        const svg = renderSVG(createThemeDays(), FIXTURE_TOTALS, {
          theme: name,
          border,
          rounded,
          weeks: 4,
        });
        const geometry = geometrySignature(svg);
        assert.equal(geometry.cardStroke, border ? EXPECTED[name].border : undefined);
        assert.equal(geometry.cardRadius, rounded ? 8 : 0);
        assert.deepEqual(geometry.cellRadii, [rounded ? 2 : 0]);
      });
    }
  }
}

test("switching between Codex variants changes palette values only", () => {
  const days = createThemeDays();
  const light = normalizeSvgPalette(
    normalizeSvgDates(renderSVG(days, FIXTURE_TOTALS, { theme: "codex-light", weeks: 4 })),
    EXPECTED["codex-light"]
  );
  const dark = normalizeSvgPalette(
    normalizeSvgDates(renderSVG(days, FIXTURE_TOTALS, { theme: "codex-dark", weeks: 4 })),
    EXPECTED["codex-dark"]
  );
  assert.equal(light, dark);
});

test("pre-existing theme records remain byte-for-byte compatible", () => {
  const legacy: Record<string, Theme> = {
    "github-dark": {
      bg: "#0d1117", text: "#c9d1d9", sub: "#8b949e", empty: "#161b22",
      scale: ["#0e4429", "#006d32", "#26a641", "#39d353"], border: "#30363d",
    },
    "github-light": {
      bg: "#ffffff", text: "#24292f", sub: "#57606a", empty: "#ebedf0",
      scale: ["#9be9a8", "#40c463", "#30a14e", "#216e39"], border: "#d0d7de",
    },
    "tokyo-night": {
      bg: "#1a1b27", text: "#c0caf5", sub: "#a9b1d6", empty: "#23243a",
      scale: ["#0f3d4a", "#1f6f7a", "#2db3a3", "#41dcc4"], border: "#2a2e45",
    },
    dracula: {
      bg: "#282a36", text: "#f8f8f2", sub: "#6272a4", empty: "#3a3d52",
      scale: ["#1d4d33", "#2e8a52", "#41c97a", "#50fa7b"], border: "#44475a",
    },
    nord: {
      bg: "#2e3440", text: "#eceff4", sub: "#9aa5b8", empty: "#3b4252",
      scale: ["#3b5a52", "#4f8a76", "#74b39b", "#a3be8c"], border: "#434c5e",
    },
    claude: {
      bg: "#1f1e1d", text: "#faf9f5", sub: "#b0aba1", empty: "#2d2b28",
      scale: ["#5e3a2e", "#9c5640", "#d97757", "#ee9a78"], border: "#3a3633",
    },
    "claude-light": {
      bg: "#faf9f5", text: "#1f1e1d", sub: "#6b6862", empty: "#ece7dd",
      scale: ["#f0c9b6", "#e3a184", "#d97757", "#bc5739"], border: "#e5ded2",
    },
  };
  for (const [name, theme] of Object.entries(legacy)) assert.deepEqual(THEMES[name], theme);
});

test("aliases, resolver fallback, and Claude report default remain unchanged", () => {
  assert.equal(resolveTheme("dark"), THEMES["github-dark"]);
  assert.equal(resolveTheme("light"), THEMES["github-light"]);
  assert.equal(resolveTheme("codex"), THEMES["codex-light"]);
  assert.equal(resolveTheme(), THEMES["github-dark"]);
  assert.equal(resolveTheme("no-such-theme"), THEMES["github-dark"]);

  const days = createThemeDays();
  const unknown = renderSVG(days, FIXTURE_TOTALS, { theme: "no-such-theme", weeks: 4 });
  const githubDark = renderSVG(days, FIXTURE_TOTALS, { theme: "github-dark", weeks: 4 });
  assert.equal(normalizeSvgDates(unknown), normalizeSvgDates(githubDark));

  const payload = createPushPayload();
  const report = renderReport(payload);
  assert.match(report, /--bg:#1f1e1d/);
  assert.match(report, /--fg:#faf9f5/);
});

test("codex shorthand renders the Codex light palette", () => {
  const days = createThemeDays();
  const shorthand = renderSVG(days, FIXTURE_TOTALS, { theme: "codex", weeks: 4 });
  const light = renderSVG(days, FIXTURE_TOTALS, { theme: "codex-light", weeks: 4 });
  assert.equal(normalizeSvgDates(shorthand), normalizeSvgDates(light));
});
