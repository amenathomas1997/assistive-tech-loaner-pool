# Security policy

Loaner Pool holds information about disabled people — names, contact details,
case references, and what equipment they have been lent. A weakness here is
not an abstract problem, so please report one rather than demonstrating it.

## Reporting a vulnerability

Use GitHub's private reporting:
**Security → Advisories → Report a vulnerability** on this repository. That
opens a channel only the maintainers can see.

Please do not open a public issue for anything exploitable.

Include what you can — the version or commit, what an attacker could reach,
and the steps to reproduce. A proof of concept against your own installation
is welcome; please do not test against anyone else's.

You should get an acknowledgement within a week. If a fix is warranted, the
advisory will credit you unless you ask otherwise.

## What is in scope

Anything in this repository, including:

- authentication, session handling and the role model
- the API key mechanism and scope enforcement
- the installer, which is deliberately reachable before anyone has signed in
- SQL injection, including through filter and sort parameters
- stored file access — condition photos and signatures are served only to
  authenticated staff and must not be reachable otherwise
- cross-tenant access between organisations
- the cron token and the scheduled job endpoint

## What is out of scope

- Findings that need an attacker to already have administrator access.
- Missing hardening on a deployment someone configured themselves — HTTP
  instead of HTTPS, a world-readable `data/config.json`, a permissive reverse
  proxy. The documentation covers these; a report that the software permits a
  misconfiguration is not itself a vulnerability.
- Denial of service through sheer volume. There is no rate limiting in the
  application by design; that belongs at the reverse proxy, and
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) says so.
- Automated scanner output with no demonstrated impact.

## For people running an installation

A few things carry real risk and are easy to get wrong:

- **`data/config.json` holds your database password and the key that encrypts
  stored secrets.** It is written `0600` and lives outside the web root. Keep
  it out of backups that are themselves public, and out of version control —
  the shipped `.gitignore` excludes `data/` entirely.
- **`data/uploads/` holds client condition photos and signature images.**
  These are served only through an authenticated route and are never placed in
  the public directory. If you move them, keep that property.
- **Serve over HTTPS.** Session cookies are only marked `Secure` when you say
  the site is HTTPS, and phone-camera scanning will not start without it.
- **The cron token authenticates the whole installation.** Treat it as a
  password; rotate it by editing `data/config.json` and restarting.
- **Rotate the app key only deliberately.** Changing `appKey` invalidates every
  session and makes any stored Microsoft Graph client secret unreadable, which
  has to be re-entered.

## What the application does on your behalf

So you can audit it rather than take it on trust:

- Passwords are hashed with bcrypt at cost 12. Sign-in failures are throttled
  and the response is identical whatever the cause, so the endpoint cannot be
  used to discover who has an account.
- Password reset tokens are single-use, stored only as a SHA-256 hash, and
  expire after an hour. Using one ends every session that account holds.
- API keys are stored only as a SHA-256 hash. The plaintext is shown once at
  creation and genuinely cannot be recovered.
- The Microsoft Graph client secret is encrypted at rest with AES-256-GCM,
  using a key derived from the install key. This protects a stolen database
  dump; it cannot protect against someone who already has the config file.
- Every query is parameterised. Sort and filter inputs are mapped through
  fixed allowlists, never interpolated.
- The audit log is append-only. Nothing in the codebase issues `UPDATE` or
  `DELETE` against it, including for administrators.

## Hardening that is on by default

So a report does not duplicate something already in place:

- **Microsoft sign-in** is the authorization code flow with PKCE, limited to one
  tenant by ID. Accounts are identified by the token's `oid`, never its email.
  State is single-use and bound to the browser. A guest from another directory
  is refused, and an account created at first sign-in can never be an
  administrator.
- **Sessions** are random 256-bit ids stored server-side; the cookie is
  `HttpOnly`, `SameSite=Lax`, and `Secure` whenever the request arrived over
  TLS, whatever the configuration file says. Changing or resetting a password
  ends every other session.
- **Cross-site writes are refused.** `SameSite=Lax` does not help against a
  page on a sibling subdomain, which is the common case on shared hosting, so
  a cookie-authenticated request that changes state is refused when its
  `Origin` names another host.
- **`X-Forwarded-For` is ignored** unless `LOANER_TRUST_PROXY=1` is set, so a
  visitor cannot choose what address the audit log records.
- **Two-factor codes work once.** The last accepted time step is stored per
  user, so a code cannot be replayed inside its window (RFC 6238 §5.2).
- **Failed sign-ins** lock an account for fifteen minutes after eight misses,
  and the count starts fresh once a lock has expired.
- **Backups omit live credentials.** Session ids, pending sign-ins, reset
  tokens and pairing codes are structure-only in the SQL dump.
- **Spreadsheet exports** prefix cells that begin with `=`, `+`, `-`, `@` or a
  tab, so a name typed as a formula does not run in Excel.
- **HSTS** is sent on HTTPS responses (one year, no subdomains).
- **Content Security Policy** is `script-src 'self'` with no inline scripts;
  all theme and keyboard behaviour is in separate files for that reason.
- **Uploads** are decoded from data URLs, checked with `getimagesize`, limited
  to JPEG/PNG/WebP and 8 MB, stored outside the web root under random names,
  and served only through an authenticated route that re-checks the path is
  inside the uploads directory.
