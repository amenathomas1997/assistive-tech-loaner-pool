#!/usr/bin/env bash
#
# Assert that every field the browser reads off a response is actually in it.
#
# This exists because of a specific failure. The PHP port changed several
# response shapes — mail status moved, a count and a row list swapped names,
# "notice" replaced "warning" — and nothing caught it, because the end-to-end
# suite greps responses for the fields *it* cares about, not the ones the views
# dereference. The first symptom was an administrator saving email settings and
# getting "undefined is not an object (evaluating 'status.usable')" on a screen
# that had just told them the save succeeded.
#
# The table below is the contract between the API and public/js/views/*.js. It
# is hand-maintained on purpose: deriving it from the JavaScript would need a
# real parser to know which `result` belongs to which call, and a guess that is
# usually right is worse than a list that is explicitly true.
#
# Rule when adding to it: if a view writes `result.foo`, `result.foo.bar` or
# `result.foo.length`, then `foo` belongs here. Optional fields that the view
# guards with `if (result.foo)` still belong here if the feature depends on
# them — a field that is silently always absent is a feature that silently
# never works.
#
# Usage: scripts/verify-ui-contract.sh [base-url]

set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-http://localhost:3000}"
JAR=$(mktemp)
FAILURES=0

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; FAILURES=$((FAILURES + 1)); }

