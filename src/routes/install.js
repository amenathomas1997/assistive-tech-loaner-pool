/**
 * Web installer.
 *
 * Available only while the app is uninstalled. Once a config file exists every
 * endpoint here returns 410 Gone — an installer that stays reachable is a
 * standing offer to repoint a live system at an attacker's database.
 *
 * The installer never needs shell access and never needs CREATE DATABASE
 * rights: the expected flow on shared hosting is that the admin creates an
 * empty database and a user in their control panel, then hands those details
 * over here. Creating the database is offered but optional, because most
 * managed MySQL users cannot do it.
 */

import express from 'express';
import { createPool, loadSchemaStatements, describeDbError, resetPool } from '../db.js';
import {
  isInstalled, writeConfig, defaultConfig, configPath, reloadConfig,
  APP_VERSION, SCHEMA_VERSION,
} from '../config.js';
import {
  asyncRoute, HttpError, badRequest, requiredStr, str, int, bool, email as parseEmail,
} from '../lib/util.js';
import { hashPassword, validatePassword } from '../lib/auth.js';
import { SYMBOLOGIES } from '../lib/barcode.js';
import { runMigrations } from '../migrations.js';

const router = express.Router();

/** Refuse everything once installed. */
router.use((req, res, next) => {
  if (isInstalled()) {
    return next(new HttpError(410, 'already_installed',
      'This Loaner Pool is already installed. To reinstall, remove the configuration file on the server first.',
      { config_path: configPath() }));
  }
  return next();
});

/** What the installer needs to know about its own environment. */
router.get('/state', asyncRoute(async (req, res) => {
  res.json({
    installed: false,
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    config_path: configPath(),
    node_version: process.version,
    // Whether the request arrived over TLS decides the secure-cookie default.
    // Getting this wrong locks everyone out, so it is detected, not guessed.
    is_https: req.secure || req.get('x-forwarded-proto') === 'https',
    detected_base_url: `${req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http'}://${req.get('host') || 'localhost'}`,
    symbologies: SYMBOLOGIES,
  });
}));

/**
 * Test a set of database credentials.
 *
 * Reports precisely what worked: reachable, authenticated, database present,
 * and whether the user can create tables. "Connection failed" alone sends
 * people to the wrong place half the time.
 */
router.post('/test-database', asyncRoute(async (req, res) => {
  const dbConfig = readDbConfig(req.body);
  const checks = {
    reachable: false,
    authenticated: false,
    database_exists: false,
    can_create_tables: false,
    existing_tables: [],
    server_version: null,
  };

  // Connect without selecting a database first, so "wrong password" and
  // "database missing" are distinguishable.
  let pool = createPool({ ...dbConfig, database: undefined });
  try {
    const [versionRows] = await pool.query('SELECT VERSION() AS version');
    checks.reachable = true;
    checks.authenticated = true;
    checks.server_version = versionRows[0]?.version ?? null;

    const [dbRows] = await pool.query(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [dbConfig.database],
    );
    checks.database_exists = dbRows.length > 0;
  } catch (err) {
    await pool.end().catch(() => {});
    return res.status(400).json({
      ok: false,
      checks,
      error: describeDbError(err),
      code: err.code ?? null,
    });
  }
  await pool.end().catch(() => {});

  if (!checks.database_exists) {
    return res.json({
      ok: false,
      checks,
      error:
        `Connected to MySQL successfully, but the database "${dbConfig.database}" does not exist. ` +
        'Create it in your hosting control panel and make sure this user has ALL PRIVILEGES on it. ' +
        'Some control panels prefix the name you type with your account name — enter the full, final name here.',
    });
  }

  // Now connect to the database itself and check we can actually write.
  pool = createPool(dbConfig);
  try {
    const [tables] = await pool.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [dbConfig.database],
    );
    checks.existing_tables = tables.map((t) => t.TABLE_NAME);

    // Create and drop a scratch table — the only honest test of CREATE rights.
    await pool.query('CREATE TABLE IF NOT EXISTS _loaner_install_check (id INT PRIMARY KEY)');
    await pool.query('DROP TABLE IF EXISTS _loaner_install_check');
    checks.can_create_tables = true;
  } catch (err) {
    await pool.end().catch(() => {});
    return res.status(400).json({ ok: false, checks, error: describeDbError(err), code: err.code ?? null });
  }
  await pool.end().catch(() => {});

  const conflicting = checks.existing_tables.filter((t) =>
    ['devices', 'loans', 'users', 'organizations'].includes(t));

  res.json({
    ok: true,
    checks,
    warning: conflicting.length
      ? `This database already contains Loaner Pool tables (${conflicting.join(', ')}). ` +
        'Installing will reuse them and will not delete existing rows, but if this database ' +
        'belongs to another installation, stop and use a different one.'
      : null,
  });
}));

/**
 * Run the installation.
 *
 * Order matters: the schema and seed data are written first, and the config
 * file is written last. If anything fails, no config file exists, so the app
 * stays in installer mode and the admin can correct and retry — rather than
 * booting into a half-configured state that needs SSH to unpick.
 */
