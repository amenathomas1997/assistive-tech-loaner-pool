#!/usr/bin/env bash
#
# The routes nothing else touches.
#
# This suite exists because scripts/verify-route-coverage.php found that 49 of
# the 169 API routes were never reached by any test — and among them were the
# list endpoints behind whole screens: GET /loans, GET /requests, GET /kits,
# GET /repairs, GET /programs.
#
# That is not an accident of this project. The other suites were written by
# following what a day of use looks like, which means they exercise the actions
# — check out, check in, approve, deny — and skip the reads, because a human
# testing by hand sees the list on the way past and never thinks to assert it.
# A machine does not see it at all.
#
# It is also exactly how the Reports screen shipped broken: GET /reports
# returned a shape nothing on the screen could read, every card showed an
# error, and no test anywhere touched the route.
#
# So the assertions here are deliberately about *shape*, not status. A 200 that
# returns the wrong field names is the failure this is for, and `check 200`
# would have passed on the broken Reports screen too.
#
# Assumes scripts/e2e.sh has already run against the same instance, so there is
# data to read.
#
# Usage: scripts/e2e-coverage.sh [base-url]

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

# The status code alone, for the routes that answer 204 and therefore have no
# body to grep.
api_status() {
  local method="$1" path="$2"
  curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$method" "$BASE$path"
}

api POST /api/v1/auth/login '{"email":"admin@example.org","password":"correct-horse-battery-7"}' > /dev/null

echo
echo "What the API says it is"

OUT=$(api GET /api/v1/)
check "the API root names itself" "$OUT" '"name"'

OUT=$(api GET /api/v1/version)
check "version reports the application version" "$OUT" '"app_version"'
check "version reports the schema version" "$OUT" '"schema_version"'

OUT=$(api GET /api/v1/openapi.json)
check "the OpenAPI description is generated" "$OUT" '"openapi"'
check "and describes paths" "$OUT" '"paths"'

echo
echo "The lists behind the screens"
# Each of these is the first request a screen makes. Every one was untested.

OUT=$(api GET /api/v1/loans)
check "loans list returns rows" "$OUT" '"data"'
check "a loan row carries its reference" "$OUT" '"reference"'
check "a loan row carries its due date" "$OUT" '"due_at"'
check "a loan row names the device" "$OUT" '"device_name"'

OUT=$(api GET /api/v1/loans/overdue)
check "overdue loans is its own list" "$OUT" '"data"'
check "and reports a total" "$OUT" '"total"'

OUT=$(api GET /api/v1/loans/due-soon)
check "due-soon says what window it used" "$OUT" '"within_days"'

OUT=$(api GET /api/v1/requests)
check "requests list returns rows" "$OUT" '"data"'
check "a request row carries its reference" "$OUT" '"reference"'

OUT=$(api GET /api/v1/requests/meta)
check "request meta offers delivery modes" "$OUT" '"delivery_modes"'

OUT=$(api GET /api/v1/programs)
check "programs list returns rows" "$OUT" '"data"'

OUT=$(api GET /api/v1/kits)
check "kits list returns rows" "$OUT" '"data"'

OUT=$(api GET /api/v1/repairs)
check "repairs list returns rows" "$OUT" '"data"'

OUT=$(api GET /api/v1/repairs/meta)
check "repair meta offers statuses" "$OUT" '"statuses"'

OUT=$(api GET /api/v1/reservations)
check "reservations list returns rows" "$OUT" '"data"'

OUT=$(api GET /api/v1/audit/actions)
check "the audit filter offers its actions" "$OUT" '"data"'

OUT=$(api GET /api/v1/devices/facets)
check "device facets drive the filters" "$OUT" '"categories"'

OUT=$(api GET /api/v1/devices/import/history)
check "import history returns rows" "$OUT" '"data"'

OUT=$(api GET /api/v1/admin/loan-periods)
check "loan periods are listed" "$OUT" '"data"'