api() {
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -s -b "$JAR" -c "$JAR" -X "$method" "$BASE$path" -H 'Content-Type: application/json' -d "$data"
  else
    curl -s -b "$JAR" -c "$JAR" -X "$method" "$BASE$path"
  fi
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

# contract <label> <json> <field> [field...]
# Asserts each field is PRESENT as a top-level key. Present-and-null passes:
# null is a value the views handle; a missing key is what breaks them.
contract() {
  local label="$1" json="$2"; shift 2
  local missing
  missing=$(printf '%s' "$json" | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    print("response was not JSON: " + sys.stdin.read()[:120] if False else "RESPONSE_NOT_JSON")
    sys.exit(0)
if not isinstance(data, dict):
    print("RESPONSE_NOT_OBJECT")
    sys.exit(0)
print(" ".join(f for f in sys.argv[1:] if f not in data))
' "$@")

  if [ -z "$missing" ]; then
    pass "$label"
  elif [ "$missing" = "RESPONSE_NOT_JSON" ] || [ "$missing" = "RESPONSE_NOT_OBJECT" ]; then
    fail "$label" "$missing — $(printf '%s' "$json" | head -c 160)"
  else
    fail "$label" "missing from the response: $missing"
  fi
}

echo
echo "API/UI contract"

api POST /api/v1/auth/login '{"email":"admin@example.org","password":"correct-horse-battery-7"}' > /dev/null

# --- app.js: the shell decides what to render from these -------------------
contract "auth/me -> app.js" \
  "$(api GET /api/v1/auth/me)" user organization capabilities must_change_password

# --- admin.js: settings and email ------------------------------------------
contract "GET admin/settings -> admin.js" \
  "$(api GET /api/v1/admin/settings)" settings mail_status

# This is the exact call that produced "undefined is not an object
# (evaluating 'status.usable')": the view re-renders the email status box from
# the save response the moment it returns.
SAVED=$(api PATCH /api/v1/admin/settings '{"settings":{"notify.due_soon_days":3}}')
contract "PATCH admin/settings -> admin.js" "$SAVED" settings mail_status
printf '%s' "$SAVED" | python3 -c '
import sys, json
d = json.load(sys.stdin)
s = d.get("mail_status") or {}
missing = [f for f in ("usable", "sender", "reason") if f not in s]
sys.exit("mail_status is missing: " + " ".join(missing) if missing else 0)
' && pass "mail_status carries usable/sender/reason" \
  || fail "mail_status carries usable/sender/reason"

contract "admin/organization -> admin.js" \
  "$(api GET /api/v1/admin/organization)" organization

ORG=$(api PATCH /api/v1/admin/organization '{"name":"Assistive Technology Loaner Pool"}')
contract "PATCH admin/organization -> admin.js" "$ORG" organization notice

KEY=$(api POST /api/v1/admin/api-keys '{"name":"Contract probe","scopes":["read"]}')
contract "POST admin/api-keys -> admin.js showKeyOnce()" "$KEY" key api_key warning
KEY_ID=$(printf '%s' "$KEY" | jqv "['api_key']['id']")
api DELETE "/api/v1/admin/api-keys/$KEY_ID" > /dev/null

PERIOD=$(api POST /api/v1/admin/loan-periods '{"name":"Contract probe period","days":21}')
contract "POST admin/loan-periods -> admin.js" "$PERIOD" loan_period
PERIOD_ID=$(printf '%s' "$PERIOD" | jqv "['loan_period']['id']")
contract "DELETE admin/loan-periods -> admin.js" \
  "$(api DELETE "/api/v1/admin/loan-periods/$PERIOD_ID")" deleted message

contract "jobs/run -> admin.js" "$(api POST /api/v1/jobs/run)" summary organizations

# The update panel renders from these. reachable may be false on a CI runner
# with no outbound HTTPS, which is itself a case the panel has to handle, so
# the contract is about the keys being present either way.
contract "admin/updates -> admin.js" \
  "$(api GET /api/v1/admin/updates)" local reachable up_to_date summary how_to_apply latest
printf '%s' "$(api GET /api/v1/admin/updates)" | python3 -c '
import sys, json
d = json.load(sys.stdin)
l = d.get("local") or {}
missing = [f for f in ("app_version", "schema_version", "install_method",
                       "commit_short", "branch", "has_local_changes") if f not in l]
sys.exit("local is missing: " + " ".join(missing) if missing else 0)
' && pass "updates.local carries what the panel renders" \
  || fail "updates.local carries what the panel renders"

# --- loans.js: check-out and check-in -------------------------------------
DEV=$(api GET '/api/v1/devices?search=iPad' | jqv "['data'][0]['id']")
BC=$(api GET '/api/v1/devices?search=iPad' | jqv "['data'][0]['barcode']")
CLIENT=$(api GET /api/v1/clients | jqv "['data'][0]['id']")

OUT=$(api POST /api/v1/loans/checkout "{\"device\":$DEV,\"client_id\":$CLIENT}")
contract "loans/checkout -> loans.js" "$OUT" loan notice notification
LOAN=$(printf '%s' "$OUT" | jqv "['loan']['id']")

IN=$(api POST /api/v1/loans/checkin "{\"loan_id\":$LOAN}")
# wasOverdue/daysLate/device are dereferenced directly to build the toast;
# warning raises its own "Accessories missing" notice.
contract "loans/checkin -> loans.js" "$IN" loan device wasOverdue daysLate warning notice

contract "loans/periods -> loans.js" "$(api GET /api/v1/loans/periods)" data default

# --- devices.js: import and bulk ------------------------------------------
PREVIEW=$(api POST /api/v1/devices/import/preview \
  '{"content":"asset_tag,name\nCT-9001,Contract probe device\n"}')
contract "devices/import/preview -> devices.js" "$PREVIEW" \
  headers suggested_mapping unmapped_headers importable_fields sample_rows row_count

BULK=$(api POST /api/v1/bulk/checkin '{"devices":["NOT-A-REAL-CODE"]}')
# failed is rendered as table ROWS here, while failed_count is the number.
contract "bulk/checkin -> devices.js" "$BULK" checked_in failed_count failed

STATUS=$(api POST /api/v1/bulk/device-status "{\"device_ids\":[$DEV],\"status\":\"available\"}")
contract "bulk/device-status -> devices.js" "$STATUS" changed failed_count failed

# --- workshop.js: kits, groups, waitlist ----------------------------------
KIT=$(api POST /api/v1/kits "{\"name\":\"Contract probe kit\",\"device_ids\":[$DEV]}")
contract "POST kits -> workshop.js" "$KIT" kit
KIT_ID=$(printf '%s' "$KIT" | jqv "['kit']['id']")
printf '%s' "$KIT" | grep -q '"can_check_out"' \
  && pass "kit carries can_check_out" || fail "kit carries can_check_out"

KITOUT=$(api POST "/api/v1/kits/$KIT_ID/checkout" "{\"client_id\":$CLIENT}")
contract "kits/{id}/checkout -> workshop.js" "$KITOUT" group_ref loans skipped complete
GROUP=$(printf '%s' "$KITOUT" | jqv "['group_ref']")

GROUPIN=$(api POST "/api/v1/groups/$GROUP/checkin" '{}')
# loans.js counts result.returned.length; workshop.js reads complete.
contract "groups/{ref}/checkin -> loans.js + workshop.js" "$GROUPIN" returned complete
api DELETE "/api/v1/kits/$KIT_ID" > /dev/null

api POST /api/v1/loans/checkout "{\"device\":$DEV,\"client_id\":$CLIENT}" > /dev/null
RES=$(api POST /api/v1/reservations "{\"device_id\":$DEV,\"client_id\":$CLIENT}")
contract "POST reservations -> workshop.js" "$RES" reservation available_now
RES_ID=$(printf '%s' "$RES" | jqv "['reservation']['id']")
api POST "/api/v1/reservations/$RES_ID/cancel" '{"reason":"contract probe"}' > /dev/null
api POST /api/v1/loans/checkin "{\"device\":\"$BC\"}" > /dev/null

# --- requests.js ----------------------------------------------------------
REQ=$(api POST /api/v1/requests "{\"client_id\":$CLIENT,\"requested_category\":\"Laptop\"}")
contract "POST requests -> requests.js" "$REQ" request
REQ_ID=$(printf '%s' "$REQ" | jqv "['request']['id']")
api POST "/api/v1/requests/$REQ_ID/cancel" '{"reason":"contract probe"}' > /dev/null

# --- scan.js: pairing and polling ----------------------------------------
CHAN=$(api POST /api/v1/scan/channels '{"label":"Contract probe"}')
contract "POST scan/channels -> scan.js" "$CHAN" channel join_url join_qr_svg https_warning
CHAN_ID=$(printf '%s' "$CHAN" | jqv "['channel']['id']")
CODE=$(printf '%s' "$CHAN" | jqv "['channel']['pair_code']")

contract "scan/channels/{id}/events -> scan.js" \
  "$(api GET "/api/v1/scan/channels/$CHAN_ID/events?after=0")" closed events poll_after_ms

# scanner.js is the phone, which has no session — only the pairing code.
contract "scan/join/{code} -> scanner.js" \
  "$(curl -s "$BASE/api/v1/scan/join/$CODE")" paired channel station_connected
contract "POST scan/join/{code} -> scanner.js" \
  "$(curl -s -X POST "$BASE/api/v1/scan/join/$CODE" -H 'Content-Type: application/json' \
      -d '{"barcode":"CONTRACT-PROBE","source":"manual"}')" \
  device delivered_to_station message
api DELETE "/api/v1/scan/channels/$CHAN_ID" > /dev/null

rm -f "$JAR"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All API/UI contract checks passed."
  exit 0
fi
echo "$FAILURES contract check(s) FAILED."
exit 1
