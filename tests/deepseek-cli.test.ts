import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { call, event, header, session, USAGE } from "./helpers/deepseek-fixture.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function cli(home: string, dsh: string, args: string[], endpoint?: string): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "src/cli.ts"), ...args], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dsh, CCMAP_ENDPOINT: endpoint ?? "http://127.0.0.1:1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", data => out += data);
    child.stderr.on("data", data => err += data);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve({ out, err }) : reject(new Error(err || out)));
  });
}

test("CLI scans DSH_HOME, renders local reports and pushes only aggregates", { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "ccmap-deepseek-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dsh = join(root, "custom-harness-home");
  const now = Date.now();
  session(join(dsh, "sessions"), [header(), ...call(0, USAGE, "deepseek-flash", now),
    event(4, "user/message", { content: "PRIVATE_PROMPT_DO_NOT_UPLOAD" }, now),
    ...call(5, USAGE, "unknown-model", now),
  ]);
  const result = await cli(root, dsh, ["scan", "--no-graph"]);
  assert.match(result.out, /2,000/);
  assert.match(result.out, /deepseek 100%/);
  assert.match(result.err, /1,000 tokens have no known price/);
  const svgPath = join(root, "heatmap.svg");
  await cli(root, dsh, ["render", "--out", svgPath]);
  assert.match(readFileSync(svgPath, "utf8"), /deepseek 2\.0k/);
  const htmlPath = join(root, "report.html");
  await cli(root, dsh, ["report", "--out", htmlPath]);
  const html = readFileSync(htmlPath, "utf8");
  assert.match(html, /DeepSeek Harness/);
  assert.match(html, /Cost estimate excludes 1\.0k tokens/);

  let payload: any;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/api/push") payload = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, claimed: true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await cli(root, dsh, ["push", "--user", "test-user"], `http://127.0.0.1:${address.port}`);
  assert.equal(payload.totals.tokens, 2000);
  assert.equal(payload.totals.bySource.deepseek, 2000);
  assert.equal(payload.totals.unpricedTokens, 1000);
  assert.equal(payload.days[0].deepseek, 2000);
  assert.equal(payload.days[0].unpricedTokens, 1000);
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_PROMPT|custom-harness-home|session-1/);
});
