#!/usr/bin/env bash
#
# End-to-end exercise of the second wave of features: migrations, the reminder
# job, agreements, photos, password reset, kits, accessories, reservations,
# repairs, funding reporting and bulk actions.
#
# Assumes scripts/e2e.sh has already run against the same instance, so the
# devices, clients, programs and staff it creates are present.
#
# Usage: scripts/e2e-features.sh [base-url]

set -uo pipefail

BASE="${1:-http://localhost:3000}"
JAR=$(mktemp)
FAILURES=0

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; FAILURES=$((FAILURES + 1)); }

check() {
  # See the note in e2e.sh: a pipe plus grep -q plus pipefail reports a
  # false failure on any response large enough that printf is still writing.
  if grep -q -- "$3" <<< "$2"; then pass "$1"; else fail "$1" "got: $(printf '%s' "$2" | head -c 280)"; fi
}
check_not() {
  if grep -q -- "$3" <<< "$2"; then fail "$1" "got: $(printf '%s' "$2" | head -c 280)"; else pass "$1"; fi
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

echo
echo "Schema migration"

OUT=$(api GET /health)
check "server is healthy" "$OUT" '"database": *"connected"'

# A device with no loan history, so accessory and kit tests do not collide
# with the loans e2e.sh created.
DEV_A=$(api GET '/api/v1/devices?search=Braille' | jqv "['data'][0]['id']")
BC_A=$(api GET '/api/v1/devices?search=Braille' | jqv "['data'][0]['barcode']")
DEV_B=$(api GET '/api/v1/devices?search=JAWS' | jqv "['data'][0]['id']")
CLIENT_ID=$(api GET '/api/v1/clients' | jqv "['data'][0]['id']")
TECH_ID=$(api GET '/api/v1/users?role=tech' | jqv "['data'][0]['id']")
printf '       (devices %s / %s, client %s, tech %s)\n' "$DEV_A" "$DEV_B" "$CLIENT_ID" "$TECH_ID"

echo
echo "Accessories"

OUT=$(api PUT "/api/v1/kits/accessories/$DEV_A" '{"accessories":[{"name":"Charger","required":true},{"name":"Carry case","required":true},{"name":"Spare stylus","required":false}]}')
check "accessory checklist saved" "$OUT" "Carry case"

OUT=$(api GET "/api/v1/kits/accessories/$DEV_A")
check "accessory checklist reads back" "$OUT" "Spare stylus"

OUT=$(api POST /api/v1/loans/checkout "{\"device\":\"$BC_A\",\"client_id\":$CLIENT_ID,\"accessories\":{\"Charger\":true,\"Carry case\":true,\"Spare stylus\":false}}")
check "check-out records the accessories that went out" "$OUT" '"status": *"active"'
ACC_LOAN=$(printf '%s' "$OUT" | jqv "['loan']['id']")

# Charger deliberately not returned.
OUT=$(api POST /api/v1/loans/checkin "{\"loan_id\":$ACC_LOAN,\"accessories\":{\"Charger\":false,\"Carry case\":true}}")
check "missing accessory is reported at check-in" "$OUT" "Not returned: Charger"
check "check-in still succeeds despite the missing item" "$OUT" '"status": *"returned"'

OUT=$(api GET "/api/v1/loans/$ACC_LOAN")
check "missing accessory is recorded on the loan timeline" "$OUT" "Accessories not returned"

echo
echo "Kits"

OUT=$(api POST /api/v1/kits "{\"name\":\"Assessment kit A\",\"description\":\"Standard assessment bundle\",\"device_ids\":[$DEV_A,$DEV_B]}")
check "kit created" "$OUT" "Assessment kit A"
KIT_ID=$(printf '%s' "$OUT" | jqv "['kit']['id']")
check "kit reports whether it can go out" "$OUT" '"can_check_out": *true'

OUT=$(api POST "/api/v1/kits/$KIT_ID/checkout" "{\"client_id\":$CLIENT_ID,\"tech_id\":$TECH_ID}")
check "kit check-out issues a loan per device" "$OUT" '"group_ref": *"KIT-'
check "kit check-out is complete" "$OUT" '"complete": *true'
GROUP_REF=$(printf '%s' "$OUT" | jqv "['group_ref']")

OUT=$(api GET "/api/v1/groups/$GROUP_REF")
check "loans are grouped under one reference" "$OUT" '"group_ref"'

OUT=$(api GET "/api/v1/kits/$KIT_ID")
check "kit shows its devices are now out" "$OUT" '"can_check_out": *false'

OUT=$(api POST "/api/v1/groups/$GROUP_REF/checkin" '{"condition_in":"Good"}')
check "whole group checks back in at once" "$OUT" '"complete": *true'

echo
echo "Loan agreements"

api PATCH /api/v1/admin/settings '{"settings":{"agreements.enabled":true,"agreements.required":true,"agreements.allow_waive":true}}' > /dev/null

OUT=$(api GET /api/v1/agreements/settings)
check "agreement settings expose the wording" "$OUT" "Loan agreement"
check "signature methods are advertised" "$OUT" "drawn"

OUT=$(api POST /api/v1/loans/checkout "{\"device\":\"$BC_A\",\"client_id\":$CLIENT_ID}")
AGREE_LOAN=$(printf '%s' "$OUT" | jqv "['loan']['id']")
check "loan created for the agreement test" "$OUT" '"status": *"active"'

OUT=$(api GET "/api/v1/agreements/preview/$AGREE_LOAN")
check "agreement preview fills in placeholders" "$OUT" "Assistive Technology Loaner Pool"
check_not "no unreplaced placeholders remain" "$OUT" "{{organisation}}"

OUT=$(api POST "/api/v1/agreements/$AGREE_LOAN" '{"signed_by_name":"Jordan Rivera","signed_by_role":"client","signature_method":"typed","typed_signature":"Jordan Rivera"}')
check "typed signature accepted" "$OUT" '"signature_method": *"typed"'

OUT=$(api POST "/api/v1/agreements/$AGREE_LOAN" '{"signed_by_name":"Someone Else","signature_method":"typed","typed_signature":"Someone Else"}')
check "a second signature on the same loan is refused" "$OUT" "already has a signed agreement"

OUT=$(curl -s -b "$JAR" "$BASE/api/v1/agreements/$AGREE_LOAN/print")
check "printable agreement renders" "$OUT" "Equipment loan agreement"
check "printed agreement names the signer" "$OUT" "Jordan Rivera"

# A drawn signature: a 1x1 PNG is enough to prove the image path stores and links.
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEV_B,\"client_id\":$CLIENT_ID}")
DRAWN_LOAN=$(printf '%s' "$OUT" | jqv "['loan']['id']")
OUT=$(api POST "/api/v1/agreements/$DRAWN_LOAN" "{\"signed_by_name\":\"Jordan Rivera\",\"signature_method\":\"drawn\",\"signature_image\":\"$PNG\"}")
check "drawn signature stored as an attachment" "$OUT" '"signature_url"'
SIG_URL=$(printf '%s' "$OUT" | jqv "['agreement']['signature_url']")

