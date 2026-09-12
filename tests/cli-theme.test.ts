import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { THEMES } from "../src/render.js";
import { geometrySignature } from "./helpers/theme-fixture.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function temporaryHome(): string {
  return mkdtempSync(join(tmpdir(), "ccmap-cli-theme-"));
}

function runCli(home: string, args: string[]): string {
  const result = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("CLI render keeps border and rounded flags independent", () => {
  const home = temporaryHome();
  const cases = [
    { label: "none", flags: [], border: false, rounded: false },
    { label: "border", flags: ["--border"], border: true, rounded: false },
    { label: "rounded", flags: ["--rounded"], border: false, rounded: true },
    { label: "both", flags: ["--border", "--rounded"], border: true, rounded: true },
  ] as const;

  for (const item of cases) {
    const output = join(home, `${item.label}.svg`);
    runCli(home, ["render", "--out", output, "--theme", "codex-dark", "--weeks", "4", ...item.flags]);
    const geometry = geometrySignature(readFileSync(output, "utf8"));
    assert.equal(geometry.cardStroke, item.border ? THEMES["codex-dark"].border : undefined);
    assert.equal(geometry.cardRadius, item.rounded ? 8 : 0);
    assert.deepEqual(geometry.cellRadii, [item.rounded ? 2 : 0]);
  }
});

test("CLI config persists a Codex theme for subsequent local render and report", () => {
  const home = temporaryHome();
  const configOutput = runCli(home, ["config", "--theme", "codex-light"]);
  assert.match(configOutput, /"theme": "codex-light"/);

  const svgPath = join(home, "saved-theme.svg");
  runCli(home, ["render", "--out", svgPath, "--weeks", "4"]);
  const svg = readFileSync(svgPath, "utf8");
  assert.match(svg, /fill="#FFFFFF"/);
  assert.match(svg, /fill="#191C1F"/);

  const reportPath = join(home, "saved-theme.html");
  runCli(home, ["report", "--out", reportPath]);
  const html = readFileSync(reportPath, "utf8");
  assert.match(html, /--bg:#FFFFFF/);
  assert.match(html, /--fg:#191C1F/);
});

test("CLI help lists the complete theme choices for render, report, and config", () => {
  const help = runCli(temporaryHome(), ["help"]);
  const choices = "claude|claude-light|codex-dark|codex-light|github-dark|github-light|tokyo-night|dracula|nord";
  assert.equal(help.split(choices).length - 1, 3);
  assert.match(help, /--border[^\n]*--rounded[^\n]*opt-in/);
});

test("fresh CLI render keeps the Claude call-site default", () => {
  const home = temporaryHome();
  const output = join(home, "default-theme.svg");
  runCli(home, ["render", "--out", output, "--weeks", "4"]);
  const svg = readFileSync(output, "utf8");
  assert.match(svg, /fill="#1f1e1d"/);
  assert.match(svg, /fill="#faf9f5"/);
});

test("CLI codex shorthand uses the Codex light theme", () => {
  const home = temporaryHome();
  const output = join(home, "codex-theme.svg");
  runCli(home, ["render", "--out", output, "--theme", "codex", "--weeks", "4"]);
  const svg = readFileSync(output, "utf8");
  assert.match(svg, /fill="#FFFFFF"/);
  assert.match(svg, /fill="#191C1F"/);
});
