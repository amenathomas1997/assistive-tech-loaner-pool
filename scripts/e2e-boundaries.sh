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

# --- Found by the third audit -------------------------------------------------

# A blank retention box is saved as zero, and zero has to mean "keep".
KEEP='{"settings":{"retention.enabled":true,"retention.client_years":0,"retention.audit_years":0,"retention.email_log_days":0}}'
api "$ADMIN" PATCH /admin/settings "$KEEP" > /dev/null
eq 'a blank audit limit previews nothing to delete'         "$(api "$ADMIN" GET /admin/retention | jqv audit_entries)" 0
PURGE_BODY="{\"password\":\"$PASSWORD\"}"
PURGED=$(api "$ADMIN" POST /admin/retention/purge "$PURGE_BODY")
eq 'a blank audit limit deletes no audit entries'           "$(printf '%s' "$PURGED" | jqv audit_deleted)" 0
eq 'a blank email limit deletes no email records'           "$(printf '%s' "$PURGED" | jqv email_deleted)" 0
OFF='{"settings":{"retention.enabled":false,"retention.client_years":7,"retention.audit_years":7,"retention.email_log_days":365}}'
api "$ADMIN" PATCH /admin/settings "$OFF" > /dev/null

# A request for one device cannot be fulfilled with another.
PROMISED=$(device); OTHER=$(device)
Q=$(api "$ADMIN" POST /requests '{"requested_details":"x","justification":"y"}' | jqv request.id)
APPROVE="{\"device_id\":$PROMISED}"
api "$ADMIN" POST "/requests/$Q/approve" "$APPROVE" > /dev/null
WRONG="{\"device\":$OTHER,\"client_id\":$MY_CLIENT,\"custom_days\":3,\"request_id\":$Q}"
eq 'a request cannot be spent on a different device'        "$(code "$ADMIN" POST /loans/checkout "$WRONG")" 409
eq 'and the promised device stays held'                     "$(status_of "$PROMISED")" reserved

# A new client is held to the same checks as an edit.
BAD_COUNSELOR='{"first_name":"A","last_name":"B","counselor_id":99999999}'
BAD_SHAPE='{"first_name":"A","last_name":"B","program_id":[1]}'
eq 'a new client cannot name a counselor who does not exist' "$(code "$ADMIN" POST /clients "$BAD_COUNSELOR")" 400
eq 'a new client cannot send a list as its program'         "$(code "$ADMIN" POST /clients "$BAD_SHAPE")" 400

# Only somebody with the password learns an account was deactivated.
GONE_MAIL="gone-$(date +%s)-$$@example.org"
GONE=$(staff 'Gone Person' "$GONE_MAIL" tech)
GONE_OFF='{"active":false}'
api "$ADMIN" PATCH "/users/$GONE" "$GONE_OFF" > /dev/null
NOJAR=$(mktemp)
WRONG_PW="{\"email\":\"$GONE_MAIL\",\"password\":\"not-the-password-99\"}"
RIGHT_PW="{\"email\":\"$GONE_MAIL\",\"password\":\"$PASSWORD\"}"
eq 'a wrong password does not reveal a deactivated account' "$(code "$NOJAR" POST /auth/login "$WRONG_PW")" 401
eq 'the right password is told the account is deactivated'  "$(code "$NOJAR" POST /auth/login "$RIGHT_PW")" 403
rm -f "$NOJAR"

# --- Found by the fourth audit ------------------------------------------------

rows() { python3 -c 'import sys,json; print(len(json.load(sys.stdin)["data"]))'; }
checkout() { api "$ADMIN" POST /loans/checkout "{\"device\":$1,\"client_id\":$2,\"custom_days\":7}"; }
import_csv() { # import_csv "header\nrow"   a real import, not a dry run
  local body; body=$(python3 -c 'import json,sys; print(json.dumps({"content":sys.argv[1].replace("\\n","\n"),"dry_run":False}))' "$1")
  api "$ADMIN" POST /devices/import "$body" > /dev/null
}

# Re-importing a spreadsheet must not reset what the sheet did not mention.
A4_TAG="A4$RANDOM$RANDOM"; A4_RETIRED=$(device retired)
A4_TAG_BODY="{\"asset_tag\":\"$A4_TAG\"}"
api "$ADMIN" PATCH "/devices/$A4_RETIRED" "$A4_TAG_BODY" > /dev/null
import_csv "asset_tag,name\n$A4_TAG,Renamed by import"
eq 'an import with no status column leaves a retired device retired' "$(status_of "$A4_RETIRED")" retired

