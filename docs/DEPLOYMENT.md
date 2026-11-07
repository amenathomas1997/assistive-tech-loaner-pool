# Deploying Loaner Pool

This guide covers cPanel shared hosting, because that is the most constrained
target. Nothing here is specific to one host or one account name — the database
name, user and subdomain are all whatever you choose.

There is no build step, no Composer and no package manager. The application
runs the files as they are: upload them, point a subdomain at `public/`, and
open it in a browser.

---

## What you need

| Requirement | Notes |
|---|---|
| PHP 8.1 or newer | With `pdo_mysql`, `mbstring`, `json` and `openssl`. All four are standard on shared hosting; the app checks on first request and names any that are missing. |
| Apache with `mod_rewrite` | The default on cPanel. `.htaccess` is already in the right place. |
| MySQL 5.7+ or MariaDB 10.2+ | An empty database and a user with `ALL PRIVILEGES` on it. |
| A subdomain or domain | For example `loanerpool.example.com`. |
| HTTPS | Strongly recommended, and **required** for phone-camera scanning. Browsers block camera access on plain HTTP. |

You do **not** need shell access, Composer, a package manager or a deploy
step. The installer never needs permission to `CREATE DATABASE` either — you
create the database yourself in the control panel, which is all that most
managed MySQL users are allowed to do.

---

## 1. Create the subdomain

In cPanel → **Domains** → **Create A New Domain**:

- **Domain**: `loanerpool.example.com`
- **Document Root**: cPanel proposes something like `/home/<account>/loanerpool`.
  Note this path; it is where the application files go.

Then in cPanel → **SSL/TLS Status**, run **Run AutoSSL** for the new subdomain
so it is served over HTTPS.

---

## 2. Create the database

In cPanel → **MySQL® Databases**:

1. **Create New Database** — type e.g. `loanerpool`.
2. **Add New User** — create a user and a strong password. Save the password
   somewhere safe; you will paste it into the installer once.
3. **Add User To Database** — select the user and the database, then grant
   **ALL PRIVILEGES**.

> **Most control panels prefix what you type with your account name.** If you
> typed `loanerpool` and your account is `example`, the real database name is
> `example_loanerpool`, and the real username is `example_dbuser`. The final
> names are shown on the MySQL Databases page — use those exactly.

---

## 3. Upload the application

The important part of this step is **which directory becomes the document
root**, because only `public/` should be web-reachable.

Upload the whole project to the account, *beside* the document root rather than
into it — for example to `/home/<account>/loanerpool-src/` — then point the
subdomain's document root at `/home/<account>/loanerpool-src/public`.

cPanel → **Domains** → your subdomain → **Document Root**, and set it to the
`public` directory.

That one setting is what keeps `data/config.json` — which holds your database
password and the key that encrypts stored secrets — outside anything the web
server will serve.

If your host will not let you change the document root, upload the project
into the document root as-is. `public/.htaccess` and the front controller still
work, and `data/` is protected by its own rules, but the separate document root
is the stronger arrangement and worth asking for.

Skip `data/` when uploading: it is created on first run and holds your
credentials.

Via File Manager: zip the project locally, upload the zip, then **Extract**.

---

## 4. Check that rewriting works

Open `https://loanerpool.example.com/health` in a browser. You should get JSON:

```json
{"ok":true,"app_version":"2.0.0","installed":false,"php_version":"8.2.x", ...}
```

That single response proves four things at once: PHP is executing, the
rewrite rules are being applied, the required extensions are present, and the
application knows it has not been installed yet.

If you get a directory listing or a 404, `mod_rewrite` is not picking up
`.htaccess`. On cPanel this is almost always a document root pointing one level
too high — recheck step 3.

If you get a PHP error naming a missing extension, install or enable it in
cPanel → **Select PHP Version** → **Extensions**.

There is nothing to register and no process to restart. PHP runs per request;
once the files are in place and `/health` answers, the application is running.

---

## 5. Run the installer

Open `https://loanerpool.example.com/` in a browser. Because no configuration
file exists yet, every request redirects to the setup wizard.

Work through the six steps:

1. **Welcome** — confirms the PHP version, the required extensions, whether
   the configuration directory is writable, and whether you are on HTTPS.
2. **Database** — enter host `localhost`, port `3306`, and the **full** database
   name and username from step 2. Press **Test connection**; it reports
   separately whether the server was reachable, the credentials were accepted,
   the database exists, and the user can create tables.
3. **Organisation** — your name, time zone, and barcode type.
4. **Loan periods** — the durations offered at check-out. All editable later.
5. **Administrator** — your own account. Minimum 12 characters.
6. **Finish** — creates the tables, the organisation and your account, then
   writes the configuration file.

