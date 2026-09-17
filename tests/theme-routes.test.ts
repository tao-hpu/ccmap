import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../server/src/index.js";
import { THEMES } from "../src/render.js";
import { renderSocialCard, renderPortraitCard } from "../src/report.js";
import {
  createPushPayload,
  geometrySignature,
} from "./helpers/theme-fixture.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const NODE_SERVER = join(ROOT, "src", "server.ts");

class MemoryKv {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

async function startNodeServer(payload: ReturnType<typeof createPushPayload>): Promise<{
  base: string;
  child: ChildProcess;
}> {
  const directory = mkdtempSync(join(tmpdir(), "ccmap-theme-routes-"));
  const dataPath = join(directory, "data.json");
  writeFileSync(dataPath, JSON.stringify({ [`user:${payload.user}`]: JSON.stringify(payload) }));
  const port = await freePort();
  const child = spawn(process.execPath, [TSX, NODE_SERVER], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CCMAP_DATA: dataPath, HOME: directory, USERPROFILE: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errorOutput = "";
  child.stderr?.on("data", (chunk) => (errorOutput += String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Node server exited early: ${errorOutput}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return { base, child };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill("SIGTERM");
  throw new Error(`Node server did not start: ${errorOutput}`);
}

function expectedNodeOptions(query: string): { border: boolean; rounded: boolean } {
  const params = new URLSearchParams(query);
  return {
    border: params.get("border") === "true",
    rounded: params.get("rounded") === "true",
  };
}

function expectedWorkerOptions(query: string): { border: boolean; rounded: boolean } {
  const params = new URLSearchParams(query);
  return {
    border: params.get("hide_border") !== "true",
    rounded: false,
  };
}

test("Node and Worker preserve their existing SVG option behavior for both Codex themes", async (t) => {
  const payload = createPushPayload();
  const node = await startNodeServer(payload);
  t.after(() => node.child.kill("SIGTERM"));

  const kv = new MemoryKv();
  kv.values.set(`user:${payload.user}`, JSON.stringify(payload));
  const env = { USERS: kv } as never;
  const queries = [
    "",
    "border=true",
    "border=false",
    "border=TRUE",
    "rounded=true",
    "rounded=false",
    "hide_border=true",
    "hide_border=false",
    "border=true&hide_border=true",
    "border=false&hide_border=false",
  ];

  for (const theme of ["codex-light", "codex-dark"]) {
    for (const query of queries) {
      const params = new URLSearchParams(query);
      params.set("theme", theme);
      params.set("weeks", "4");
      const path = `/u/${payload.user}.svg?${params}`;
      const [nodeResponse, workerResponse] = await Promise.all([
        fetch(node.base + path),
        worker.fetch(new Request(node.base + path), env),
      ]);
      assert.equal(nodeResponse.status, 200);
      assert.equal(workerResponse.status, 200);
      assert.equal(nodeResponse.headers.get("content-type"), "image/svg+xml; charset=utf-8");
      assert.equal(workerResponse.headers.get("content-type"), "image/svg+xml; charset=utf-8");

      const [nodeSvg, workerSvg] = await Promise.all([nodeResponse.text(), workerResponse.text()]);
      const surfaces = [
        { svg: nodeSvg, expected: expectedNodeOptions(query) },
        { svg: workerSvg, expected: expectedWorkerOptions(query) },
      ];
      for (const { svg, expected } of surfaces) {
        assert.ok(svg.includes(THEMES[theme].bg));
        for (const color of THEMES[theme].scale) assert.ok(svg.includes(color));
        const geometry = geometrySignature(svg);
        assert.equal(geometry.cardStroke, expected.border ? THEMES[theme].border : undefined);
        assert.equal(geometry.cardRadius, expected.rounded ? 8 : 0);
        assert.deepEqual(geometry.cellRadii, [expected.rounded ? 2 : 0]);
      }
    }
  }
});

test("Node and Worker HTML aliases select the same Codex report", async (t) => {
  const payload = createPushPayload();
  const node = await startNodeServer(payload);
  t.after(() => node.child.kill("SIGTERM"));
  const kv = new MemoryKv();
  kv.values.set(`user:${payload.user}`, JSON.stringify(payload));
  const env = { USERS: kv } as never;

  for (const theme of ["codex-light", "codex-dark"]) {
    for (const suffix of ["", ".html"]) {
      const path = `/u/${payload.user}${suffix}?theme=${theme}`;
      const [nodeResponse, workerResponse] = await Promise.all([
        fetch(node.base + path),
        worker.fetch(new Request(node.base + path), env),
      ]);
      assert.equal(nodeResponse.status, 200);
      assert.equal(workerResponse.status, 200);
      assert.match(nodeResponse.headers.get("content-type") ?? "", /^text\/html/);
      assert.match(workerResponse.headers.get("content-type") ?? "", /^text\/html/);
      const [nodeHtml, workerHtml] = await Promise.all([nodeResponse.text(), workerResponse.text()]);
      assert.equal(nodeHtml, workerHtml);
      assert.ok(nodeHtml.includes(`--bg:${THEMES[theme].bg}`));
    }
  }
});

test("Node PNG routes preserve a Codex theme in their SVG fallback", async (t) => {
  const payload = createPushPayload();
  const node = await startNodeServer(payload);
  t.after(() => node.child.kill("SIGTERM"));

  for (const variant of ["", "&shape=portrait", "&card=badge"]) {
    const response = await fetch(
      `${node.base}/u/${payload.user}.png?theme=codex-dark${variant}`,
      { redirect: "manual" }
    );
    assert.ok(response.status === 200 || response.status === 302);
    if (response.status === 200) {
      assert.equal(response.headers.get("content-type"), "image/png");
    } else {
      const location = response.headers.get("location");
      assert.ok(location);
      const fallback = new URL(location, node.base);
      assert.equal(fallback.pathname, `/u/${payload.user}.svg`);
      assert.equal(fallback.searchParams.get("theme"), "codex-dark");
    }
  }
});

test("DeepSeek aggregates survive push and appear in Node and Worker reports and badges", async (t) => {
  const payload = createPushPayload("deepseek-user");
  payload.totals.tokens += 80;
  payload.totals.bySource.deepseek = 80;
  payload.totals.unpricedTokens = 80;
  payload.byModel["custom-model"] = 80;
  for (const day of payload.days) {
    day.tokens += 10;
    day.deepseek = 10;
    day.unpricedTokens = 10;
  }
  const node = await startNodeServer(createPushPayload());
  t.after(() => node.child.kill("SIGTERM"));
  const kv = new MemoryKv();
  const env = { USERS: kv } as never;
  const key = "test-deepseek-key-not-a-real-secret";
  for (const request of [
    (path: string, init?: RequestInit) => fetch(node.base + path, init),
    (path: string, init?: RequestInit) => worker.fetch(new Request(node.base + path, init), env),
  ]) {
    const claim = await request("/api/claim", { method: "POST", body: JSON.stringify({ user: payload.user, key }) });
    assert.equal(claim.status, 200);
    const push = await request("/api/push", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(payload) });
    assert.equal(push.status, 200);
    const html = await (await request(`/u/${payload.user}`)).text();
    assert.match(html, /DeepSeek Harness/);
    assert.match(html, /deepseek 10/);
    assert.match(html, /Cost estimate excludes 80 tokens/);
    const svg = await (await request(`/u/${payload.user}.svg`)).text();
    assert.match(svg, /deepseek 10/);
    assert.match(svg, /partial/);
  }
  for (const render of [renderSocialCard, renderPortraitCard]) {
    const svg = render(payload);
    assert.match(svg, /partial est\./);
    assert.match(svg, /116 tokens/);
  }
});
