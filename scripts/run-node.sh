#!/usr/bin/env bash
# scripts/run-node.sh
# Run a single ZIRA Core node. Pass bootstrap peers via ZIRA_BOOTSTRAP to join an existing network.
# Examples:
#   ZIRA_NETWORK=devnet ZIRA_SEED=1 ZIRA_STEWARD=1 bash scripts/run-node.sh    # local genesis steward
#   ZIRA_BOOTSTRAP=/dns4/seed.zira.network/tcp/9645/p2p/<id> bash scripts/run-node.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -f "$ROOT/node/dist/index.js" ]; then
  echo "Building first..."; ( cd "$ROOT" && pnpm build:node )
fi
exec node "$ROOT/node/dist/index.js"
