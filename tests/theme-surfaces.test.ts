import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderSVG, THEMES } from "../src/render.js";
import { renderPortraitCard, renderReport, renderSocialCard } from "../src/report.js";
import { dayStatToRecord, saveRollup } from "../src/rollup.js";
import {
  FIXTURE_TOTALS,
  createPushPayload,
  createThemeDays,
} from "./helpers/theme-fixture.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

interface FakeElement {
  value: string;
  checked: boolean;
  textContent: string;
  href: string;
  src: string;
}

function element(value = ""): FakeElement {
  return { value, checked: false, textContent: "", href: "", src: "" };
}

function runCustomizer(theme: string, border: boolean, rounded: boolean): Map<string, FakeElement> {
  const payload = createPushPayload();
  const html = renderReport(payload, {
    theme,
    origin: "https://ccmap.example",
    share: true,
  });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const customizerEnd = script.indexOf("\nbuild();") + "\nbuild();".length;
  assert.ok(customizerEnd >= "\nbuild();".length);
  const customizer = script.slice(0, customizerEnd);
  const elements = new Map<string, FakeElement>([
    ["t", element("claude")],
    ["a", element("none")],
    ["m", element("tokens")],
    ["w", element("26")],
    ["bd", element()],
    ["rd", element()],
    ["cb-note", element()],
    ["dl", element()],
    ["preview", element()],
    ["s-md", element()],
    ["s-pic", element()],
    ["s-url", element()],
    ["tweet", element()],
  ]);
  const context: Record<string, unknown> = {
    document: {
      getElementById(id: string) {
        return elements.get(id) ?? null;
      },
    },
    navigator: { clipboard: { writeText: async () => undefined } },
    setTimeout,
  };
  vm.runInNewContext(customizer, context);
  elements.get("t")!.value = theme;
  elements.get("a")!.value = "wave";
  elements.get("m")!.value = "cost";
  elements.get("w")!.value = "53";
  elements.get("bd")!.checked = border;
  elements.get("rd")!.checked = rounded;
  (context.build as () => void)();
  return elements;
}

function assertSharedOptions(value: string, border: boolean, rounded: boolean, occurrences = 1): void {
  assert.equal(value.split("border=true").length - 1, border ? occurrences : 0);
  assert.equal(value.split("border=false").length - 1, 0);
  assert.equal(value.split("rounded=true").length - 1, rounded ? occurrences : 0);
  assert.equal(value.split("anim=wave").length - 1, occurrences);
  assert.equal(value.split("metric=cost").length - 1, occurrences);
  assert.equal(value.split("weeks=53").length - 1, occurrences);
}

for (const theme of ["codex", "codex-light", "codex-dark"]) {
  for (const border of [false, true]) {
    for (const rounded of [false, true]) {
      test(`customizer propagates ${theme} border=${border ? "true" : "omitted"} rounded=${rounded}`, () => {
        const elements = runCustomizer(theme, border, rounded);
        assertSharedOptions(elements.get("preview")!.src, border, rounded);
        assertSharedOptions(elements.get("s-md")!.textContent, border, rounded);
        assertSharedOptions(elements.get("s-pic")!.textContent, border, rounded, 3);
        const adaptive = elements.get("s-pic")!.textContent;
        assert.match(adaptive, /dark\)" srcset="[^"]*theme=codex-dark/);
        assert.match(adaptive, /light\)" srcset="[^"]*theme=codex-light/);
        assert.match(adaptive, /<img src="[^"]*theme=codex-dark/);
      });
    }
  }
}

test("report selector lists Codex themes and preserves existing adaptive pairing", () => {
  const html = renderReport(createPushPayload(), {
    origin: "https://ccmap.example",
    share: true,
  });
  assert.match(html, /<option>codex<\/option>/);
  assert.match(html, /<option>codex-dark<\/option>/);
  assert.match(html, /<option>codex-light<\/option>/);

  const codex = runCustomizer("codex", false, false).get("s-pic")!.textContent;
  assert.match(codex, /dark\)" srcset="[^"]*theme=codex-dark&/);
  assert.match(codex, /light\)" srcset="[^"]*theme=codex-light&/);

  const claude = runCustomizer("claude-light", false, false).get("s-pic")!.textContent;
  assert.match(claude, /dark\)" srcset="[^"]*theme=claude&/);
  assert.match(claude, /light\)" srcset="[^"]*theme=claude-light&/);

  const unpaired = runCustomizer("dracula", false, false).get("s-pic")!.textContent;
  assert.match(unpaired, /dark\)" srcset="[^"]*theme=dracula&/);
  assert.match(unpaired, /light\)" srcset="[^"]*theme=github-light&/);
});

for (const theme of ["codex-light", "codex-dark"]) {
  test(`${theme} reaches local SVG, HTML, social, portrait, and badge-card renderers`, () => {
    const payload = createPushPayload();
    const days = createThemeDays();
    const options = { theme, origin: "https://ccmap.example" };
    const surfaces = [
      renderSVG(days, FIXTURE_TOTALS, { theme, weeks: 4 }),
      renderReport(payload, options),
      renderSocialCard(payload, options),
      renderPortraitCard(payload, options),
    ];
    for (const surface of surfaces) {
      assert.ok(surface.includes(THEMES[theme].bg));
      assert.ok(surface.includes(THEMES[theme].text));
      assert.ok(surface.includes(THEMES[theme].sub));
      assert.ok(surface.includes(THEMES[theme].border) || surface === surfaces[0]);
      for (const color of THEMES[theme].scale) assert.ok(surface.includes(color));
    }
  });
}

function ansiBackground(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `\u001b[48;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}

test("terminal scan uses saved Codex ANSI empty and activity colors without real logs", () => {
  const home = mkdtempSync(join(tmpdir(), "ccmap-terminal-theme-"));
  const configDirectory = join(home, ".ccmap");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "config.json"), JSON.stringify({ theme: "codex-dark", weeks: 4 }));
  saveRollup(
    new Map([...createThemeDays().entries()].map(([date, day]) => [date, dayStatToRecord(day)])),
    join(configDirectory, "history.json")
  );
  const wrapper = join(home, "tty-scan.mjs");
  writeFileSync(
    wrapper,
    `Object.defineProperty(process.stdout,"isTTY",{value:true,configurable:true});\n` +
      `process.argv=[process.execPath,${JSON.stringify(CLI)},"scan"];\n` +
      `await import(${JSON.stringify(pathToFileURL(CLI).href)});\n`
  );
  const result = spawnSync(process.execPath, [TSX, wrapper], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const color of [THEMES["codex-dark"].empty, ...THEMES["codex-dark"].scale]) {
    assert.ok(result.stdout.includes(ansiBackground(color)), `missing ANSI background ${color}`);
  }
});