The installer closes itself permanently once it succeeds. Every endpoint under
`/api/install` then returns `410 Gone`.

---

## 6. Lock down the configuration file

Installation writes `data/config.json` containing your database password and
the encryption key used for stored secrets. The application writes it mode
`0600`, but confirm it is not reachable over the web:

```bash
curl -I https://loanerpool.example.com/data/config.json
```

You should get **404**. With the document root set to `public/` as in step 3,
`data/` is not under the web server at all and cannot be served. If you had to
upload into the document root instead, verify that URL specifically — and if it
returns the file, move the configuration elsewhere and tell the application
where it went:

```apache
# In public/.htaccess, or the subdomain's PHP settings
SetEnv LOANER_CONFIG /home/<account>/loaner-config.json
```

Then move `data/config.json` to that path. Nothing needs restarting.

Back this file up. Losing it means re-running the installer; losing the
`appKey` inside it means any stored Graph client secret must be re-entered.

---

## 7. After installation

- **Import your inventory** — Devices → Import spreadsheet. Run the test
  import first; it reports exactly what would change without writing anything.
- **Print labels** — Devices → Print labels. Check one against your scanner
  before printing hundreds.
- **Add staff** — Staff → Add staff account.
- **Configure email** — Settings → Email. See below.

### Choosing a barcode type

| Type | Read by | Not read by |
|---|---|---|
| QR | Phone cameras, 2D imaging scanners | Cheap 1D laser scanners |
| Code 128 | Essentially every scanner, including lasers | Phone cameras, unreliably |
| Code 39 | Very old hardware | — (lower density than Code 128) |

The barcode **value** never changes when you switch types — only the printed
symbol does. Switching means reprinting labels, not re-identifying devices.

---

## Email via Microsoft Graph

Notifications go out through an Azure app registration using the
client-credentials flow, so they keep working unattended.

**In the Azure portal:**

1. **App registrations → New registration.** Any name; single tenant is fine.
2. From **Overview**, copy the **Directory (tenant) ID** and
   **Application (client) ID**.
3. **Certificates & secrets → New client secret.** Copy the **Value** — not the
   Secret ID — immediately. It is never shown again.
4. **API permissions → Add a permission → Microsoft Graph → Application
   permissions → `Mail.Send`.** Then **Grant admin consent**.

> Application permissions, not delegated. Delegated permissions require a
> signed-in user and will fail for unattended sending.

**In Loaner Pool:** Settings → Email. Paste the three values, set the sender to
a real licensed mailbox in your tenant, and press **Send a test email** before
switching notifications on. Failures are reported with the actual Azure reason,
not a generic error.

Every send — including failures and skips — is recorded, so "did the client get
told?" always has an answer.

---

## Due-soon and overdue reminders

These are the only emails sent on a schedule rather than in response to
something happening, and they are the ones people notice when they stop.

**Nothing schedules itself.** A PHP request ends the moment the response is
sent, so there is nowhere inside the application for a timer to live. An
in-process scheduler would only ever fire while somebody happened to be using
the app, which is precisely when an overdue reminder is not needed.

So these reminders require a cron entry, and until you add one **no reminder
will ever be sent**. The application says so plainly: **Settings → Scheduled
jobs** shows a warning until it has seen a real cron run, and tells you how
long ago the last one was.

To set it up:

1. **Settings → Scheduled jobs** → copy the command it shows you.
2. Paste it into cPanel → **Cron Jobs**, set to **Once Per Day**.

Two forms are offered and either works:

- **The command line** — preferred when cron runs on the same host. It needs no
  network, no token, and keeps working even if the site is briefly unreachable
  from outside.
- **A `curl` request** — for when cron runs somewhere else. It carries a secret
  in an `X-Cron-Token` header rather than the URL, because query strings end up
  in access logs, proxy logs and browser history.

Run it once a day. Seven in the morning means notices are waiting for people
when they start work.

It looks like this:

```bash
curl -fsS -X POST "https://loanerpool.example.com/api/v1/jobs/run" -H "X-Cron-Token: YOUR-TOKEN" >/dev/null
```

The token authenticates the whole installation, so treat it like a password.
It is stored in `data/config.json` and generated the first time you ask for it.

---

## Storage for photos and signatures

Condition photos are **off by default** — switch them on under **Settings →
Condition photos** only if your organisation has decided that photographing
client equipment is appropriate.

