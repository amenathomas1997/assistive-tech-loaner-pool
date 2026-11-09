#!/usr/bin/env bash
#
# Who may see what, what a status may become, and what a bad request gets back.
#
# Everything here was found by the whole-project audit of November 2026 and
# reproduced against a running server before it was fixed.
#
#   - A counselor is limited to their own caseload, and the main lists have
#     always said so. Eleven other routes did not: overdue and due-soon lists,
#     the loan CSV, signed agreements and their print view, kit groups, waitlist
#     entries, the device screens and the reports overview. And a spreadsheet
#     import could rewrite any client by typing their reference.
#   - A transfer marked a device "maintenance" on the way out and "available"
#     on the way in, whatever it had been: a retired device came back into
#     stock, and a device out on loan came back marked free.
#   - A check-in ignored an open repair. Closing a repair as cancelled, or
#     cancelling a transfer or a request, did not consult the waitlist.
#   - A device already held for someone could be promised to a second request.
#   - Wrong-typed input was a 500: the schema refusing a value is the request's
#     fault, and a list where a value was expected is too.
#   - The password reset link was stored in clear in the email log, the cron
#     token was shown to everyone who could read settings, and the reset form
#     would send any number of emails to one mailbox.
#
# Assumes scripts/e2e.sh has run.
#
# Usage: scripts/e2e-boundaries.sh [base-url]

