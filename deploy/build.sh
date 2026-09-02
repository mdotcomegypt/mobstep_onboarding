#!/usr/bin/env bash
#
# Builds both packages for deployment. Run on a machine with the toolchain;
# ship server/dist, web/dist, server/node_modules and .env to the server.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "▶ installing"
pnpm install --frozen-lockfile

echo "▶ typechecking"
pnpm typecheck

echo "▶ building"
pnpm build

echo "✓ server/dist and web/dist are ready"