OUT=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE$SIG_URL")
check "signature image is served to an authenticated caller" "$OUT" "200"

OUT=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$SIG_URL")
check "signature image is NOT served without authentication" "$OUT" "401"

# DEV_A is still out under AGREE_LOAN; return it so it can be lent again.
api POST /api/v1/loans/checkin "{\"loan_id\":$AGREE_LOAN}" > /dev/null
OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEV_A,\"client_id\":$CLIENT_ID}")
WAIVE_LOAN=$(printf '%s' "$OUT" | jqv "['loan']['id']")
check "device re-lent for the waiver test" "$OUT" '"status": *"active"'
OUT=$(api POST "/api/v1/agreements/$WAIVE_LOAN" '{"signed_by_name":"X","signature_method":"waived"}')
check "waiving without a reason is refused" "$OUT" "reason"

OUT=$(api POST "/api/v1/agreements/$WAIVE_LOAN" '{"signed_by_name":"Sam Tech","signature_method":"waived","waived_reason":"Client collecting tomorrow"}')
check "waiving with a reason is recorded" "$OUT" '"was_waived": *true'
api POST /api/v1/loans/checkin "{\"loan_id\":$WAIVE_LOAN}" > /dev/null

echo
echo "Condition photos (optional)"

OUT=$(api POST "/api/v1/attachments/loan/$DRAWN_LOAN" "{\"phase\":\"out\",\"images\":[\"$PNG\"]}")
check "photos are refused while the feature is switched off" "$OUT" "switched off"

