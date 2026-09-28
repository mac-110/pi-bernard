#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
agent_dir="$(mktemp -d)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$agent_dir" "$work_dir"' EXIT
PI_CODING_AGENT_DIR="$agent_dir" pi install "$PWD" >/dev/null
# Capture output before matching (`pi … | grep -q` can fail with EPIPE), and never let Pi wait for stdin.
models="$(PI_CODING_AGENT_DIR="$agent_dir" pi --list-models bernard </dev/null)"
grep -q 'claude-sonnet-4-6' <<<"$models"
# A real account is optional for CI. When BERNARD_TOKEN is supplied, also test streaming and tool use.
if [[ -n "${BERNARD_TOKEN:-}" ]]; then
  reply="$(PI_CODING_AGENT_DIR="$agent_dir" pi -p --no-session --model bernard/claude-sonnet-4-6 \
    --system-prompt 'Reply with OK only.' 'Test' </dev/null)"
  grep -q 'OK' <<<"$reply"
  # The version exists only in a local file, so the reply must come from a real Pi read tool call.
  version="$((RANDOM % 90 + 10)).$((RANDOM % 90 + 10)).$((RANDOM % 900 + 100))"
  printf '{ "name": "smoke", "version": "%s" }\n' "$version" > "$work_dir/package.json"
  reply="$(cd "$work_dir" && PI_CODING_AGENT_DIR="$agent_dir" pi -p --no-session --no-approve --tools read \
    --model bernard/claude-sonnet-4-6 'Which version is set in package.json? Reply with the version number only.' </dev/null)"
  grep -qF "$version" <<<"$reply"
fi
printf 'smoke test passed\n'
