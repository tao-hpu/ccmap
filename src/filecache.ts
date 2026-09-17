import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.js";

// Per-file scan cache. Session logs are append-only, so a file whose size and
// mtime are unchanged since the last scan can only produce the aggregates we
// already computed — we replay those instead of re-reading the bytes.
//
// Grok uses one log per session. DeepSeek uses a separate cache after selecting
// one generation per session and deduplicates session ids before aggregation.
// Claude Code can repeat assistant messages across resumed transcripts, so
// its global dedup stays on the live path.
export const SCAN_CACHE_PATH = join(CONFIG_DIR, "scan-cache.json");

export interface CachedDay {
  m: Record<string, { t: number; c: number; u?: number }>; // tokens, cost, unpriced tokens per model
  s: string[]; // session ids seen that day
}
export interface CachedFile {
  size: number;
  mtime: number;
  days: Record<string, CachedDay>;
}
interface CacheFile {
  v: number;
  files: Record<string, CachedFile>;
}

export function loadScanCache(path: string = SCAN_CACHE_PATH): Map<string, CachedFile> {
  const map = new Map<string, CachedFile>();
  if (!existsSync(path)) return map;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (parsed?.v !== 1) return map;
    for (const [file, entry] of Object.entries(parsed.files ?? {})) {
      if (entry && typeof entry.size === "number") map.set(file, entry);
    }
  } catch {
    // corrupt cache → rescan from source; a stats tool must never throw on read
  }
  return map;
}

export function saveScanCache(map: Map<string, CachedFile>, path: string = SCAN_CACHE_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const files: Record<string, CachedFile> = {};
    for (const [k, v] of map) files[k] = v;
    writeFileSync(path, JSON.stringify({ v: 1, files } satisfies CacheFile));
  } catch {
    // best-effort: a failed write just means no caching this run
  }
}

// A file is a cache hit only if both size and mtime still match.
export function fresh(entry: CachedFile | undefined, file: string): CachedFile | null {
  if (!entry) return null;
  try {
    const st = statSync(file);
    return st.size === entry.size && Math.floor(st.mtimeMs) === entry.mtime ? entry : null;
  } catch {
    return null;
  }
}

export function stampOf(file: string): { size: number; mtime: number } | null {
  try {
    const st = statSync(file);
    return { size: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}
