#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${OS:-}" != "Windows_NT" && "$(uname -s)" != MINGW* && "$(uname -s)" != MSYS* && "$(uname -s)" != CYGWIN* ]]; then
  echo "This script must run on Windows to produce Windows installers." >&2
  echo "Use the GitHub Actions workflow in .github/workflows/build-windows.yml from macOS/Linux." >&2
  exit 1
fi

npm ci
npm run tauri:build:windows

echo
echo "Windows artifacts:"
echo "  src-tauri/target/release/bundle/nsis/*.exe"
echo "  src-tauri/target/release/bundle/msi/*.msi"