set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-http://localhost:3000}"
ADMIN=$(mktemp); VRC=$(mktemp); TECH=$(mktemp)
FAILURES=0
JSON='Content-Type: application/json'
PASSWORD='correct-horse-battery-7'
SECRET_NAME="Zzcaseload$RANDOM"
TAG="B$RANDOM"

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; FAILURES=$((FAILURES + 1)); }
eq()   { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected $3, got $2"; fi; }

jqv() { python3 -c '
import sys, json
try: d = json.loads(sys.stdin.read())
except Exception: print(""); sys.exit()
for part in sys.argv[1].split("."):
    if isinstance(d, list):
        try: d = d[int(part)]
        except Exception: d = None; break
    elif isinstance(d, dict): d = d.get(part)
    else: d = None; break
print("" if d is None else d)' "$1"; }

# api JAR METHOD PATH [BODY]    prints the response body
api()  { local j=$1 m=$2 p=$3; shift 3
         curl -s -b "$j" -c "$j" -X "$m" "$BASE/api/v1$p" -H "$JSON" ${1:+-d "$1"}; }
# code JAR METHOD PATH [BODY]   prints the status code
code() { local j=$1 m=$2 p=$3; shift 3
         curl -s -o /dev/null -w '%{http_code}' -b "$j" -c "$j" -X "$m" "$BASE/api/v1$p" -H "$JSON" ${1:+-d "$1"}; }
login() { api "$1" POST /auth/login "{\"email\":\"$2\",\"password\":\"$PASSWORD\"}" > /dev/null; }

login "$ADMIN" admin@example.org

device() { # device [status]  -> id
  local id; id=$(api "$ADMIN" POST /devices "{\"name\":\"$TAG device $RANDOM\",\"category\":\"$TAG-$RANDOM\"}" | jqv device.id)
  [ -n "${1:-}" ] && api "$ADMIN" PATCH "/devices/$id" "{\"status\":\"$1\"}" > /dev/null
  printf '%s' "$id"
}
status_of() { api "$ADMIN" GET "/devices/$1" | jqv device.status; }

staff() { api "$ADMIN" POST /users "{\"full_name\":\"$1\",\"email\":\"$2\",\"role\":\"$3\",\"password\":\"$PASSWORD\",\"must_change_password\":false}" | jqv user.id; }

VRC_A_MAIL="vrca$RANDOM@example.org"; VRC_B_MAIL="vrcb$RANDOM@example.org"; TECH_MAIL="tech$RANDOM@example.org"
VRC_A=$(staff "Counselor A" "$VRC_A_MAIL" vrc)
VRC_B=$(staff "Counselor B" "$VRC_B_MAIL" vrc)
staff "Technician" "$TECH_MAIL" tech > /dev/null
login "$VRC" "$VRC_A_MAIL"; login "$TECH" "$TECH_MAIL"

REF="$TAG-PRIV"
THEIR_CLIENT=$(api "$ADMIN" POST /clients "{\"first_name\":\"Private\",\"last_name\":\"$SECRET_NAME\",\"counselor_id\":$VRC_B,\"external_ref\":\"$REF\"}" | jqv client.id)
MY_CLIENT=$(api "$ADMIN" POST /clients "{\"first_name\":\"Mine\",\"last_name\":\"$TAG-own\",\"counselor_id\":$VRC_A}" | jqv client.id)

echo "==> A counselor sees their own caseload and nobody else's"

DEV=$(device)
LOAN=$(api "$ADMIN" POST /loans/checkout "{\"device\":$DEV,\"client_id\":$THEIR_CLIENT,\"custom_days\":3}" | jqv loan.id)
api "$ADMIN" POST "/agreements/$LOAN" "{\"signature_method\":\"typed\",\"signed_by_name\":\"Private $SECRET_NAME\",\"typed_signature\":\"Private $SECRET_NAME\"}" > /dev/null
RES=$(api "$ADMIN" POST /reservations "{\"device_id\":$DEV,\"client_id\":$THEIR_CLIENT}" | jqv reservation.id)
BARCODE=$(api "$ADMIN" GET "/devices/$DEV" | jqv device.barcode)
KIT_DEV=$(device)
KIT=$(api "$ADMIN" POST /kits "{\"name\":\"$TAG kit\",\"items\":[{\"device_id\":$KIT_DEV}],\"device_ids\":[$KIT_DEV]}" | jqv kit.id)
GROUP=$(api "$ADMIN" POST "/kits/$KIT/checkout" "{\"client_id\":$THEIR_CLIENT,\"custom_days\":3}" | jqv group_ref)

for path in /loans /loans/overdue '/loans/due-soon?days=10' /loans/export.csv "/agreements/$LOAN" \
            "/agreements/preview/$LOAN" "/agreements/$LOAN/print" /agreements/audit/missing "/groups/$GROUP" \
            /reservations "/reservations/$RES" "/reservations/device/$DEV" /outcomes/outstanding \
            '/devices?per_page=200' "/devices/$DEV" "/devices/lookup/$BARCODE" /reports /clients; do
  if api "$VRC" GET "$path" | grep -q "$SECRET_NAME"; then
    fail "does not reveal the other counselor's client: GET $path"
  else
    pass "does not reveal the other counselor's client: GET $path"
  fi
done

eq 'a client outside the caseload cannot be read'           "$(code "$VRC" GET "/clients/$THEIR_CLIENT")" 404
eq 'a loan outside the caseload cannot be read'             "$(code "$VRC" GET "/loans/$LOAN")" 404
eq 'nor its signed agreement'                               "$(code "$VRC" GET "/agreements/$LOAN")" 404
eq 'a waitlist entry cannot name someone else’s client'     "$(code "$VRC" POST /reservations "{\"device_id\":$DEV,\"client_id\":$THEIR_CLIENT}")" 400
eq 'nor can a loan request'                                 "$(code "$VRC" POST /requests "{\"client_id\":$THEIR_CLIENT,\"requested_details\":\"x\",\"justification\":\"y\"}")" 400
eq 'their own client is still fine'                         "$(code "$VRC" POST /requests "{\"client_id\":$MY_CLIENT,\"requested_details\":\"x\",\"justification\":\"y\"}")" 201

# The device history is the audit trail, which has its own permission.
HISTORY=$(api "$VRC" GET "/devices/$DEV" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["history"]))')
eq 'a device’s audit history needs the audit permission'    "$HISTORY" 0

api "$VRC" POST /clients/import "{\"content\":\"external_ref,last_name\\n$REF,Overwritten\",\"dry_run\":false}" > /dev/null
AFTER=$(api "$ADMIN" GET "/clients/$THEIR_CLIENT" | jqv client.last_name)
eq 'an import cannot rewrite a client on another caseload'  "$AFTER" "$SECRET_NAME"

# Every other role is untouched by any of this.
if api "$TECH" GET "/agreements/$LOAN" | grep -q "$SECRET_NAME"; then pass 'a technician still sees everything'; else fail 'a technician still sees everything'; fi

echo "==> A transfer returns a device to what it was"

SITE1=$(api "$ADMIN" POST /sites "{\"name\":\"$TAG one\"}" | jqv site.id)
[ -n "$SITE1" ] || SITE1=$(api "$ADMIN" POST /sites "{\"name\":\"$TAG one\"}" | jqv id)
SITE=$(api "$ADMIN" GET /sites | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"][0]["id"])')
tid() { python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("transfer") or d).get("id",""))'; }

D=$(device retired)
eq 'a retired device cannot be sent'                        "$(code "$ADMIN" POST /transfers "{\"device_id\":$D,\"to_site_id\":$SITE}")" 409
eq 'and stays retired'                                      "$(status_of "$D")" retired

D=$(device)
T=$(api "$ADMIN" POST /transfers "{\"device_id\":$D,\"to_site_id\":$SITE,\"send_now\":false}" | tid)
api "$ADMIN" POST /loans/checkout "{\"device\":$D,\"client_id\":$MY_CLIENT,\"custom_days\":3}" > /dev/null
eq 'a device lent mid-transfer cannot be received'          "$(code "$ADMIN" POST "/transfers/$T/receive" '{}')" 409
eq 'and is still on loan'                                   "$(status_of "$D")" checked_out

D=$(device)
T=$(api "$ADMIN" POST /transfers "{\"device_id\":$D,\"to_site_id\":$SITE,\"send_now\":false}" | tid)
api "$ADMIN" POST /repairs "{\"device_id\":$D,\"fault\":\"x\"}" > /dev/null
api "$ADMIN" POST "/transfers/$T/cancel" '{}' > /dev/null
eq 'cancelling a transfer leaves a repair in place'         "$(status_of "$D")" maintenance
eq 'a transfer cannot be cancelled twice'                   "$(code "$ADMIN" POST "/transfers/$T/cancel" '{}')" 409

D=$(device)
T=$(api "$ADMIN" POST /transfers "{\"device_id\":$D,\"to_site_id\":$SITE}" | tid)
api "$ADMIN" POST /reservations "{\"device_id\":$D,\"client_id\":$MY_CLIENT}" > /dev/null
api "$ADMIN" POST "/transfers/$T/cancel" '{}' > /dev/null
eq 'cancelling a transfer serves the waitlist'              "$(status_of "$D")" reserved

echo "==> A repair and a loan do not overwrite each other"

D=$(device retired)
eq 'a retired device cannot go in for repair'               "$(code "$ADMIN" POST /repairs "{\"device_id\":$D,\"fault\":\"x\"}")" 409

D=$(device)
api "$ADMIN" POST /loans/checkout "{\"device\":$D,\"client_id\":$MY_CLIENT,\"custom_days\":3}" > /dev/null
api "$ADMIN" POST /repairs "{\"device_id\":$D,\"fault\":\"x\"}" > /dev/null
api "$ADMIN" POST /loans/checkin "{\"device\":$D}" > /dev/null
eq 'a check-in does not close an open repair'               "$(status_of "$D")" maintenance

D=$(device)
R=$(api "$ADMIN" POST /repairs "{\"device_id\":$D,\"fault\":\"x\"}" | jqv repair.id)
api "$ADMIN" POST /reservations "{\"device_id\":$D,\"client_id\":$MY_CLIENT}" > /dev/null
api "$ADMIN" PATCH "/repairs/$R" '{"status":"cancelled"}' > /dev/null
eq 'a cancelled repair serves the waitlist'                 "$(status_of "$D")" reserved

D=$(device)
api "$ADMIN" POST /loans/checkout "{\"device\":$D,\"client_id\":$MY_CLIENT,\"custom_days\":3}" > /dev/null
W=$(api "$ADMIN" POST /reservations "{\"device_id\":$D,\"client_id\":$MY_CLIENT}" | jqv reservation.id)
api "$ADMIN" POST /loans/checkin "{\"device\":$D}" > /dev/null
api "$ADMIN" POST /repairs "{\"device_id\":$D,\"fault\":\"x\"}" > /dev/null
eq 'a held device going for repair returns its entry to the queue' "$(api "$ADMIN" GET "/reservations/$W" | jqv reservation.status)" waiting

echo "==> A status has to be true"

D=$(device)
api "$ADMIN" POST /loans/checkout "{\"device\":$D,\"client_id\":$MY_CLIENT,\"custom_days\":3}" > /dev/null
eq 'a check-in cannot leave a device "on loan"'             "$(code "$ADMIN" POST /loans/checkin "{\"device\":$D,\"new_device_status\":\"checked_out\"}")" 400
D=$(device)
eq 'a device cannot be typed into "on loan"'                "$(code "$ADMIN" PATCH "/devices/$D" '{"status":"checked_out"}')" 409

D=$(device)
api "$ADMIN" POST /loans/checkout "{\"device\":$D,\"client_id\":$MY_CLIENT,\"custom_days\":3}" > /dev/null
api "$ADMIN" POST /reservations "{\"device_id\":$D,\"client_id\":$MY_CLIENT}" > /dev/null
api "$ADMIN" POST /loans/checkin "{\"device\":$D}" > /dev/null
Q=$(api "$ADMIN" POST /requests '{"requested_details":"x","justification":"y"}' | jqv request.id)
eq 'a held device cannot be promised to a second request'   "$(code "$ADMIN" POST "/requests/$Q/approve" "{\"device_id\":$D}")" 409

D=$(device)
Q=$(api "$ADMIN" POST /requests '{"requested_details":"x","justification":"y"}' | jqv request.id)
api "$ADMIN" POST "/requests/$Q/approve" "{\"device_id\":$D}" > /dev/null
api "$ADMIN" POST /reservations "{\"device_id\":$D,\"client_id\":$MY_CLIENT}" > /dev/null
api "$ADMIN" POST "/requests/$Q/cancel" '{}' > /dev/null
eq 'a cancelled request serves the waitlist'                "$(status_of "$D")" reserved

echo "==> A bad request gets a 400, not a server error"

D=$(device)
# path|body|expected status
while IFS='|' read -r METHOD ROUTE BODY WANT; do
  eq "$METHOD $ROUTE $BODY" "$(code "$ADMIN" "$METHOD" "$ROUTE" "$BODY")" "$WANT"
done <<CASES
POST|/repairs|{"device_id":$D,"fault":"x","cost":"abc"}|400
POST|/repairs|{"device_id":$D,"fault":"x","assigned_to":999999}|400
PATCH|/clients/$MY_CLIENT|{"first_name":""}|400
PATCH|/clients/$MY_CLIENT|{"program_id":{"a":1}}|400
PATCH|/clients/$MY_CLIENT|{"counselor_id":"abc"}|400
PATCH|/devices/$D|{"site_id":"abc"}|400
PATCH|/devices/$D|{"purchase_cost":99999999999}|400
POST|/devices/$D/cleaned|{"loan_id":"abc"}|400
POST|/devices/$D/cleaned|{"cleaned_at":["x"]}|200
POST|/devices/$D/dispose|{"method":{"a":1}}|400
POST|/agreements/$LOAN|{"role":[]}|409
POST|/loans/$LOAN/outcome|{"outcome":["x"]}|400
PATCH|/admin/organization|{"contact_email":null}|200
CASES
for q in '/loans?search[]=x' '/repairs?status[]=x' '/requests?status[]=x' '/users?search[]=x' \
         '/clients?search[]=x' '/audit/export.csv?action[]=x' '/admin/settings/email-log?limit=-1'; do
  eq "GET $q" "$(code "$ADMIN" GET "$q")" 200
done

echo "==> Secrets stay where they belong"

CRON=$(api "$TECH" GET /admin/settings | jqv cron.token)
eq 'someone who can only read settings is not given the cron token' "$CRON" ''
eq 'nor can they ask for it directly'                       "$(code "$TECH" GET /jobs/cron-command)" 403
if api "$ADMIN" GET /admin/settings | jqv cron.url | grep -q 'token='; then
  fail 'the cron address carries no token'
else
  pass 'the cron address carries no token'
fi

RESET_MAIL="$TECH_MAIL"
for _ in 1 2 3; do curl -s -o /dev/null -X POST "$BASE/api/v1/auth/forgot-password" -H "$JSON" -d "{\"email\":\"$RESET_MAIL\"}"; done
LOG=$(api "$ADMIN" GET '/admin/settings/email-log?limit=200')
SENT=$(printf '%s' "$LOG" | python3 -c "
import sys,json
print(sum(1 for r in json.load(sys.stdin)['data'] if r['event_type']=='password_reset' and '$RESET_MAIL' in r['recipient']))")
eq 'three requests send one reset message'                  "$SENT" 1

php -r '
require "app/bootstrap.php";
$n = (int) Loaner\Db::value("SELECT COUNT(*) FROM email_log WHERE event_type = \"password_reset\" AND body_preview LIKE \"%token=%\"");
exit($n === 0 ? 0 : 1);'
if [ $? -eq 0 ]; then pass 'a reset link is not kept in the email log'; else fail 'a reset link is not kept in the email log'; fi

eq 'the server path is not given to strangers after install' "$(curl -s "$BASE/api/install/state" | grep -c config_path)" 0

CC=$(curl -s -D - -o /dev/null -b "$ADMIN" "$BASE/api/v1/clients" | tr -d '\r' | grep -i '^cache-control' | head -1)
eq 'client records are not left in the browser cache'       "$CC" 'Cache-Control: no-store'

LOAN_D=$(device)
L2=$(api "$ADMIN" POST /loans/checkout "{\"device\":$LOAN_D,\"client_id\":$MY_CLIENT,\"custom_days\":3}" | jqv loan.id)
GIF='data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
STORED=$(api "$ADMIN" POST "/attachments/loan/$L2" "{\"phase\":\"out\",\"images\":[\"$GIF\"]}" | jqv count)
eq 'a file must be the kind of image it claims to be'       "$STORED" 0

rm -f "$ADMIN" "$VRC" "$TECH"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo 'All boundary checks passed.'
  exit 0
fi
echo "$FAILURES boundary check(s) FAILED."
exit 1
