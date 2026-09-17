import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TIME = Date.parse("2026-09-14T02:00:00Z");
export const USAGE = { inputTokens: 100, cacheReadTokens: 800, outputTokens: 100, reasoningTokens: 40 };
export const event = (seq: number, type: string, data: unknown, time = TIME) => ({ type, seq, time, data });
export const header = (version = 0, id = "session-1", extra = {}) => ({
  type: "session", version, id, createdAt: TIME, delegationDepth: 0,
  ...(version >= 2 ? { isSeeded: false } : {}), ...extra,
});
export function call(start = 0, usage: unknown = USAGE, model = "deepseek-flash", time = TIME) {
  return [
    event(start, "step/start", { turn: 1, step: start + 1 }, time),
    event(start + 1, "request/context", { provider: "deepseek-official", model }, time),
    event(start + 2, "assistant/message", { turn: 1, step: start + 1, usage, message: { role: "assistant" } }, time + 1000),
    event(start + 3, "step/end", { turn: 1, step: start + 1 }, time + 1000),
  ];
}

// A standard Zstandard frame with raw blocks: fixtures need no native encoder
// or system zstd installation, including on the supported Node 18 runtime.
export function zstdFrame(text: string): Buffer {
  const data = Buffer.from(text);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  const blocks: Buffer[] = [];
  for (let offset = 0; offset < data.length || offset === 0; offset += 100000) {
    const block = data.subarray(offset, offset + 100000);
    const tag = Buffer.alloc(3);
    tag.writeUIntLE((block.length << 3) | (offset + block.length >= data.length ? 1 : 0), 0, 3);
    blocks.push(tag, block);
  }
  return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0]), size, ...blocks]);
}

export function session(root: string, rows: unknown[], name = "one", version = 0, compressed = false): string {
  const dir = join(root, "project", name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `session${version ? `.v${version}` : ""}.jsonl${compressed ? ".zstd" : ""}`);
  const text = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(file, compressed ? zstdFrame(text) : text);
  return file;
}
