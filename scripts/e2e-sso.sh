#!/usr/bin/env bash
#
# Sign in with Microsoft Entra ID, against a stand-in token endpoint
# (scripts/fake-entra.php). The server must have been started with
# LOANER_SSO_AUTHORITY pointing at it: see scripts/reset-and-test.sh.
#
# What this cannot show is that Microsoft itself behaves as documented. It
# shows what this application does with every answer it could be given.
#
# Assumes scripts/e2e.sh has run.
#
# Usage: scripts/e2e-sso.sh [base-url]

set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-http://localhost:3000}"
FAKE_PORT="${LP_FAKE_ENTRA_PORT:-3909}"
AUTHORITY="http://127.0.0.1:$FAKE_PORT"
ADMIN=$(mktemp)
FAILURES=0
JSON='Content-Type: application/json'
PASSWORD='correct-horse-battery-7'
TENANT='11111111-2222-3333-4444-555555555555'
CLIENT='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

php -S "127.0.0.1:$FAKE_PORT" scripts/fake-entra.php > /dev/null 2>&1 &
FAKE_PID=$!
trap 'kill $FAKE_PID 2>/dev/null' EXIT
for _ in $(seq 1 30); do
  curl -s -o /dev/null "$AUTHORITY/" && break
  perl -e 'select(undef,undef,undef,0.1)'
done

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; FAILURES=$((FAILURES + 1)); }
eq()   { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected $3, got $2"; fi; }

api()  { local j=$1 m=$2 p=$3; shift 3
         curl -s -b "$j" -c "$j" -X "$m" "$BASE/api/v1$p" -H "$JSON" ${1:+-d "$1"}; }
code() { local j=$1 m=$2 p=$3; shift 3
         curl -s -o /dev/null -w '%{http_code}' -b "$j" -c "$j" -X "$m" "$BASE/api/v1$p" -H "$JSON" ${1:+-d "$1"}; }
jqv()  { python3 -c '
import sys, json
try: d = json.loads(sys.stdin.read())
except Exception: print(""); sys.exit()
for part in sys.argv[1].split("."):
    d = d.get(part) if isinstance(d, dict) else None
print("" if d is None else d)' "$1"; }
settings() { api "$ADMIN" PATCH /admin/settings "{\"settings\":$1}" > /dev/null; }
location() { grep -i '^location:' | tail -1 | tr -d '\r' | sed 's/^[Ll]ocation: *//'; }
oid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

api "$ADMIN" POST /auth/login "{\"email\":\"admin@example.org\",\"password\":\"$PASSWORD\"}" > /dev/null

# sign_in JAR [claim=value ...]
# Goes to /start, then returns to /callback as Microsoft would. Prints where
# the application sent the browser. A value of "null" removes the claim.
# Arguments rather than a JSON string: bash 3.2, which is what macOS has, runs
# brace expansion on a {a,b} inside a nested "$(...)".
LAST_QUERY_FILE=$(mktemp)
sign_in() {
  local jar=$1; shift
  local there; there=$(curl -s -D - -o /dev/null -b "$jar" -c "$jar" "$BASE/api/v1/auth/sso/start${START_QUERY:-}" | location)

  local query; query=$(python3 - "$there" "$TENANT" "$CLIENT" "$AUTHORITY" "$@" <<'PY'
import sys, json, base64, time, urllib.parse as u
there, tenant, client, authority = sys.argv[1:5]
q = dict(u.parse_qsl(u.urlparse(there).query))
claims = {"iss": f"{authority}/{tenant}/v2.0", "tid": tenant, "aud": client, "nonce": q.get("nonce",""),
          "exp": int(time.time()) + 3600, "nbf": int(time.time()) - 10,
          "name": "Sam Sso", "preferred_username": "nobody@example.org"}
for pair in sys.argv[5:]:
    k, v = pair.split("=", 1)
    if v == "null": claims.pop(k, None)
    elif v.isdigit(): claims[k] = int(v)
    else: claims[k] = v
plan = {"claims": claims, "redirect_uri": q.get("redirect_uri",""), "challenge": q.get("code_challenge","")}
code = base64.urlsafe_b64encode(json.dumps(plan).encode()).decode().rstrip("=")
print(u.urlencode({"code": code, "state": q.get("state","")}))
PY
)
  printf '%s' "$query" > "$LAST_QUERY_FILE"
  curl -s -D - -o /dev/null -b "$jar" -c "$jar" "$BASE/api/v1/auth/sso/callback?$query" | location
}

staff() { api "$ADMIN" POST /users "{\"full_name\":\"$1\",\"email\":\"$2\",\"role\":\"$3\",\"password\":\"$PASSWORD\"}" | jqv user.id; }

R=$RANDOM

echo "==> Switched off"

settings '{"sso.enabled":false,"sso.required":false,"sso.auto_create":false,"sso.default_role":"viewer"}'
eq 'the sign-in page offers nothing'        "$(curl -s "$BASE/api/v1/auth/sso/status" | jqv enabled)" False
HERE=$(mktemp)
eq 'and starting one goes nowhere'          "$(curl -s -D - -o /dev/null "$BASE/api/v1/auth/sso/start" | location)" '/?sso_error=not_configured'

echo "==> Only one directory, named by its ID"

settings "{\"sso.enabled\":true,\"sso.tenant_id\":\"common\",\"sso.client_id\":\"$CLIENT\",\"sso.client_secret\":\"test-client-secret\"}"
eq '"common" is refused'                    "$(curl -s "$BASE/api/v1/auth/sso/status" | jqv enabled)" False
settings "{\"sso.tenant_id\":\"$TENANT\"}"
eq 'a tenant ID is accepted'                "$(curl -s "$BASE/api/v1/auth/sso/status" | jqv enabled)" True

SETTINGS=$(api "$ADMIN" GET /admin/settings)
if grep -q 'test-client-secret' <<< "$SETTINGS"; then fail 'the secret is never sent back'; else pass 'the secret is never sent back'; fi
case "$(jqv sso_status.redirect_uri <<< "$SETTINGS")" in
  */api/v1/auth/sso/callback) pass 'the settings screen gives the redirect address' ;;
  *) fail 'the settings screen gives the redirect address' ;;
