-- ---------------------------------------------------------------------------
-- Loaner Pool — schema
--
-- Target: MySQL 5.7+ / MariaDB 10.2+ (cPanel hosts commonly run MariaDB 10.x).
-- Deliberately conservative:
--   * utf8mb4_unicode_ci, not utf8mb4_0900_ai_ci (MySQL 8 only)
--   * LONGTEXT for JSON payloads, not the JSON type
--   * no CHECK constraints (silently ignored on MySQL 5.7, enforced on MariaDB
--     10.2+ — the inconsistency is worse than enforcing in application code)
--   * one TIMESTAMP with CURRENT_TIMESTAMP default per table
--
-- Statements are split on ";\n" by the installer, so keep each statement
-- terminated by a semicolon at end of line and avoid semicolons inside literals.
-- ---------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- Organisations. The installer seeds exactly one. Every tenant-scoped table
-- carries organization_id so a second org can be added later without a
-- migration that rewrites every row.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(190) NOT NULL,
  slug            VARCHAR(64)  NOT NULL,
  timezone        VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  barcode_symbology ENUM('qr','code128','code39') NOT NULL DEFAULT 'qr',
  barcode_prefix  VARCHAR(16)  NOT NULL DEFAULT 'LP',
  contact_email   VARCHAR(190) DEFAULT NULL,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Free-form per-org settings (Graph mail config, notification toggles, etc.).
-- Secrets are stored encrypted at rest; see src/lib/secrets.js.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_settings (
  organization_id INT UNSIGNED NOT NULL,
  setting_key     VARCHAR(96)  NOT NULL,
  setting_value   LONGTEXT,
  is_secret       TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, setting_key),
  CONSTRAINT fk_settings_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Users. Roles:
--   admin — full control incl. settings, users, API keys
--   tech  — device/loan operations, approves VRC requests, provisions
--   vrc   — requests loans for clients, sees own requests + own clients
--   viewer— read-only reporting access
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  email           VARCHAR(190) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  full_name       VARCHAR(190) NOT NULL,
  role            ENUM('admin','tech','vrc','viewer') NOT NULL DEFAULT 'tech',
  phone           VARCHAR(40)  DEFAULT NULL,
  employee_ref    VARCHAR(64)  DEFAULT NULL,
  badge_barcode   VARCHAR(64)  DEFAULT NULL,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  failed_logins   INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until    DATETIME     DEFAULT NULL,
  last_login_at   DATETIME     DEFAULT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_email (organization_id, email),
  UNIQUE KEY uq_user_badge (badge_barcode),
  KEY idx_user_role (organization_id, role, active),
  CONSTRAINT fk_users_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Server-side sessions. Kept in MySQL rather than memory so the app survives
-- a Passenger restart without logging everyone out.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id          CHAR(64)     NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  ip          VARCHAR(64)  DEFAULT NULL,
  user_agent  VARCHAR(255) DEFAULT NULL,
  expires_at  DATETIME     NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- API keys for third-party apps built on the public API.