# A status column cannot contradict a loan.
A4_OUT_TAG="A4$RANDOM$RANDOM"; A4_OUT=$(device)
A4_OUT_BODY="{\"asset_tag\":\"$A4_OUT_TAG\"}"
api "$ADMIN" PATCH "/devices/$A4_OUT" "$A4_OUT_BODY" > /dev/null
checkout "$A4_OUT" "$MY_CLIENT" > /dev/null
import_csv "asset_tag,name,status\n$A4_OUT_TAG,Still out,available"
eq 'an import cannot mark a device on loan as available'    "$(status_of "$A4_OUT")" checked_out

# One licence is one row, however many seats are out.
LICENCE_NAME="$TAG licence $RANDOM"
LICENCE_BODY="{\"name\":\"$LICENCE_NAME\",\"item_type\":\"licence\",\"seats_total\":3,\"licence_key\":\"SECRET-KEY-1\"}"
LICENCE=$(api "$ADMIN" POST /devices "$LICENCE_BODY" | jqv device.id)
checkout "$LICENCE" "$MY_CLIENT" > /dev/null
checkout "$LICENCE" "$MY_CLIENT" > /dev/null
LICENCE_Q=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$LICENCE_NAME")
eq 'a licence with two seats out is listed once'            "$(api "$ADMIN" GET "/devices?search=$LICENCE_Q" | rows)" 1
eq 'a licence with a free seat counts as available'         "$(api "$ADMIN" GET "/devices?status=available&search=$LICENCE_Q" | rows)" 1
eq 'a counselor is not shown a licence key'                 "$(api "$VRC" GET "/devices/$LICENCE" | jqv device.licence_key)" ''

# Cancelling a request only releases a hold it actually had.
HELD=$(device)
HOLDER=$(api "$ADMIN" POST /requests '{"requested_details":"x","justification":"y"}' | jqv request.id)
HELD_BODY="{\"device_id\":$HELD}"
api "$ADMIN" POST "/requests/$HOLDER/approve" "$HELD_BODY" > /dev/null
BYSTANDER_BODY="{\"device_id\":$HELD,\"justification\":\"y\"}"
BYSTANDER=$(api "$ADMIN" POST /requests "$BYSTANDER_BODY" | jqv request.id)
CANCEL_BODY='{"reason":"no longer needed"}'
api "$ADMIN" POST "/requests/$BYSTANDER/cancel" "$CANCEL_BODY" > /dev/null
eq 'cancelling one request does not free a device held for another' "$(status_of "$HELD")" reserved

# Fulfilling a request cannot jump the waitlist.
WAIT_ON='{"settings":{"reservations.enabled":true}}'
api "$ADMIN" PATCH /admin/settings "$WAIT_ON" > /dev/null
WAITED=$(device)
LOAN=$(checkout "$WAITED" "$MY_CLIENT" | jqv loan.id)
REQ_CLIENT_BODY='{"first_name":"Other","last_name":"Client"}'
REQ_CLIENT=$(api "$ADMIN" POST /clients "$REQ_CLIENT_BODY" | jqv client.id)
WAIT_BODY="{\"device_id\":$WAITED,\"client_id\":$MY_CLIENT}"
RES=$(api "$ADMIN" POST /reservations "$WAIT_BODY" | jqv reservation.id)
JUMPER_BODY="{\"device_id\":$WAITED,\"client_id\":$REQ_CLIENT,\"justification\":\"y\"}"
JUMPER=$(api "$ADMIN" POST /requests "$JUMPER_BODY" | jqv request.id)
api "$ADMIN" POST "/requests/$JUMPER/approve" '{}' > /dev/null
CHECKIN_BODY="{\"loan_id\":$LOAN}"
api "$ADMIN" POST /loans/checkin "$CHECKIN_BODY" > /dev/null
eq 'the returned device is held for the waitlist'           "$(status_of "$WAITED")" reserved
FULFIL_BODY='{"custom_days":7}'
eq 'a request cannot be fulfilled over a waitlist hold'     "$(code "$ADMIN" POST "/requests/$JUMPER/fulfil" "$FULFIL_BODY")" 409
eq 'and the device is still held'                           "$(status_of "$WAITED")" reserved

