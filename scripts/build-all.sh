#!/usr/bin/env bash
# scripts/build-all.sh
# Build everything and stage the Console into the node so a single ZIRA Core binary serves the GUI.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> protocol"; pnpm build:protocol
echo "==> node";     pnpm build:node
echo "==> console";  pnpm build:console

echo "==> staging Console into node/public (served by the node at its root)"
rm -rf "$ROOT/node/public"
mkdir -p "$ROOT/node/public"
cp -r "$ROOT/apps/console/dist/." "$ROOT/node/public/"

echo "Done. Run a node with:  node node/dist/index.js   then open http://127.0.0.1:8645"
