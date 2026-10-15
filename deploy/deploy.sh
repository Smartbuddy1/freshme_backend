#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f deploy/.env || ! -f .env.production ]]; then
  echo 'Configure deploy/.env and .env.production first; see deploy/EC2.md.' >&2
  exit 1
fi
chmod 600 deploy/.env .env.production
compose=(docker compose --env-file deploy/.env)
"${compose[@]}" config --quiet
"${compose[@]}" build app
"${compose[@]}" run --rm --no-deps app node scripts/preflight.js "$@"
"${compose[@]}" run --rm --no-deps app node scripts/database.js --migrate
"${compose[@]}" run --rm --no-deps app node src/seed.js
"${compose[@]}" up -d --wait --wait-timeout 180
"${compose[@]}" ps
