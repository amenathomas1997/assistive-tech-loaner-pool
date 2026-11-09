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

# Every route the suite reaches is appended here by Router::dispatch(), which
# does nothing at all unless this variable is set. Compared against the live
# route table at the end of the run: see scripts/verify-route-coverage.php.
ROUTE_LOG="${LP_ROUTE_LOG:-/tmp/loaner-route-coverage.log}"
rm -f "$ROUTE_LOG"
export LOANER_ROUTE_LOG="$ROUTE_LOG"

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

# The two routes that exist only before setup. After the installer runs they
# answer 410 for good, so this is the only moment either can be exercised —
# and the installer is the one screen where a wrong response shape means
# somebody cannot get started at all.
echo "==> Checking the installer's own routes"
INSTALL_CHECKS=0
STATE=$(curl -s "http://localhost:$PORT/api/install/state")
if printf '%s' "$STATE" | grep -q '"installed"'; then
  echo "  ok   the installer reports whether setup has happened"
else
  echo "  FAIL the installer reports whether setup has happened"
  printf '       got: %s\n' "$(printf '%s' "$STATE" | head -c 200)"
  INSTALL_CHECKS=1
fi

# Deliberately wrong credentials: the point is that it answers with a usable
# message rather than a stack trace, which is what somebody setting this up on
# shared hosting will actually hit.
DBTEST=$(curl -s -X POST "http://localhost:$PORT/api/install/test-database" \
  -H 'Content-Type: application/json' \
  -d '{"db_host":"127.0.0.1","db_port":3306,"db_user":"nobody","db_password":"wrong","db_name":"nothing"}')
if printf '%s' "$DBTEST" | grep -qi 'error\|ok'; then
  echo "  ok   the database test answers a bad password without crashing"
else
  echo "  FAIL the database test answers a bad password without crashing"
  printf '       got: %s\n' "$(printf '%s' "$DBTEST" | head -c 200)"
  INSTALL_CHECKS=1
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

# The routes the three suites above never reach. See the header of that file:
# it exists because 49 routes had no test at all, among them the list endpoint
# behind every screen.
echo "==> Running route-coverage suite"
./scripts/e2e-coverage.sh "http://localhost:$PORT"
COVERAGE_SUITE_RESULT=$?

# Who holds what: reservation holds, cancellations, request links and signed
# agreements. See the header of that file for the defects it pins down.
echo "==> Running custody suite"
./scripts/e2e-custody.sh "http://localhost:$PORT"
CUSTODY_RESULT=$?

# Caseload confidentiality, device status integrity, and what bad input gets
# back. See the header of that file.
echo "==> Running boundary suite"
./scripts/e2e-boundaries.sh "http://localhost:$PORT"
BOUNDARY_RESULT=$?

echo "==> Checking the API/UI contract"
./scripts/verify-ui-contract.sh "http://localhost:$PORT"
CONTRACT_RESULT=$?

# Last of the HTTP suites: it enrols and then removes a second factor on the
# administrator, and the coverage suite above asserts that two-factor is off.
echo "==> Running security suite"
./scripts/e2e-security.sh "http://localhost:$PORT"
SECURITY_RESULT=$?

# Needs no server: the security rules that are pure functions, held to a
# table of cases — the lockout window and TOTP steps, which an HTTP test
# cannot make time pass for.
echo "==> Checking security decision tables"
php scripts/verify-security.php
SECURITY_TABLES_RESULT=$?

# Which routes did all of that actually reach? Answers the question the
# suites above cannot: not "does what we test work" but "what are we not
# testing". Runs last, because it needs every suite's requests in the log.
echo "==> Checking API route coverage"
php scripts/verify-route-coverage.php "$ROUTE_LOG"
COVERAGE_RESULT=$?

# Needs no server: it reads the source. The word "null" rendered to a user is
# a defect no end-to-end suite will ever notice, because the request succeeded.
echo "==> Checking for .append(null)"
php scripts/verify-append-safety.php
APPEND_RESULT=$?

# Needs no server: it reads the stylesheet. Kept in this run anyway, because a
# contrast regression is invisible to everything else here.
echo "==> Checking colour contrast"
node scripts/verify-contrast.mjs
CONTRAST_RESULT=$?

# Fail the run if either suite failed. Assigned explicitly rather than through
# a short-circuit, so the exit status of the test itself is not what escapes.
if [ "$RESULT" -eq 0 ]; then RESULT=$FEATURE_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$WAVE3_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$COVERAGE_SUITE_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$CUSTODY_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$BOUNDARY_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$INSTALL_CHECKS; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$CONTRACT_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$CONTRAST_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$COVERAGE_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$APPEND_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$SECURITY_RESULT; fi
if [ "$RESULT" -eq 0 ]; then RESULT=$SECURITY_TABLES_RESULT; fi

exit "$RESULT"
