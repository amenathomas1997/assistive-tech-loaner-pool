#!/usr/bin/env bash
#
# The third wave: trial outcomes, client import, licence seats, hygiene,
# disposal, sites and transfers, shipping, backups, retention and two-factor.
#
# Assumes scripts/e2e.sh has already run against the same instance.
#
# Usage: scripts/e2e-wave3.sh [base-url]

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

api POST /api/v1/auth/login '{"email":"admin@example.org","password":"correct-horse-battery-7"}' > /dev/null

# Remove the per-client cap, which otherwise masks the seat logic below.
api PATCH /api/v1/admin/settings '{"settings":{"loans.max_per_client":0}}' > /dev/null

CLIENT_ID=$(api GET /api/v1/clients | jqv "['data'][0]['id']")

echo
echo "Trial outcomes"

OUT=$(api GET /api/v1/outcomes/meta)
check "outcome list is offered" "$OUT" "recommended"
check "outcomes say which need a note" "$OUT" '"needs_notes": *true'
check "blank is allowed, and says why" "$OUT" "worse than no outcome"

DEV_O=$(api GET '/api/v1/devices?search=Latitude' | jqv "['data'][0]['id']")
OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEV_O,\"client_id\":$CLIENT_ID}")
OUT_LOAN=$(printf '%s' "$OUT" | jqv "['loan']['id']")
api POST /api/v1/loans/checkin "{\"loan_id\":$OUT_LOAN}" > /dev/null

OUT=$(api POST "/api/v1/loans/$OUT_LOAN/outcome" '{"outcome":"not_suitable"}')
check "an unsuitable verdict must say why" "$OUT" "learns nothing"

OUT=$(api POST "/api/v1/loans/$OUT_LOAN/outcome" '{"outcome":"nonsense"}')
check "an unknown outcome is refused" "$OUT" "not a trial outcome"

OUT=$(api POST "/api/v1/loans/$OUT_LOAN/outcome" \
      '{"outcome":"recommended","notes":"Client reached 40wpm"}')
check "outcome recorded" "$OUT" '"outcome": *"recommended"'
check "outcome is labelled for people" "$OUT" "recommend purchasing"

OUT=$(api GET "/api/v1/loans/$OUT_LOAN")
check "outcome appears on the loan timeline" "$OUT" "Trial outcome"

OUT=$(api GET /api/v1/reports/outcomes)
check "outcomes report counts what was recorded" "$OUT" '"recommended"'
check "report states its own coverage" "$OUT" "coverage_percent"
check "report is honest about what it excludes" "$OUT" "Percentages exclude the rest"
check "report values purchases avoided" "$OUT" "purchases_avoided"

OUT=$(api GET /api/v1/outcomes/outstanding)
check "outstanding outcomes are listed" "$OUT" '"meta"'

OUT=$(api POST "/api/v1/loans/$OUT_LOAN/outcome" '{"outcome":""}')
check_not "an outcome can be cleared" "$OUT" '"outcome": *"recommended"'

echo
echo "Client import"

CSV='external_ref,first_name,surname,email,cell,vrc,program
VR-7001,Alex,Mercer,alex@example.org,918-555-0111,vrc@example.org,LEAP
VR-7002,Robin,Shah,,,Sam Tech,Retreat
VR-7001,Duplicate,Reference,,,,'