esac

START=$(curl -s -D - -o /dev/null "$BASE/api/v1/auth/sso/start" | location)
for part in 'code_challenge_method=S256' "client_id=$CLIENT" 'prompt=select_account' 'response_type=code' 'nonce=' 'state='; do
  if grep -q -- "$part" <<< "$START"; then pass "the request carries $part"; else fail "the request carries $part" "$START"; fi
done
if grep -q 'test-client-secret' <<< "$START"; then fail 'the secret does not go through the browser'; else pass 'the secret does not go through the browser'; fi

echo "==> Signing in"

MAIL="sso$R@example.org"
USER_ID=$(staff "Sso Person" "$MAIL" tech)
OID=$(oid)
J=$(mktemp)

eq 'the first sign-in links the account'    "$(sign_in "$J" oid="$OID" preferred_username="$MAIL")" /
eq 'and is signed in as that person'        "$(api "$J" GET /auth/me | jqv user.email)" "$MAIL"
eq 'a one-time password needs no changing'  "$(api "$J" GET /auth/me | jqv must_change_password)" False
eq 'the temporary password stops working'   "$(code "$(mktemp)" POST /auth/login "{\"email\":\"$MAIL\",\"password\":\"$PASSWORD\"}")" 401
eq 'staff screen shows it is linked'        "$(api "$ADMIN" GET "/users/$USER_ID" | jqv user.sso_linked)" 1

STATE_REPLAY=$(curl -s -D - -o /dev/null -b "$J" -c "$J" "$BASE/api/v1/auth/sso/callback?$(cat "$LAST_QUERY_FILE")" | location)
eq 'a response cannot be replayed'          "$STATE_REPLAY" '/?sso_error=expired'

