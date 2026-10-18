#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if command -v uv >/dev/null 2>&1; then
  exec uv run --directory "$SCRIPT_DIR" deploy-linux "$@"
else
  exec node "$SCRIPT_DIR/scripts/deploy.mjs" "$@"
fi
