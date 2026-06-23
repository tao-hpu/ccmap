# Changelog

All notable changes to **ccmap** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions track the npm
package version (each release is tagged `vX.Y.Z` in git).

## [0.1.9] — 2026-06-23

### Changed
- **Portrait/download card now defaults to 26 weeks** (a chunkier, fuller "recent
  half-year" strip) and honors the customizer's week selector — the download link
  passes `&weeks=`, so what you pick is what you get. The wide X/OG card stays
  full-year (it fills the landscape strip edge-to-edge).
- **Emoji → inline SVG icons.** The CTA rocket and the sticky "Get your own"
  lightning/arrow are now crisp SVG icons (plus a GitHub mark on the CTA button)
  instead of emoji, for consistent rendering across platforms.

### Added
- A **copy button** on the `npm i -g @tao-hpu/ccmap` command in the CTA.

## [0.1.8] — 2026-06-23

### Added
- **Scannable QR on the portrait share card.** The downloadable portrait PNG now
  embeds a crisp QR code (zero-dependency encoder, `src/qr.ts`) linking straight
  back to the live report — scan it from a phone to open the page. Verified
  end-to-end (jsQR decode of the rasterized PNG).

### Changed
- **Cleaner report UI.** Removed all drop-shadows / glow (buttons, tooltip,
  sticky pill) and the CTA gradient for a flat, calmer look. The "Post on X" and
  "Download" buttons now share one height and baseline so they line up exactly.
- The download button is **English-only** ("Download card", with a download
  glyph) — no more mixed-script label.

## [0.1.7] — 2026-06-23

### Added
- **Downloadable portrait share card** (1080×1350, heatmap included) for X /
  朋友圈 / stories — a "Download" button in the report; also at
  `/u/<user>.png?shape=portrait`.
- **"Get your own" CTA everywhere** — a persistent sticky button plus a prominent
  call-to-action section (GitHub button + `npm i -g` install) so a visitor can
  grab their own heatmap in one click.
- A big **"Post on X"** button; every share link now carries a fresh cache-bust
  tag so X always unfurls the latest card instead of a stale one.

## [0.1.6] — 2026-06-23

### Added
- **Tier ladder** in the report rank card — all six ranks shown as pixel sprites
  with their token thresholds; your current tier is highlighted, locked tiers
  dimmed, each hover shows "how far to go".

### Changed
- **Richer social card.** The `/u/<user>.png` OG image now also embeds your actual
  full-year heatmap plus a call-to-action footer (`npm i -g @tao-hpu/ccmap` ·
  ccmap.fim.ai · github). OG/Twitter title & description gained emoji, a per-tier
  badge, and a "see your own" prompt so the unfurl reads as an invite, not a label.

## [0.1.5] — 2026-06-23

### Changed
- The social/OG image (`/u/<user>.png`) is now a bespoke **tier-mascot card**: the
  user's pixel-art rank sprite as the hero, rank title, headline stats, and
  next-tier progress — far more shareable than the raw heatmap grid. The heatmap
  badge is still available at `/u/<user>.png?card=badge`.

## [0.1.4] — 2026-06-23

### Added
- `ccmap start` now registers an **OS-level scheduled job** (launchd on macOS,
  cron elsewhere) instead of holding a foreground loop — it survives logout/reboot
  with no terminal attached, and needs no `save`. New `ccmap stop` / `ccmap status`;
  `ccmap start --foreground` keeps the old attached loop for containers/debugging.
- **Social cards.** Report pages emit full Open Graph + Twitter Card tags, and the
  server gained a `/u/<user>.png` route (rasterized badge via resvg) so X/Twitter,
  Slack, etc. render a real preview image instead of a bare link.

### Fixed
- Social tags now use the reverse proxy's `https` origin (was `http://`).

## [0.1.3] — 2026-06-23

### Fixed
- `ccmap update` (and the `ccmap start` daily check) used Node's global `fetch`
  to read the registry, which ignores proxy settings — so it failed with
  "could not reach npm registry" behind a corporate proxy / VPN even when `npm`
  itself worked. It now shells out to `npm view`, which honors the user's
  proxy/registry config.

## [0.1.2] — 2026-06-23

### Fixed
- CLI version was a hardcoded constant that `npm version` didn't touch, so 0.1.1
  reported itself as `0.1.0` and the update check nagged endlessly. Version is now
  read from `package.json` at runtime and can never drift again.

## [0.1.1] — 2026-06-23

Zero-config `ccmap push`: a public badge service is now live and baked in.

### Added
- **Public hosted endpoint** `https://ccmap.fim.ai` baked into the CLI as the
  default — `ccmap push` works out of the box with no `--endpoint`.
- **Node badge server** (`src/server.ts`): a zero-dependency `node:http` port of
  the Cloudflare Worker with a JSON-file store and atomic, flush-on-shutdown
  persistence. Same routes and trust-on-first-use auth.

### Changed
- `DEFAULT_ENDPOINT` now points at `https://ccmap.fim.ai` (override with
  `CCMAP_ENDPOINT` or `ccmap login --endpoint`).
- Clearer message when no endpoint is configured.

## [0.1.0] — 2026-06-23

First public release.

### CLI
- `ccmap scan` — summarize local Claude Code + Codex usage (tokens, est. cost,
  streak, model mix) with a true-color terminal heatmap. Fully local, no upload.
- `ccmap render` — render a GitHub-style heatmap SVG, with themes
  (`claude`, `claude-light`, `github-dark/light`, `tokyo-night`, `dracula`,
  `nord`), animations (`ember` / `wave` / `cascade`), `--metric`, `--weeks`,
  and `--hide-border`.
- `ccmap report` — a full shareable HTML report: rank card with pixel-art tiers,
  headline stats, calendar heatmap, daily/cumulative/weekday-radar/model charts,
  a Claude-vs-Codex donut, interactive hover tooltips, and a live embed
  customizer with copy-paste snippets (incl. adaptive light/dark `<picture>`).
- `ccmap push` — publish per-day aggregates to a badge endpoint. First run picks
  a public username: prompts on a terminal (default = OS name), or takes
  `--user` / `CCMAP_USER`; non-interactive runs use the default silently.
- `ccmap start` — resident daemon, pushes on an interval and checks for updates.
- `ccmap login` — claim a specific username / point at your own server.
- `ccmap config`, `ccmap update`, `ccmap version`.

### Server
- Cloudflare Worker (`server/`): `POST /api/claim`, `POST /api/push`,
  `GET /u/:user.svg` (badge), `GET /u/:user` (HTML report). Per-user auth via
  `sha256(key)`; only aggregate counts and model names are stored.

### Privacy
- Only per-day token/cost counts and model names ever leave the machine — never
  prompts, code, or project names.

[0.1.9]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.9
[0.1.8]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.8
[0.1.7]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.7
[0.1.6]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.6
[0.1.5]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.5
[0.1.4]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.4
[0.1.3]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.3
[0.1.2]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.2
[0.1.1]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.1
[0.1.0]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.0
