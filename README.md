# Loaner Pool

[![Tests](https://github.com/amenathomas1997/assistive-tech-loaner-pool/actions/workflows/test.yml/badge.svg)](https://github.com/amenathomas1997/assistive-tech-loaner-pool/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![WCAG 2.2 AA](https://img.shields.io/badge/accessibility-WCAG%202.2%20AA-success)](#accessibility)

Assistive technology loaner pool management: device inventory, barcode
check-out and check-in, loan tracking, counselor requests, audit logging and a
full REST API.

Built on PHP, MySQL and Apache, with plain HTML5, CSS and JavaScript in the
browser. No build step, no Composer, no package manager, no framework — upload
the files and it runs. That is deliberate: this is software for agencies whose
hosting is a cPanel account, and anything that needs a deploy pipeline is
software they cannot run.

## Why this exists

Most assistive technology loaner pools run on a spreadsheet. That works until
someone asks which magnifier a client has had since March, whether the charger
came back with it, or what the pool's utilisation was last quarter — and then
it does not work at all.

This is the tool that replaces the spreadsheet. It installs through a browser,
runs on ordinary shared hosting, and is built to WCAG 2.2 AA throughout,
because some of the people using it rely on the equipment it lends out.

If you run a loaner pool, it is yours to take. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## What it does

**Inventory**
- Bulk import from a CSV exported by Excel or Google Sheets, with a test run
  that reports exactly what would change before anything is written
- Every device gets a unique barcode automatically
- Printable label sheets in QR, Code 128 or Code 39
- Existing devices are matched by barcode, then serial number, then asset tag,
  so re-importing updates rather than duplicates

**Loans**
- Check out to a technician, a program, a client, or any combination at once
- Configurable loan periods per organisation, including open-ended loans with
  no due date, plus a custom length for any individual loan
- Extend, bring forward, cancel or transfer a loan, with a full timeline
- Check back in by scanning, or by picking the device from a list when no
  scanner is available
- Accessory checklists — the charger and case are ticked out and ticked back
  in, and anything missing is flagged and recorded
- Kits: several tracked devices issued and returned together under one group
  reference, while each keeps its own barcode and history
- Loan agreements signed by typing a name, drawing a signature, or
  photographing a signed paper form, with a printable copy
- Optional condition photos at check-out and check-in, off by default

**Scanning**
- Any USB or Bluetooth keyboard-wedge scanner works with no setup
- Camera scanning in the browser
- A phone can be paired as a remote scanner for a desktop station
- Works offline: returns scanned during a network drop are queued and replayed
  in order when the connection comes back
- Manual entry everywhere, as a first-class path rather than a fallback

**Keeping track**
- Waitlist for a specific device or for the next of a category, with automatic
  promotion and notification when one is checked in
- Repair tickets with vendor, cost and turnaround, owning the device's status
  while open
- Due-soon and overdue reminders on a schedule, with visible proof that the
  job is actually running
- Bulk check-in and bulk status change, reporting per-item results rather than
  failing as a block

**Requests**
- Counselors request equipment for a client through a web form
- Technicians approve or decline, optionally reserving a device
- Progress tracking: being provisioned → on its way → ready for pickup →
  delivered, visible to the requester throughout
- Handing the device over creates the loan and closes the request

**Oversight**
- Append-only audit log of every change
- Usage reports: per-device frequency, category demand, idle stock, return
  punctuality, request turnaround, and scan-vs-manual adoption
- Funding and grant reporting: spend, utilisation, people reached and cost per
  loan grouped by funding source and by program
- Repair spend by vendor, plus the devices repaired often enough to be worth
  replacing instead
- CSV export from every list

**Integration**
- Versioned REST API at `/api/v1` with scoped API keys
- OpenAPI 3 document served from the running application
- Optional email notifications through Microsoft Graph, configured in the
  admin interface
- Self-service password reset by email, with single-use hashed tokens

---

## Installing

There is a browser-based installer. Upload the files, point a browser at the
site, and answer six screens — it creates the tables, the organisation and the
first administrator, then closes itself permanently.

Full instructions, including cPanel specifics and the Microsoft Graph setup:
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

Locally, with nothing but PHP's own web server:

```bash
php -S 127.0.0.1:8080 -t public scripts/dev-router.php
```

Then open `http://127.0.0.1:8080/`. The router script mirrors what
`public/.htaccess` does under Apache, so the development server behaves the
same way as a real host.

Requires **PHP 8.1+** with `pdo_mysql`, `mbstring`, `json` and `openssl`, and
**MySQL 5.7+** or **MariaDB 10.2+**. Those extensions are standard on every
shared host; the application checks for them on the first request and says
exactly which one is missing if not.

---

## API

```bash
curl -H "Authorization: Bearer lp_xxxxxxxx_yyyy…" \
     https://your-host/api/v1/devices
```

Check a device out by barcode:

```bash
curl -X POST https://your-host/api/v1/loans/checkout \
  -H "Authorization: Bearer lp_xxxxxxxx_yyyy…" \
  -H "Content-Type: application/json" \
  -d '{"device": "AT-7K3F9Q2M", "client_id": 42, "loan_period_id": 2}'
```

Keys are created under **Settings → API keys** with `read`, `write` or `admin`
scope. The full reference is at `/api/v1/openapi.json` on your running
installation — generated from the live route table, so it describes the paths,
methods and required permission of the build you are actually running rather
than a hand-maintained file that has drifted.

Both `/api/v1/...` and the unversioned `/api/...` reach the same endpoints. Use
the versioned path: it is the one that will not change under you.

---

## Accessibility

Built to **WCAG 2.2 Level AA**, including the criteria new in 2.2:

| Criterion | How |
|---|---|
| 2.4.11 Focus Not Obscured | Focusable elements reserve space below the sticky header |
| 2.5.7 Dragging Movements | No drag-only interaction exists anywhere |
| 2.5.8 Target Size | Every target ≥ 24×24 px; primary controls ≥ 44×44 px |
| 3.2.6 Consistent Help | Help sits in the same header position on every screen |
| 3.3.7 Redundant Entry | The installer carries answers across steps; forms never re-ask |
| 3.3.8 Accessible Authentication | Correct `autocomplete` tokens, paste never blocked, no cognitive test |

Throughout: colour is never the only signal, every scan result is announced
through a live region, focus moves to the heading on navigation, dialogs use
native `<dialog>` for real focus trapping, and the interface works in both
light and dark schemes and in Windows High Contrast Mode.

---

## Verifying a change

```bash
./scripts/reset-and-test.sh
```

Drops and recreates the test database, runs the web installer through its own
API, then exercises the application end to end — 229 checks covering
authentication, RBAC, spreadsheet import, barcode encoding, the loan
lifecycle, the request workflow, kits and accessories, agreements and
signatures, condition photos, the waitlist, repairs, funding reporting, bulk
actions, scheduled jobs, password reset, API keys and the guard rails.

Barcode encoders alone, with no database:

```bash
php scripts/verify-barcode.php
```

The Code 128 and Code 39 tables are hand-transcribed, so this asserts
properties of the specifications — every character exactly 11 modules wide,
bar widths summing to an even number, all patterns unique — which catches a
mistyped digit that would otherwise produce a label that scans as the wrong
value.

The QR encoder is checked differently, by decoding its own output with an
independent library:

```bash
./scripts/verify-qr.sh
```

This is the one place Node is used, and only as a test harness. It exists
because an encoder verified against itself is verified against nothing: an
earlier version of this code produced symbols that looked perfect, passed every
structural check, and decoded on no reader in the world, because two terms of
the Reed–Solomon generator polynomial were transposed. A reimplementation by
the same author reproduced the identical bug. Only a genuinely independent
decoder found it.

---

## How it is put together

```
public/                 The document root — the ONLY directory web-exposed
  index.php             Front controller; everything non-file arrives here
  .htaccess             Rewrite rules, cache headers, Authorization pass-through
  app.html              Application shell
  install.html          Setup wizard
  scanner.html          Phone scanner page
  css/app.css           Design system
  js/                   API client, UI primitives, views
  vendor/jsQR.js        Vendored QR decoder (Apache-2.0) for camera scanning

app/                    Application code, above the document root
  bootstrap.php         Autoloader, error handling, environment checks
  Config.php            Install state and the configuration file
  Db.php                Lazy PDO, transactions, actionable error messages
  Migrations.php        Idempotent schema upgrades
  Auth.php              Sessions, roles, capabilities, API keys
  Loans.php             Loan lifecycle, including the check-out row lock
  Devices.php           Inventory and spreadsheet import
  Requests.php          Counselor request workflow and fulfilment tracking
  Reservations.php      Waitlists and holds
  Kits.php              Kits, accessories, loan groups
  Repairs.php           Repair tracking and reliability reporting
  Agreements.php        Loan agreements and signatures
  Attachments.php       Condition photos and signature images
  Reports.php           Usage, demand, idle stock and funding analytics
  Jobs.php              Scheduled reminders and housekeeping
  Scan.php              Barcode lookup and phone pairing
  Notifications.php     What to say and who should hear it
  Mailer.php            Microsoft Graph client
  Barcode.php           Allocation and Code 128 / Code 39 rendering
  Qr.php                QR encoder (Reed-Solomon over GF(256))
  Csv.php               RFC 4180 parser written for what Excel actually emits
  Secrets.php           AES-256-GCM for stored credentials
  Settings.php          Per-organisation settings
  Audit.php             Append-only audit trail
  Util.php              Errors, validation, pagination, dates
  Routes/               One module per resource group

bin/run-jobs.php        Cron entry point for the scheduled jobs
schema.sql              Full DDL for a fresh install
data/                   Config file and uploads — created at install, never web-served
docs/                   Deployment guide
scripts/                Verification and the development router
```

Only `public/` is inside the document root. The configuration file, the
database credentials and every uploaded photo live in `data/`, one level above
it, so a misconfigured server cannot serve them as static files.

A few decisions that are load-bearing:

- **Routes are matched by specificity, not registration order.** Express
  matches in declaration order, which in an earlier version silently swallowed
  `/devices/export.csv` as a device whose id was "export.csv". Scoring literal
  path segments above parameters removes the whole class of mistake instead of
  relying on everyone remembering the ordering rule.
- **Check-out takes a row lock.** Two technicians scanning the same device at
  the same desk is a real scenario, so the device row is locked inside a
  transaction rather than checking `status` first and hoping.
- **Sessions live in the database, not in PHP's session handler.** It is the
  only way "changing your password signs you out everywhere" can be true, and
  it means no session files to secure on shared hosting.
- **Scheduled work runs from cron, not from inside a request.** A PHP request
  ends when the response is sent, so there is nowhere for a timer to live. An
  in-process scheduler would only fire while somebody happened to be using the
  app — which is exactly when overdue reminders are not needed. The jobs screen
  says plainly whether cron has actually run.
- **The paired phone scanner is polled, not streamed.** PHP occupies a server
  worker for the whole life of a request, so one long-lived connection per scan
  station would exhaust the worker pool on precisely the shared hosting this is
  built for.
- **Overdue is derived, never stored.** A loan cannot sit at "active" while
  silently months overdue because a nightly job failed.
- **Import is two-phase.** A dry run reports precisely what would happen and
  writes nothing; only an explicit second call commits.
- **Cancelled loans are excluded from utilisation.** A loan cancelled because
  the wrong barcode was scanned is not a use of the device, and counting it
  inflates the numbers used to justify purchases.
- **The audit log is append-only.** Nothing in this codebase issues UPDATE or
  DELETE against it.
- **Secrets are encrypted at rest** with a key derived from the install key, so
  a stolen database dump does not hand over the Graph client secret.
- **Only check-ins are queued offline, never check-outs.** A check-out needs to
  know the device is free *now*; replaying one an hour later could issue
  equipment somebody else has already taken.
- **Funding totals aggregate devices and loans separately.** Summing purchase
  cost across a loan join multiplies each device's price by how often it was
  lent, which silently overstates every figure a funder is shown.
- **Signing is never pointer-only.** Typing a name and photographing a paper
  form count exactly as much as drawing, so nobody is blocked from receiving
  equipment by a step they cannot physically complete.

---

## Contributing

Issues and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to get it running locally and what
the suite expects before a PR.

Two things that are not negotiable, and are explained there: accessibility
regressions are not merged, and schema changes go through `app/Migrations.php`
rather than `schema.sql`, so a site installed last year and one installed this
morning converge on the same schema by the same code path.

For anything security-related, please use private reporting rather than an
issue — see [SECURITY.md](SECURITY.md).

## Status

Working and tested, but young. It has been exercised end to end against
MariaDB and MySQL by the suite above; it has not yet been run by an agency for
a full year, so expect rough edges in corners the tests do not reach.

Two parts are deliberately untested by automation, because they need hardware
or an external account: **Microsoft Graph email** (needs an Azure app
registration) and **phone-camera scanning** (needs a camera and HTTPS). Both
degrade safely — the app reports clearly when email is unconfigured, and every
scanning path has a manual equivalent.

## Licence

[MIT](LICENSE) — use it, change it, run it, sell it. If it is useful to your
agency, no attribution or permission is needed.

One exception: `public/vendor/jsQR.js` is third-party code under the
**Apache License 2.0**, vendored so the app needs no CDN. It keeps its own
licence and attribution — see
[public/vendor/README.md](public/vendor/README.md). If you redistribute this
project, that notice has to travel with it.

Server dependencies are `express`, `mysql2`, `bcryptjs`, `cookie-parser` and
`qrcode` — all MIT or ISC.
