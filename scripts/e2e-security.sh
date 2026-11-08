#!/usr/bin/env bash
#
# The security findings from the November 2026 audit, each reproduced over
# HTTP before it was fixed and asserted here so it cannot quietly come back.
#
#   - X-Forwarded-For was believed by default: any visitor could choose what
#     address the audit log recorded.
#   - A cookie-authenticated write from a page on another site was accepted.
#     SameSite=Lax does not cover a sibling subdomain, which on shared hosting
#     is whatever else the owner has put under the same domain.
#   - The failed-sign-in count never reset after a lockout expired, so one
#     wrong password every fifteen minutes kept an account locked for good.
#     (The expiry half is in scripts/verify-security.php, which can make time
#     pass; the lock itself is proved here.)
#   - A spreadsheet export carried a name typed as =HYPERLINK(...) straight
#     into Excel.
#   - A database backup included live session ids — signed-in browsers for
#     fourteen days — in a file that gets emailed and left on laptops.
#   - A two-factor code was accepted any number of times inside its window.
#   - The session cookie was Secure only if a config flag said so, not when
#     the request itself arrived over TLS; and there was no HSTS.
#
# Runs last of the HTTP suites: it enrols and then removes a second factor on
# the administrator account, and other suites assert that it is off.
#
# Usage: scripts/e2e-security.sh [base-url]

set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-http://localhost:3000}"
JAR=$(mktemp)
FAILURES=0

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; FAILURES=$((FAILURES + 1)); }

check() {
  # See the note in e2e.sh about pipefail, grep -q and SIGPIPE.
  if grep -q -- "$3" <<< "$2"; then pass "$1"; else fail "$1" "got: $(printf '%s' "$2" | head -c 240)"; fi
}
check_not() {
  if grep -q -- "$3" <<< "$2"; then fail "$1" "got: $(printf '%s' "$2" | head -c 240)"; else pass "$1"; fi
}
# Case-insensitive variants, for HTTP headers: PHP writes "HttpOnly" and
# "secure", curl may show either case, and a header name is case-insensitive
# by definition. (An earlier version passed -i as the pattern, which made
# grep look for the two characters "-i" — present in every response, inside
# the CSP's 'unsafe-inline' — so every positive check passed for nothing.)
checki() {
  if grep -qi -- "$3" <<< "$2"; then pass "$1"; else fail "$1" "got: $(printf '%s' "$2" | head -c 240)"; fi
}
check_noti() {
  if grep -qi -- "$3" <<< "$2"; then fail "$1" "got: $(printf '%s' "$2" | head -c 240)"; else pass "$1"; fi
}

jqv() {
  python3 -c '
import sys, json, re
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for key in re.findall(r"\[([^\]]+)\]", sys.argv[1]):
    key = key.strip().strip("\x27\"")
    try:
        data = data[int(key)] if key.lstrip("-").isdigit() else data[key]
    except Exception:
        sys.exit(0)
print("" if data is None else data)
' "$1" 2>/dev/null
}

api() {
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -s -b "$JAR" -c "$JAR" -X "$method" "$BASE$path" -H 'Content-Type: application/json' -d "$data"
  else
    curl -s -b "$JAR" -c "$JAR" -X "$method" "$BASE$path"
  fi
}

# Status code alone.
api_status() {
  curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$1" "$BASE$2" "${@:3}"
}

ORIGIN_SELF="$BASE"   # e.g. http://localhost:3000 — the application's own origin

api POST /api/v1/auth/login '{"email":"admin@example.org","password":"correct-horse-battery-7"}' > /dev/null

echo
echo "Which address the audit log records"

# A fresh sign-in carrying a forged header, from a second jar so the main
# session is undisturbed.
FORGED=$(mktemp)
curl -s -c "$FORGED" -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 203.0.113.77' \
  -d '{"email":"admin@example.org","password":"correct-horse-battery-7"}' > /dev/null
rm -f "$FORGED"

OUT=$(api GET '/api/v1/audit?per_page=1')
check "the latest audit entry is that sign-in" "$OUT" '"auth.login"'
check_not "and does not carry the forged address" "$OUT" "203.0.113.77"

echo
echo "Where a write may come from"