router.post('/run', asyncRoute(async (req, res) => {
  const dbConfig = readDbConfig(req.body);
  const org = readOrgConfig(req.body);
  const admin = await readAdminConfig(req.body);
  const periods = readPeriods(req.body);

  const baseUrl = str(req.body?.base_url, { max: 255 })
    || `${req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http'}://${req.get('host') || 'localhost'}`;
  const secureCookies = bool(
    req.body?.secure_cookies,
    baseUrl.startsWith('https://'),
  );

  const pool = createPool(dbConfig);
  const conn = await pool.getConnection().catch((err) => {
    throw new HttpError(400, 'db_unreachable', describeDbError(err));
  });

  const log = [];
  let pendingMigrations = false;

  try {
    // --- Schema ------------------------------------------------------------
    const statements = loadSchemaStatements();
    for (const statement of statements) {
      await conn.query(statement);
    }
    log.push(`Created or verified ${statements.length} schema objects.`);

    // A fresh install gets the base schema, then every migration on top, so it
    // lands on exactly the same shape as a site that has been upgraded.
    pendingMigrations = true;

    // Everything from here is one transaction: a failure must not leave an
    // organisation with no administrator.
    await conn.beginTransaction();

    // --- Organisation ------------------------------------------------------
    const [existingOrg] = await conn.execute(
      'SELECT id FROM organizations WHERE slug = ?', [org.slug],
    );
    let organizationId;

    if (existingOrg.length) {
      organizationId = existingOrg[0].id;
      await conn.execute(
        `UPDATE organizations SET name = ?, timezone = ?, barcode_symbology = ?,
                barcode_prefix = ?, contact_email = ?, updated_at = NOW() WHERE id = ?`,
        [org.name, org.timezone, org.symbology, org.barcodePrefix, org.contactEmail, organizationId],
      );
      log.push(`Reused existing organisation "${org.name}".`);
    } else {
      const [orgResult] = await conn.execute(
        `INSERT INTO organizations (name, slug, timezone, barcode_symbology, barcode_prefix, contact_email)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [org.name, org.slug, org.timezone, org.symbology, org.barcodePrefix, org.contactEmail],
      );
      organizationId = orgResult.insertId;
      log.push(`Created organisation "${org.name}".`);
    }

    // --- Loan periods ------------------------------------------------------
    let periodCount = 0;
    for (const [index, period] of periods.entries()) {
      const [existing] = await conn.execute(
        'SELECT id FROM loan_periods WHERE organization_id = ? AND name = ?',
        [organizationId, period.name],
      );
      if (existing.length) continue;
      await conn.execute(
        `INSERT INTO loan_periods
           (organization_id, name, days, is_default, max_extensions, extension_days, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          organizationId, period.name, period.days, period.isDefault ? 1 : 0,
          period.maxExtensions, period.extensionDays, index,
        ],
      );
      periodCount += 1;
    }
    log.push(`Configured ${periodCount} loan period(s).`);

    // --- Administrator -----------------------------------------------------
    const [existingUser] = await conn.execute(
      'SELECT id FROM users WHERE organization_id = ? AND email = ?',
      [organizationId, admin.email],
    );
    if (existingUser.length) {
      await conn.rollback();
      throw new HttpError(409, 'admin_exists',
        `A user with the address ${admin.email} already exists in this database. ` +
        'Either use a different address, or use an empty database.');
    }

    const [userResult] = await conn.execute(
      `INSERT INTO users (organization_id, email, password_hash, full_name, role, active)
       VALUES (?, ?, ?, ?, 'admin', 1)`,
      [organizationId, admin.email, admin.passwordHash, admin.fullName],
    );
    log.push(`Created administrator ${admin.email}.`);

    // --- Schema version marker --------------------------------------------
    await conn.execute(
      `INSERT INTO schema_meta (id, schema_version, app_version) VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE schema_version = VALUES(schema_version), app_version = VALUES(app_version)`,
      [SCHEMA_VERSION, APP_VERSION],
    );

    await conn.execute(
      `INSERT INTO audit_log (organization_id, actor_id, actor_label, actor_type, action,
                              entity_type, entity_id, summary, ip)
       VALUES (?, ?, ?, 'user', 'install.completed', 'organization', ?, ?, ?)`,
      [
        organizationId, userResult.insertId, admin.fullName, organizationId,
        `Loaner Pool ${APP_VERSION} installed`, req.ip ?? null,
      ],
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    conn.release();
    await pool.end().catch(() => {});

    if (err instanceof HttpError) throw err;
    throw new HttpError(500, 'install_failed',
      `Installation failed: ${describeDbError(err)}`,
      { log, sql_state: err.sqlState ?? null, code: err.code ?? null });
  }

  conn.release();
  await pool.end().catch(() => {});

  // --- Config file (last) ---------------------------------------------------
  const config = {
    ...defaultConfig(),
    baseUrl,
    db: dbConfig,
    session: { lifetimeDays: 14, secureCookies },
  };

  try {
    writeConfig(config);
  } catch (err) {
    throw new HttpError(500, 'config_write_failed',
      `The database was set up successfully, but the configuration file could not be written to ` +
      `${configPath()}: ${err.message}. Make sure the "data" directory exists and is writable by ` +
      'the account the app runs as, then run the installer again.',
      { log, config_path: configPath() });
  }

  reloadConfig();
  await resetPool();

  // Migrations run only now, because they use the shared pool, which needs the
  // configuration file to exist before it can be built.
  if (pendingMigrations) {
    try {
      const migration = await runMigrations({ silent: true });
      if (migration.applied.length) {
        log.push(`Applied schema upgrades: ${migration.applied.map((v) => `v${v}`).join(', ')}.`);
        log.push(...migration.log);
      }
    } catch (err) {
      // The core install succeeded, so do not fail the request — but say so
      // plainly, because the newer features will not work until it is fixed.
      log.push(`WARNING: optional schema upgrades did not apply: ${err.message}`);
    }
  }

  res.json({
    ok: true,
    log,
    config_path: configPath(),
    login_url: '/login',
    admin_email: admin.email,
    secure_cookies: secureCookies,
    warning: secureCookies
      ? null
      : 'Secure cookies are switched off because this installation is not being served over HTTPS. ' +
        'Enable HTTPS and turn them on before using this system with real client data.',
  });
}));

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function readDbConfig(body) {
  return {
    host: requiredStr(body?.db_host, 'Database host', { max: 190 }),
    port: int(body?.db_port, 'Database port', { min: 1, max: 65535 }) ?? 3306,
    user: requiredStr(body?.db_user, 'Database user', { max: 128 }),
    // A password may legitimately be empty on a local development MySQL.
    password: body?.db_password === undefined || body?.db_password === null
      ? ''
      : String(body.db_password),
    database: requiredStr(body?.db_name, 'Database name', { max: 128 }),
    connectionLimit: int(body?.db_pool_size, 'Connection pool size', { min: 1, max: 100 }) ?? 10,
    ssl: bool(body?.db_ssl, false),
  };
}

function readOrgConfig(body) {
  const name = requiredStr(body?.org_name, 'Organisation name', { max: 190 });
  const slug = (str(body?.org_slug, { max: 64 }) || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'organisation';

  const symbology = str(body?.barcode_symbology) || 'qr';
  if (!SYMBOLOGIES.includes(symbology)) {
    throw badRequest(`Barcode symbology must be one of: ${SYMBOLOGIES.join(', ')}.`, {
      field: 'barcode_symbology',
    });
  }

  const barcodePrefix = (str(body?.barcode_prefix, { max: 8 }) || 'LP')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'LP';

  return {
    name,
    slug,
    timezone: str(body?.org_timezone, { max: 64 }) || 'UTC',
    symbology,
    barcodePrefix,
    contactEmail: parseEmail(body?.org_contact_email, 'Contact email'),
  };
}

async function readAdminConfig(body) {
  const email = parseEmail(body?.admin_email, 'Administrator email', { required: true });
  const fullName = requiredStr(body?.admin_name, 'Administrator name', { max: 190 });
  const password = String(body?.admin_password ?? '');
  const confirm = String(body?.admin_password_confirm ?? password);

  if (password !== confirm) {
    throw badRequest('The two passwords do not match.', { field: 'admin_password_confirm' });
  }
  validatePassword(password);

  return { email, fullName, passwordHash: await hashPassword(password) };
}

/**
 * Loan periods. Defaults cover the common cases; the installer UI lets the
 * admin edit, remove or add to them, and they remain fully editable afterwards.
 */
function readPeriods(body) {
  const provided = Array.isArray(body?.loan_periods) ? body.loan_periods : null;

  const periods = (provided && provided.length ? provided : [
    { name: 'Short term (7 days)', days: 7, is_default: false, max_extensions: 2, extension_days: 7 },
    { name: 'Standard (30 days)', days: 30, is_default: true, max_extensions: 2, extension_days: 14 },
    { name: 'Extended (90 days)', days: 90, is_default: false, max_extensions: 1, extension_days: 30 },
    { name: 'Academic term (120 days)', days: 120, is_default: false, max_extensions: 1, extension_days: 30 },
    { name: 'Open ended (no due date)', days: 0, is_default: false, max_extensions: 0, extension_days: 0 },
  ]).map((period, index) => ({
    name: requiredStr(period.name, `Loan period ${index + 1} name`, { max: 120 }),
    days: int(period.days, `Loan period ${index + 1} length`, { min: 0, max: 3650 }) ?? 30,
    isDefault: bool(period.is_default, false),
    maxExtensions: int(period.max_extensions, `Loan period ${index + 1} extension limit`, { min: 0, max: 50 }) ?? 2,
    extensionDays: int(period.extension_days, `Loan period ${index + 1} extension length`, { min: 0, max: 365 }) ?? 14,
  }));

  // Exactly one default, or check-out has to ask every time.
  const defaults = periods.filter((p) => p.isDefault);
  if (defaults.length === 0) {
    const standard = periods.find((p) => p.days > 0) || periods[0];
    standard.isDefault = true;
  } else if (defaults.length > 1) {
    defaults.slice(1).forEach((p) => { p.isDefault = false; });
  }

  return periods;
}

export default router;