OUT=$(api GET /api/v1/admin/api-keys)
check "api keys are listed" "$OUT" '"data"'

OUT=$(api GET /api/v1/admin/settings/email-log)
check "the email log is readable" "$OUT" '"data"'

OUT=$(api GET /api/v1/agreements/audit/missing)
check "loans with no signed agreement are listed" "$OUT" '"rows"'

echo
echo "Single records"

CLIENT_ID=$(api GET /api/v1/clients | jqv "['data'][0]['id']")
OUT=$(api GET "/api/v1/clients/$CLIENT_ID")
check "one client reads back" "$OUT" '"client"'

OUT=$(api GET "/api/v1/clients/$CLIENT_ID/outcomes")
check "a client's loan outcomes read back" "$OUT" '"data"'

PROGRAM_ID=$(api GET /api/v1/programs | jqv "['data'][0]['id']")
OUT=$(api GET "/api/v1/programs/$PROGRAM_ID")
check "one program reads back" "$OUT" '"program"'

OUT=$(api GET /api/v1/users/1)
check "one staff member reads back" "$OUT" '"user"'
check_not "and never carries a password hash" "$OUT" 'password_hash'

SITE_ID=$(api GET /api/v1/sites | jqv "['data'][0]['id']")
OUT=$(api GET "/api/v1/sites/$SITE_ID")
check "one site reads back" "$OUT" '"site"'

BARCODE=$(api GET /api/v1/devices | jqv "['data'][0]['barcode']")
OUT=$(api GET "/api/v1/devices/lookup/$BARCODE")
check "a barcode finds its device" "$OUT" "$BARCODE"

LOAN_ID=$(api GET /api/v1/loans | jqv "['data'][0]['id']")
OUT=$(api GET "/api/v1/agreements/$LOAN_ID")
check "a loan's agreement state reads back" "$OUT" '"settings"'

echo
echo "Exports"

OUT=$(api GET /api/v1/reports/devices.csv)
check "the device report exports as CSV" "$OUT" '^barcode,name,category'

echo
echo "Edits nothing else makes"

OUT=$(api PATCH "/api/v1/clients/$CLIENT_ID" '{"notes":"Checked by the coverage suite."}')
check "a client can be edited" "$OUT" "Checked by the coverage suite."

OUT=$(api PATCH "/api/v1/programs/$PROGRAM_ID" '{"description":"Edited by the coverage suite."}')
check "a program can be edited" "$OUT" "Edited by the coverage suite."

KIT_ID=$(api GET /api/v1/kits | jqv "['data'][0]['id']")
OUT=$(api PATCH "/api/v1/kits/$KIT_ID" '{"name":"Assessment kit A (renamed)"}')
check "a kit can be renamed" "$OUT" "renamed"

OUT=$(api PATCH "/api/v1/sites/$SITE_ID" '{"name":"Tulsa office (renamed)"}')
check "a site can be renamed" "$OUT" "renamed"

PERIOD_ID=$(api GET /api/v1/admin/loan-periods | jqv "['data'][0]['id']")
OUT=$(api PATCH "/api/v1/admin/loan-periods/$PERIOD_ID" '{"days":45}')
check "a loan period can be changed" "$OUT" '45'

echo
echo "Barcodes"

OUT=$(api POST /api/v1/devices/backfill-barcodes '{}')
check "backfill reports how many it assigned" "$OUT" '"assigned"'

DEVICE_ID=$(api GET /api/v1/devices | jqv "['data'][0]['id']")
OLD_BARCODE=$(api GET "/api/v1/devices/$DEVICE_ID" | jqv "['device']['barcode']")
OUT=$(api POST "/api/v1/devices/$DEVICE_ID/reassign-barcode" '{}')
NEW_BARCODE=$(jqv "['device']['barcode']" <<< "$OUT")

