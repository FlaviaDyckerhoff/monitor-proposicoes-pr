#!/usr/bin/env bash
set -euo pipefail

ROOT="/root/.openclaw/workspace"
PROJECT="$ROOT/projects/monitor-proposicoes-pr"
ENV_FILE="$ROOT/agents/proposicoes/.env"
LOG_DIR="$ROOT/logs/monitor-proposicoes-pr"
LOCK_FILE="/tmp/monitor-proposicoes-pr.lock"

mkdir -p "$LOG_DIR"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

cd "$PROJECT"

if [[ ! -d node_modules ]]; then
  npm install --omit=dev
fi

flock -n "$LOCK_FILE" node monitor.js