PAYLOAD=$(python3 -c "
import json,sys
print(json.dumps({'content': sys.stdin.read(), 'dry_run': True}))
" <<< "$CSV")

OUT=$(api POST /api/v1/clients/import "$PAYLOAD")
check "client dry run reports rows to create" "$OUT" '"to_create": *2'
check "client dry run spots a repeated reference" "$OUT" "also appears on line"
check "client dry run writes nothing" "$OUT" '"dry_run": *true'

PAYLOAD=$(python3 -c "
import json,sys
print(json.dumps({'content': sys.stdin.read(), 'dry_run': False}))
" <<< "$CSV")

OUT=$(api POST /api/v1/clients/import "$PAYLOAD")
check "client import commits" "$OUT" '"created_count": *2'

OUT=$(api GET '/api/v1/clients?search=Mercer')
check "counselor resolved from an email address" "$OUT" '"counselor_name"'
check "mobile mapped from a column called cell" "$OUT" "918-555-0111"

OUT=$(curl -s -b "$JAR" "$BASE/api/v1/clients/import/template.csv")
check "client template downloads" "$OUT" "external_ref,case_number"

echo
echo "Licence seats"

OUT=$(api POST /api/v1/devices \
      '{"name":"JAWS site licence","item_type":"licence","seats_total":3,"licence_key":"AAAA-BBBB"}')
check "a licence can be created with seats" "$OUT" '"seats_total": *3'
LIC=$(printf '%s' "$OUT" | jqv "['device']['id']")

S1=$(api POST /api/v1/clients '{"first_name":"Seat","last_name":"One"}' | jqv "['client']['id']")
S2=$(api POST /api/v1/clients '{"first_name":"Seat","last_name":"Two"}' | jqv "['client']['id']")
S3=$(api POST /api/v1/clients '{"first_name":"Seat","last_name":"Three"}' | jqv "['client']['id']")
S4=$(api POST /api/v1/clients '{"first_name":"Seat","last_name":"Four"}' | jqv "['client']['id']")

api POST /api/v1/loans/checkout "{\"device\":$LIC,\"client_id\":$S1}" > /dev/null
OUT=$(api GET "/api/v1/devices/$LIC")
check "a licence stays available while seats remain" "$OUT" '"is_available": *true'
check "seats in use are counted" "$OUT" '"seats_in_use": *1'

api POST /api/v1/loans/checkout "{\"device\":$LIC,\"client_id\":$S2}" > /dev/null
api POST /api/v1/loans/checkout "{\"device\":$LIC,\"client_id\":$S3}" > /dev/null

OUT=$(api GET "/api/v1/devices/$LIC")
check "a fully used licence is not available" "$OUT" '"seats_free": *0'

OUT=$(api POST /api/v1/loans/checkout "{\"device\":$LIC,\"client_id\":$S4}")
check "a fourth seat is refused" "$OUT" "All 3 seats"

OUT=$(api PATCH "/api/v1/devices/$LIC" '{"seats_total":1}')
check "seats cannot drop below those in use" "$OUT" "cannot be set below"

OUT=$(api POST /api/v1/devices \
      '{"name":"Expired licence","item_type":"licence","seats_total":2,"licence_expires":"2020-01-01"}')
EXPIRED=$(printf '%s' "$OUT" | jqv "['device']['id']")
OUT=$(api POST /api/v1/loans/checkout "{\"device\":$EXPIRED,\"client_id\":$S4}")
check "an expired licence is not lent out" "$OUT" "expired on"

echo
echo "Hygiene"

api PATCH /api/v1/admin/settings \
  '{"settings":{"hygiene.enabled":true,"hygiene.require_between_loans":true}}' > /dev/null

DEV_H=$(api GET '/api/v1/devices?search=iPad' | jqv "['data'][0]['id']")
H_LOAN=$(api POST /api/v1/loans/checkout "{\"device\":$DEV_H,\"client_id\":$CLIENT_ID}" | jqv "['loan']['id']")
api POST /api/v1/loans/checkin "{\"loan_id\":$H_LOAN}" > /dev/null

OUT=$(api GET /api/v1/hygiene/queue)
check "a returned device joins the cleaning queue" "$OUT" '"needs_cleaning": *1'
check "the queue says it is blocking" "$OUT" "cannot be lent out"

OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEV_H,\"client_id\":$CLIENT_ID}")
check "an uncleaned device cannot be lent" "$OUT" "has not been cleaned"

OUT=$(api POST "/api/v1/devices/$DEV_H/cleaned" '{"method":"70% alcohol wipe"}')
check "cleaning is recorded" "$OUT" '"needs_cleaning": *0'

OUT=$(api GET "/api/v1/devices/$DEV_H/cleaning")
check "cleaning history reads back" "$OUT" "alcohol wipe"

OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEV_H,\"client_id\":$CLIENT_ID}")
check "a cleaned device lends again" "$OUT" '"status": *"active"'
api POST /api/v1/loans/checkin "{\"device\":$DEV_H}" > /dev/null