# Disposing of a promised device puts the person back in the queue.
DISPOSE_BODY='{"method":"donated"}'
api "$ADMIN" POST "/devices/$WAITED/dispose" "$DISPOSE_BODY" > /dev/null
eq 'disposing of a held device returns the waitlist entry to waiting' "$(api "$ADMIN" GET "/reservations/$RES" | jqv reservation.status)" waiting

# Closing a repair does not undo a disposal, or forget a promise.
GONE_DEVICE=$(device)
REPAIR_BODY="{\"device_id\":$GONE_DEVICE,\"fault\":\"broken\"}"
GONE_REPAIR=$(api "$ADMIN" POST /repairs "$REPAIR_BODY" | jqv repair.id)
api "$ADMIN" POST "/devices/$GONE_DEVICE/dispose" "$DISPOSE_BODY" > /dev/null
CLOSE_BODY='{"status":"cancelled"}'
api "$ADMIN" PATCH "/repairs/$GONE_REPAIR" "$CLOSE_BODY" > /dev/null
eq 'closing a repair does not bring a disposed device back' "$(status_of "$GONE_DEVICE")" retired

PROMISED2=$(device)
PROMISE_REQ=$(api "$ADMIN" POST /requests '{"requested_details":"x","justification":"y"}' | jqv request.id)
PROMISE_BODY="{\"device_id\":$PROMISED2}"
api "$ADMIN" POST "/requests/$PROMISE_REQ/approve" "$PROMISE_BODY" > /dev/null
REPAIR2_BODY="{\"device_id\":$PROMISED2,\"fault\":\"broken\"}"
PROMISE_REPAIR=$(api "$ADMIN" POST /repairs "$REPAIR2_BODY" | jqv repair.id)
api "$ADMIN" PATCH "/repairs/$PROMISE_REPAIR" "$CLOSE_BODY" > /dev/null
eq 'a repaired device goes back to the request it was promised to' "$(status_of "$PROMISED2")" reserved

# Changing the device on a request moves the hold with it.
MOVED_TO=$(device)
MOVE_BODY="{\"state\":\"provisioning\",\"device_id\":$MOVED_TO}"
api "$ADMIN" POST "/requests/$PROMISE_REQ/fulfillment" "$MOVE_BODY" > /dev/null
eq 'moving a request to another device reserves the new one' "$(status_of "$MOVED_TO")" reserved
eq 'and releases the old one'                               "$(status_of "$PROMISED2")" available
NO_DEVICE='{"state":"provisioning","device_id":99999999}'
eq 'a request cannot be moved to a device that does not exist' "$(code "$ADMIN" POST "/requests/$PROMISE_REQ/fulfillment" "$NO_DEVICE")" 400

# The label page only prints what it validated.
eq 'the label page refuses an unknown barcode type'         "$(code "$ADMIN" GET "/devices/labels?ids=$MOVED_TO&symbology=%3Cimg%20src%3Dx%3E")" 400

# ---------------------------------------------------------------------------
# Fifth audit
# ---------------------------------------------------------------------------

# A page number past what the database can offset by is a quiet empty page.
for path in /devices /loans /clients /audit /requests; do
  eq "an absurd page number on $path is not a server error"  "$(code "$ADMIN" GET "$path?page=99999999999999999999")" 200
done

# A session cookie sent as an array is simply not a session.
eq 'an array-shaped session cookie is treated as signed out' \
   "$(curl -s -o /dev/null -w '%{http_code}' -H 'Cookie: loaner_session[]=x' "$BASE/api/v1/devices")" 401

# A counselor saving their own client keeps them. The edit form used to send
# an empty counselor, which unassigned the client and locked the counselor out.
UNASSIGN_BODY='{"first_name":"Mine","counselor_id":null}'
api "$VRC" PATCH "/clients/$MY_CLIENT" "$UNASSIGN_BODY" > /dev/null
eq 'a counselor cannot unassign themselves from a client'   "$(api "$ADMIN" GET "/clients/$MY_CLIENT" | jqv client.counselor_id)" "$VRC_A"
eq 'and can still open the client afterwards'               "$(code "$VRC" GET "/clients/$MY_CLIENT")" 200
REASSIGN_BODY="{\"counselor_id\":$VRC_B}"
api "$VRC" PATCH "/clients/$MY_CLIENT" "$REASSIGN_BODY" > /dev/null
eq 'nor hand a client to another counselor'                 "$(api "$ADMIN" GET "/clients/$MY_CLIENT" | jqv client.counselor_id)" "$VRC_A"

