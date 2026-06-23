# ccmap

Coding heatmap for **Claude Code + Codex**. Scans your local CLI logs, renders a
GitHub-style contribution heatmap, and can run resident to push aggregates to a
badge endpoint — so you get a public `https://.../u/<you>.svg` you can embed in a
README or post.

> **Privacy:** only per-day token/cost counts and model names ever leave your
> machine. Never your prompts, code, or project names.

## Quick start (local, no server)

```bash
# from anywhere, once published to npm:
npx ccmap scan                 # summarize usage in the terminal
npx ccmap render --out me.svg  # render a heatmap you can open / commit

# or in this repo:
pnpm install && pnpm build
node dist/cli.js scan
```

## Commands

| Command | What it does |
| --- | --- |
| `ccmap scan` | Summarize local usage (tokens, est. cost, streak, model mix). No upload. |
| `ccmap render [--out f.svg] [--metric tokens\|cost] [--weeks 26] [--theme dark\|light]` | Render a heatmap SVG locally. |
| `ccmap config --user <name> --endpoint <url> [--token <t>] [--interval 15]` | Save push settings to `~/.ccmap/config.json`. |
| `ccmap push` | Push aggregates to your endpoint once. |
| `ccmap start` | Resident: push every `interval` minutes. |

## Data sources

- Claude Code: `~/.claude/projects/**/*.jsonl` (assistant `message.usage`)
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`token_count` events)

## Pricing

Cost is an **estimate** from a built-in per-model price table. Override any model
in `~/.ccmap/config.json`:

```json
{ "pricing": { "claude-opus": { "in": 15, "out": 75, "cw": 18.75, "cr": 1.5 } } }
```

## Install & update

```bash
npx ccmap@latest scan     # zero-install, always latest
npm i -g ccmap            # install the `ccmap` command
ccmap update              # self-update to latest (or `npm i -g ccmap@latest`)
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

If the name `ccmap` is taken on npm, publish scoped: set `"name": "@you/ccmap"`
in `package.json`, update `PKG` in `src/cli.ts`, and `npm publish --access public`.

## Badge server (Cloudflare Worker)

The public badge URL is served by a tiny Worker in [`server/`](./server) that
reuses `src/render.ts`. Deploy it once:

```bash
cd server
pnpm install
npx wrangler kv namespace create USERS   # paste the printed id into wrangler.toml
npx wrangler deploy                      # -> https://ccmap.<you>.workers.dev
# Optional invite gate (keeps the service private):
#   npx wrangler secret put PUSH_SECRET  # users then pass `ccmap login --invite <code>`
```

### How users onboard — 100% CLI, no Cloudflare account

Only **you** (the operator) have a Cloudflare account. Each user just runs the CLI:

```bash
ccmap login --user alice --endpoint https://ccmap.<you>.workers.dev
#   mints a local secret, claims the name "alice" (POST /api/claim), saves config
ccmap push          # one-shot
ccmap start         # resident, pushes every 15 min
```

Auth model: `login` stores `sha256(key)` server-side under `auth:<user>`; the raw key
lives only on the user's machine (`~/.ccmap/config.json`). A name, once claimed, can
only be pushed by the holder of its key. Lose the key = lose the name (v0; no recovery).

Embed the badge anywhere (GitHub README renders SVG natively):

```md
![my coding heatmap](https://ccmap.<you>.workers.dev/u/taotao.svg)
```

### Query params

| param | values | default |
| --- | --- | --- |
| `theme` | `github-dark` `github-light` `tokyo-night` `dracula` `nord` (`dark`/`light` aliases) | `github-dark` |
| `metric` | `tokens` `cost` | `tokens` |
| `weeks` | `1..53` | `26` |
| `hide_border` | `true` `false` | `false` |

Add themes by editing the `THEMES` registry in `src/render.ts` — each is just a
palette, instantly available as `?theme=<name>`.

### Auto light/dark (follow the viewer's GitHub theme)

A single image URL can't detect the viewer's color mode. GitHub's official trick is
`<picture>` with `prefers-color-scheme` — serve two themed URLs and the README swaps
automatically:

```html
<picture>
  <source media="(prefers-color-scheme: dark)"
          srcset="https://ccmap.<you>.workers.dev/u/taotao.svg?theme=github-dark">
  <source media="(prefers-color-scheme: light)"
          srcset="https://ccmap.<you>.workers.dev/u/taotao.svg?theme=github-light">
  <img src="https://ccmap.<you>.workers.dev/u/taotao.svg?theme=github-dark" alt="coding heatmap">
</picture>
```

## Status

- ✅ Local: `scan` / `render` / `login` / `push` / `start` — verified against real logs.
- ✅ Server: Cloudflare Worker (`/api/claim`, `/api/push`, `/u/:user.svg`) — full flow
  verified end-to-end via `wrangler dev` + local KV (claim, per-user auth, badge render).
- ⏳ PNG route (`/u/:user.png`): SVG covers GitHub/Notion/Slack. PNG (for X/Twitter)
  is one dep away — add `@resvg/resvg-wasm` and a `.png` route.
- 💡 Ideas backlog: leaderboard, "AI Wrapped" recap card, model fingerprint, streak-only mini badge.