HOURS=$(php -r '
require "app/bootstrap.php";
echo (int) Loaner\Db::value("SELECT TIMESTAMPDIFF(HOUR, NOW(), MAX(expires_at)) FROM sessions WHERE user_id = ?", ['"$USER_ID"']);')
if [ "$HOURS" -le 24 ]; then pass 'the session lasts a day, not a fortnight'; else fail 'the session lasts a day, not a fortnight' "$HOURS hours"; fi

eq 'next time the oid is what counts'       "$(sign_in "$(mktemp)" oid="$OID" preferred_username="renamed$R@example.org")" /
eq 'someone new at that address is refused' "$(sign_in "$(mktemp)" oid="$(oid)" preferred_username="$MAIL")" '/?sso_error=mismatch'

api "$ADMIN" PATCH "/users/$USER_ID" '{"unlink_sso":true}' > /dev/null
NEW_OID=$(oid)
eq 'unlinking lets a replacement account in' "$(sign_in "$(mktemp)" oid="$NEW_OID" preferred_username="$MAIL")" /

# Signing back in over an expired session happens in its own window.
START_QUERY='?popup=1'
eq 'a sign-in in its own window ends on the closing page' "$(sign_in "$(mktemp)" oid="$NEW_OID" preferred_username="$MAIL")" /sso-complete.html
eq 'and a refusal there carries the reason' "$(sign_in "$(mktemp)" oid="$(oid)" preferred_username="$MAIL")" '/sso-complete.html?error=mismatch'
START_QUERY=''

echo "==> Tokens that must not be accepted"

MAKE() { sign_in "$(mktemp)" oid="$NEW_OID" preferred_username="$MAIL" "$@"; }
eq 'another tenant'      "$(MAKE tid="99999999-2222-3333-4444-555555555555")" '/?sso_error=failed'
eq 'another issuer'      "$(MAKE iss="https://evil.example/$TENANT/v2.0")" '/?sso_error=failed'
eq 'another application' "$(MAKE aud="not-this-app")" '/?sso_error=failed'
eq 'the wrong nonce'     "$(MAKE nonce="wrong")" '/?sso_error=failed'
eq 'no nonce'            "$(MAKE nonce=null)" '/?sso_error=failed'
eq 'an expired token'    "$(MAKE exp="1000")" '/?sso_error=failed'
eq 'no object id'        "$(MAKE oid=null)" '/?sso_error=failed'
eq 'a guest from elsewhere' "$(MAKE idp="https://sts.windows.net/99999999-2222-3333-4444-555555555555/")" '/?sso_error=guest'

# The state cookie is what ties the round trip to one browser.
JA=$(mktemp); THERE=$(curl -s -D - -o /dev/null -c "$JA" "$BASE/api/v1/auth/sso/start" | location)
ST=$(python3 -c 'import sys,urllib.parse as u; print(dict(u.parse_qsl(u.urlparse(sys.argv[1]).query))["state"])' "$THERE")
eq 'finishing in another browser'  "$(curl -s -D - -o /dev/null "$BASE/api/v1/auth/sso/callback?code=x&state=$ST" | location)" '/?sso_error=expired'
JA=$(mktemp); THERE=$(curl -s -D - -o /dev/null -c "$JA" "$BASE/api/v1/auth/sso/start" | location)
ST=$(python3 -c 'import sys,urllib.parse as u; print(dict(u.parse_qsl(u.urlparse(sys.argv[1]).query))["state"])' "$THERE")
eq 'pressing Cancel at Microsoft'  "$(curl -s -D - -o /dev/null -b "$JA" "$BASE/api/v1/auth/sso/callback?error=access_denied&state=$ST" | location)" '/?sso_error=cancelled'
eq 'a state nobody issued'         "$(curl -s -D - -o /dev/null "$BASE/api/v1/auth/sso/callback?code=x&state=nonsense" | location)" '/?sso_error=expired'

echo "==> Who gets an account"

STRANGER="new$R@example.org"
eq 'nobody is created unless that is switched on' "$(sign_in "$(mktemp)" oid="$(oid)" preferred_username="$STRANGER")" '/?sso_error=no_account'

settings '{"sso.auto_create":true,"sso.default_role":"admin"}'
J2=$(mktemp)
eq 'switched on, they are created'          "$(sign_in "$J2" oid="$(oid)" preferred_username="$STRANGER" name="New Starter")" /
eq 'and can never arrive as an administrator' "$(api "$J2" GET /auth/me | jqv user.role)" viewer
settings '{"sso.auto_create":false}'

GONE="gone$R@example.org"; GONE_ID=$(staff "Gone Person" "$GONE" tech); GONE_OID=$(oid)
sign_in "$(mktemp)" oid="$GONE_OID" preferred_username="$GONE" > /dev/null
api "$ADMIN" PATCH "/users/$GONE_ID" '{"active":false}' > /dev/null
eq 'a deactivated account stays out'        "$(sign_in "$(mktemp)" oid="$GONE_OID" preferred_username="$GONE")" '/?sso_error=inactive'

echo "==> Requiring Microsoft sign-in"

PW="pw$R@example.org"; staff "Password Person" "$PW" tech > /dev/null
api "$ADMIN" PATCH /admin/settings '{"settings":{"sso.required":true}}' > /dev/null
eq 'a password no longer signs staff in'    "$(code "$(mktemp)" POST /auth/login "{\"email\":\"$PW\",\"password\":\"$PASSWORD\"}")" 403
eq 'a wrong password learns nothing'        "$(code "$(mktemp)" POST /auth/login "{\"email\":\"$PW\",\"password\":\"wrong-password-123\"}")" 401
eq 'an administrator can still get in'      "$(code "$(mktemp)" POST /auth/login "{\"email\":\"admin@example.org\",\"password\":\"$PASSWORD\"}")" 200
eq 'the sign-in page says so'               "$(curl -s "$BASE/api/v1/auth/sso/status" | jqv required)" True

settings '{"sso.enabled":false}'
eq 'turned off again, passwords work'       "$(code "$(mktemp)" POST /auth/login "{\"email\":\"$PW\",\"password\":\"$PASSWORD\"}")" 200

settings '{"sso.enabled":false,"sso.required":false,"sso.auto_create":false,"sso.default_role":"viewer"}'

echo
if [ "$FAILURES" -eq 0 ]; then
  echo 'All Microsoft sign-in checks passed.'
  exit 0
fi
echo "$FAILURES Microsoft sign-in check(s) FAILED."
exit 1
