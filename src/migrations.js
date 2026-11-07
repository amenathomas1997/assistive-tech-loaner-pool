/**
 * Schema migrations.
 *
 * `schema.sql` describes version 1 and is only ever run by the installer.
 * Everything after that lives here, so a site installed months ago and a site
 * installed this morning converge on the same schema by the same code path:
 * the installer runs schema.sql then the migrations, and an existing install
 * runs the migrations alone on boot.
 *
 * Every step is written to be safe to re-run. Statements go through helpers
 * that check information_schema first, because MySQL has no
 * `ADD COLUMN IF NOT EXISTS` (MariaDB does, but relying on it would break
 * MySQL) and a half-applied migration must not wedge the next boot.
 */

import { query, queryOne, execute } from './db.js';
import { SCHEMA_VERSION } from './config.js';

// ---------------------------------------------------------------------------
// Idempotent DDL helpers
// ---------------------------------------------------------------------------

async function currentDatabase() {
  const row = await queryOne('SELECT DATABASE() AS db');
  return row?.db;
}

async function tableExists(table) {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [await currentDatabase(), table],
  );
  return Number(row?.n) > 0;
}

async function columnExists(table, column) {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [await currentDatabase(), table, column],
  );
  return Number(row?.n) > 0;
}

async function indexExists(table, indexName) {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [await currentDatabase(), table, indexName],
  );
  return Number(row?.n) > 0;
}

/** ALTER TABLE ... ADD COLUMN, skipped when the column is already present. */
async function addColumn(table, column, definition, log) {
  if (!(await tableExists(table))) return;
  if (await columnExists(table, column)) return;
  await execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  log.push(`Added ${table}.${column}`);
}

async function addIndex(table, indexName, definition, log) {
  if (!(await tableExists(table))) return;
  if (await indexExists(table, indexName)) return;
  await execute(`ALTER TABLE \`${table}\` ADD ${definition}`);
  log.push(`Indexed ${table}.${indexName}`);
}