STATUS=$(api_status POST /api/v1/scan/channels -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example' -d '{"label":"cross-site probe"}')
[ "$STATUS" = "403" ] && pass "a write from another site is refused" \
  || fail "a write from another site is refused" "expected 403, got $STATUS"

OUT=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/scan/channels" -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example' -d '{"label":"cross-site probe"}')
check "and says why" "$OUT" "cross_site_request"

STATUS=$(api_status POST /api/v1/scan/channels -H 'Content-Type: application/json' \
  -H 'Origin: https://other.example.org' -d '{"label":"sibling probe"}')
[ "$STATUS" = "403" ] && pass "so is one from a sibling subdomain, which SameSite would allow" \
  || fail "so is one from a sibling subdomain, which SameSite would allow" "expected 403, got $STATUS"

STATUS=$(api_status POST /api/v1/scan/channels -H 'Content-Type: application/json' \
  -H 'Origin: null' -d '{"label":"opaque probe"}')
[ "$STATUS" = "403" ] && pass "an opaque origin is refused" \
  || fail "an opaque origin is refused" "expected 403, got $STATUS"

STATUS=$(api_status POST /api/v1/scan/channels -H 'Content-Type: application/json' \
  -H "Origin: $ORIGIN_SELF" -d '{"label":"same-origin probe"}')
[ "$STATUS" = "201" ] && pass "the application's own pages are not affected" \
  || fail "the application's own pages are not affected" "expected 201, got $STATUS"

STATUS=$(api_status POST /api/v1/scan/channels -H 'Content-Type: application/json' \
  -d '{"label":"no-origin probe"}')
[ "$STATUS" = "201" ] && pass "a client that sends no Origin (curl, scripts) is not affected" \
  || fail "a client that sends no Origin (curl, scripts) is not affected" "expected 201, got $STATUS"

STATUS=$(api_status GET /api/v1/devices -H 'Origin: https://evil.example')
[ "$STATUS" = "200" ] && pass "reads are not affected — only writes can do harm" \
  || fail "reads are not affected — only writes can do harm" "expected 200, got $STATUS"

# A bearer token is not something a browser sends on another site's behalf,
# so the check must not touch API keys.
OUT=$(api POST /api/v1/admin/api-keys '{"name":"Security suite","scopes":["write"]}')
KEY=$(jqv "['key']" <<< "$OUT")
KEY_ID=$(jqv "['api_key']['id']" <<< "$OUT")
OUT=$(curl -s -X POST "$BASE/api/v1/devices/backfill-barcodes" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -d '{}')
check "an API key with a foreign Origin is still served" "$OUT" '"assigned"'
[ -n "$KEY_ID" ] && api DELETE "/api/v1/admin/api-keys/$KEY_ID" > /dev/null

echo
echo "Failed sign-ins"

api POST /api/v1/users \
  '{"email":"lockout@example.org","full_name":"Lock Out","role":"viewer","password":"lockout-Secret-2026"}' > /dev/null

LOCK_JAR=$(mktemp)
for i in 1 2 3 4 5 6 7 8; do
  curl -s -c "$LOCK_JAR" -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"lockout@example.org","password":"wrong-'"$i"'"}' > /dev/null
done

OUT=$(curl -s -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"lockout@example.org","password":"wrong-9"}')
check "eight misses lock the account" "$OUT" "account_locked"
check "and the message says until when" "$OUT" "Try again after"

OUT=$(curl -s -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"lockout@example.org","password":"lockout-Secret-2026"}')
check "the right password does not get in while it is locked" "$OUT" "account_locked"
rm -f "$LOCK_JAR"
# What happens after the fifteen minutes is in scripts/verify-security.php:
# the count starts fresh, rather than the next miss re-locking the account.

echo
echo "Spreadsheet exports"

OUT=$(api POST /api/v1/devices \
  '{"name":"=HYPERLINK(\"http://evil.example\",\"click\")","category":"Export probe"}')
PROBE_ID=$(jqv "['device']['id']" <<< "$OUT")
check "a device can be named with a formula — the name is just text here" "$OUT" '"device"'

CSV=$(api GET '/api/v1/devices/export.csv?search=HYPERLINK')
check "the export carries the name" "$CSV" "HYPERLINK"
check "prefixed so a spreadsheet reads it as text" "$CSV" "'=HYPERLINK"
check_not "and never as a bare formula" "$CSV" ',=HYPERLINK'

[ -n "$PROBE_ID" ] && api DELETE "/api/v1/devices/$PROBE_ID" > /dev/null

echo
echo "Backups"