-- Only a hash is stored; the plaintext key is shown once at creation.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  name            VARCHAR(190) NOT NULL,
  key_prefix      VARCHAR(16)  NOT NULL,
  key_hash        CHAR(64)     NOT NULL,
  scopes          VARCHAR(500) NOT NULL DEFAULT 'read',
  created_by      INT UNSIGNED DEFAULT NULL,
  last_used_at    DATETIME     DEFAULT NULL,
  expires_at      DATETIME     DEFAULT NULL,
  revoked_at      DATETIME     DEFAULT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_key_hash (key_hash),
  KEY idx_api_key_prefix (key_prefix),
  CONSTRAINT fk_apikeys_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_apikeys_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Programs — service activities a loan can be attributed to (LEAP, Retreat...).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS programs (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  name            VARCHAR(190) NOT NULL,
  code            VARCHAR(40)  DEFAULT NULL,
  description     TEXT,
  contact_email   VARCHAR(190) DEFAULT NULL,
  default_loan_days INT UNSIGNED DEFAULT NULL,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_program_code (organization_id, code),
  KEY idx_program_name (organization_id, name),
  CONSTRAINT fk_programs_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Clients — the people devices are ultimately loaned to.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  external_ref    VARCHAR(64)  DEFAULT NULL,
  first_name      VARCHAR(120) NOT NULL,
  last_name       VARCHAR(120) NOT NULL,
  email           VARCHAR(190) DEFAULT NULL,
  phone           VARCHAR(40)  DEFAULT NULL,
  counselor_id    INT UNSIGNED DEFAULT NULL,
  program_id      INT UNSIGNED DEFAULT NULL,
  notes           TEXT,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_ref (organization_id, external_ref),
  KEY idx_client_name (organization_id, last_name, first_name),
  KEY idx_client_counselor (counselor_id),
  CONSTRAINT fk_clients_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_clients_counselor FOREIGN KEY (counselor_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_clients_program FOREIGN KEY (program_id) REFERENCES programs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Configurable loan periods. Each org defines its own; exactly one is default.
-- days = 0 is legal and means "open ended / no due date".
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_periods (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  name            VARCHAR(120) NOT NULL,
  days            INT UNSIGNED NOT NULL DEFAULT 30,
  is_default      TINYINT(1)   NOT NULL DEFAULT 0,
  max_extensions  INT UNSIGNED NOT NULL DEFAULT 2,
  extension_days  INT UNSIGNED NOT NULL DEFAULT 14,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order      INT          NOT NULL DEFAULT 0,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_period_name (organization_id, name),
  CONSTRAINT fk_periods_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Devices. barcode is unique across the whole install and is what a scanner
-- reads. asset_tag is the organisation's own inventory number.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  barcode         VARCHAR(64)  NOT NULL,
  asset_tag       VARCHAR(64)  DEFAULT NULL,
  serial_number   VARCHAR(128) DEFAULT NULL,
  name            VARCHAR(190) NOT NULL,
  category        VARCHAR(96)  DEFAULT NULL,
  manufacturer    VARCHAR(120) DEFAULT NULL,
  model           VARCHAR(120) DEFAULT NULL,
  description     TEXT,
  status          ENUM('available','checked_out','reserved','maintenance','retired','lost') NOT NULL DEFAULT 'available',
  condition_note  VARCHAR(190) DEFAULT NULL,
  location        VARCHAR(190) DEFAULT NULL,
  home_location   VARCHAR(190) DEFAULT NULL,
  owner_program_id INT UNSIGNED DEFAULT NULL,
  purchase_date   DATE         DEFAULT NULL,
  purchase_cost   DECIMAL(10,2) DEFAULT NULL,
  warranty_expires DATE        DEFAULT NULL,
  funding_source  VARCHAR(120) DEFAULT NULL,
  notes           TEXT,
  custom_fields   LONGTEXT,
  import_id       INT UNSIGNED DEFAULT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_device_barcode (barcode),
  UNIQUE KEY uq_device_asset (organization_id, asset_tag),
  UNIQUE KEY uq_device_serial (organization_id, serial_number),
  KEY idx_device_status (organization_id, status),
  KEY idx_device_category (organization_id, category),
  KEY idx_device_name (organization_id, name),
  CONSTRAINT fk_devices_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_devices_program FOREIGN KEY (owner_program_id) REFERENCES programs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- One row per spreadsheet ingest, so an import can be reviewed or attributed.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_imports (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  filename        VARCHAR(255) DEFAULT NULL,
  row_count       INT UNSIGNED NOT NULL DEFAULT 0,
  created_count   INT UNSIGNED NOT NULL DEFAULT 0,
  updated_count   INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count   INT UNSIGNED NOT NULL DEFAULT 0,
  error_count     INT UNSIGNED NOT NULL DEFAULT 0,
  column_mapping  LONGTEXT,
  errors          LONGTEXT,
  dry_run         TINYINT(1)   NOT NULL DEFAULT 0,
  imported_by     INT UNSIGNED DEFAULT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_import_org (organization_id, created_at),
  CONSTRAINT fk_imports_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_imports_user FOREIGN KEY (imported_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Loan requests raised by a VRC (or by a tech on a VRC's behalf).
--
-- fulfillment_state tracks the physical journey once approved:
--   pending      -> not yet started
--   provisioning -> tech is imaging/configuring the device
--   in_transit   -> being brought to the client
--   ready_pickup -> staged for the VRC to collect
--   delivered    -> handed over (a loan row exists by this point)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_requests (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id   INT UNSIGNED NOT NULL,
  reference         VARCHAR(24)  NOT NULL,
  requested_by      INT UNSIGNED NOT NULL,
  client_id         INT UNSIGNED DEFAULT NULL,
  program_id        INT UNSIGNED DEFAULT NULL,
  device_id         INT UNSIGNED DEFAULT NULL,
  requested_category VARCHAR(96) DEFAULT NULL,
  requested_details TEXT,
  justification     TEXT,
  needed_by         DATE         DEFAULT NULL,
  loan_period_id    INT UNSIGNED DEFAULT NULL,
  requested_days    INT UNSIGNED DEFAULT NULL,
  delivery_mode     ENUM('vrc_pickup','deliver_to_client','client_pickup') NOT NULL DEFAULT 'vrc_pickup',
  status            ENUM('submitted','approved','denied','cancelled','fulfilled') NOT NULL DEFAULT 'submitted',
  fulfillment_state ENUM('pending','provisioning','in_transit','ready_pickup','delivered') NOT NULL DEFAULT 'pending',
  assigned_tech_id  INT UNSIGNED DEFAULT NULL,
  reviewed_by       INT UNSIGNED DEFAULT NULL,
  reviewed_at       DATETIME     DEFAULT NULL,
  review_notes      TEXT,
  loan_id           INT UNSIGNED DEFAULT NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_request_ref (reference),
  KEY idx_request_status (organization_id, status, fulfillment_state),
  KEY idx_request_requester (requested_by, status),
  KEY idx_request_tech (assigned_tech_id, status),
  CONSTRAINT fk_requests_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_requests_user FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_requests_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL,
  CONSTRAINT fk_requests_program FOREIGN KEY (program_id) REFERENCES programs (id) ON DELETE SET NULL,
  CONSTRAINT fk_requests_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL,
  CONSTRAINT fk_requests_tech FOREIGN KEY (assigned_tech_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_requests_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Loans. A device may be held by a tech, a program, a client, or a client and
-- a tech simultaneously — hence three independent nullable holder columns.
-- Application code enforces "at least one holder present" (see lib/loans.js);
-- a CHECK constraint here would be silently ignored on MySQL 5.7.
--
-- due_at NULL means an open-ended loan (loan_period.days = 0).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id   INT UNSIGNED NOT NULL,
  reference         VARCHAR(24)  NOT NULL,
  device_id         INT UNSIGNED NOT NULL,
  request_id        INT UNSIGNED DEFAULT NULL,
  tech_id           INT UNSIGNED DEFAULT NULL,
  client_id         INT UNSIGNED DEFAULT NULL,
  program_id        INT UNSIGNED DEFAULT NULL,
  loan_period_id    INT UNSIGNED DEFAULT NULL,
  status            ENUM('active','returned','cancelled') NOT NULL DEFAULT 'active',
  checked_out_at    DATETIME     NOT NULL,
  checked_out_by    INT UNSIGNED DEFAULT NULL,
  checkout_method   ENUM('scan','manual','api','request') NOT NULL DEFAULT 'manual',
  due_at            DATETIME     DEFAULT NULL,
  original_due_at   DATETIME     DEFAULT NULL,
  returned_at       DATETIME     DEFAULT NULL,
  checked_in_by     INT UNSIGNED DEFAULT NULL,
  checkin_method    ENUM('scan','manual','api') DEFAULT NULL,
  extension_count   INT UNSIGNED NOT NULL DEFAULT 0,
  condition_out     VARCHAR(190) DEFAULT NULL,
  condition_in      VARCHAR(190) DEFAULT NULL,
  notes             TEXT,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_loan_ref (reference),
  KEY idx_loan_device (device_id, status),
  KEY idx_loan_status (organization_id, status, due_at),
  KEY idx_loan_tech (tech_id, status),
  KEY idx_loan_client (client_id, status),
  KEY idx_loan_program (program_id, status),
  KEY idx_loan_checkout (organization_id, checked_out_at),
  CONSTRAINT fk_loans_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_loans_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
  CONSTRAINT fk_loans_request FOREIGN KEY (request_id) REFERENCES loan_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_loans_tech FOREIGN KEY (tech_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_loans_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL,
  CONSTRAINT fk_loans_program FOREIGN KEY (program_id) REFERENCES programs (id) ON DELETE SET NULL,
  CONSTRAINT fk_loans_period FOREIGN KEY (loan_period_id) REFERENCES loan_periods (id) ON DELETE SET NULL,
  CONSTRAINT fk_loans_outby FOREIGN KEY (checked_out_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_loans_inby FOREIGN KEY (checked_in_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Loan timeline: every extension, reduction, cancellation and hand-off.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_events (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  loan_id     INT UNSIGNED NOT NULL,
  event_type  ENUM('checkout','extend','reduce','cancel','checkin','transfer','note','overdue_notice','due_soon_notice') NOT NULL,
  old_due_at  DATETIME     DEFAULT NULL,
  new_due_at  DATETIME     DEFAULT NULL,
  actor_id    INT UNSIGNED DEFAULT NULL,
  notes       TEXT,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_event_loan (loan_id, created_at),
  CONSTRAINT fk_events_loan FOREIGN KEY (loan_id) REFERENCES loans (id) ON DELETE CASCADE,
  CONSTRAINT fk_events_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Append-only audit log. Nothing in the application ever issues UPDATE or
-- DELETE against this table.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  actor_id        INT UNSIGNED DEFAULT NULL,
  actor_label     VARCHAR(190) DEFAULT NULL,
  actor_type      ENUM('user','api_key','system') NOT NULL DEFAULT 'user',
  action          VARCHAR(64)  NOT NULL,
  entity_type     VARCHAR(40)  DEFAULT NULL,
  entity_id       INT UNSIGNED DEFAULT NULL,
  entity_label    VARCHAR(190) DEFAULT NULL,
  summary         VARCHAR(500) DEFAULT NULL,
  detail          LONGTEXT,
  ip              VARCHAR(64)  DEFAULT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_org_time (organization_id, created_at),
  KEY idx_audit_entity (entity_type, entity_id, created_at),
  KEY idx_audit_actor (actor_id, created_at),
  KEY idx_audit_action (organization_id, action, created_at),
  CONSTRAINT fk_audit_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Remote scanner pairing. A phone opens /scan/remote?code=XXXX and pushes
-- decoded barcodes to whichever desktop station holds the same channel.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_channels (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  pair_code       VARCHAR(12)  NOT NULL,
  label           VARCHAR(120) DEFAULT NULL,
  owner_id        INT UNSIGNED NOT NULL,
  expires_at      DATETIME     NOT NULL,
  last_scan_at    DATETIME     DEFAULT NULL,
  scan_count      INT UNSIGNED NOT NULL DEFAULT 0,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pair_code (pair_code),
  KEY idx_channel_owner (owner_id, expires_at),
  CONSTRAINT fk_channels_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_channels_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Outbound email queue/journal for Microsoft Graph notifications.
-- Rows are retained after send so the audit view can show what went out.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_log (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  event_type      VARCHAR(48)  NOT NULL,
  recipient       VARCHAR(500) NOT NULL,
  subject         VARCHAR(255) NOT NULL,
  body_preview    TEXT,
  loan_id         INT UNSIGNED DEFAULT NULL,
  request_id      INT UNSIGNED DEFAULT NULL,
  status          ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',
  error_message   TEXT,
  attempts        INT UNSIGNED NOT NULL DEFAULT 0,
  sent_at         DATETIME     DEFAULT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_email_status (organization_id, status, created_at),
  KEY idx_email_loan (loan_id),
  CONSTRAINT fk_email_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------------
-- Schema version marker, so future upgrades can migrate rather than guess.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_meta (
  id             TINYINT UNSIGNED NOT NULL DEFAULT 1,
  schema_version INT UNSIGNED NOT NULL,
  app_version    VARCHAR(32) NOT NULL,
  installed_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
