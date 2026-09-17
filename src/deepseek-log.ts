import { closeSync, openSync, readSync } from "node:fs";
import { Decompress } from "fzstd";

// The JSONL callback sees complete lines only. A truncated final frame or JSON
// record must not discard the complete usage records preceding it.
export function readDeepSeekLines(file: string, onLine: (line: string) => void): void {
  const fd = openSync(file, "r");
  const chunk = Buffer.allocUnsafe(256 * 1024);
  let carry = Buffer.alloc(0);
  const consume = (bytes: Uint8Array) => {
    const region = carry.length ? Buffer.concat([carry, bytes]) : Buffer.from(bytes);
    let start = 0;
    for (;;) {
      const end = region.indexOf(10, start);
      if (end < 0) break;
      if (end > start) onLine(region.toString("utf8", start, end));
      start = end + 1;
    }
    carry = Buffer.from(region.subarray(start));
  };
  const decoder = file.endsWith(".zstd") ? new Decompress(consume) : undefined;
  try {
    for (;;) {
      const n = readSync(fd, chunk);
      if (!n) break;
      // fzstd retains input slices when a frame crosses pushes. Never hand it
      // the reusable read buffer, whose next read would corrupt that suffix.
      if (decoder) decoder.push(Buffer.from(chunk.subarray(0, n)));
      else consume(chunk.subarray(0, n));
    }
    if (decoder) decoder.push(new Uint8Array(), true);
    if (carry.length) onLine(carry.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