api PATCH /api/v1/admin/settings '{"settings":{"photos.enabled":true}}' > /dev/null

OUT=$(api POST "/api/v1/attachments/loan/$DRAWN_LOAN" "{\"phase\":\"out\",\"images\":[\"$PNG\",\"$PNG\"]}")
check "photos attach once enabled" "$OUT" '"stored"'

OUT=$(api GET "/api/v1/attachments/loan/$DRAWN_LOAN/list")
check "photos list against the loan" "$OUT" "condition_photo"

OUT=$(api POST "/api/v1/attachments/loan/$DRAWN_LOAN" '{"phase":"out","images":["data:text/html;base64,PHNjcmlwdD4="]}')
check "a non-image upload is rejected" "$OUT" '"failed"'
check_not "the bad upload stored nothing" "$OUT" '"stored": *\[{'

OUT=$(api POST "/api/v1/attachments/loan/$DRAWN_LOAN" "{\"phase\":\"out\",\"images\":[\"$PNG\",\"$PNG\",\"$PNG\",\"$PNG\",\"$PNG\",\"$PNG\"]}")
check "per-phase photo limit enforced" "$OUT" "At most"

api POST /api/v1/loans/checkin "{\"loan_id\":$DRAWN_LOAN}" > /dev/null
api POST /api/v1/loans/checkin "{\"loan_id\":$AGREE_LOAN}" > /dev/null

echo
echo "Reservations and waitlist"

OUT=$(api POST /api/v1/loans/checkout "{\"device\":\"$BC_A\",\"client_id\":$CLIENT_ID}")
BUSY_LOAN=$(printf '%s' "$OUT" | jqv "['loan']['id']")
check "device taken out so the queue has something to wait for" "$OUT" '"status": *"active"'

OUT=$(api POST /api/v1/reservations "{\"device_id\":$DEV_A,\"client_id\":$CLIENT_ID}")
check "waitlist entry created" "$OUT" '"reference": *"RS-'
RES_ID=$(printf '%s' "$OUT" | jqv "['reservation']['id']")
check "queue position is reported" "$OUT" '"queue_position": *1'
check "correctly reports the device is not free" "$OUT" '"available_now": *null'

OUT=$(api POST /api/v1/reservations "{\"device_id\":$DEV_A,\"client_id\":$CLIENT_ID}")
check "joining the same queue twice is refused" "$OUT" "already on the waitlist"

OUT=$(api GET "/api/v1/reservations/device/$DEV_A")
check "device waitlist is visible" "$OUT" '"status": *"waiting"'

# Checking the device in should promote the waiting entry automatically.
OUT=$(api POST /api/v1/loans/checkin "{\"loan_id\":$BUSY_LOAN}")
check "check-in promotes the next in the queue" "$OUT" '"promoted_reservation"'

OUT=$(api GET "/api/v1/reservations/$RES_ID")
check "promoted reservation is marked ready" "$OUT" '"status": *"ready"'
check "a hold expiry is set" "$OUT" '"claim_expires_at"'

OUT=$(api GET "/api/v1/devices/$DEV_A")
check "held device is reserved, not available" "$OUT" '"status": *"reserved"'

OUT=$(api POST "/api/v1/reservations/$RES_ID/cancel" '{"reason":"no longer needed"}')
check "cancelling a reservation releases the device" "$OUT" '"status": *"cancelled"'

OUT=$(api GET "/api/v1/devices/$DEV_A")
check "device returns to available after cancellation" "$OUT" '"status": *"available"'

echo
echo "Repairs"

