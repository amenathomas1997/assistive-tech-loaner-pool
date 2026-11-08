#!/usr/bin/env bash
#
# Full verification cycle against a local MySQL/MariaDB.
#
#   1. stop any running instance
#   2. drop and recreate the test database
#   3. remove the config file so the app returns to installer mode
#   4. start the server
#   5. run the web installer through its own API
#   6. run the end-to-end suite
#
# Doing all of it in one script is what makes the suite repeatable: running the
# API tests twice against the same database fails on the second pass for
# uninteresting reasons (duplicate programs, duplicate email addresses), which
# hides the failures that matter.
#
# Usage: scripts/reset-and-test.sh

set -uo pipefail
cd "$(dirname "$0")/.."

DB_HOST="${LP_DB_HOST:-127.0.0.1}"
DB_PORT="${LP_DB_PORT:-3306}"
DB_USER="${LP_DB_USER:-loaner}"
DB_PASS="${LP_DB_PASS:-loanerpooldev}"
DB_NAME="${LP_DB_NAME:-loanerpool_test}"
PORT="${LP_PORT:-3000}"

MYSQL_BIN="${LP_MYSQL_BIN:-}"
if [ -z "$MYSQL_BIN" ]; then
  for candidate in \
    /opt/homebrew/opt/mariadb/bin/mariadb \
    /usr/local/opt/mariadb/bin/mariadb \
    "$(command -v mariadb 2>/dev/null)" \
    "$(command -v mysql 2>/dev/null)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then MYSQL_BIN="$candidate"; break; fi
  done
fi

if [ -z "$MYSQL_BIN" ]; then
  echo "Could not find a mysql or mariadb client. Set LP_MYSQL_BIN to its path." >&2
  exit 1
fi

echo "==> Stopping any running instance"
pkill -f "scripts/dev-router.php" 2>/dev/null
sleep 1

echo "==> Resetting database $DB_NAME"
"$MYSQL_BIN" -u "$DB_USER" -p"$DB_PASS" -h "$DB_HOST" -P "$DB_PORT" -e \
  "DROP DATABASE IF EXISTS \`$DB_NAME\`;
   CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" || exit 1

echo "==> Removing config so the app returns to installer mode"
rm -f data/config.json

echo "==> Starting server on port $PORT"
# PHP's built-in server with the dev router, which mirrors what .htaccess does
# under Apache. Single-threaded by default, so the worker count is raised:
# several endpoints call back into the API, and one request waiting on another
# would deadlock a single worker.
PHP_CLI_SERVER_WORKERS=8 php -S "127.0.0.1:$PORT" -t public scripts/dev-router.php \
  > /tmp/loaner-test-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

# Wait for the health endpoint rather than sleeping a fixed amount.
for _ in $(seq 1 40); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then break; fi
  sleep 0.25
done

if ! curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
  echo "Server did not start. Log:" >&2
  cat /tmp/loaner-test-server.log >&2
  exit 1
fi

echo "==> Running the installer"
INSTALL=$(curl -s -X POST "http://localhost:$PORT/api/install/run" \
  -H 'Content-Type: application/json' \
  -d "{
    \"db_host\": \"$DB_HOST\", \"db_port\": $DB_PORT,
    \"db_user\": \"$DB_USER\", \"db_password\": \"$DB_PASS\", \"db_name\": \"$DB_NAME\",
    \"org_name\": \"Assistive Technology Loaner Pool\",
    \"org_contact_email\": \"at@example.org\",
    \"org_timezone\": \"America/New_York\",
    \"barcode_symbology\": \"qr\", \"barcode_prefix\": \"AT\",
    \"admin_name\": \"Amena Thomas\", \"admin_email\": \"admin@example.org\",
    \"admin_password\": \"correct-horse-battery-7\",
    \"admin_password_confirm\": \"correct-horse-battery-7\",
    \"base_url\": \"http://localhost:$PORT\"
  }")

if ! printf '%s' "$INSTALL" | grep -q '"ok":true'; then
  echo "Installer failed:" >&2
  printf '%s\n' "$INSTALL" >&2
  exit 1
fi
echo "    installed"

echo "==> Running barcode encoder checks"
php scripts/verify-barcode.php || exit 1

echo "==> Running end-to-end API suite"
./scripts/e2e.sh "http://localhost:$PORT"
RESULT=$?

echo "==> Running feature suite"
./scripts/e2e-features.sh "http://localhost:$PORT"
FEATURE_RESULT=$?

echo "==> Running third-wave suite"
./scripts/e2e-wave3.sh "http://localhost:$PORT"
WAVE3_RESULT=$?

echo "==> Checking the API/UI contract"
./scripts/verify-ui-contract.sh "http://localhost:$PORT"
CONTRACT_RESULT=$?

# Fail the run if either suite failed. Assigned explicitly rather than through
# a short-circuit, so the exit status of the test itself is not what escapes.
if [ "$RESULT" -eq 0 ]; then RESULT=$FEATURE_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$WAVE3_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$CONTRACT_RESULT; fi

exit "$RESULT"