# The whole dump, held in memory and never written to disk.
DUMP=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/admin/backup" --data-urlencode 'password=correct-horse-battery-7')
check "a backup streams as SQL" "$DUMP" 'Loaner Pool database backup'
check "it ends with the completeness marker" "$DUMP" 'Backup complete'
check "ordinary tables carry their rows" "$DUMP" 'INSERT INTO `users`'
check "the sessions table is created" "$DUMP" 'CREATE TABLE `sessions`'
check_not "but no live session id is in the file" "$DUMP" 'INSERT INTO `sessions`'
check_not "nor any reset token" "$DUMP" 'INSERT INTO `password_resets`'
check "and it says so" "$DUMP" 'rows deliberately not included'
unset DUMP

OUT=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/admin/backup" --data-urlencode 'password=wrong')
check "the wrong password gets nothing" "$OUT" "not correct"

echo
echo "Two-factor codes work once"

# Codes are computed for explicit thirty-second steps so the test is not at
# the mercy of the clock. If the current step is nearly over, wait for the
# next so that the step after it is still inside the server's window later.
NOW=$(date +%s)
if [ $(( NOW % 30 )) -gt 20 ]; then sleep $(( 30 - NOW % 30 )); NOW=$(date +%s); fi
STEP=$(( NOW / 30 ))
code_for_step() { php -r "require 'app/bootstrap.php'; echo Loaner\\Totp::codeAt('$1', $(( $2 * 30 + 15 )));"; }

OUT=$(api POST /api/v1/auth/2fa/begin '{}')
SECRET=$(jqv "['secret']" <<< "$OUT")
CODE_S=$(code_for_step "$SECRET" "$STEP")
CODE_S1=$(code_for_step "$SECRET" $(( STEP + 1 )))

OUT=$(api POST /api/v1/auth/2fa/confirm "{\"code\":\"$CODE_S\"}")
check "enrolment accepts the current code" "$OUT" '"enabled": *true'
RECOVERY=$(jqv "['recovery_codes'][0]" <<< "$OUT")

curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/logout" > /dev/null
OUT=$(curl -s -c "$JAR" -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.org","password":"correct-horse-battery-7"}')
PENDING=$(jqv "['pending_id']" <<< "$OUT")

OUT=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/auth/login/verify" -H 'Content-Type: application/json' \
  -d "{\"pending_id\":\"$PENDING\",\"code\":\"$CODE_S\"}")
check "the code that proved the app works cannot also sign you in" "$OUT" "not right"

OUT=$(curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/login/verify" -H 'Content-Type: application/json' \
  -d "{\"pending_id\":\"$PENDING\",\"code\":\"$CODE_S1\"}")
check "the next step's code does" "$OUT" '"capabilities"'

curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/logout" > /dev/null
OUT=$(curl -s -c "$JAR" -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.org","password":"correct-horse-battery-7"}')
PENDING=$(jqv "['pending_id']" <<< "$OUT")

OUT=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/auth/login/verify" -H 'Content-Type: application/json' \
  -d "{\"pending_id\":\"$PENDING\",\"code\":\"$CODE_S1\"}")
check "and, once used, is refused if presented again" "$OUT" "not right"

# Back in with a recovery code, which does not depend on the clock, to leave
# the account as it was found.
OUT=$(curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/login/verify" -H 'Content-Type: application/json' \
  -d "{\"pending_id\":\"$PENDING\",\"code\":\"$RECOVERY\"}")
check "a recovery code still gets the owner back in" "$OUT" '"used_recovery_code": *true'

OUT=$(api POST /api/v1/auth/2fa/disable '{"password":"correct-horse-battery-7"}')
check "two-factor is turned back off for the suites that follow" "$OUT" '"enabled": *false'

echo
echo "Cookie flags and transport"

HEADERS=$(curl -s -D - -o /dev/null -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.org","password":"correct-horse-battery-7"}')
checki "the session cookie is HttpOnly" "$HEADERS" 'httponly'
checki "and SameSite" "$HEADERS" 'samesite=lax'
check_noti "over plain HTTP it is not marked Secure, or nobody could sign in on a dev server" "$HEADERS" '; *secure'
check_noti "and no HSTS is promised over plain HTTP" "$HEADERS" 'strict-transport-security'

HEADERS=$(curl -s -D - -o /dev/null -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -H 'X-Forwarded-Proto: https' \
  -d '{"email":"admin@example.org","password":"correct-horse-battery-7"}')
checki "a request that arrived over TLS gets a Secure cookie whatever the config says" "$HEADERS" '; *secure'
checki "and an HSTS header" "$HEADERS" 'strict-transport-security: max-age=31536000'
check_noti "that does not speak for other subdomains" "$HEADERS" 'includesubdomains'

rm -f "$JAR"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All security checks passed."
  exit 0
fi
echo "$FAILURES security check(s) FAILED."
exit 1