check "a damaged label can be reissued" "$OUT" '"barcode"'
if [ -n "$NEW_BARCODE" ] && [ "$NEW_BARCODE" != "$OLD_BARCODE" ]; then
  pass "and the barcode actually changes"
else
  fail "and the barcode actually changes" "was $OLD_BARCODE, now $NEW_BARCODE"
fi
# The response is read by nobody — public/js/views/devices.js just re-renders
# — but the notice is what an integrator building against this API sees, and
# a device going back on the shelf under its old label is a device that
# cannot be found again.
check "and it says to print the new label" "$OUT" "before putting it back on the shelf\|Print and apply"

# The old barcode must stop resolving, or two labels point at one device.
OUT=$(api GET "/api/v1/devices/lookup/$OLD_BARCODE")
check "the old barcode no longer finds it" "$OUT" '"error"'

OUT=$(api GET "/api/v1/devices/lookup/$NEW_BARCODE")
check "the new one does" "$OUT" "$NEW_BARCODE"

echo
echo "Transfers between sites"

OUT=$(api GET /api/v1/transfers)
TRANSFER_ID=$(jqv "['data'][0]['id']" <<< "$OUT")
if [ -n "$TRANSFER_ID" ]; then
  OUT=$(api GET "/api/v1/transfers/$TRANSFER_ID")
  check "one transfer reads back" "$OUT" '"transfer"'
else
  fail "one transfer reads back" "no transfer exists to read; e2e-wave3.sh should have created one"
fi

# A transfer that is sent and then called back before it arrives — the
# equivalent of catching the courier at the door. Nothing else tests the
# cancellation; wave 3 only tests the receiving end.
DEV_X=$(api GET '/api/v1/devices?status=available' | jqv "['data'][0]['id']")
SITE_OTHER=$(api GET /api/v1/sites | jqv "['data'][-1]['id']")

if [ -n "$DEV_X" ] && [ -n "$SITE_OTHER" ]; then
  OUT=$(api POST /api/v1/transfers "{\"device_id\":$DEV_X,\"to_site_id\":$SITE_OTHER}")
  PENDING=$(jqv "['transfer']['id']" <<< "$OUT")

  OUT=$(api POST "/api/v1/transfers/$PENDING/cancel" '{"reason":"Called back by the coverage suite."}')
  check "a transfer in flight can be called back" "$OUT" '"cancelled"'
else
  fail "a transfer in flight can be called back" "no available device or second site to transfer between"
fi

echo
echo "Moving a loan to somebody else"
# A device already out, handed from one person to another without coming back
# to the shelf first — which is what actually happens when a program ends and
# the equipment stays with the participant.

DEV_T=$(api GET '/api/v1/devices?status=available' | jqv "['data'][0]['id']")
CLIENT_B=$(api GET /api/v1/clients | jqv "['data'][1]['id']")
OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEV_T,\"client_id\":$CLIENT_ID}")
OPEN_LOAN=$(jqv "['loan']['id']" <<< "$OUT")

if [ -n "$OPEN_LOAN" ] && [ -n "$CLIENT_B" ]; then
  OUT=$(api POST "/api/v1/loans/$OPEN_LOAN/transfer" \
    "{\"client_id\":$CLIENT_B,\"reason\":\"Moved by the coverage suite.\"}")
  check "an open loan moves to another client" "$OUT" '"loan"'
  check "and the loan now names the new holder" "$OUT" "\"client_id\": *$CLIENT_B"

  api POST /api/v1/loans/checkin "{\"device\":$DEV_T}" > /dev/null
else
  fail "an open loan moves to another client" "could not open a loan to transfer"
fi

echo
echo "Photographs on a repair"

PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
REPAIR_ID=$(api GET /api/v1/repairs | jqv "['data'][0]['id']")

