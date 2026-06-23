# Changelog

All notable changes to **ccmap** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions track the npm
package version (each release is tagged `vX.Y.Z` in git).

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

[0.1.0]: https://github.com/tao-hpu/ccmap/releases/tag/v0.1.0
