#!/usr/bin/env bash
#
# Who holds what: the custody rules found wanting in the November 2026 audit
# of the loan, reservation and retention logic.
#
#   - A device the waitlist had just promised to someone was lendable to
#     anyone: "reserved" was a status and nothing checked it. And when the
#     right person did collect it, nothing recorded that — Reservations::fulfil
#     had no callers — so every collected reservation went on to "expire".
#   - A cancelled loan freed a device without consulting the waitlist.
#   - A reservation's needed_from / needed_to were stored and never read, so
#     somebody who needed a device in three weeks was held one today, and
#     dropped when they did not collect it.
#   - A desk check-out with a wrong request_id was a 500; another tenant's id
#     would have been stored and its reference shown on the loan.
#   - The signature on a signed agreement could be deleted through the
#     generic attachment route; the foreign key is SET NULL, so the agreement
#     silently became unsigned.
#
# Assumes scripts/e2e.sh has run, so clients, programs and loan periods exist.
#
# Usage: scripts/e2e-custody.sh [base-url]

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
api_status() {
  curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$1" "$BASE$2" "${@:3}"
}

api POST /api/v1/auth/login '{"email":"admin@example.org","password":"correct-horse-battery-7"}' > /dev/null

# Policy out of the way, so the checks below test custody and nothing else.
api PATCH /api/v1/admin/settings \
  '{"settings":{"loans.max_per_client":0,"loans.allow_overdue_checkout":true,"agreements.enabled":true,"agreements.required":false}}' > /dev/null

DEVICE=$(api GET '/api/v1/devices?status=available' | jqv "['data'][0]['id']")
DEVICE_NAME=$(api GET "/api/v1/devices/$DEVICE" | jqv "['device']['name']")
CLIENT_A=$(api GET /api/v1/clients | jqv "['data'][0]['id']")
CLIENT_B=$(api GET /api/v1/clients | jqv "['data'][1]['id']")

if [ -z "$DEVICE" ] || [ -z "$CLIENT_A" ] || [ -z "$CLIENT_B" ]; then
  fail "the suite has a free device and two clients to work with" "device=$DEVICE a=$CLIENT_A b=$CLIENT_B"
  echo "$FAILURES check(s) FAILED."; exit 1
fi

# Put a device through the waitlist so it is held for CLIENT_A.
hold_for_a() {
  RES=$(api POST /api/v1/reservations "{\"device_id\":$DEVICE,\"client_id\":$CLIENT_A}" | jqv "['reservation']['id']")
  api POST /api/v1/loans/checkout "{\"device\":$DEVICE,\"tech_id\":1}" > /dev/null
  OUT=$(api POST /api/v1/loans/checkin "{\"device\":$DEVICE}")
}

echo
echo "A device held for someone on the waitlist"

hold_for_a
check "a return promotes the person waiting" "$OUT" '"promoted_reservation"'
check "and tells the desk so" "$OUT" "has been notified"
OUT=$(api GET "/api/v1/devices/$DEVICE")
check "the device is marked reserved" "$OUT" '"status": *"reserved"'

STATUS=$(api_status POST /api/v1/loans/checkout -H 'Content-Type: application/json' \
  -d "{\"device\":$DEVICE,\"client_id\":$CLIENT_B}")
[ "$STATUS" = "409" ] && pass "a walk-in cannot take it" || fail "a walk-in cannot take it" "expected 409, got $STATUS"

OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEVICE,\"client_id\":$CLIENT_B}")
check "the refusal says who it is held for" "$OUT" '"held_for"'
check "and names the reservation" "$OUT" '"reference": *"RS-'
check "and that it can be overridden" "$OUT" '"can_override": *true'

OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEVICE,\"client_id\":$CLIENT_B,\"override_hold\":true}")
check "with an explicit override it goes out anyway" "$OUT" '"loan"'
OUT=$(api GET "/api/v1/reservations/$RES")
check "and the person held for goes back to waiting, not to the end" "$OUT" '"status": *"waiting"'
check_not "with no device still pinned to them" "$OUT" '"ready_device_id": *[0-9]'

OUT=$(api GET '/api/v1/audit?per_page=3')
check "the override is in the audit log" "$OUT" "overridden"

OUT=$(api POST /api/v1/loans/checkin "{\"device\":$DEVICE}")
check "when it comes back, it is held for them again" "$OUT" '"promoted_reservation"'

OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEVICE,\"client_id\":$CLIENT_A}")
check "the person it is held for can collect it" "$OUT" '"loan"'
LOAN_A=$(jqv "['loan']['id']" <<< "$OUT")
OUT=$(api GET "/api/v1/reservations/$RES")
check "and collecting it fulfils the reservation" "$OUT" '"status": *"fulfilled"'
check "recording which loan satisfied it" "$OUT" "\"fulfilled_loan_id\": *$LOAN_A"

echo
echo "A cancelled loan consults the waitlist"