if [ -n "$REPAIR_ID" ]; then
  OUT=$(api POST "/api/v1/attachments/repair/$REPAIR_ID" "{\"images\":[\"$PNG\"]}")
  check "a photo can be attached to a repair" "$OUT" '"count"'
  ATTACHMENT_ID=$(jqv "['stored'][0]['id']" <<< "$OUT")

  if [ -n "$ATTACHMENT_ID" ]; then
    # 204, so there is no body to assert on — and "it answered 204" is not
    # the same claim as "the photo is gone". Both, then.
    STATUS=$(api_status DELETE "/api/v1/attachments/$ATTACHMENT_ID")
    if [ "$STATUS" = "204" ]; then
      pass "and taken off again"
    else
      fail "and taken off again" "expected 204, got $STATUS"
    fi

    STATUS=$(api_status GET "/api/v1/attachments/$ATTACHMENT_ID/file")
    if [ "$STATUS" = "404" ]; then
      pass "and the file really is gone"
    else
      fail "and the file really is gone" "expected 404 fetching the deleted file, got $STATUS"
    fi
  else
    fail "and taken off again" "the upload returned no attachment id: $(printf '%s' "$OUT" | head -c 180)"
  fi
else
  fail "a photo can be attached to a repair" "no repair exists; e2e-wave3.sh should have created one"
fi

echo
echo "Pairing a phone as a scanner"

OUT=$(api POST /api/v1/scan/channels '{"label":"Coverage suite"}')
CHANNEL_ID=$(jqv "['channel']['id']" <<< "$OUT")
check "a pairing channel is created" "$OUT" '"pair_code"'

OUT=$(api GET "/api/v1/scan/channels/$CHANNEL_ID")
check "and can be polled for scans" "$OUT" '"channel"'

echo
echo "Spreadsheet preview"

# The dry run, which writes nothing. The committing half is covered by
# e2e-wave3.sh; this is the half the screen calls first and nothing tested.
OUT=$(api POST /api/v1/clients/import/preview \
  '{"content":"first_name,last_name,external_ref\nAda,Lovelace,VR-9001\n"}')
check "a client import is previewed before it runs" "$OUT" '"suggested_mapping"'
check "and the preview counts the rows" "$OUT" '"row_count"'

echo
echo "Errors the forms depend on"
# applyApiError() in public/js/ui.js puts the message on the named field. A
# route that answers with a bare message instead leaves the person with a
# toast and no idea which box is wrong — so the field name is the contract,
# not a nicety.

OUT=$(api POST /api/v1/admin/settings/test-email '{}')
check "a test email with no recipient says which field" "$OUT" '"field": *"recipient"'

OUT=$(api POST /api/v1/users/1/reset-password '{}')
check "a password reset with no password says which field" "$OUT" '"field": *"password"'

OUT=$(api POST /api/v1/auth/2fa/recovery-codes '{}')
check "new recovery codes ask for the password first" "$OUT" '"field": *"password"'

# With the password, but on an account that has no second factor configured.
# The refusal is the contract here: there are no codes to reissue.
OUT=$(api POST /api/v1/auth/2fa/recovery-codes '{"password":"correct-horse-battery-7"}')
check "and refuse plainly when two-factor is off" "$OUT" "not on for this account"

echo
echo "Changing your own password"

OUT=$(api POST /api/v1/auth/change-password \
  '{"current_password":"correct-horse-battery-7","new_password":"coverage-suite-temp-42"}')
check "the password changes" "$OUT" '"ok"\|"user"\|"changed"'

# Straight back, so the rest of the run — and the next one — still signs in.
OUT=$(api POST /api/v1/auth/change-password \
  '{"current_password":"coverage-suite-temp-42","new_password":"correct-horse-battery-7"}')
check "and changes back" "$OUT" '"ok"\|"user"\|"changed"'

OUT=$(api POST /api/v1/auth/login \
  '{"email":"admin@example.org","password":"correct-horse-battery-7"}')
check "the original password works again" "$OUT" '"user"'

rm -f "$JAR"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All coverage checks passed."
  exit 0
fi
echo "$FAILURES check(s) FAILED."
exit 1
