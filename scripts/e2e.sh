#!/usr/bin/env bash
#
# End-to-end exercise of the API against a running, installed instance.
#
# Every check prints "ok" or "FAIL". This is a smoke test, not a unit suite:
# it drives the same endpoints the browser does, in the order a real day of
# use would, so schema mistakes and broken joins surface immediately.
#
# Usage: scripts/e2e.sh [base-url]

set -uo pipefail

BASE="${1:-http://localhost:3000}"
JAR=$(mktemp)
FAILURES=0

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; FAILURES=$((FAILURES + 1)); }

# check <description> <actual> <expected-substring>
check() {
  if printf '%s' "$2" | grep -q -- "$3"; then pass "$1"; else fail "$1" "got: $(printf '%s' "$2" | head -c 300)"; fi
}

# check_not <description> <actual> <substring that must NOT appear>
check_not() {
  if printf '%s' "$2" | grep -q -- "$3"; then fail "$1" "got: $(printf '%s' "$2" | head -c 300)"; else pass "$1"; fi
}

# Read a value out of a JSON response by bracket path, e.g. jqv "['loan']['id']".
# Deliberately does not use eval(): the path contains single quotes, which
# cannot survive being embedded in a shell-quoted Python string literal.
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

echo
echo "Authentication"

OUT=$(api POST /api/v1/auth/login '{"email":"admin@example.org","password":"wrong-password"}')
check "wrong password is rejected" "$OUT" "invalid_credentials"
check_not "failure response does not leak whether the account exists" "$OUT" "no_such_user"

OUT=$(api POST /api/v1/auth/login '{"email":"admin@example.org","password":"correct-horse-battery-7"}')
check "correct password signs in" "$OUT" '"role": *"admin"'
check "organisation is returned on sign-in" "$OUT" "Assistive Technology Loaner Pool"

OUT=$(api GET /api/v1/auth/me)
check "session cookie authenticates subsequent requests" "$OUT" '"actor_type": *"user"'
check "admin has the settings.write capability" "$OUT" "settings.write"

echo
echo "Reference data"

OUT=$(api POST /api/v1/programs '{"name":"LEAP","code":"LEAP","description":"Life skills and employment activity"}')
check "program created" "$OUT" '"name": *"LEAP"'
PROGRAM_ID=$(printf '%s' "$OUT" | jqv "['program']['id']")

OUT=$(api POST /api/v1/programs '{"name":"Retreat","code":"RTR"}')
check "second program created" "$OUT" "Retreat"

OUT=$(api POST /api/v1/programs '{"name":"Duplicate code test","code":"LEAP"}')
check "duplicate program code is rejected" "$OUT" "already exists"

OUT=$(api POST /api/v1/users '{"email":"tech@example.org","full_name":"Sam Tech","role":"tech","password":"tech-Secret-2026"}')
check "technician account created" "$OUT" '"role": *"tech"'
TECH_ID=$(printf '%s' "$OUT" | jqv "['user']['id']")

OUT=$(api POST /api/v1/users '{"email":"vrc@example.org","full_name":"Val Counselor","role":"vrc","password":"counsel-Secret-26"}')
check "counselor account created" "$OUT" '"role": *"vrc"'
VRC_ID=$(printf '%s' "$OUT" | jqv "['user']['id']")

OUT=$(api POST /api/v1/users '{"email":"weak@example.org","full_name":"Weak","role":"tech","password":"short"}')
check "weak password is rejected" "$OUT" "at least 12 characters"

OUT=$(api POST /api/v1/clients "{\"first_name\":\"Jordan\",\"last_name\":\"Rivera\",\"email\":\"jordan@example.org\",\"external_ref\":\"VR-1001\",\"counselor_id\":$VRC_ID,\"program_id\":$PROGRAM_ID}")
check "client created" "$OUT" "Jordan"
CLIENT_ID=$(printf '%s' "$OUT" | jqv "['client']['id']")

echo
echo "Spreadsheet import"

