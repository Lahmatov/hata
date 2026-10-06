#!/bin/bash
# Daily entry point (used by launchd). Loads .env, runs the monitor, keeps logs in ./logs.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
mkdir -p logs
exec npx tsx src/main.ts "$@" >> "logs/launchd.out.log" 2>&1
