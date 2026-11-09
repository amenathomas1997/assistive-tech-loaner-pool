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

# contract <label> <json> <path> [path...]
# Asserts each path is PRESENT. A path may be nested with dots —
# "devices.utilisation_percent" — because that is where this check was weakest:
# the end-to-end suite greps the response body for a field name, which passes
# whenever the name appears ANYWHERE. A summary that returned
# utilisation_percent at the top level while the dashboard read it from
# devices.* satisfied the grep and rendered "undefined%" on the first screen a
# user sees. Paths are compared where the view actually looks.
#
# Present-and-null passes: null is a value the views handle, a missing key is
# what breaks them.
contract() {
  local label="$1" json="$2"; shift 2
  local missing
  missing=$(printf '%s' "$json" | python3 -c '
import sys, json

try:
    data = json.load(sys.stdin)
except Exception:
    print("RESPONSE_NOT_JSON")
    sys.exit(0)

if not isinstance(data, dict):
    print("RESPONSE_NOT_OBJECT")
    sys.exit(0)

def present(root, path):
    """Walk a dotted path. A numeric part indexes into a list, so a row shape
    can be checked as rows.0.period rather than only at the top level — which
    is how the whole Reports screen shipped broken: /reports returned the key
    the check looked for and nothing inside it was what the view read."""
    node = root
    for part in path.split("."):
        if isinstance(node, list):
            if not part.isdigit() or int(part) >= len(node):
                return False
            node = node[int(part)]
        elif isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return False
    return True

print(" ".join(p for p in sys.argv[1:] if not present(data, p)))
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

# --- dashboard.js: the first screen anyone sees ---------------------------
# Every one of these is dereferenced to build a counter tile, so a missing one
# renders the word "undefined" to the user rather than failing loudly.
contract "reports/summary -> dashboard.js" "$(api GET /api/v1/reports/summary)" \
  devices.total devices.available devices.checked_out devices.maintenance \
  devices.utilisation_percent \
  loans.overdue loans.due_within_7_days \
  requests.awaiting_review requests.provisioning requests.ready_pickup

# --- insights.js: the Reports screen --------------------------------------
# GET /reports had no check of any kind, and every card on the screen read a
# field the endpoint did not return: the page showed nothing but "Could not
# build reports" from the day it was written. Each path below is one the view
# dereferences.
REPORT=$(api GET /api/v1/reports)
contract "reports -> insights.js headline tiles" "$REPORT" \
  summary.devices.total summary.devices.available summary.devices.utilisation_percent \
  summary.loans.total summary.loans.active \
  return_performance.on_time_rate_percent return_performance.completed_loans \
  return_performance.on_time return_performance.late return_performance.avg_loan_days \
  return_performance.avg_days_late return_performance.max_days_late

contract "reports -> insights.js request performance" "$REPORT" \
  request_performance.total request_performance.approved request_performance.denied \
  request_performance.fulfilled request_performance.awaiting_review \
  request_performance.avg_hours_to_review request_performance.avg_hours_to_fulfil

contract "reports -> insights.js cards" "$REPORT" \
  trend categories activity.clients activity.programs activity.techs \
  idle_devices scan_adoption

# The row shapes each table renders, checked one level in.
contract "reports/trend -> insights.js" "$(api GET /api/v1/reports/trend)" \
  rows.0.period rows.0.checked_out rows.0.returned rows.0.returned_late rows.0.late_rate_percent

contract "reports/categories -> insights.js" "$(api GET /api/v1/reports/categories)" \
  rows.0.category rows.0.device_count rows.0.loan_count rows.0.turns_per_device \
  rows.0.avg_loan_days rows.0.currently_available

contract "reports/activity -> insights.js" "$(api GET /api/v1/reports/activity/client)" \
  rows.0.name rows.0.loan_count rows.0.active_count rows.0.overdue_count \
  rows.0.avg_loan_days rows.0.last_loan_at

contract "reports/idle -> insights.js" "$(api GET /api/v1/reports/idle)" \
  rows.0.id rows.0.name rows.0.barcode rows.0.lifetime_loans rows.0.never_loaned

contract "reports/scan-adoption -> insights.js" "$(api GET /api/v1/reports/scan-adoption)" \
  check_out.scanned check_out.manual check_out.request check_out.api check_out.scan_percent \
  check_in.scanned check_in.manual check_in.api check_in.scan_percent

contract "reports/funding -> insights.js" "$(api GET /api/v1/reports/funding)" \
  by_funding_source by_program

contract "repairs/summary -> insights.js" "$(api GET /api/v1/repairs/summary)" \
  open repaired unrepairable total_cost avg_days_to_close out_of_warranty_cost \
  repeat_offenders by_vendor

# --- admin.js: settings and email ------------------------------------------
contract "GET admin/settings -> admin.js" \
  "$(api GET /api/v1/admin/settings)" settings mail_status

# This is the exact call that produced "undefined is not an object
# (evaluating 'status.usable')": the view re-renders the email status box from
# the save response the moment it returns.
SAVED=$(api PATCH /api/v1/admin/settings '{"settings":{"notify.due_soon_days":3}}')
contract "PATCH admin/settings -> admin.js" "$SAVED" \
  settings mail_status mail_status.usable mail_status.sender mail_status.reason

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

# The scheduler panel leads with "when did this last work?", and renders the
# run log as a table. A missing runs array threw before this check existed.
contract "GET jobs -> admin.js schedulerSection()" "$(api GET /api/v1/jobs)" \
  healthy in_process_scheduler last_success runs
contract "jobs/cron-command -> admin.js" \
  "$(api GET /api/v1/jobs/cron-command)" crontab note token

# The photos panel reports what the uploads are costing in disk.
contract "attachments/usage/summary -> admin.js" \
  "$(api GET /api/v1/attachments/usage/summary)" files megabytes photos_enabled

# The update panel renders from these. reachable may be false on a CI runner
# with no outbound HTTPS, which is itself a case the panel has to handle, so
# the contract is about the keys being present either way.
contract "admin/updates -> admin.js" "$(api GET /api/v1/admin/updates)" \
  local reachable up_to_date summary how_to_apply latest \
  local.app_version local.schema_version local.install_method \
  local.commit_short local.branch local.has_local_changes

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
# Here-string rather than a pipe; see the note on check() in e2e.sh.
grep -q '"can_check_out"' <<< "$KIT" \
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

# --- the third wave -------------------------------------------------------
contract "outcomes/meta -> loans.js check-in prompt" \
  "$(api GET /api/v1/outcomes/meta)" outcomes enabled prompt_on_checkin notice

contract "admin/backup -> admin.js backupSection()" \
  "$(api GET /api/v1/admin/backup)" approximate_size table_count warning last_backup

contract "admin/retention -> admin.js retentionSection()" \
  "$(api GET /api/v1/admin/retention)" notice policy policy.describes policy.never_touched \
  policy.enabled clients clients.count

contract "auth/2fa -> admin.js twoFactorSection()" \
  "$(api GET /api/v1/auth/2fa)" enabled confirmed_at recovery_codes_remaining \
  required_for_you notice

TFA=$(api POST /api/v1/auth/2fa/begin '{}')
contract "auth/2fa/begin -> admin.js enrolTwoFactor()" \
  "$TFA" qr_svg secret secret_formatted steps notice

# --- The lists behind the screens -----------------------------------------
# Added after scripts/verify-route-coverage.php showed that the first request
# every one of these screens makes had no test of any kind. The row paths
# matter more than the top-level keys: /reports returned the key this file
# looked for and nothing inside it was what the view read, which is how an
# entire screen shipped broken.

contract "loans -> loans.js rows" "$(api GET /api/v1/loans)" \
  data.0.id data.0.reference data.0.status data.0.due_at data.0.device_name \
  data.0.device_barcode data.0.client_name data.0.holder_summary \
  data.0.is_overdue data.0.days_overdue data.0.period_name

contract "loans/overdue -> dashboard.js" "$(api GET /api/v1/loans/overdue)" data meta.total
contract "loans/due-soon -> dashboard.js" "$(api GET /api/v1/loans/due-soon)" data meta.within_days

contract "requests -> requests.js rows" "$(api GET /api/v1/requests)" \
  data.0.id data.0.reference data.0.status data.0.client_name data.0.requester_name

contract "requests/meta -> requests.js" "$(api GET /api/v1/requests/meta)" delivery_modes

contract "kits -> workshop.js rows" "$(api GET /api/v1/kits)" \
  data.0.id data.0.name data.0.item_count

contract "repairs -> workshop.js rows" "$(api GET /api/v1/repairs)" \
  data.0.id data.0.reference data.0.status data.0.device_name data.0.is_open

contract "repairs/meta -> workshop.js" "$(api GET /api/v1/repairs/meta)" statuses

# loan_count, not total_loan_count: the Programs screen rendered
# String(p.total_loan_count) for its "Loans ever" column, and no endpoint has
# ever returned that field, so every row read "undefined".
contract "programs -> directory.js rows" "$(api GET /api/v1/programs)" \
  data.0.id data.0.name data.0.device_count data.0.active_loan_count data.0.loan_count

contract "clients -> directory.js rows" "$(api GET /api/v1/clients)" \
  data.0.id data.0.full_name data.0.loan_count data.0.active_loan_count data.0.program_name

contract "devices/facets -> devices.js" "$(api GET /api/v1/devices/facets)" categories
contract "audit/actions -> insights.js" "$(api GET /api/v1/audit/actions)" data

contract "hygiene/queue -> workshop" "$(api GET /api/v1/hygiene/queue)" rows total blocking notice
contract "sites -> workshop" "$(api GET /api/v1/sites)" data meta
contract "transfers -> workshop" "$(api GET /api/v1/transfers)" data meta

# The three detail screens. Every one of these failed to load at all: the device
# screen read loan_history, which the route never returned; the loan screen read
# .data from a response keyed by phase; the repair screen read .timeline where
# the field is events. The suite tested the routes, and nothing tested that the
# screens could use what the routes sent.
DEVICE_ID=$(api GET '/api/v1/devices?per_page=1' | jqv "['data'][0]['id']")
LOAN_ID=$(api GET '/api/v1/loans?per_page=1' | jqv "['data'][0]['id']")
REPAIR_ID=$(api GET '/api/v1/repairs?per_page=1' | jqv "['data'][0]['id']")

contract "devices/{id} -> devices.js detail" "$(api GET /api/v1/devices/$DEVICE_ID)" \
  device.id device.name loan_history accessories waitlist
contract "attachments/loan -> loans.js detail" "$(api GET /api/v1/attachments/loan/$LOAN_ID/list)" all
contract "loans/{id} -> loans.js detail" "$(api GET /api/v1/loans/$LOAN_ID)" \
  loan.id loan.reference loan.device_name loan.status loan.period_name
contract "repairs/{id} -> workshop.js detail" "$(api GET /api/v1/repairs/$REPAIR_ID)" \
  repair.id repair.reference repair.events repair.status_label repair.days_open

# Formatted with toFixed() on three screens, so a string is a crash.
COST_TYPE=$(api GET /api/v1/repairs/$REPAIR_ID | python3 -c '
import sys, json
c = json.load(sys.stdin)["repair"]["cost"]
print("ok" if c is None or isinstance(c, (int, float)) else type(c).__name__)')
if [ "$COST_TYPE" = "ok" ]; then pass "a repair cost is a number"; else fail "a repair cost is a number" "got $COST_TYPE"; fi

rm -f "$JAR"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All API/UI contract checks passed."
  exit 0
fi
echo "$FAILURES contract check(s) FAILED."
exit 1