CSV='asset_tag,serial_number,name,category,manufacturer,model,status,location,purchase_date,purchase_cost,program,notes
AT-1001,SN-0001,Dell Latitude 5440,Laptop,Dell,Latitude 5440,available,Main store,03/15/2024,899.00,LEAP,Includes charger
AT-1002,SN-0002,JAWS licence,Software,Freedom Scientific,JAWS 2024,available,Main store,2024-05-02,1095.00,LEAP,Annual licence
AT-1003,SN-0003,Optelec ClearView C,Magnifier,Optelec,ClearView C,maintenance,Repair bench,2021-09-30,2450.00,Retreat,Screen flickers
AT-1004,SN-0004,iPad Air 11-inch,Tablet,Apple,iPad Air,available,Main store,2025-01-20,699.00,Retreat,
AT-1005,SN-0005,"Braille display, 40 cell",Braille,HumanWare,Brailliant BI 40X,available,Main store,2023-07-11,3195.00,LEAP,"Ships with case, cable"'

PAYLOAD=$(python3 -c "
import json,sys
print(json.dumps({'content': sys.stdin.read(), 'filename': 'inventory.csv', 'dry_run': True}))
" <<< "$CSV")

OUT=$(api POST /api/v1/devices/import "$PAYLOAD")
check "dry run reports rows to create" "$OUT" '"to_create": *5'
check "dry run reports no errors" "$OUT" '"error_count": *0'
check "dry run does not commit" "$OUT" '"dry_run": *true'
check "US-format date parsed" "$OUT" '"action": *"create"'
check "quoted field containing a comma survived parsing" "$OUT" "Braille display, 40 cell"

OUT=$(api GET /api/v1/devices)
check "dry run really wrote nothing" "$OUT" '"total": *0'

PAYLOAD=$(python3 -c "
import json,sys
print(json.dumps({'content': sys.stdin.read(), 'filename': 'inventory.csv', 'dry_run': False}))
" <<< "$CSV")

OUT=$(api POST /api/v1/devices/import "$PAYLOAD")
check "commit creates 5 devices" "$OUT" '"created_count": *5'

OUT=$(api GET /api/v1/devices)
check "devices are listed after import" "$OUT" '"total": *5'
check "every imported device got a barcode" "$OUT" '"barcode": *"AT-'

# Re-importing the same file must update, not duplicate.
OUT=$(api POST /api/v1/devices/import "$PAYLOAD")
check "re-import updates rather than duplicating" "$OUT" '"updated_count": *5'
OUT=$(api GET /api/v1/devices)
check "device count unchanged after re-import" "$OUT" '"total": *5'

BARCODE=$(api GET '/api/v1/devices?search=Latitude' | jqv "['data'][0]['barcode']")
DEVICE_ID=$(api GET '/api/v1/devices?search=Latitude' | jqv "['data'][0]['id']")
printf '       (using device %s / barcode %s)\n' "$DEVICE_ID" "$BARCODE"

echo
echo "Barcode lookup and labels"

OUT=$(api POST /api/v1/scan/lookup "{\"barcode\":\"$BARCODE\"}")
check "scan resolves a barcode to a device" "$OUT" "Latitude"
check "scan suggests check-out for an available device" "$OUT" '"suggested_action": *"check_out"'

OUT=$(api POST /api/v1/scan/lookup "{\"barcode\":\"  ${BARCODE}\\r\\n\"}")
check "scanner terminators are stripped before lookup" "$OUT" "Latitude"

OUT=$(api POST /api/v1/scan/lookup '{"barcode":"NOT-A-REAL-CODE"}')
check "unknown barcode returns a helpful 404" "$OUT" "device_not_found"

OUT=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/api/v1/devices/$DEVICE_ID/barcode.svg")
check "barcode SVG renders" "$OUT" "200"

OUT=$(curl -s -b "$JAR" "$BASE/api/v1/devices/labels?ids=$DEVICE_ID")
check "printable label sheet renders" "$OUT" "Print 1 label"

echo
echo "Check-out"

OUT=$(api POST /api/v1/loans/checkout "{\"device\":\"$BARCODE\",\"client_id\":$CLIENT_ID,\"tech_id\":$TECH_ID,\"program_id\":$PROGRAM_ID,\"scanned\":true}")
check "device checked out to client + tech + program at once" "$OUT" '"status": *"active"'
check "loan reference allocated" "$OUT" '"reference": *"LN-'
check "due date computed from the default period" "$OUT" '"due_at"'
LOAN_ID=$(printf '%s' "$OUT" | jqv "['loan']['id']")

OUT=$(api GET "/api/v1/devices/$DEVICE_ID")
check "device status flipped to checked_out" "$OUT" '"status": *"checked_out"'
check "device shows its current holder" "$OUT" "Jordan Rivera"

OUT=$(api POST /api/v1/loans/checkout "{\"device\":\"$BARCODE\",\"tech_id\":$TECH_ID}")
check "double check-out of the same device is refused" "$OUT" "already on loan"

OUT=$(api POST /api/v1/loans/checkout "{\"device\":\"$BARCODE\"}")
check "check-out with no holder is refused" "$OUT" "at least one"

MAINT_BARCODE=$(api GET '/api/v1/devices?search=Optelec' | jqv "['data'][0]['barcode']")
OUT=$(api POST /api/v1/loans/checkout "{\"device\":\"$MAINT_BARCODE\",\"tech_id\":$TECH_ID}")
check "device in maintenance cannot be lent" "$OUT" "maintenance"

echo
echo "Loan adjustment"

OUT=$(api POST "/api/v1/loans/$LOAN_ID/extend" '{"days":14,"reason":"Client needs longer"}')
check "loan extended" "$OUT" '"extension_count": *1'

OUT=$(api POST "/api/v1/loans/$LOAN_ID/extend" '{"days":14}')
check "second extension allowed (limit is 2)" "$OUT" '"extension_count": *2'

OUT=$(api POST "/api/v1/loans/$LOAN_ID/extend" '{"days":14}')
check "third extension blocked by the period limit" "$OUT" "maximum"

OUT=$(api POST "/api/v1/loans/$LOAN_ID/reduce" '{"days":7,"reason":"Brought forward"}')
check "loan reduced" "$OUT" '"reference"'

OUT=$(api GET "/api/v1/loans/$LOAN_ID")
check "timeline records checkout" "$OUT" '"event_type": *"checkout"'
check "timeline records extension" "$OUT" '"event_type": *"extend"'
check "timeline records reduction" "$OUT" '"event_type": *"reduce"'

echo
echo "Check-in"

OUT=$(api POST /api/v1/loans/checkin "{\"device\":\"$BARCODE\",\"condition_in\":\"Good\",\"scanned\":true}")
check "device checked in by barcode" "$OUT" '"status": *"returned"'

OUT=$(api GET "/api/v1/devices/$DEVICE_ID")
check "device returned to available" "$OUT" '"status": *"available"'

OUT=$(api POST /api/v1/loans/checkin "{\"device\":\"$BARCODE\"}")
check "checking in an idle device is reported, not silently accepted" "$OUT" "not currently on loan"

echo
echo "Manual check-out and check-in (no scanner)"

TABLET_ID=$(api GET '/api/v1/devices?search=iPad' | jqv "['data'][0]['id']")
OUT=$(api POST /api/v1/loans/checkout "{\"device\":$TABLET_ID,\"program_id\":$PROGRAM_ID,\"custom_days\":5}")
check "manual check-out by device id works" "$OUT" '"status": *"active"'
check "custom loan length accepted" "$OUT" '"checkout_method": *"manual"'
TABLET_LOAN=$(printf '%s' "$OUT" | jqv "['loan']['id']")

OUT=$(api POST /api/v1/loans/checkin "{\"loan_id\":$TABLET_LOAN}")
check "manual check-in by loan id works" "$OUT" '"status": *"returned"'

echo
echo "Open-ended loans"

PERIODS=$(api GET /api/v1/loans/periods)
OPEN_PERIOD=$(python3 -c "
import sys,json
d=json.load(sys.stdin)
print(next((p['id'] for p in d['data'] if p['days']==0), ''))
" <<< "$PERIODS")

OUT=$(api POST /api/v1/loans/checkout "{\"device\":$TABLET_ID,\"tech_id\":$TECH_ID,\"loan_period_id\":$OPEN_PERIOD}")
check "open-ended loan has no due date" "$OUT" '"due_at": *null'
OPEN_LOAN=$(printf '%s' "$OUT" | jqv "['loan']['id']")
api POST "/api/v1/loans/$OPEN_LOAN/cancel" '{"reason":"test cleanup"}' > /dev/null

echo
echo "VRC request workflow"

curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/logout" > /dev/null
api POST /api/v1/auth/login '{"email":"vrc@example.org","password":"counsel-Secret-26"}' > /dev/null

OUT=$(api POST /api/v1/requests "{\"client_id\":$CLIENT_ID,\"program_id\":$PROGRAM_ID,\"requested_category\":\"Laptop\",\"justification\":\"Client starting work placement\",\"delivery_mode\":\"vrc_pickup\"}")
check "counselor can submit a request" "$OUT" '"status": *"submitted"'
REQUEST_ID=$(printf '%s' "$OUT" | jqv "['request']['id']")

OUT=$(api GET /api/v1/devices)
check "counselor can see the device catalogue" "$OUT" '"total"'

OUT=$(api POST /api/v1/users '{"email":"sneaky@example.org","full_name":"Sneaky","role":"admin","password":"sneaky-Secret-2026"}')
check "counselor cannot create user accounts" "$OUT" "forbidden"

OUT=$(api PATCH /api/v1/admin/settings '{"settings":{"graph.enabled":true}}')
check "counselor cannot change settings" "$OUT" "forbidden"

OUT=$(api POST "/api/v1/requests/$REQUEST_ID/approve" '{}')
check "counselor cannot approve their own request" "$OUT" "forbidden"

curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/logout" > /dev/null
api POST /api/v1/auth/login '{"email":"tech@example.org","password":"tech-Secret-2026"}' > /dev/null

OUT=$(api GET "/api/v1/requests/$REQUEST_ID")
check "technician can see the request" "$OUT" '"reference": *"RQ-'

OUT=$(api POST "/api/v1/requests/$REQUEST_ID/deny" '{}')
check "denial without a reason is refused" "$OUT" "reason"

OUT=$(api POST "/api/v1/requests/$REQUEST_ID/approve" "{\"device_id\":$DEVICE_ID}")
check "technician approves and reserves a device" "$OUT" '"status": *"approved"'

OUT=$(api GET "/api/v1/devices/$DEVICE_ID")
check "approved request reserves the device" "$OUT" '"status": *"reserved"'

OUT=$(api POST "/api/v1/requests/$REQUEST_ID/fulfillment" '{"state":"provisioning"}')
check "fulfilment moves to provisioning" "$OUT" '"fulfillment_state": *"provisioning"'

OUT=$(api POST "/api/v1/requests/$REQUEST_ID/fulfillment" '{"state":"ready_pickup"}')
check "fulfilment moves to ready for pickup" "$OUT" '"fulfillment_state": *"ready_pickup"'
check "tracking summary is human readable" "$OUT" "Ready for you to collect"

OUT=$(api POST "/api/v1/requests/$REQUEST_ID/fulfillment" '{"state":"delivered"}')
check "delivered cannot be set directly" "$OUT" "fulfil"

OUT=$(api POST "/api/v1/requests/$REQUEST_ID/fulfil" "{\"device\":\"$BARCODE\"}")
check "fulfilling creates a real loan" "$OUT" '"reference": *"LN-'
check "request marked fulfilled" "$OUT" '"status": *"fulfilled"'
FULFIL_LOAN=$(printf '%s' "$OUT" | jqv "['loan']['id']")

api POST /api/v1/loans/checkin "{\"loan_id\":$FULFIL_LOAN}" > /dev/null

echo
echo "Audit log"

curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/logout" > /dev/null
api POST /api/v1/auth/login '{"email":"admin@example.org","password":"correct-horse-battery-7"}' > /dev/null

OUT=$(api GET '/api/v1/audit?per_page=100')
check "audit recorded the sign-in" "$OUT" "auth.login"
check "audit recorded the import" "$OUT" "device.imported"
check "audit recorded the check-out" "$OUT" "loan.checked_out"
check "audit recorded the check-in" "$OUT" "loan.checked_in"
check "audit recorded the extension" "$OUT" "loan.extended"
check "audit recorded the approval" "$OUT" "request.approved"
check "audit recorded the failed sign-in" "$OUT" "auth.login_failed"

echo
echo "Reports"

OUT=$(api GET /api/v1/reports/summary)
check "summary counts devices" "$OUT" '"total": *5'
check "summary reports utilisation" "$OUT" "utilisation_percent"

OUT=$(api GET /api/v1/reports/devices)
check "device utilisation report returns rows" "$OUT" "loan_count"

OUT=$(api GET /api/v1/reports/categories)
check "category demand report works" "$OUT" "turns_per_device"

OUT=$(api GET /api/v1/reports/activity/client)
check "client activity report works" "$OUT" "Jordan Rivera"

OUT=$(api GET /api/v1/reports/activity/program)
check "program activity report works" "$OUT" "LEAP"

OUT=$(api GET /api/v1/reports/idle)
check "idle device report works" "$OUT" "never_loaned"

OUT=$(api GET /api/v1/reports/scan-adoption)
check "scan adoption report works" "$OUT" "scan_percent"

OUT=$(api GET /api/v1/reports/trend)
check "loan trend report works" "$OUT" "checked_out"

echo
echo "API keys"

OUT=$(api POST /api/v1/admin/api-keys '{"name":"Integration test","scopes":["read"]}')
check "API key created" "$OUT" '"key": *"lp_'
check "key comes with a copy-it-now warning" "$OUT" "cannot be shown again"
APIKEY=$(printf '%s' "$OUT" | jqv "['key']")
KEY_ID=$(printf '%s' "$OUT" | jqv "['api_key']['id']")

OUT=$(curl -s "$BASE/api/v1/devices" -H "Authorization: Bearer $APIKEY")
check "API key authenticates" "$OUT" '"total": *5'

OUT=$(curl -s -X POST "$BASE/api/v1/devices" -H "Authorization: Bearer $APIKEY" \
      -H 'Content-Type: application/json' -d '{"name":"Should not be created"}')
check "read-scoped key cannot write" "$OUT" "forbidden"

OUT=$(curl -s "$BASE/api/v1/devices" -H "Authorization: Bearer lp_deadbeef_notarealkey")
check "invalid API key is rejected" "$OUT" "unauthorized"

api DELETE "/api/v1/admin/api-keys/$KEY_ID" > /dev/null
OUT=$(curl -s "$BASE/api/v1/devices" -H "Authorization: Bearer $APIKEY")
check "revoked API key stops working" "$OUT" "unauthorized"

echo
echo "Settings and loan periods"

OUT=$(api PATCH /api/v1/admin/settings '{"settings":{"notify.due_soon_days":5,"loans.max_per_client":2}}')
check "settings updated" "$OUT" "notify.due_soon_days"

OUT=$(api PATCH /api/v1/admin/settings '{"settings":{"not.a.real.setting":"x"}}')
check "unknown settings are ignored, not stored" "$OUT" "not.a.real.setting"

OUT=$(api POST /api/v1/admin/loan-periods '{"name":"Summer programme","days":60,"max_extensions":1}')
check "custom loan period created" "$OUT" "Summer programme"
PERIOD_ID=$(printf '%s' "$OUT" | jqv "['loan_period']['id']")

OUT=$(api DELETE "/api/v1/admin/loan-periods/$PERIOD_ID")
check "unused loan period can be deleted" "$OUT" '"deleted": *true'

OUT=$(api GET /api/v1/admin/settings)
check "graph secret is never returned to the client" "$OUT" '"graph.client_secret": *null'
check "mail status is reported to the client" "$OUT" "mail_status"

echo
echo "Exports"

OUT=$(curl -s -b "$JAR" "$BASE/api/v1/devices/export.csv")
check "device CSV export works" "$OUT" "barcode,asset_tag"
OUT=$(curl -s -b "$JAR" "$BASE/api/v1/loans/export.csv")
check "loan CSV export works" "$OUT" "reference,device"
OUT=$(curl -s -b "$JAR" "$BASE/api/v1/audit/export.csv")
check "audit CSV export works" "$OUT" "timestamp,actor"
OUT=$(curl -s -b "$JAR" "$BASE/api/v1/devices/import/template.csv")
check "import template downloads" "$OUT" "asset_tag,serial_number"

echo
echo "Guard rails"

OUT=$(api DELETE "/api/v1/devices/$DEVICE_ID")
check "device with loan history cannot be deleted" "$OUT" "retired"

ADMIN_ID=$(api GET /api/v1/auth/me | jqv "['user']['id']")
OUT=$(api PATCH "/api/v1/users/$ADMIN_ID" '{"active":false}')
check "cannot deactivate your own account" "$OUT" "your own account"

OUT=$(api PATCH "/api/v1/users/$ADMIN_ID" '{"role":"tech"}')
check "cannot demote the only administrator" "$OUT" "own administrator role"

OUT=$(curl -s "$BASE/api/v1/devices")
check "unauthenticated request is rejected" "$OUT" "unauthorized"

OUT=$(curl -s -X POST "$BASE/api/install/run" -H 'Content-Type: application/json' -d '{}')
check "installer is closed after installation" "$OUT" "already_installed"

rm -f "$JAR"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All end-to-end checks passed."
  exit 0
fi
echo "$FAILURES check(s) FAILED."
exit 1
