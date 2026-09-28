#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
agent_dir="$(mktemp -d)"
trap 'rm -rf "$agent_dir"' EXIT
PI_CODING_AGENT_DIR="$agent_dir" pi install "$PWD" >/dev/null
PI_CODING_AGENT_DIR="$agent_dir" pi --list-models bernard | grep -q 'claude-sonnet-4-6'
# A real account is optional for CI. When BERNARD_TOKEN is supplied, also test streaming.
if [[ -n "${BERNARD_TOKEN:-}" ]]; then
  PI_CODING_AGENT_DIR="$agent_dir" pi -p --no-session --model bernard/claude-sonnet-4-6 \
    --system-prompt 'Reply with OK only.' 'Test' | grep -q 'OK'
fi
printf 'smoke test passed\n'
