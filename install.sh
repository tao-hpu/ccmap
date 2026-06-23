#!/usr/bin/env sh
# ccmap installer (npm wrapper).
# Usage:  curl -fsSL https://<your-host>/install.sh | sh
#
# This is a thin wrapper: it checks for Node/npm and then runs the normal
# `npm i -g ccmap`. No native binary, no extra magic — just a friendly one-liner.
#
# Override the package name (e.g. if you publish scoped):
#   CCMAP_PKG=@you/ccmap  curl -fsSL https://<host>/install.sh | sh

set -e

PKG="${CCMAP_PKG:-ccmap}"
MIN_NODE_MAJOR=18

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }

# 1. Node present?
if ! command -v node >/dev/null 2>&1; then
  red "Node.js is not installed."
  echo "ccmap needs Node.js >= ${MIN_NODE_MAJOR}. Install it, then re-run this script:"
  echo "  • macOS:  brew install node"
  echo "  • or:     https://nodejs.org/  (or use nvm / fnm)"
  exit 1
fi

# 2. Node version OK?
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  red "Node.js $(node -v) is too old (need >= ${MIN_NODE_MAJOR})."
  echo "Upgrade Node and re-run this script."
  exit 1
fi

# 3. npm present?
if ! command -v npm >/dev/null 2>&1; then
  red "npm not found (it normally ships with Node)."
  echo "Reinstall Node.js so npm is available, then re-run."
  exit 1
fi

# 4. Install / update
green "Installing ${PKG} globally via npm ..."
if npm install -g "${PKG}@latest"; then
  echo
  green "Done. ccmap $(ccmap version 2>/dev/null || echo '') is installed."
  echo "Next steps:"
  echo "  ccmap scan                                   # see your local usage"
  echo "  ccmap login --user <name> --endpoint <url>   # claim your badge"
  echo "  ccmap start                                  # resident, pushes on a timer"
else
  echo
  red "Install failed."
  dim "If it's a permissions error (EACCES), either fix npm's global prefix"
  dim "or run with a Node version manager (nvm/fnm) that owns its own prefix."
  dim "Manual fallback:  npm i -g ${PKG}@latest"
  exit 1
fi
