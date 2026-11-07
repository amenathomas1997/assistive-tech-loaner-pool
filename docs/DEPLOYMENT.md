# Deploying Loaner Pool

This guide covers cPanel shared hosting, because that is the most constrained
target. Nothing here is specific to one host or one account name — the database
name, user and subdomain are all whatever you choose.

There is no build step. The application runs the files as they are.

---

## What you need

| Requirement | Notes |
|---|---|
| Node.js 18 or newer | cPanel ships this under **Setup Node.js App**. |
| MySQL 5.7+ or MariaDB 10.2+ | An empty database and a user with `ALL PRIVILEGES` on it. |
| A subdomain or domain | For example `loanerpool.example.com`. |
| HTTPS | Strongly recommended, and **required** for phone-camera scanning. Browsers block camera access on plain HTTP. |

You do **not** need shell access, and the installer never needs permission to
`CREATE DATABASE` — you create the database yourself in the control panel.

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

Upload the project to the document root from step 1, so that `app.js` and
`package.json` sit directly in it.

**Do not upload `node_modules`.** cPanel installs dependencies for you in the
next step, and an uploaded `node_modules` from a different platform will
contain the wrong binaries.

Also skip `data/` — it is created on first run and holds your credentials.

Via File Manager: zip the project locally, upload the zip, then **Extract**.

---

## 4. Register the Node.js application

cPanel → **Setup Node.js App** → **Create Application**:

| Field | Value |
|---|---|
| Node.js version | 18 or newer |
| Application mode | Production |
| Application root | the document root from step 1 |
| Application URL | your subdomain |
| Application startup file | `app.js` |

Click **Create**, then **Run NPM Install** on the same screen. That reads
`package.json` and installs the five runtime dependencies.

Finally click **Restart**.

Passenger supplies the listening port through the `PORT` environment variable,
which `src/config.js` already reads. There is nothing to configure.

---

## 5. Run the installer

Open `https://loanerpool.example.com/` in a browser. Because no configuration
file exists yet, every request redirects to the setup wizard.

Work through the six steps:

1. **Welcome** — confirms the Node version and whether you are on HTTPS.
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

You should get **404**. The application only serves files from `public/`, so
`data/` is not exposed — but if your host serves the application root
statically for any reason, move the file above the web root and point the app
at it:

```
LOANER_CONFIG=/home/<account>/loaner-config.json
```

Set that in **Setup Node.js App → Environment variables**, then restart.

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

The application runs its own hourly scheduler by default. It only sends
between **07:00 and 19:00** local time, so an overdue notice never lands at
three in the morning, and it records every run — **Settings → Due-soon and
overdue reminders** shows whether the job is healthy and lets you run it by
hand.

On most cPanel accounts the built-in scheduler is enough. Use an external cron
entry instead if your host idles the application out between requests, or if
you want the timing to be exact:

1. Turn the built-in one off by adding the environment variable
   `LOANER_DISABLE_SCHEDULER=1` in **Setup Node.js App**, then restart.
2. In **Settings → Due-soon and overdue reminders**, press **Show the cron
   command** and copy the line it gives you.
3. Paste it into cPanel → **Cron Jobs**.

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

1. Back up `data/config.json`, `data/uploads/`, and take a database dump.
2. Upload the new files over the old ones, leaving `data/` alone.
3. **Run NPM Install**, then **Restart** in Setup Node.js App.

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
Passenger could not start the app. Check the log path shown in Setup Node.js
App; the usual causes are a missing `npm install` or a Node version below 18.

---

## Running outside cPanel

Nothing here depends on cPanel:

```bash
npm install
PORT=3000 npm start
```

Then open `http://localhost:3000/` and run the installer. Behind nginx or
Apache, proxy to the port and leave `LOANER_TRUST_PROXY` at its default so
`req.ip` reflects the real client in the audit log.

Useful environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listening port. Passenger sets this. |
| `LOANER_CONFIG` | `./data/config.json` | Configuration file location. |
| `LOANER_TRUST_PROXY` | enabled | Set `0` when not behind a proxy. |