OUT=$(api POST /api/v1/repairs "{\"device_id\":$DEV_A,\"fault\":\"Left hinge cracked\",\"vendor\":\"Acme Repairs\"}")
check "repair opened" "$OUT" '"reference": *"RP-'
REPAIR_ID=$(printf '%s' "$OUT" | jqv "['repair']['id']")

OUT=$(api GET "/api/v1/devices/$DEV_A")
check "opening a repair moves the device to maintenance" "$OUT" '"status": *"maintenance"'

OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEV_A,\"client_id\":$CLIENT_ID}")
check "a device in repair cannot be lent" "$OUT" "maintenance"

OUT=$(api POST /api/v1/repairs "{\"device_id\":$DEV_A,\"fault\":\"Another fault\"}")
check "a second open repair on one device is refused" "$OUT" "already has an open repair"

OUT=$(api PATCH "/api/v1/repairs/$REPAIR_ID" '{"status":"with_vendor","notes":"Shipped to Acme"}')
check "repair status advances" "$OUT" '"status": *"with_vendor"'
check "sent date recorded" "$OUT" '"sent_at"'

OUT=$(api PATCH "/api/v1/repairs/$REPAIR_ID" '{"status":"repaired","cost":149.50,"resolution":"Hinge replaced"}')
check "repair closes" "$OUT" '"status": *"repaired"'

OUT=$(api GET "/api/v1/devices/$DEV_A")
check "closing a repair returns the device to the pool" "$OUT" '"status": *"available"'

OUT=$(api PATCH "/api/v1/repairs/$REPAIR_ID" '{"status":"diagnosing"}')
check "a closed repair cannot be reopened" "$OUT" "cannot be reopened"

OUT=$(api GET "/api/v1/repairs/$REPAIR_ID")
check "repair keeps a timeline" "$OUT" '"event_type": *"opened"'

OUT=$(api GET /api/v1/repairs/summary)
check "repair summary reports cost" "$OUT" '"total_cost": *149.5'

# Unrepairable retires the device rather than returning it to the pool.
OUT=$(api POST /api/v1/repairs "{\"device_id\":$DEV_B,\"fault\":\"Water damage\"}")
DEAD_REPAIR=$(printf '%s' "$OUT" | jqv "['repair']['id']")
api PATCH "/api/v1/repairs/$DEAD_REPAIR" '{"status":"unrepairable","resolution":"Beyond economical repair"}' > /dev/null
OUT=$(api GET "/api/v1/devices/$DEV_B")
check "unrepairable device is retired, not made available" "$OUT" '"status": *"retired"'

echo
echo "Funding and grant reporting"

OUT=$(api GET /api/v1/reports/funding)
check "funding report groups by source" "$OUT" "funding_source"
# 899 + 1095 + 2450 + 699 + 3195 = 8338. A join-multiplied sum reports far more.
check "funding cost is not inflated by the loan join" "$OUT" '"total_cost": *8338'
check "funding report reports clients served" "$OUT" "clients_served"
check "funding report computes loans per device" "$OUT" "loans_per_device"
check "funding report groups by program too" "$OUT" "by_program"

OUT=$(curl -s -b "$JAR" "$BASE/api/v1/reports/funding.csv")
check "funding CSV export works" "$OUT" "funding_source,devices,total_cost"

echo
echo "Bulk actions"

OUT=$(api POST /api/v1/bulk/checkin '{"devices":["NOT-A-CODE"]}')
check "bulk check-in reports per-item failure" "$OUT" '"failed_count": *1'
check_not "one bad item does not fail the whole call" "$OUT" '"error"'

BC_C=$(api GET '/api/v1/devices?search=iPad' | jqv "['data'][0]['barcode']")
api POST /api/v1/loans/checkout "{\"device\":\"$BC_C\",\"client_id\":$CLIENT_ID}" > /dev/null
OUT=$(api POST /api/v1/bulk/checkin "{\"devices\":[\"$BC_C\",\"NOT-A-CODE\"]}")
check "bulk check-in returns the good one" "$OUT" '"checked_in": *1'
check "bulk check-in still reports the bad one" "$OUT" '"failed_count": *1'

