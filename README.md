# ccmap

Coding heatmap for **Claude Code + Codex**. Scans your local CLI logs, renders a
GitHub-style contribution heatmap, and can run resident to push aggregates to a
badge endpoint — so you get a public `https://.../u/<you>.svg` you can embed in a
README or post.

> **Privacy:** only per-day token/cost counts and model names ever leave your
> machine. Never your prompts, code, or project names.

## Install

```bash
npm i -g @tao-hpu/ccmap
```

That's the whole install (the command is still just `ccmap`). Then:

```bash
ccmap scan      # see your usage in the terminal — colored heatmap, no upload, no setup
ccmap push      # pick a name + publish your badge → https://ccmap.fim.ai/u/<you>.svg
ccmap start     # keep it fresh: push once a day in the background
```

Don't want to install? `npx @tao-hpu/ccmap@latest scan` runs it once, always latest.

> `scan` / `render` / `report` are fully local and need **no setup**. `push` / `start`
> publish to the public badge service at **`https://ccmap.fim.ai`** (baked in — zero
> config). Prefer your own server? Point at it with `ccmap login --endpoint <url>`
> (deploy one in minutes, see [Badge server](#badge-server)).

## Commands

| Command | What it does |
| --- | --- |
| `ccmap scan` | Summarize local usage (tokens, est. cost, streak, model mix) + terminal heatmap. No upload. |
| `ccmap render [--out f.svg] [--theme …] [--anim ember\|wave\|cascade] [--metric tokens\|cost] [--weeks 26] [--border] [--rounded]` | Render a heatmap SVG locally. |
| `ccmap report [--out f.html]` | Render a full shareable HTML report (with a live customizer). |
| `ccmap push [--user <name>]` | Publish your data. First run picks a username: on a terminal it **prompts** you (default = your OS name); non-interactively it uses the default. Override with `--user` or the `CCMAP_USER` env var. |
| `ccmap start` | Resident: push every `interval` minutes (also checks for updates daily). |
| `ccmap login --user <name> --endpoint <url>` | Optional: pick a specific username / point at your own server. |
| `ccmap update` | Self-update to the latest published version. |

## Data sources

- Claude Code: `~/.claude/projects/**/*.jsonl` (assistant `message.usage`)
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`token_count` events)

## Local history (so your heatmap keeps filling up)

Claude Code prunes its own session logs after ~30 days (`cleanupPeriodDays`,
default 30), and Codex has its own retention — so the raw logs are a **rolling
window**, not your full past. If a fresh heatmap looks sparse, that's why: the
older transcripts are already gone from disk.

To stop losing history going forward, every `scan` / `render` / `report` /
`push` snapshots each day's totals into a tiny rollup at **`~/.ccmap/history.json`**
(a few KB/year). Once a day is recorded it stays on the heatmap **even after
Claude Code deletes the raw transcript** — so the map keeps lighting up over time.
This is fully automatic and local: it touches **no** Claude Code / Codex config,
and nothing extra leaves your machine.

> Run regularly (e.g. `ccmap start`, which pushes daily) so each day is captured
> before the 30-day prune removes it. Already-deleted history can't be recovered —
> it accumulates from when you start running ccmap.

## Pricing

Cost is an **estimate** from a built-in per-model price table. Override any model
in `~/.ccmap/config.json`:

```json
{ "pricing": { "claude-opus": { "in": 15, "out": 75, "cw": 18.75, "cr": 1.5 } } }
```

## Updating

```bash
ccmap update     # self-update to latest (same as `npm i -g @tao-hpu/ccmap@latest`)
```

The resident daemon (`ccmap start`) checks npm once a day and prints when a new
version exists; set `"autoUpdate": true` in `~/.ccmap/config.json` to auto-install.

## Maintainer: build / publish / version

```bash
pnpm build                # tsc -> dist/
pnpm link --global        # dev: `ccmap` points at this working copy
npm version patch         # bump + git tag (patch | minor | major)
npm publish               # runs prepublishOnly (tsc); ships dist/ only
```

Published as the scoped package **`@tao-hpu/ccmap`** (the bare `ccmap` name is
blocked by npm for similarity to `cc-map`); the installed CLI command is still
`ccmap`. Releases use a 2FA-bypassing automation token in `.env` via `pnpm release`.

## Badge server

The default public instance runs at **`https://ccmap.fim.ai`** (baked into the CLI),
so `ccmap push` needs zero setup. You only need to run your own server if you'd rather
self-host. Two interchangeable implementations live in this repo — both reuse
`src/render.ts` / `src/report.ts` and speak the same API:

- **Node** (`src/server.ts`) — zero deps, a JSON-file store. Runs anywhere node does:
  ```bash
  pnpm build
  CCMAP_DATA=/var/lib/ccmap/data.json PORT=3006 node dist/server.js
  # put it behind nginx/caddy with TLS, then point clients at it:
  ccmap login --user alice --endpoint https://your.host
  ```
- **Cloudflare Worker** (`server/`) — KV-backed, deploy with `wrangler deploy`.

Either way set an optional invite gate by exporting `PUSH_SECRET` (Node) or
`wrangler secret put PUSH_SECRET` (Worker); clients then pass `ccmap login --invite <code>`.

### How users onboard — 100% CLI, no server account

Only the **operator** runs the server. Each user just runs the CLI against it:

```bash
ccmap push          # claims a name + pushes against the default endpoint, one-shot
ccmap start         # resident, pushes once a day
# self-hosting instead? add:  ccmap login --user alice --endpoint https://your.host
```

Auth model: `login`/first `push` mints a local secret and stores only `sha256(key)`
server-side under `auth:<user>`; the raw key lives only on the user's machine
(`~/.ccmap/config.json`). A name, once claimed, can only be pushed by the holder of its
key. Lose the key = lose the name (v0; no recovery — back up `~/.ccmap/config.json`).

Embed the badge anywhere (GitHub README renders SVG natively):

```md
![my coding heatmap](https://ccmap.fim.ai/u/taotao.svg)
```

### Query params

| param | values | default |
| --- | --- | --- |
| `theme` | `github-dark` `github-light` `tokyo-night` `dracula` `nord` (`dark`/`light` aliases) | `github-dark` |
| `metric` | `tokens` `cost` | `tokens` |
| `weeks` | `1..53` | `26` |
| `border` | `true` `false` | `false` |
| `rounded` | `true` `false` | `false` |

Add themes by editing the `THEMES` registry in `src/render.ts` — each is just a
palette, instantly available as `?theme=<name>`.

### Auto light/dark (follow the viewer's GitHub theme)

A single image URL can't detect the viewer's color mode. GitHub's official trick is
`<picture>` with `prefers-color-scheme` — serve two themed URLs and the README swaps
automatically:

```html
<picture>
  <source media="(prefers-color-scheme: dark)"
          srcset="https://ccmap.fim.ai/u/taotao.svg?theme=github-dark">
  <source media="(prefers-color-scheme: light)"
          srcset="https://ccmap.fim.ai/u/taotao.svg?theme=github-light">
  <img src="https://ccmap.fim.ai/u/taotao.svg?theme=github-dark" alt="coding heatmap">
</picture>
```

## Status

- ✅ Local: `scan` / `render` / `report` / `login` / `push` / `start` — verified against real logs.
- ✅ Server: **live at `https://ccmap.fim.ai`** (Node, `src/server.ts`) — claim, per-user
  auth, badge + HTML report all verified end-to-end. Cloudflare Worker (`server/`) is an
  interchangeable alternative.
- ⏳ PNG route (`/u/:user.png`): SVG covers GitHub/Notion/Slack. PNG (for X/Twitter)
  is one dep away — add `@resvg/resvg-wasm` and a `.png` route.
- 💡 Ideas backlog: leaderboard, "AI Wrapped" recap card, model fingerprint, streak-only mini badge.
