import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSVG, type Theme } from "../../src/render.js";
import { emptySrc, fromSrc, type DayStat } from "../../src/sources.js";

export const FIXTURE_TOTALS = {
  totalTokens: 36,
  totalCost: 3.6,
  streak: 8,
} as const;

export interface ThemePushPayload {
  v: string;
  user: string;
  generatedAt: string;
  totals: {
    tokens: number;
    cost: number;
    unpricedTokens?: number;
    streak: number;
    bySource: { claude: number; codex: number; grok: number; deepseek?: number };
  };
  byModel: Record<string, number>;
  days: {
    date: string;
    tokens: number;
    cost: number;
    unpricedTokens?: number;
    claude: number;
    codex: number;
    grok: number;
    deepseek?: number;
    sessions: number;
  }[];
}

export function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function fixtureReferenceDate(): Date {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  return date;
}

export function createThemeDays(reference = fixtureReferenceDate()): Map<string, DayStat> {
  const days = new Map<string, DayStat>();
  for (let index = 0; index < 8; index++) {
    const date = new Date(reference);
    date.setDate(reference.getDate() - 7 + index);
    const value = index + 1;
    const key = localDateKey(date);
    const src = emptySrc();
    src.codex = {
      tokens: value,
      cost: value / 10,
      byModel: { "gpt-5-codex": value },
    };
    days.set(key, fromSrc(key, src, new Set([`fixture-session-${value}`])));
  }
  return days;
}

export function createPushPayload(user = "alice", reference = fixtureReferenceDate()): ThemePushPayload {
  const days = [...createThemeDays(reference).values()];
  return {
    v: "0.2.0",
    user,
    generatedAt: reference.toISOString(),
    totals: {
      tokens: FIXTURE_TOTALS.totalTokens,
      cost: FIXTURE_TOTALS.totalCost,
      streak: FIXTURE_TOTALS.streak,
      bySource: { claude: 0, codex: FIXTURE_TOTALS.totalTokens, grok: 0 },
    },
    byModel: { "gpt-5-codex": FIXTURE_TOTALS.totalTokens },
    days: days.map((day) => ({
      date: day.date,
      tokens: day.tokens,
      cost: day.cost,
      claude: day.bySource.claude,
      codex: day.bySource.codex,
      grok: day.bySource.grok,
      sessions: day.sessions.size,
    })),
  };
}

export function normalizeSvgDates(svg: string): string {
  return svg
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
    .replace(/(<text[^>]*font-size="10">)[A-Z][a-z]{2}(<\/text>)/g, "$1<month>$2");
}

export function normalizeSvgPalette(svg: string, theme: Theme): string {
  const roles = [
    ["bg", theme.bg],
    ["text", theme.text],
    ["sub", theme.sub],
    ["empty", theme.empty],
    ...theme.scale.map((color, index) => [`scale-${index + 1}`, color]),
    ["border", theme.border],
  ] as const;
  return roles.reduce(
    (result, [role, color]) => result.replaceAll(color, `<${role}>`),
    svg
  );
}

export function geometrySignature(svg: string): {
  cardRadius: number;
  cellRadii: number[];
  cardStroke?: string;
} {
  const card = svg.match(/<rect x="0\.5"[^>]*rx="(\d+)"[^>]*\/?>/);
  if (!card) throw new Error("card rectangle not found");
  const cellRadii = [...svg.matchAll(/<rect x="\d+" y="\d+" width="11" height="11" rx="(\d+)"/g)]
    .map((match) => Number(match[1]));
  const stroke = card[0].match(/ stroke="([^"]+)"/)?.[1];
  return {
    cardRadius: Number(card[1]),
    cellRadii: [...new Set(cellRadii)],
    ...(stroke ? { cardStroke: stroke } : {}),
  };
}

function writeFixtureFiles(outputDirectory: string): void {
  mkdirSync(outputDirectory, { recursive: true });
  const days = createThemeDays();
  for (const theme of ["codex-light", "codex-dark"]) {
    for (const border of [false, true]) {
      for (const rounded of [false, true]) {
        const name = `${theme}-border-${border}-rounded-${rounded}.svg`;
        const svg = renderSVG(days, FIXTURE_TOTALS, {
          theme,
          border,
          rounded,
          weeks: 12,
          title: "Codex theme fixture",
        });
        writeFileSync(join(outputDirectory, name), svg);
      }
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    console.error("usage: tsx tests/helpers/theme-fixture.ts <output-directory>");
    process.exitCode = 1;
  } else {
    writeFixtureFiles(resolve(outputDirectory));
  }
}