RES_B=$(api POST /api/v1/reservations "{\"device_id\":$DEVICE,\"client_id\":$CLIENT_B}" | jqv "['reservation']['id']")
api POST "/api/v1/loans/$LOAN_A/cancel" '{"reason":"wrong device scanned"}' > /dev/null
OUT=$(api GET "/api/v1/reservations/$RES_B")
check "cancelling the loan holds the device for the next person" "$OUT" '"status": *"ready"'
api POST "/api/v1/reservations/$RES_B/cancel" '{"reason":"custody suite"}' > /dev/null

echo
echo "A reservation for later is not held now"

NEXT_MONTH=$(date -v+30d +%Y-%m-%d 2>/dev/null || date -d '+30 days' +%Y-%m-%d)
RES_LATER=$(api POST /api/v1/reservations \
  "{\"device_id\":$DEVICE,\"client_id\":$CLIENT_A,\"needed_from\":\"$NEXT_MONTH\"}" | jqv "['reservation']['id']")
api POST /api/v1/loans/checkout "{\"device\":$DEVICE,\"tech_id\":1}" > /dev/null
OUT=$(api POST /api/v1/loans/checkin "{\"device\":$DEVICE}")
check_not "someone who needs it next month is not promoted today" "$OUT" '"promoted_reservation": *{'
OUT=$(api GET "/api/v1/reservations/$RES_LATER")
check "they keep their place in the queue" "$OUT" '"status": *"waiting"'
api POST "/api/v1/reservations/$RES_LATER/cancel" '{"reason":"custody suite"}' > /dev/null

echo
echo "What a browser form actually sends"
# A <select> submits strings. Under strict_types, a helper typed ?int turned
# loan_period_id "2" into a TypeError — a 500 for anyone who chose a loan
# period by name at the desk. curl sends numbers, so no suite had seen it.
# These send ids the way a form does.

PERIOD=$(api GET /api/v1/loans/periods | jqv "['default']['id']")
OUT=$(api POST /api/v1/loans/checkout \
  "{\"device\":\"$DEVICE\",\"client_id\":\"$CLIENT_A\",\"loan_period_id\":\"$PERIOD\",\"scanned\":true}")
check "a check-out with a loan period chosen by name (string id) works" "$OUT" '"loan"'
check "and is on that period" "$OUT" "\"loan_period_id\": *$PERIOD"
api POST /api/v1/loans/checkin "{\"device\":$DEVICE}" > /dev/null

OUT=$(api POST /api/v1/loans/checkout \
  "{\"device\":$DEVICE,\"client_id\":$CLIENT_A,\"loan_period_id\":\"abc\"}")
check "a loan period that is not an id is a 400, not a server error" "$OUT" '"field": *"loan_period_id"'

OUT=$(api POST /api/v1/reservations "{\"device_id\":\"$DEVICE\",\"client_id\":\"$CLIENT_B\"}")
check "joining the waitlist with a string device id works" "$OUT" '"reservation"'
RES_S=$(jqv "['reservation']['id']" <<< "$OUT")
[ -n "$RES_S" ] && api POST "/api/v1/reservations/$RES_S/cancel" '{"reason":"custody suite"}' > /dev/null

echo
echo "Linking a loan to a request"

OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEVICE,\"client_id\":$CLIENT_A,\"request_id\":999999}")
check "a request that does not exist is a 400, not a server error" "$OUT" '"bad_request"'
check "naming the field" "$OUT" '"field": *"request_id"'

echo
echo "A signed agreement stays signed"

LOAN=$(api POST /api/v1/loans/checkout "{\"device\":$DEVICE,\"client_id\":$CLIENT_A}" | jqv "['loan']['id']")
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
api POST "/api/v1/agreements/$LOAN" \
  "{\"signature_method\":\"drawn\",\"signed_by_name\":\"Jordan Rivera\",\"signature_image\":\"$PNG\"}" > /dev/null
SIG=$(api GET "/api/v1/agreements/$LOAN" | jqv "['agreement']['signature_attachment_id']")

if [ -n "$SIG" ]; then
  STATUS=$(api_status DELETE "/api/v1/attachments/$SIG")
  [ "$STATUS" = "409" ] && pass "the signature image cannot be deleted" \
    || fail "the signature image cannot be deleted" "expected 409, got $STATUS"
  OUT=$(curl -s -b "$JAR" -X DELETE "$BASE/api/v1/attachments/$SIG")
  check "and the refusal explains why" "$OUT" "signed agreement is kept"
  OUT=$(api GET "/api/v1/agreements/$LOAN")
  check "the agreement still carries it" "$OUT" "\"signature_attachment_id\": *$SIG"
else
  fail "the signature image cannot be deleted" "signing produced no attachment id"
fi

api POST /api/v1/loans/checkin "{\"device\":$DEVICE}" > /dev/null

rm -f "$JAR"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All custody checks passed."
  exit 0
fi
echo "$FAILURES check(s) FAILED."
exit 1
