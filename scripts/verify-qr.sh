#!/usr/bin/env bash
#
# QR round-trip check: encode with PHP, decode with an independent library.
#
# Fully headless — no browser and no server. The encoder prints its matrices as
# JSON and Node decodes them with the vendored jsQR, so this runs in CI.
#
# Node is used here and nowhere else in the project, and only as a test
# harness. If Node is not installed, scripts/qr-roundtrip.php does the same
# check in a browser instead.
#
# Usage: scripts/verify-qr.sh
set -uo pipefail
cd "$(dirname "$0")/.."

if ! command -v node > /dev/null 2>&1; then
  echo "Node is not installed, so the independent decoder cannot run." >&2
  echo "Serve the app and open /qr-roundtrip.php in a browser instead." >&2
  exit 1
fi

php scripts/qr-matrices.php | node scripts/qr-decode.mjs