# Clients can be found by phone number.
PHONE="555-01$((RANDOM % 90 + 10))-$RANDOM"
PHONE_BODY="{\"first_name\":\"Phone\",\"last_name\":\"$TAG-phone\",\"phone\":\"$PHONE\"}"
PHONE_CLIENT=$(api "$ADMIN" POST /clients "$PHONE_BODY" | jqv client.id)
eq 'client search matches a phone number'                   "$(api "$ADMIN" GET "/clients?search=$PHONE" | jqv data.0.id)" "$PHONE_CLIENT"

# Settings are checked before any of them are saved.
setting() { api "$ADMIN" GET /admin/settings | python3 -c '
import sys, json
print(json.load(sys.stdin)["settings"].get(sys.argv[1]))' "$1"; }
ARRAY_SETTING='{"settings":{"notify.due_soon_days":[1,2]}}'
eq 'a list where a setting wants one value is refused'      "$(code "$ADMIN" PATCH /admin/settings "$ARRAY_SETTING")" 400
HOLD_BEFORE=$(setting reservations.hold_hours)
NEGATIVE_HOLD='{"settings":{"reservations.hold_hours":-3}}'
eq 'a negative waitlist hold is refused'                    "$(code "$ADMIN" PATCH /admin/settings "$NEGATIVE_HOLD")" 400
eq 'and the hold is unchanged'                              "$(setting reservations.hold_hours)" "$HOLD_BEFORE"
WORD_SETTING='{"settings":{"loans.max_per_client":"lots"}}'
eq 'a word where a setting wants a number is refused'       "$(code "$ADMIN" PATCH /admin/settings "$WORD_SETTING")" 400
MAX_BEFORE=$(setting loans.max_per_client)
MIXED_SETTINGS='{"settings":{"loans.max_per_client":7,"notify.due_soon_days":0}}'
eq 'one bad setting refuses the whole request'              "$(code "$ADMIN" PATCH /admin/settings "$MIXED_SETTINGS")" 400
eq 'and the good setting beside it is not half-saved'       "$(setting loans.max_per_client)" "$MAX_BEFORE"
GOOD_SETTING="{\"settings\":{\"reservations.hold_hours\":$HOLD_BEFORE}}"
eq 'a setting inside its range is still accepted'           "$(code "$ADMIN" PATCH /admin/settings "$GOOD_SETTING")" 200

# Sorting clients by name, descending, reverses the last names too.
SORT_A_BODY="{\"first_name\":\"Zed\",\"last_name\":\"$TAG-sort Aaa\"}"
SORT_Z_BODY="{\"first_name\":\"Amy\",\"last_name\":\"$TAG-sort Zzz\"}"
SORT_A=$(api "$ADMIN" POST /clients "$SORT_A_BODY" | jqv client.id)
SORT_Z=$(api "$ADMIN" POST /clients "$SORT_Z_BODY" | jqv client.id)
eq 'clients sort by last name ascending'                    "$(api "$ADMIN" GET "/clients?search=$TAG-sort&sort=name" | jqv data.0.id)" "$SORT_A"
eq 'and descending'                                         "$(api "$ADMIN" GET "/clients?search=$TAG-sort&sort=-name" | jqv data.0.id)" "$SORT_Z"

# Paging through rows that tie on the sort column never repeats or drops one.
TIE="$TAG-tie-$RANDOM"
TIE_BODY="{\"name\":\"$TIE\",\"category\":\"$TIE\"}"
for _ in 1 2 3 4 5 6; do api "$ADMIN" POST /devices "$TIE_BODY" > /dev/null; done
SEEN=$(for page in 1 2 3; do
  api "$ADMIN" GET "/devices?search=$TIE&sort=name&per_page=2&page=$page"
  echo
done | python3 -c '
import sys, json
ids = [row["id"] for line in sys.stdin if line.strip() for row in json.loads(line)["data"]]
print(len(ids), len(set(ids)))')
eq 'three pages of identically named devices hold six different devices' "$SEEN" '6 6'

# ---------------------------------------------------------------------------
# Sixth audit
# ---------------------------------------------------------------------------

# Direct writes, for states that take days to arrive by themselves. This script
# only ever runs against the throwaway database reset-and-test.sh creates.
sql() { php -r '
  $c = json_decode(file_get_contents("data/config.json"), true); $d = $c["db"];
  if ($d["database"] !== "loanerpool_test") { fwrite(STDERR, "refusing: not the test database\n"); exit(1); }
  (new PDO("mysql:host={$d["host"]};port={$d["port"]};dbname={$d["database"]}", $d["user"], $d["password"]))->exec($argv[1]);
' "$1"; }
totp() { php -r 'require "app/Totp.php"; echo Loaner\Totp::codeAt($argv[1], time() + (int) $argv[2]);' "$1" "$2"; }
new_client() { local body="{\"first_name\":\"$1\",\"last_name\":\"$TAG-$2\"}"; api "$ADMIN" POST /clients "$body" | jqv client.id; }
lend() { local body="{\"device\":$1,\"client_id\":$2,\"custom_days\":$3}"; api "$ADMIN" POST /loans/checkout "$body" | jqv loan.id; }

# Two-factor guesses are limited per account, not per typed password.
TF_MAIL="tf$RANDOM@example.org"; TF_JAR=$(mktemp)
TF_ID=$(staff "Two Factor" "$TF_MAIL" tech)
TF_LOGIN="{\"email\":\"$TF_MAIL\",\"password\":\"$PASSWORD\"}"
api "$TF_JAR" POST /auth/login "$TF_LOGIN" > /dev/null
TF_SECRET=$(api "$TF_JAR" POST /auth/2fa/begin '{}' | jqv secret)
TF_CONFIRM="{\"code\":\"$(totp "$TF_SECRET" 0)\"}"
api "$TF_JAR" POST /auth/2fa/confirm "$TF_CONFIRM" > /dev/null
TF_REISSUE="{\"password\":\"$PASSWORD\"}"
api "$TF_JAR" POST /auth/2fa/recovery-codes "$TF_REISSUE" > /dev/null
eq 'new recovery codes are recorded in the audit log' \
   "$(api "$ADMIN" GET "/audit?search=recovery%20codes&action_prefix=auth&per_page=1" | jqv data.0.action)" auth.twofactor_codes_reissued
rm -f "$TF_JAR"
pending() { api "$TF_JAR" POST /auth/login "$TF_LOGIN" | jqv pending_id; }
guess() { local body="{\"pending_id\":\"$1\",\"code\":\"000000\"}"; code "$TF_JAR" POST /auth/login/verify "$body"; }

P=$(pending)
guess "$P" > /dev/null; guess "$P" > /dev/null; guess "$P" > /dev/null
TF_GOOD="{\"pending_id\":\"$P\",\"code\":\"$(totp "$TF_SECRET" 30)\"}"
eq 'a right code still works after a few wrong ones'        "$(code "$TF_JAR" POST /auth/login/verify "$TF_GOOD")" 200
P=$(pending)
for _ in 1 2 3 4 5; do guess "$P" > /dev/null; done
P=$(pending)
guess "$P" > /dev/null
eq 'the count starts again after a successful sign-in'      "$(guess "$P")" 401
eq 'the guess that reaches the limit locks the account'     "$(guess "$P")" 423
eq 'and the right password no longer starts a sign-in'      "$(code "$TF_JAR" POST /auth/login "$TF_LOGIN")" 423

# An administrator can get a colleague back in, carefully.
RESET_WRONG='{"password":"not-the-password-1"}'
RESET_RIGHT="{\"password\":\"$PASSWORD\"}"
eq 'resetting a colleague needs the right password'         "$(code "$ADMIN" POST "/users/$TF_ID/reset-2fa" "$RESET_WRONG")" 400
eq 'a technician cannot reset anyone'                       "$(code "$TECH" POST "/users/$TF_ID/reset-2fa" "$RESET_RIGHT")" 403
eq 'the staff list says who has it on'                      "$(api "$ADMIN" GET "/users/$TF_ID" | jqv user.totp_enabled)" True
eq 'an administrator can reset a colleague'                 "$(code "$ADMIN" POST "/users/$TF_ID/reset-2fa" "$RESET_RIGHT")" 200
eq 'which clears the lock too, and asks for no code'        "$(api "$TF_JAR" POST /auth/login "$TF_LOGIN" | jqv user.email)" "$TF_MAIL"
eq 'resetting it twice says there is nothing to reset'      "$(code "$ADMIN" POST "/users/$TF_ID/reset-2fa" "$RESET_RIGHT")" 409
ADMIN_ID=$(api "$ADMIN" GET /auth/me | jqv user.id)
eq 'and nobody resets their own this way'                   "$(code "$ADMIN" POST "/users/$ADMIN_ID/reset-2fa" "$RESET_RIGHT")" 400
rm -f "$TF_JAR"

# Due dates, counted the way people count them.
DUE_DEVICE=$(device); DUE_CLIENT=$(new_client Due Dates)
DUE_LOAN=$(lend "$DUE_DEVICE" "$DUE_CLIENT" 7)
eq 'a seven-day loan is due in seven days'                  "$(api "$ADMIN" GET "/loans/$DUE_LOAN" | jqv loan.days_until_due)" 7
DUE_BEFORE=$(api "$ADMIN" GET "/loans/$DUE_LOAN" | jqv loan.due_at)
BLANK_DUE='{"new_due_at":""}'
eq 'a blank date is refused'                                "$(code "$ADMIN" POST "/loans/$DUE_LOAN/extend" "$BLANK_DUE")" 400
eq 'and does not make the loan due today'                   "$(api "$ADMIN" GET "/loans/$DUE_LOAN" | jqv loan.due_at)" "$DUE_BEFORE"

# A notice sent yesterday, a moment later than this morning's run.
sql "UPDATE loans SET due_at = DATE_SUB(NOW(), INTERVAL 5 DAY) WHERE id = $DUE_LOAN"
sql "INSERT INTO loan_events (loan_id, event_type, notes, created_at) VALUES ($DUE_LOAN, 'overdue_notice', 'test', DATE_SUB(NOW(), INTERVAL 86390 SECOND))"
OVERDUE_IDS=$(api "$ADMIN" GET /loans/overdue | python3 -c 'import sys,json; print(" ".join(str(r["id"]) for r in json.load(sys.stdin)["data"]))')
case " $OVERDUE_IDS " in *" $DUE_LOAN "*) pass 'a loan chased yesterday is still overdue today';; *) fail 'a loan chased yesterday is still overdue today';; esac

# The end of a date filter includes that day.
TODAY=$(php -r 'echo date("Y-m-d");')
eq 'the audit log filtered to today finds today'            "$([ "$(api "$ADMIN" GET "/audit?from=$TODAY&to=$TODAY&per_page=1" | jqv meta.total)" -gt 0 ] && echo yes)" yes

# Lending over a request's hold does not lose the request.
HELD=$(device); OWNER=$(new_client Request Owner); WALKIN=$(new_client Walk In)
HELD_REQ_BODY="{\"client_id\":$OWNER,\"device_id\":$HELD,\"justification\":\"y\"}"
HELD_REQ=$(api "$ADMIN" POST /requests "$HELD_REQ_BODY" | jqv request.id)
HELD_APPROVE="{\"device_id\":$HELD}"
api "$ADMIN" POST "/requests/$HELD_REQ/approve" "$HELD_APPROVE" > /dev/null
OVERRIDE_BODY="{\"device\":$HELD,\"client_id\":$WALKIN,\"custom_days\":7,\"override_hold\":true}"
HELD_LOAN=$(api "$ADMIN" POST /loans/checkout "$OVERRIDE_BODY" | jqv loan.id)
HELD_IN="{\"loan_id\":$HELD_LOAN}"
api "$ADMIN" POST /loans/checkin "$HELD_IN" > /dev/null
eq 'a device lent over a request hold is held again on return' "$(status_of "$HELD")" reserved
eq 'for the request that is still waiting'                  "$(api "$ADMIN" GET "/requests/$HELD_REQ" | jqv request.status)" approved

# Editing a promised device by hand puts the person back in the queue.
PROMISED=$(device); HOLDER=$(new_client Current Holder); NEXT=$(new_client Next Inline)
PROMISED_LOAN=$(lend "$PROMISED" "$HOLDER" 7)
PROMISED_WAIT="{\"device_id\":$PROMISED,\"client_id\":$NEXT}"
PROMISED_RES=$(api "$ADMIN" POST /reservations "$PROMISED_WAIT" | jqv reservation.id)
PROMISED_IN="{\"loan_id\":$PROMISED_LOAN}"
api "$ADMIN" POST /loans/checkin "$PROMISED_IN" > /dev/null
eq 'the waitlist holds the returned device'                 "$(api "$ADMIN" GET "/reservations/$PROMISED_RES" | jqv reservation.status)" ready
TO_MAINT='{"status":"maintenance"}'
api "$ADMIN" PATCH "/devices/$PROMISED" "$TO_MAINT" > /dev/null
eq 'marking it for maintenance returns them to the queue'   "$(api "$ADMIN" GET "/reservations/$PROMISED_RES" | jqv reservation.status)" waiting
TO_AVAILABLE='{"status":"available"}'
api "$ADMIN" PATCH "/devices/$PROMISED" "$TO_AVAILABLE" > /dev/null
eq 'and bringing it back offers it to them again'           "$(api "$ADMIN" GET "/reservations/$PROMISED_RES" | jqv reservation.status)" ready

# Retention counts from when the device came back.
OLD_CLIENT=$(new_client Long Loan); OLD_DEVICE=$(device)
OLD_LOAN=$(lend "$OLD_DEVICE" "$OLD_CLIENT" 7)
OLD_IN="{\"loan_id\":$OLD_LOAN}"
api "$ADMIN" POST /loans/checkin "$OLD_IN" > /dev/null
sql "UPDATE loans SET checked_out_at = DATE_SUB(NOW(), INTERVAL 9 YEAR) WHERE id = $OLD_LOAN"
sql "UPDATE clients SET created_at = DATE_SUB(NOW(), INTERVAL 9 YEAR) WHERE id = $OLD_CLIENT"
RETAIN_SEVEN='{"settings":{"retention.client_years":7}}'
api "$ADMIN" PATCH /admin/settings "$RETAIN_SEVEN" > /dev/null
RETAIN_HITS=$(api "$ADMIN" GET /admin/retention | python3 -c 'import sys,json; print(sum(1 for s in json.load(sys.stdin)["clients"]["sample"] if s["id"]=='"$OLD_CLIENT"'))')
eq 'someone who returned a device yesterday is not inactive' "$RETAIN_HITS" 0

# Several seats out: the barcode alone cannot say whose is coming back.
SEAT_BODY="{\"name\":\"$TAG seats\",\"category\":\"$TAG-seats\",\"item_type\":\"licence\",\"seats_total\":3}"
SEATS=$(api "$ADMIN" POST /devices "$SEAT_BODY" | jqv device.id)
SEAT_BARCODE=$(api "$ADMIN" GET "/devices/$SEATS" | jqv device.barcode)
SEAT_A=$(new_client Seat Alpha); SEAT_B=$(new_client Seat Beta)
SEAT_LOAN_A=$(lend "$SEATS" "$SEAT_A" 7); SEAT_LOAN_B=$(lend "$SEATS" "$SEAT_B" 7)
SEAT_SCAN="{\"barcode\":\"$SEAT_BARCODE\"}"
eq 'a barcode with several seats out needs a named loan'    "$(code "$ADMIN" POST /loans/checkin "$SEAT_SCAN")" 409
eq 'and neither loan was ended by trying'                   "$(api "$ADMIN" GET "/loans/$SEAT_LOAN_A" | jqv loan.status)" active
SEAT_IN="{\"loan_id\":$SEAT_LOAN_B}"
eq 'naming the loan ends that loan'                         "$(code "$ADMIN" POST /loans/checkin "$SEAT_IN")" 200

# A list where one value belongs is a bad request, not a crash.
while IFS='|' read -r method path body; do
  got=$(code "$ADMIN" "$method" "$path" "$body")
  case "$got" in 500) fail "malformed $path" "got 500 for $body";; *) pass "malformed $path is refused cleanly";; esac
done <<'MALFORMED'
POST|/loans/checkin|{"barcode":[1]}
POST|/admin/api-keys|{"name":"k","scopes":[[1]]}
POST|/admin/backup|{"password":123}
POST|/admin/updates/apply|{"password":[1]}
POST|/auth/login|{"email":"a@b.co","password":[1]}
POST|/auth/login/verify|{"pending_id":"x","code":[1]}
POST|/auth/change-password|{"current_password":[1],"new_password":"x"}
POST|/auth/reset-password|{"token":"x","new_password":[1]}
MALFORMED

rm -f "$ADMIN" "$VRC" "$TECH"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo 'All boundary checks passed.'
  exit 0
fi
echo "$FAILURES boundary check(s) FAILED."
exit 1