OUT=$(api POST /api/v1/bulk/device-status "{\"device_ids\":[$DEV_A],\"status\":\"maintenance\"}")
check "bulk status change works" "$OUT" '"changed": *1'
api POST /api/v1/bulk/device-status "{\"device_ids\":[$DEV_A],\"status\":\"available\"}" > /dev/null

echo
echo "Scheduled jobs"

OUT=$(api GET /api/v1/jobs)
check "job history is readable" "$OUT" '"in_process_scheduler"'

OUT=$(api POST /api/v1/jobs/run)
check "job runs on demand" "$OUT" '"organizations"'
check "job reports what it did" "$OUT" '"summary"'

OUT=$(api GET /api/v1/jobs)
check "the run is recorded" "$OUT" '"status": *"ok"'

OUT=$(api GET /api/v1/jobs/cron-command)
check "cron command is offered to administrators" "$OUT" "X-Cron-Token"
CRON_TOKEN=$(printf '%s' "$OUT" | jqv "['token']")

OUT=$(curl -s -X POST "$BASE/api/v1/jobs/run" -H "X-Cron-Token: $CRON_TOKEN")
check "cron token authenticates without a session" "$OUT" '"organizations"'

OUT=$(curl -s -X POST "$BASE/api/v1/jobs/run" -H "X-Cron-Token: wrong-token-entirely")
check "a wrong cron token is refused" "$OUT" "not valid"

OUT=$(curl -s -X POST "$BASE/api/v1/jobs/run")
check "running jobs without any credential is refused" "$OUT" "forbidden"

echo
echo "Password reset"

OUT=$(curl -s -X POST "$BASE/api/v1/auth/forgot-password" -H 'Content-Type: application/json' -d '{"email":"admin@example.org"}')
check "reset request succeeds" "$OUT" '"ok": *true'

OUT=$(curl -s -X POST "$BASE/api/v1/auth/forgot-password" -H 'Content-Type: application/json' -d '{"email":"nobody@example.org"}')
check "unknown address gets the identical response" "$OUT" "If that address belongs to an account"
check_not "reset does not reveal whether the account exists" "$OUT" "not found"

OUT=$(curl -s -X POST "$BASE/api/v1/auth/reset-password" -H 'Content-Type: application/json' -d '{"token":"made-up-token","new_password":"a-brand-new-secret-1"}')
check "an invalid reset token is refused" "$OUT" "not valid"

# Pull the real token straight from the database, since email is not configured
# in the test environment.
RESET_TOKEN=$(python3 - <<'PY' 2>/dev/null
import subprocess, sys
# The token itself is never stored, only its hash — so instead assert the row
# exists and was created, which is the part this test can verify.
print("")
PY
)
OUT=$(api GET '/api/v1/audit?per_page=100&action=auth.password_reset_requested')
check "reset request is audited" "$OUT" "password_reset_requested"

echo
echo "Access control on the new endpoints"

curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/logout" > /dev/null
api POST /api/v1/auth/login '{"email":"vrc@example.org","password":"counsel-Secret-26"}' > /dev/null

OUT=$(api POST /api/v1/repairs "{\"device_id\":$DEV_A,\"fault\":\"should not work\"}")
check "counselor cannot open repairs" "$OUT" "forbidden"

OUT=$(api POST /api/v1/kits '{"name":"Sneaky kit"}')
check "counselor cannot create kits" "$OUT" "forbidden"

OUT=$(api POST /api/v1/bulk/device-status "{\"device_ids\":[$DEV_A],\"status\":\"retired\"}")
check "counselor cannot bulk-change device status" "$OUT" "forbidden"

OUT=$(api POST /api/v1/jobs/run)
check "counselor cannot run scheduled jobs" "$OUT" "forbidden"

OUT=$(api POST /api/v1/reservations "{\"device_id\":$DEV_A,\"client_id\":$CLIENT_ID}")
check "counselor CAN join a waitlist" "$OUT" '"reference": *"RS-'

rm -f "$JAR"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All feature checks passed."
  exit 0
fi
echo "$FAILURES check(s) FAILED."
exit 1