async function createTable(name, body, log) {
  if (await tableExists(name)) return;
  await execute(
    `CREATE TABLE \`${name}\` (${body}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  log.push(`Created table ${name}`);
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const MIGRATIONS = [
  {
    version: 2,
    name: 'Kits, agreements, photos, reservations, repairs, resets',
    async up(log) {
      // --- Attachments: condition photos and signature images ---------------
      // Files live on disk under data/uploads; only metadata is stored here,
      // so a database dump stays a sensible size and a photo can be served
      // with a normal streamed response rather than a BLOB round trip.
      await createTable('attachments', `
        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id INT UNSIGNED NOT NULL,
        kind            ENUM('condition_photo','signature','document','other') NOT NULL DEFAULT 'other',
        loan_id         INT UNSIGNED DEFAULT NULL,
        device_id       INT UNSIGNED DEFAULT NULL,
        repair_id       INT UNSIGNED DEFAULT NULL,
        phase           ENUM('out','in','repair','agreement') DEFAULT NULL,
        filename        VARCHAR(255) NOT NULL,
        mime_type       VARCHAR(64)  NOT NULL,
        byte_size       INT UNSIGNED NOT NULL DEFAULT 0,
        width           INT UNSIGNED DEFAULT NULL,
        height          INT UNSIGNED DEFAULT NULL,
        storage_path    VARCHAR(255) NOT NULL,
        sha256          CHAR(64)     DEFAULT NULL,
        caption         VARCHAR(255) DEFAULT NULL,
        uploaded_by     INT UNSIGNED DEFAULT NULL,
        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_attach_loan (loan_id, phase),
        KEY idx_attach_device (device_id),
        KEY idx_attach_repair (repair_id),
        KEY idx_attach_org (organization_id, kind, created_at),
        CONSTRAINT fk_attach_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
        CONSTRAINT fk_attach_loan FOREIGN KEY (loan_id) REFERENCES loans (id) ON DELETE CASCADE,
        CONSTRAINT fk_attach_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
        CONSTRAINT fk_attach_user FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
      `, log);

      // --- Loan agreements ---------------------------------------------------
      // agreement_text is snapshotted per loan rather than referenced, because
      // the wording an organisation uses today is not what someone signed two
      // years ago, and the signed wording is the thing that matters.
      await createTable('loan_agreements', `
        id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id    INT UNSIGNED NOT NULL,
        loan_id            INT UNSIGNED NOT NULL,
        agreement_text     LONGTEXT     NOT NULL,
        signed_by_name     VARCHAR(190) NOT NULL,
        signed_by_role     ENUM('client','counselor','technician','guardian','other') NOT NULL DEFAULT 'client',
        signature_method   ENUM('drawn','typed','uploaded','waived') NOT NULL DEFAULT 'typed',
        signature_attachment_id INT UNSIGNED DEFAULT NULL,
        typed_signature    VARCHAR(190) DEFAULT NULL,
        waived_reason      VARCHAR(255) DEFAULT NULL,
        witnessed_by       INT UNSIGNED DEFAULT NULL,
        signed_at          DATETIME     NOT NULL,
        ip                 VARCHAR(64)  DEFAULT NULL,
        created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_agreement_loan (loan_id),
        CONSTRAINT fk_agreement_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
        CONSTRAINT fk_agreement_loan FOREIGN KEY (loan_id) REFERENCES loans (id) ON DELETE CASCADE,
        CONSTRAINT fk_agreement_sig FOREIGN KEY (signature_attachment_id) REFERENCES attachments (id) ON DELETE SET NULL,
        CONSTRAINT fk_agreement_witness FOREIGN KEY (witnessed_by) REFERENCES users (id) ON DELETE SET NULL
      `, log);

      // --- Accessories -------------------------------------------------------
      // A charger is not a device worth its own barcode, but it is the thing
      // that actually goes missing. Modelled as a checklist on the device.
      await createTable('device_accessories', `
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        device_id  INT UNSIGNED NOT NULL,
        name       VARCHAR(120) NOT NULL,
        required   TINYINT(1)   NOT NULL DEFAULT 1,
        sort_order INT          NOT NULL DEFAULT 0,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_accessory (device_id, name),
        CONSTRAINT fk_accessory_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
      `, log);

      // --- Kits --------------------------------------------------------------
      await createTable('kits', `
        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id INT UNSIGNED NOT NULL,
        name            VARCHAR(190) NOT NULL,
        description     TEXT,
        active          TINYINT(1)   NOT NULL DEFAULT 1,
        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_kit_name (organization_id, name),
        CONSTRAINT fk_kit_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
      `, log);

      await createTable('kit_items', `
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        kit_id     INT UNSIGNED NOT NULL,
        device_id  INT UNSIGNED NOT NULL,
        required   TINYINT(1)   NOT NULL DEFAULT 1,
        sort_order INT          NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE KEY uq_kit_item (kit_id, device_id),
        KEY idx_kit_item_device (device_id),
        CONSTRAINT fk_kititem_kit FOREIGN KEY (kit_id) REFERENCES kits (id) ON DELETE CASCADE,
        CONSTRAINT fk_kititem_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
      `, log);

      // --- Reservations / waitlist -------------------------------------------
      await createTable('reservations', `
        id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id   INT UNSIGNED NOT NULL,
        reference         VARCHAR(24)  NOT NULL,
        device_id         INT UNSIGNED DEFAULT NULL,
        category          VARCHAR(96)  DEFAULT NULL,
        client_id         INT UNSIGNED DEFAULT NULL,
        program_id        INT UNSIGNED DEFAULT NULL,
        request_id        INT UNSIGNED DEFAULT NULL,
        requested_by      INT UNSIGNED NOT NULL,
        status            ENUM('waiting','ready','fulfilled','cancelled','expired') NOT NULL DEFAULT 'waiting',
        priority          INT          NOT NULL DEFAULT 0,
        needed_from       DATE         DEFAULT NULL,
        needed_to         DATE         DEFAULT NULL,
        notes             TEXT,
        ready_device_id   INT UNSIGNED DEFAULT NULL,
        notified_at       DATETIME     DEFAULT NULL,
        claim_expires_at  DATETIME     DEFAULT NULL,
        fulfilled_loan_id INT UNSIGNED DEFAULT NULL,
        closed_at         DATETIME     DEFAULT NULL,
        created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        DATETIME     DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_reservation_ref (reference),
        KEY idx_res_queue (organization_id, status, priority, created_at),
        KEY idx_res_device (device_id, status),
        KEY idx_res_category (organization_id, category, status),
        CONSTRAINT fk_res_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
        CONSTRAINT fk_res_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
        CONSTRAINT fk_res_ready FOREIGN KEY (ready_device_id) REFERENCES devices (id) ON DELETE SET NULL,
        CONSTRAINT fk_res_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL,
        CONSTRAINT fk_res_program FOREIGN KEY (program_id) REFERENCES programs (id) ON DELETE SET NULL,
        CONSTRAINT fk_res_request FOREIGN KEY (request_id) REFERENCES loan_requests (id) ON DELETE SET NULL,
        CONSTRAINT fk_res_user FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_res_loan FOREIGN KEY (fulfilled_loan_id) REFERENCES loans (id) ON DELETE SET NULL
      `, log);

      // --- Repairs -----------------------------------------------------------
      await createTable('repairs', `
        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id INT UNSIGNED NOT NULL,
        reference       VARCHAR(24)  NOT NULL,
        device_id       INT UNSIGNED NOT NULL,
        loan_id         INT UNSIGNED DEFAULT NULL,
        status          ENUM('reported','diagnosing','awaiting_parts','with_vendor','repaired','unrepairable','cancelled') NOT NULL DEFAULT 'reported',
        fault           TEXT         NOT NULL,
        diagnosis       TEXT,
        resolution      TEXT,
        vendor          VARCHAR(190) DEFAULT NULL,
        vendor_ref      VARCHAR(120) DEFAULT NULL,
        cost            DECIMAL(10,2) DEFAULT NULL,
        under_warranty  TINYINT(1)   NOT NULL DEFAULT 0,
        reported_by     INT UNSIGNED DEFAULT NULL,
        assigned_to     INT UNSIGNED DEFAULT NULL,
        sent_at         DATETIME     DEFAULT NULL,
        returned_at     DATETIME     DEFAULT NULL,
        closed_at       DATETIME     DEFAULT NULL,
        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME     DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_repair_ref (reference),
        KEY idx_repair_device (device_id, status),
        KEY idx_repair_status (organization_id, status, created_at),
        CONSTRAINT fk_repair_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
        CONSTRAINT fk_repair_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
        CONSTRAINT fk_repair_loan FOREIGN KEY (loan_id) REFERENCES loans (id) ON DELETE SET NULL,
        CONSTRAINT fk_repair_reporter FOREIGN KEY (reported_by) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_repair_assignee FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL
      `, log);

      await createTable('repair_events', `
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        repair_id  INT UNSIGNED NOT NULL,
        event_type VARCHAR(40)  NOT NULL,
        from_status VARCHAR(40) DEFAULT NULL,
        to_status  VARCHAR(40)  DEFAULT NULL,
        actor_id   INT UNSIGNED DEFAULT NULL,
        notes      TEXT,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_repair_event (repair_id, created_at),
        CONSTRAINT fk_repairevent_repair FOREIGN KEY (repair_id) REFERENCES repairs (id) ON DELETE CASCADE,
        CONSTRAINT fk_repairevent_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
      `, log);

      // --- Password resets ---------------------------------------------------
      // Only a hash of the token is stored, so a database dump cannot be used
      // to take over accounts.
      await createTable('password_resets', `
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id    INT UNSIGNED NOT NULL,
        token_hash CHAR(64)     NOT NULL,
        expires_at DATETIME     NOT NULL,
        used_at    DATETIME     DEFAULT NULL,
        ip         VARCHAR(64)  DEFAULT NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_reset_token (token_hash),
        KEY idx_reset_user (user_id, expires_at),
        CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      `, log);

      // --- Job runs ----------------------------------------------------------
      // So an administrator can see whether the nightly reminder job is
      // actually running, rather than discovering months later that it is not.
      await createTable('job_runs', `
        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
        organization_id INT UNSIGNED DEFAULT NULL,
        job_name        VARCHAR(64)  NOT NULL,
        status          ENUM('running','ok','failed') NOT NULL DEFAULT 'running',
        started_at      DATETIME     NOT NULL,
        finished_at     DATETIME     DEFAULT NULL,
        summary         VARCHAR(500) DEFAULT NULL,
        detail          LONGTEXT,
        triggered_by    VARCHAR(40)  DEFAULT NULL,
        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_job_name (job_name, started_at)
      `, log);

      // --- Loan columns for kits, accessories and agreements ------------------
      await addColumn('loans', 'group_ref', 'VARCHAR(24) DEFAULT NULL', log);
      await addColumn('loans', 'kit_id', 'INT UNSIGNED DEFAULT NULL', log);
      await addColumn('loans', 'accessories_out', 'LONGTEXT', log);
      await addColumn('loans', 'accessories_in', 'LONGTEXT', log);
      await addIndex('loans', 'idx_loan_group', 'KEY idx_loan_group (group_ref)', log);

      // --- Device column for the repair link ---------------------------------
      await addColumn('devices', 'active_repair_id', 'INT UNSIGNED DEFAULT NULL', log);
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** The version recorded in the database, or 0 if the marker row is missing. */
export async function currentSchemaVersion() {
  if (!(await tableExists('schema_meta'))) return 0;
  const row = await queryOne('SELECT schema_version FROM schema_meta WHERE id = 1');
  return Number(row?.schema_version ?? 0);
}

/**
 * Apply any migration newer than the recorded version.
 *
 * Each migration is applied outside a transaction because MySQL commits
 * implicitly on DDL — wrapping it would give a false sense of atomicity. The
 * helpers are individually idempotent instead, so a migration interrupted
 * halfway simply resumes on the next run.
 */
export async function runMigrations({ silent = false } = {}) {
  const from = await currentSchemaVersion();
  const pending = MIGRATIONS.filter((m) => m.version > from);

  if (!pending.length) {
    return { from, to: from, applied: [], log: [] };
  }

  const log = [];
  const applied = [];

  for (const migration of pending) {
    if (!silent) console.log(`[migrate] applying v${migration.version}: ${migration.name}`);
    const stepLog = [];

    try {
      await migration.up(stepLog);
    } catch (err) {
      console.error(`[migrate] v${migration.version} FAILED:`, err.message);
      throw new Error(
        `Database upgrade to version ${migration.version} failed: ${err.message}. ` +
        'The application will keep running on the previous schema; fix the cause and restart.',
      );
    }

    await execute(
      `INSERT INTO schema_meta (id, schema_version, app_version)
       VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE schema_version = VALUES(schema_version), app_version = VALUES(app_version)`,
      [migration.version, process.env.npm_package_version || '1.0.0'],
    );

    applied.push(migration.version);
    log.push(...stepLog);
    if (!silent && stepLog.length) {
      for (const line of stepLog) console.log(`[migrate]   ${line}`);
    }
  }

  return { from, to: await currentSchemaVersion(), applied, log };
}

/** Highest migration this build knows about. */
export function targetSchemaVersion() {
  return MIGRATIONS.length ? Math.max(SCHEMA_VERSION, ...MIGRATIONS.map((m) => m.version)) : SCHEMA_VERSION;
}