OUT=$(api GET /api/v1/reports/hygiene)
check "hygiene report works" "$OUT" "cleanings_per_return"
check "hygiene report admits what it measures" "$OUT" "what was written down"

api PATCH /api/v1/admin/settings '{"settings":{"hygiene.require_between_loans":false}}' > /dev/null

echo
echo "Disposal"

OUT=$(api POST /api/v1/devices \
      '{"name":"Worn out magnifier","purchase_cost":"1200.00","funding_source":"Title I","purchase_date":"2018-03-01"}')
DISP=$(printf '%s' "$OUT" | jqv "['device']['id']")

OUT=$(api POST "/api/v1/devices/$DISP/dispose" '{"method":"lost"}')
check "a device lost with no explanation is refused" "$OUT" "auditor asks about"

OUT=$(api POST "/api/v1/devices/$DISP/dispose" '{"method":"nonsense"}')
check "an unknown disposal method is refused" "$OUT" "what happened to the device"

OUT=$(api POST "/api/v1/devices/$DISP/dispose" \
      '{"method":"recycled","reference":"CERT-9912","notes":"Beyond economical repair"}')
check "disposal is recorded" "$OUT" '"disposal_method": *"recycled"'
check "a disposed device is retired" "$OUT" '"status": *"retired"'

OUT=$(api POST "/api/v1/devices/$DISP/dispose" '{"method":"donated"}')
check "a device cannot be disposed of twice" "$OUT" "already disposed"

OUT=$(api GET /api/v1/reports/disposals)
check "disposal report groups by funder" "$OUT" "by_funder"
check "disposal report reports service life" "$OUT" "years_in_service"
check "disposal report is honest about valuation" "$OUT" "not for claiming a loss"

echo
echo "Sites and transfers"

SITE_A=$(api POST /api/v1/sites '{"name":"Tulsa office","code":"TUL"}' | jqv "['site']['id']")
SITE_B=$(api POST /api/v1/sites '{"name":"Oklahoma City office","code":"OKC"}' | jqv "['site']['id']")

OUT=$(api POST /api/v1/sites '{"name":"Duplicate code","code":"TUL"}')
check "duplicate site codes are refused" "$OUT" "already uses that code"

DEV_T=$(api GET '/api/v1/devices?search=Braille' | jqv "['data'][0]['id']")
api PATCH "/api/v1/devices/$DEV_T" "{\"site_id\":$SITE_A}" > /dev/null

OUT=$(api POST /api/v1/transfers "{\"device_id\":$DEV_T,\"to_site_id\":$SITE_B,\"carrier\":\"UPS\",\"tracking\":\"1Z999\"}")
check "a transfer is created" "$OUT" '"reference": *"TR-'
check "a sent device is in transit" "$OUT" '"status": *"in_transit"'
TRANSFER=$(printf '%s' "$OUT" | jqv "['transfer']['id']")

OUT=$(api GET "/api/v1/devices/$DEV_T")
check "a device in transit is not available" "$OUT" '"status": *"maintenance"'

OUT=$(api POST /api/v1/transfers "{\"device_id\":$DEV_T,\"to_site_id\":$SITE_A}")
check "a second transfer of the same device is refused" "$OUT" "already being transferred"

OUT=$(api POST "/api/v1/transfers/$TRANSFER/receive" '{}')
check "receiving completes the transfer" "$OUT" '"status": *"received"'

