#!/usr/bin/env bash
#
# Runs the QR round-trip check. Copies the harness into the document root for
# the duration, then removes it — it is a test, not part of the application,
# and must never be left reachable on a deployed site.
set -uo pipefail
cd "$(dirname "$0")/.."

cp scripts/qr-roundtrip.php public/qr-roundtrip.php
trap 'rm -f public/qr-roundtrip.php' EXIT

echo "Serving at http://127.0.0.1:8080/qr-roundtrip.php"
echo "Open it in a browser; the title reads QR OK or QR FAIL."
php -S 127.0.0.1:8080 -t public scripts/dev-router.php
