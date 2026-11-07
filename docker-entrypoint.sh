#!/usr/bin/env bash
# Container start: write cre/.env from the host's environment variables (the CRE CLI reads its secrets from that
# file), then start the Settld server (API + watcher + keeper). Values are never printed.
set -euo pipefail

CRE_ENV=/app/cre/.env
: > "$CRE_ENV"
for k in CRE_ETH_PRIVATE_KEY YOUTUBE_API_KEY_ALL GROQ_API_KEY_ALL GEMINI_API_KEY_ALL NVIDIA_API_KEY_ALL COURT_WRITE_TOKEN_ALL GITHUB_TOKEN_ALL; do
  if [ -n "${!k:-}" ]; then printf '%s=%s\n' "$k" "${!k}" >> "$CRE_ENV"; fi
done
chmod 600 "$CRE_ENV"

if [ -z "${CRE_API_KEY:-}" ]; then
  echo "[start] warning: CRE_API_KEY is not set — the Chainlink workflows can't run (create one at app.chain.link)" >&2
fi
cd /app/server
exec npx tsx src/index.ts