OUT=$(api GET "/api/v1/devices/$DEV_T")
check "the device is now at the destination" "$OUT" "Oklahoma City office"

echo
echo "Shipping"

SHIP_LOAN=$(api POST /api/v1/loans/checkout "{\"device\":$DEV_O,\"client_id\":$CLIENT_ID}" | jqv "['loan']['id']")
OUT=$(api PATCH "/api/v1/loans/$SHIP_LOAN/shipping" '{"out_carrier":"FedEx","out_tracking":"7712345"}')
check "shipping details are recorded" "$OUT" "7712345"
check "a tracking number dates the despatch" "$OUT" '"out_shipped_at"'
api POST /api/v1/loans/checkin "{\"loan_id\":$SHIP_LOAN}" > /dev/null

echo
echo "Backups"

OUT=$(api GET /api/v1/admin/backup)
check "backup summary lists the tables" "$OUT" "approximate_size"
check "backup summary warns what it contains" "$OUT" "password hash"

OUT=$(api POST /api/v1/admin/backup '{}')
check "a backup needs the password re-entered" "$OUT" "password"

OUT=$(api POST /api/v1/admin/backup '{"password":"wrong"}')
check "a backup refuses a wrong password" "$OUT" "not correct"

OUT=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/admin/backup" \
      -H 'Content-Type: application/json' -d '{"password":"correct-horse-battery-7"}')
check "the backup is SQL" "$OUT" "Loaner Pool database backup"
check "the backup contains data" "$OUT" "INSERT INTO"
check "the backup says how to restore it" "$OUT" "mysql -u USER"

echo
echo "Two-factor"

OUT=$(api GET /api/v1/auth/2fa)
check "two-factor starts off" "$OUT" '"enabled": *false'

OUT=$(api POST /api/v1/auth/2fa/begin '{}')
check "enrolment offers a QR" "$OUT" "<svg"
check "enrolment offers the secret to type" "$OUT" "secret_formatted"
check "nothing changes until a code is entered" "$OUT" "stays exactly as it is"
SECRET=$(printf '%s' "$OUT" | jqv "['secret']")

OUT=$(api POST /api/v1/auth/2fa/confirm '{"code":"000000"}')
check "a wrong code does not enable it" "$OUT" "not right"

CODE=$(php -r "require 'app/bootstrap.php'; echo Loaner\\Totp::codeAt('$SECRET');")
OUT=$(api POST /api/v1/auth/2fa/confirm "{\"code\":\"$CODE\"}")
check "a correct code enables it" "$OUT" '"enabled": *true'
check "recovery codes are issued once" "$OUT" "recovery_codes"
RECOVERY=$(printf '%s' "$OUT" | jqv "['recovery_codes'][0]")

curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/logout" > /dev/null

OUT=$(curl -s -c "$JAR" -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
      -d '{"email":"admin@example.org","password":"correct-horse-battery-7"}')
check "the password alone no longer signs you in" "$OUT" '"second_factor_required": *true'
check_not "no session is issued at the first step" "$OUT" '"capabilities"'
PENDING=$(printf '%s' "$OUT" | jqv "['pending_id']")

OUT=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/auth/login/verify" -H 'Content-Type: application/json' \
      -d "{\"pending_id\":\"$PENDING\",\"code\":\"999999\"}")
check "a wrong code is refused and counted" "$OUT" "attempt"