When enabled, files are written to `data/uploads/`, beside the configuration
file and outside the web root. They are served only to signed-in staff through
an authenticated route, never from a guessable URL. Images are resized in the
browser before upload, so a typical photo lands at 200–400 KB.

Two consequences worth planning for:

- **Back up `data/uploads/` along with the database.** A signature stored
  against a loan agreement is not in the SQL dump.
- **Watch your disk quota.** Settings shows current usage. A busy pool taking
  two photos per transaction will accumulate a few hundred MB a year.

---

## Upgrading

Check whether there is anything to do:

```bash
php /home/<account>/loanerpool-src/bin/update.php
```

Or in the app: **Settings → Software updates**. If the server blocks outbound
HTTPS — many shared hosts do — the panel says so rather than claiming you are
up to date.

To apply it, on the server:

```bash
php /home/<account>/loanerpool-src/bin/update.php --apply
```

That pulls the new code and runs any database migrations, printing what it did.
Back up the database and `data/` first. If the checkout has local edits it
refuses and tells you, rather than overwriting them.

Applying is deliberately not possible from the browser. A web page that could
pull code and change the schema is a way into the server the day its
credentials leak.

### Manually

1. Back up `data/config.json`, `data/uploads/`, and take a database dump.
2. Upload the new files over the old ones, leaving `data/` alone.
3. Run the migrations by loading any page — they apply on the first request
   after an upgrade, and the version is recorded in the database so they never
   run twice.

The application detects its existing configuration and starts normally. Any
database changes a new version needs are applied automatically on boot, and
logged — look for `[migrate]` lines in the application log. Migrations are
written so that re-running them is harmless, so an interrupted upgrade simply
finishes on the next restart.

If a migration cannot apply, the application still starts on the old schema and
logs the reason rather than taking the check-in desk offline; newer features
will not work until it is fixed.

Static assets are served with `Cache-Control: no-cache`, so browsers revalidate
and pick up new JavaScript immediately rather than running stale code.

---

## Troubleshooting

**Every page redirects to the installer.**
The configuration file is missing or unreadable. Check the path reported on the
installer's welcome step, and that the account running the app can read it.

**"The database rejected that username or password."**
Use the full prefixed names from the MySQL Databases page.

**"That user exists but has no rights on this database."**
Add the user to the database with ALL PRIVILEGES.

**Nobody can sign in, with no error shown.**
Secure cookies are on but the site is served over HTTP, so the browser never
sends the session cookie. Either enable HTTPS, or set `session.secureCookies`
to `false` in `data/config.json` and restart. Enable HTTPS — do not leave this
off in production.

**The phone camera scanner will not start.**
Camera access requires a secure context. The pairing screen warns about this
when the join URL is plain HTTP.

**A laser scanner reads nothing.**
It is almost certainly a 1D-only scanner facing a QR label. Switch the
organisation to Code 128 under Settings and reprint.

**502 or "We're sorry, but something went wrong".**
PHP failed before it could render anything. Check the error log in cPanel →
**Errors**, or `error_log` in the application directory. The usual causes are a
PHP version below 8.1 and a missing `pdo_mysql`; both are fixed under **Select
PHP Version**.

---

## Running outside cPanel

Nothing here depends on cPanel:

```bash
php -S 127.0.0.1:8080 -t public scripts/dev-router.php
```

Then open `http://127.0.0.1:8080/` and run the installer. The router script
mirrors what `public/.htaccess` does under Apache, so the development server
behaves like a real host.

Under any other web server, the rules are the same three things Apache needs:
serve `public/` as the document root, route everything that is not a real file
to `public/index.php`, and pass the `Authorization` header through to PHP
(FastCGI strips it by default, which breaks API-key authentication in a way
that looks like a bug in the keys).

nginx, for example:

```nginx
root /home/account/loanerpool-src/public;
index index.php;

location / {
    try_files $uri $uri/ /index.php?$query_string;
}

location ~ \.php$ {
    include fastcgi_params;
    fastcgi_pass unix:/run/php/php8.2-fpm.sock;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_param HTTP_AUTHORIZATION $http_authorization;
}

# Never serve the data directory, whatever the document root says.
location ^~ /data/ { deny all; return 404; }
```

Useful environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `LOANER_CONFIG` | `<project>/data/config.json` | Configuration file location. Set it to move the credentials anywhere you like. |
| `LOANER_TRUST_PROXY` | enabled | Honours `X-Forwarded-For` for the address recorded in the audit log. Set to `0` when PHP is exposed directly, or a client can forge its own audit entries. |

Set these with `SetEnv` in `.htaccess`, in the vhost, or in the FPM pool
configuration — whichever your host allows.
