# Contributing

Thanks for looking. This started as an internal tool for an assistive
technology loaner pool, and it is public because other agencies run the same
process on spreadsheets.

## Getting it running

You need **PHP 8.1+** (with `pdo_mysql`, `mbstring`, `json` and `openssl`) and
**MySQL 5.7+** or **MariaDB 10.2+**. Nothing else — there is no Composer step
and no package manager.

```bash
php -S 127.0.0.1:8080 -t public scripts/dev-router.php
```

Then open `http://127.0.0.1:8080/` and work through the installer. It creates
the schema and your first administrator; nothing needs to be edited by hand.

The router script mirrors what `public/.htaccess` does under Apache. Running
`php -S` without it will appear to work and then fail on static files, so use
the script.

To run the test suite you need a database the tests can drop and recreate:

```sql
CREATE USER 'loaner'@'127.0.0.1' IDENTIFIED BY 'loanerpooldev';
GRANT ALL PRIVILEGES ON *.* TO 'loaner'@'127.0.0.1';
CREATE DATABASE loanerpool_test;
```

Those credentials are throwaway fixtures for a disposable local database and
are the defaults the harness expects. Override them with `LP_DB_USER`,
`LP_DB_PASS` and `LP_DB_NAME` if you prefer. **Never point the suite at a
database with real data in it — it drops the schema on every run.**

## Before opening a pull request

```bash
./scripts/reset-and-test.sh
```

This drops and recreates the test database, runs the installer through its own
API, then exercises the application end to end — 229 checks. It should finish
green. If you have changed behaviour on purpose, change the assertion in the
same commit so the diff shows what moved.

The QR encoder is checked separately, because it is the one piece that cannot
be verified against itself:

```bash
./scripts/verify-qr.sh
```

This encodes with PHP and decodes with a vendored copy of jsQR. It needs Node,
and that is the only thing in the project that does — purely as a test harness.
It exists because an earlier version of the encoder had two terms of the
Reed–Solomon generator polynomial transposed: every structural check passed,
the symbol read back to its own codewords, and all 77 symbols were undecodable
by any real reader. A reimplementation by the same author reproduced the
identical bug. If you touch `app/Qr.php`, run this.

There is no build step, no bundler and no transpiler. What is in the repository
is what runs. Please keep it that way: the target is shared hosting where the
deployment story is "upload the files".

## House style

- **No runtime dependencies in the browser.** No framework, no CDN. The app
  must work on a locked-down network with no outbound access.
- **No server dependencies at all.** No Composer, no autoloader to generate,
  nothing to install. The application uses only PHP's own standard extensions.
  A pull request that adds a dependency needs a reason better than convenience,
  because on the hosting this targets "run `composer install`" is often not
  something the administrator can do.
- **One class per file**, named to match: `Loaner\Foo\Bar` lives at
  `app/Foo/Bar.php`. The autoloader in `app/bootstrap.php` depends on it.
- **Comment the "why", not the "what".** The code says what it does. Comments
  earn their place by explaining a decision that is not obvious — why
  check-out takes a row lock, why overdue is derived rather than stored, why
  funding totals aggregate devices and loans separately.
- **Errors are written for the person reading them.** "That database does not
  exist. Create it first, then enter its exact name" beats `ER_BAD_DB_ERROR`.
  Assume the reader is a technician mid-clinic, not a developer.

## Accessibility is not optional here

This is software for an assistive technology service. Some of the people using
it rely on the technology it lends out.

The target is **WCAG 2.2 Level AA**, and a change that regresses it will not be
merged. In practice:

- Colour is never the only signal. A status gets a dot *and* a word.
- Every interactive target is at least 24×24px; primary controls are 44×44px.
- Nothing is reachable only by dragging. The signature pad offers typing and
  photo upload as equals for exactly this reason — the pointer-only path is
  never the only path.
- Focus is always visible, and focus moves to the heading after navigation.
- Anything that changes without a page load is announced through a live region.
- Inputs carry correct `autocomplete` tokens, and paste is never blocked.

If you add a screen, tab through it with the mouse unplugged before you open
the PR. Most problems surface in the first thirty seconds.

## Things that need care

- **Check-out concurrency.** Two technicians scanning the same device at one
  desk is real. The device row is locked inside a transaction. Do not replace
  that with a status check.
- **The audit log is append-only.** Do not add an `UPDATE` or `DELETE` against
  `audit_log`, whatever the reason seems to be.
- **Schema changes go in `app/Migrations.php`**, never into `schema.sql`, which
  describes version 1 and is only run by the installer. Bump `TARGET_VERSION`
  and add a step. Each step must be safe to re-run: MySQL commits implicitly on
  DDL, so a migration cannot be made atomic with a transaction, and an upgrade
  interrupted halfway must resume cleanly on the next request.
- **Routes are matched by specificity, not registration order.** You can add
  `/devices/export.csv` next to `/devices/{id}` and it will work. Do not
  "fix" the router to match in order.
- **Nothing schedules itself.** Reminders run from cron via `bin/run-jobs.php`
  or the HTTP job runner. A PHP request ends when the response is sent, so an
  in-process timer would only fire while someone was already using the app.
- **Offline queues returns, never check-outs.** A check-out needs to know the
  device is free *now*.

## Reporting bugs

Open an issue with what you expected, what happened, and the version. If it
involves a scanner, say which model and whether it is a 1D laser or a 2D
imager — a surprising share of "it does not scan" turns out to be a laser
scanner pointed at a QR code.

For anything security-related, see [SECURITY.md](SECURITY.md) instead.