CODE=$(php -r "require 'app/bootstrap.php'; echo Loaner\\Totp::codeAt('$SECRET');")
OUT=$(curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/login/verify" \
      -H 'Content-Type: application/json' -d "{\"pending_id\":\"$PENDING\",\"code\":\"$CODE\"}")
check "a correct code completes the sign-in" "$OUT" '"capabilities"'

OUT=$(api GET /api/v1/auth/me)
check "the session from a two-factor sign-in works" "$OUT" '"actor_type": *"user"'

# A lost phone: the recovery code is the way back in.
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/logout" > /dev/null
OUT=$(curl -s -c "$JAR" -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
      -d '{"email":"admin@example.org","password":"correct-horse-battery-7"}')
PENDING=$(printf '%s' "$OUT" | jqv "['pending_id']")
OUT=$(curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/login/verify" \
      -H 'Content-Type: application/json' -d "{\"pending_id\":\"$PENDING\",\"code\":\"$RECOVERY\"}")
check "a recovery code signs you in" "$OUT" '"used_recovery_code": *true'
check "using one says how many are left" "$OUT" "recovery_notice"

# And it only works once.
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/logout" > /dev/null
OUT=$(curl -s -c "$JAR" -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
      -d '{"email":"admin@example.org","password":"correct-horse-battery-7"}')
PENDING=$(printf '%s' "$OUT" | jqv "['pending_id']")
OUT=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/auth/login/verify" \
      -H 'Content-Type: application/json' -d "{\"pending_id\":\"$PENDING\",\"code\":\"$RECOVERY\"}")
check "a recovery code cannot be reused" "$OUT" "not right"

CODE=$(php -r "require 'app/bootstrap.php'; echo Loaner\\Totp::codeAt('$SECRET');")
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/login/verify" \
  -H 'Content-Type: application/json' -d "{\"pending_id\":\"$PENDING\",\"code\":\"$CODE\"}" > /dev/null

OUT=$(api POST /api/v1/auth/2fa/disable '{}')
check "turning it off needs the password" "$OUT" "password"

OUT=$(api POST /api/v1/auth/2fa/disable '{"password":"correct-horse-battery-7"}')
check "two-factor can be turned off" "$OUT" '"enabled": *false'

echo
echo "Retention"

OUT=$(api GET /api/v1/admin/retention)
check "retention previews what it would do" "$OUT" "policy"
check "retention names what it never touches" "$OUT" "never_touched"
check "retention is off until switched on" "$OUT" '"enabled": *false'

OUT=$(api POST /api/v1/admin/retention/purge '{"password":"correct-horse-battery-7"}')
check "a purge refuses while retention is off" "$OUT" "switched off"

api PATCH /api/v1/admin/settings '{"settings":{"retention.enabled":true}}' > /dev/null

OUT=$(api POST /api/v1/admin/retention/purge '{}')
check "a purge needs the password re-entered" "$OUT" "password"

OUT=$(api POST /api/v1/admin/retention/purge '{"password":"correct-horse-battery-7"}')
check "a purge runs and reports what it did" "$OUT" '"ran": *true'
check "a purge is itself audited" "$OUT" "summary"

api PATCH /api/v1/admin/settings '{"settings":{"retention.enabled":false}}' > /dev/null

echo
echo "Access control on the third wave"

curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/logout" > /dev/null
api POST /api/v1/auth/login '{"email":"vrc@example.org","password":"counsel-Secret-26"}' > /dev/null

OUT=$(api GET /api/v1/reports/outcomes)
check "a counselor cannot see the outcomes report" "$OUT" "forbidden"

OUT=$(api GET /api/v1/reports/disposals)
check "a counselor cannot see the disposal report" "$OUT" "forbidden"

OUT=$(api POST /api/v1/admin/backup '{"password":"counsel-Secret-26"}')
check "a counselor cannot download a backup" "$OUT" "administrator"

OUT=$(api POST /api/v1/admin/retention/purge '{"password":"counsel-Secret-26"}')
check "a counselor cannot purge data" "$OUT" "administrator"

OUT=$(api POST /api/v1/sites '{"name":"Sneaky site"}')
check "a counselor cannot create sites" "$OUT" "forbidden"

rm -f "$JAR"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All third-wave checks passed."
  exit 0
fi
echo "$FAILURES check(s) FAILED."
exit 1
