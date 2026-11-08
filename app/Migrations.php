<?php
/**
 * Schema migrations.
 *
 * `schema.sql` describes version 1 and is only ever run by the installer.
 * Everything after that lives here, so a site installed months ago and a site
 * installed this morning converge on the same schema by the same code path.
 *
 * Every step is written to be safe to re-run. MySQL commits implicitly on DDL,
 * so wrapping a migration in a transaction would give a false sense of
 * atomicity; the helpers are individually idempotent instead, and a migration
 * interrupted halfway simply resumes on the next run.
 */

declare(strict_types=1);

namespace Loaner;

final class Migrations
{
    /** Highest version this build knows about. */
    public const TARGET_VERSION = 6;

    // -----------------------------------------------------------------------
    // Idempotent DDL helpers
    // -----------------------------------------------------------------------

    private static function database(): string
    {
        return (string) Db::value('SELECT DATABASE()');
    }

    private static function tableExists(string $table): bool
    {
        return (int) Db::value(
            'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
            [self::database(), $table],
        ) > 0;
    }

    private static function columnExists(string $table, string $column): bool
    {
        return (int) Db::value(
            'SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [self::database(), $table, $column],
        ) > 0;
    }

    private static function indexExists(string $table, string $index): bool
    {
        return (int) Db::value(
            'SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
            [self::database(), $table, $index],
        ) > 0;
    }

    private static function createTable(string $name, string $body, array &$log): void
    {
        if (self::tableExists($name)) {
            return;
        }

        Db::connection()->exec(
            "CREATE TABLE `{$name}` ({$body}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
        );
        $log[] = "Created table {$name}";
    }

    private static function addColumn(string $table, string $column, string $definition, array &$log): void
    {
        if (!self::tableExists($table) || self::columnExists($table, $column)) {
            return;
        }

        Db::connection()->exec("ALTER TABLE `{$table}` ADD COLUMN `{$column}` {$definition}");
        $log[] = "Added {$table}.{$column}";
    }

    private static function addIndex(string $table, string $index, string $definition, array &$log): void
    {
        if (!self::tableExists($table) || self::indexExists($table, $index)) {
            return;
        }

        Db::connection()->exec("ALTER TABLE `{$table}` ADD {$definition}");
        $log[] = "Indexed {$table}.{$index}";
    }

    // -----------------------------------------------------------------------
    // The migrations
    // -----------------------------------------------------------------------

    /** @return array<int, array{version:int, name:string, up:callable}> */
    private static function all(): array
    {
        return [
            [
                'version' => 2,
                'name'    => 'Kits, agreements, photos, reservations, repairs, resets',
                'up'      => static function (array &$log): void {
                    // --- Attachments: condition photos and signature images ---
                    // Files live on disk under data/uploads; only metadata is
                    // here, so a database dump stays a sensible size and a
                    // photo can be streamed rather than fetched as a BLOB.
                    self::createTable('attachments', '
                        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        organization_id INT UNSIGNED NOT NULL,
                        kind            ENUM("condition_photo","signature","document","other") NOT NULL DEFAULT "other",
                        loan_id         INT UNSIGNED DEFAULT NULL,
                        device_id       INT UNSIGNED DEFAULT NULL,
                        repair_id       INT UNSIGNED DEFAULT NULL,
                        phase           ENUM("out","in","repair","agreement") DEFAULT NULL,
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
                    ', $log);

                    // --- Loan agreements -------------------------------------
                    // agreement_text is snapshotted per loan rather than
                    // referenced: the wording an organisation uses today is not
                    // what someone signed two years ago, and the signed wording
                    // is the thing that matters.
                    self::createTable('loan_agreements', '
                        id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        organization_id         INT UNSIGNED NOT NULL,
                        loan_id                 INT UNSIGNED NOT NULL,
                        agreement_text          LONGTEXT     NOT NULL,
                        signed_by_name          VARCHAR(190) NOT NULL,
                        signed_by_role          ENUM("client","counselor","technician","guardian","other") NOT NULL DEFAULT "client",
                        signature_method        ENUM("drawn","typed","uploaded","waived") NOT NULL DEFAULT "typed",
                        signature_attachment_id INT UNSIGNED DEFAULT NULL,
                        typed_signature         VARCHAR(190) DEFAULT NULL,
                        waived_reason           VARCHAR(255) DEFAULT NULL,
                        witnessed_by            INT UNSIGNED DEFAULT NULL,
                        signed_at               DATETIME     NOT NULL,
                        ip                      VARCHAR(64)  DEFAULT NULL,
                        created_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        UNIQUE KEY uq_agreement_loan (loan_id),
                        CONSTRAINT fk_agreement_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
                        CONSTRAINT fk_agreement_loan FOREIGN KEY (loan_id) REFERENCES loans (id) ON DELETE CASCADE,
                        CONSTRAINT fk_agreement_sig FOREIGN KEY (signature_attachment_id) REFERENCES attachments (id) ON DELETE SET NULL,
                        CONSTRAINT fk_agreement_witness FOREIGN KEY (witnessed_by) REFERENCES users (id) ON DELETE SET NULL
                    ', $log);

                    // --- Accessories -----------------------------------------
                    // A charger is not worth its own barcode, but it is exactly
                    // what goes missing. Modelled as a checklist on the device.
                    self::createTable('device_accessories', '
                        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        device_id  INT UNSIGNED NOT NULL,
                        name       VARCHAR(120) NOT NULL,
                        required   TINYINT(1)   NOT NULL DEFAULT 1,
                        sort_order INT          NOT NULL DEFAULT 0,
                        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        UNIQUE KEY uq_accessory (device_id, name),
                        CONSTRAINT fk_accessory_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
                    ', $log);

                    // --- Kits -------------------------------------------------
                    self::createTable('kits', '
                        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        organization_id INT UNSIGNED NOT NULL,
                        name            VARCHAR(190) NOT NULL,
                        description     TEXT,
                        active          TINYINT(1)   NOT NULL DEFAULT 1,
                        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        UNIQUE KEY uq_kit_name (organization_id, name),
                        CONSTRAINT fk_kit_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
                    ', $log);

                    self::createTable('kit_items', '
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
                    ', $log);

                    // --- Reservations / waitlist ------------------------------
                    self::createTable('reservations', '
                        id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        organization_id   INT UNSIGNED NOT NULL,
                        reference         VARCHAR(24)  NOT NULL,
                        device_id         INT UNSIGNED DEFAULT NULL,
                        category          VARCHAR(96)  DEFAULT NULL,
                        client_id         INT UNSIGNED DEFAULT NULL,
                        program_id        INT UNSIGNED DEFAULT NULL,
                        request_id        INT UNSIGNED DEFAULT NULL,
                        requested_by      INT UNSIGNED NOT NULL,
                        status            ENUM("waiting","ready","fulfilled","cancelled","expired") NOT NULL DEFAULT "waiting",
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
                    ', $log);

                    // --- Repairs ----------------------------------------------
                    self::createTable('repairs', '
                        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        organization_id INT UNSIGNED NOT NULL,
                        reference       VARCHAR(24)  NOT NULL,
                        device_id       INT UNSIGNED NOT NULL,
                        loan_id         INT UNSIGNED DEFAULT NULL,
                        status          ENUM("reported","diagnosing","awaiting_parts","with_vendor","repaired","unrepairable","cancelled") NOT NULL DEFAULT "reported",
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
                    ', $log);

                    self::createTable('repair_events', '
                        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        repair_id   INT UNSIGNED NOT NULL,
                        event_type  VARCHAR(40)  NOT NULL,
                        from_status VARCHAR(40)  DEFAULT NULL,
                        to_status   VARCHAR(40)  DEFAULT NULL,
                        actor_id    INT UNSIGNED DEFAULT NULL,
                        notes       TEXT,
                        created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        KEY idx_repair_event (repair_id, created_at),
                        CONSTRAINT fk_repairevent_repair FOREIGN KEY (repair_id) REFERENCES repairs (id) ON DELETE CASCADE,
                        CONSTRAINT fk_repairevent_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
                    ', $log);

                    // --- Password resets ---------------------------------------
                    // Only a hash of the token is stored, so a database dump
                    // cannot be used to take over accounts.
                    self::createTable('password_resets', '
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
                    ', $log);

                    // --- Job runs ----------------------------------------------
                    // So an administrator can see whether the nightly reminder
                    // job is actually running, rather than discovering months
                    // later that it is not.
                    self::createTable('job_runs', '
                        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        organization_id INT UNSIGNED DEFAULT NULL,
                        job_name        VARCHAR(64)  NOT NULL,
                        status          ENUM("running","ok","failed") NOT NULL DEFAULT "running",
                        started_at      DATETIME     NOT NULL,
                        finished_at     DATETIME     DEFAULT NULL,
                        summary         VARCHAR(500) DEFAULT NULL,
                        detail          LONGTEXT,
                        triggered_by    VARCHAR(40)  DEFAULT NULL,
                        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        KEY idx_job_name (job_name, started_at)
                    ', $log);

                    // --- Remote scanner channels -------------------------------
                    // Short-polled rather than streamed: PHP holds an Apache
                    // worker for the life of a connection, so a long-lived SSE
                    // stream per scan station would exhaust the worker pool.
                    self::createTable('scan_events', '
                        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        channel_id INT UNSIGNED NOT NULL,
                        barcode    VARCHAR(64)  NOT NULL,
                        source     VARCHAR(32)  NOT NULL DEFAULT "camera",
                        scanned_by INT UNSIGNED DEFAULT NULL,
                        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        KEY idx_scan_event (channel_id, id),
                        CONSTRAINT fk_scanevent_channel FOREIGN KEY (channel_id) REFERENCES scan_channels (id) ON DELETE CASCADE
                    ', $log);

                    // --- Loan columns for kits, accessories and agreements -----
                    self::addColumn('loans', 'group_ref', 'VARCHAR(24) DEFAULT NULL', $log);
                    self::addColumn('loans', 'kit_id', 'INT UNSIGNED DEFAULT NULL', $log);
                    self::addColumn('loans', 'accessories_out', 'LONGTEXT', $log);
                    self::addColumn('loans', 'accessories_in', 'LONGTEXT', $log);
                    self::addIndex('loans', 'idx_loan_group', 'KEY idx_loan_group (group_ref)', $log);

                    self::addColumn('devices', 'active_repair_id', 'INT UNSIGNED DEFAULT NULL', $log);
                },
            ],
            [
                'version' => 3,
                'name'    => 'Polled scan channels',
                'up'      => static function (array &$log): void {
                    // The scan station polls for its phone's scans rather than
                    // holding a stream open. Recording when it last asked is
                    // what lets the phone tell the operator whether anyone is
                    // actually listening — without it, a phone scanning into a
                    // closed station looks exactly like one that is working.
                    self::addColumn('scan_channels', 'last_poll_at', 'DATETIME DEFAULT NULL', $log);
                },
            ],
            [
                'version' => 4,
                'name'    => 'Outcomes, licences, sites, hygiene, retention and two-factor',
                'up'      => static function (array &$log): void {
                    // --- Trial outcomes --------------------------------------
                    // The reason a loaner pool exists. Everything else records
                    // that a device went out and came back; this records
                    // whether it worked, which is the question the loan was
                    // asked to answer and the one a purchase decision needs.
                    self::addColumn('loans', 'outcome',
                        'ENUM("recommended","not_suitable","needs_training","trying_alternative",'
                        . '"client_declined","inconclusive") DEFAULT NULL', $log);
                    self::addColumn('loans', 'outcome_notes', 'TEXT', $log);
                    self::addColumn('loans', 'outcome_recorded_at', 'DATETIME DEFAULT NULL', $log);
                    self::addColumn('loans', 'outcome_recorded_by', 'INT UNSIGNED DEFAULT NULL', $log);
                    self::addIndex('loans', 'idx_loan_outcome',
                        'KEY idx_loan_outcome (organization_id, outcome)', $log);

                    // --- Authorisation ---------------------------------------
                    // Equipment goes out against a VR authorisation. Without
                    // the reference on the loan there is no way to tie what was
                    // lent back to the case that paid for it.
                    self::addColumn('loans', 'authorization_ref', 'VARCHAR(64) DEFAULT NULL', $log);
                    self::addColumn('loan_requests', 'authorization_ref', 'VARCHAR(64) DEFAULT NULL', $log);
                    self::addColumn('clients', 'case_number', 'VARCHAR(64) DEFAULT NULL', $log);

                    // --- Shipping --------------------------------------------
                    // "In transit" is a state the request tracker already has;
                    // these are the facts somebody rings up to ask for.
                    self::addColumn('loans', 'out_carrier', 'VARCHAR(64) DEFAULT NULL', $log);
                    self::addColumn('loans', 'out_tracking', 'VARCHAR(120) DEFAULT NULL', $log);
                    self::addColumn('loans', 'out_shipped_at', 'DATETIME DEFAULT NULL', $log);
                    self::addColumn('loans', 'return_carrier', 'VARCHAR(64) DEFAULT NULL', $log);
                    self::addColumn('loans', 'return_tracking', 'VARCHAR(120) DEFAULT NULL', $log);
                    self::addColumn('loans', 'return_shipped_at', 'DATETIME DEFAULT NULL', $log);

                    // --- Licences and consumables ----------------------------
                    // A JAWS licence is not one object with one holder: it is a
                    // number of seats. Modelled on devices rather than in a
                    // table of its own because it is lent, returned, reported
                    // on and searched for in exactly the same ways.
                    self::addColumn('devices', 'item_type',
                        'ENUM("device","licence","consumable") NOT NULL DEFAULT "device"', $log);
                    self::addColumn('devices', 'seats_total', 'INT UNSIGNED NOT NULL DEFAULT 1', $log);
                    self::addColumn('devices', 'licence_key', 'VARCHAR(255) DEFAULT NULL', $log);
                    self::addColumn('devices', 'licence_expires', 'DATE DEFAULT NULL', $log);
                    self::addIndex('devices', 'idx_device_type',
                        'KEY idx_device_type (organization_id, item_type)', $log);

                    // --- Disposal --------------------------------------------
                    // Funders ask what became of equipment they paid for, and
                    // "retired" on its own is not an answer.
                    self::addColumn('devices', 'disposed_at', 'DATETIME DEFAULT NULL', $log);
                    self::addColumn('devices', 'disposal_method',
                        'ENUM("transferred","donated","recycled","destroyed","sold","lost","returned_to_funder")'
                        . ' DEFAULT NULL', $log);
                    self::addColumn('devices', 'disposal_ref', 'VARCHAR(120) DEFAULT NULL', $log);
                    self::addColumn('devices', 'disposal_notes', 'TEXT', $log);
                    self::addColumn('devices', 'disposed_by', 'INT UNSIGNED DEFAULT NULL', $log);

                    // --- Sites -----------------------------------------------
                    // A state agency holds stock in regional offices. location
                    // was free text, which cannot answer "what is in Tulsa?".
                    self::createTable('sites', '
                        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        organization_id INT UNSIGNED NOT NULL,
                        name            VARCHAR(190) NOT NULL,
                        code            VARCHAR(32)  DEFAULT NULL,
                        address         TEXT,
                        contact_email   VARCHAR(190) DEFAULT NULL,
                        phone           VARCHAR(40)  DEFAULT NULL,
                        active          TINYINT(1)   NOT NULL DEFAULT 1,
                        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        UNIQUE KEY uq_site_code (organization_id, code),
                        CONSTRAINT fk_sites_org FOREIGN KEY (organization_id)
                          REFERENCES organizations (id) ON DELETE CASCADE
                    ', $log);

                    self::addColumn('devices', 'site_id', 'INT UNSIGNED DEFAULT NULL', $log);
                    self::addColumn('users', 'site_id', 'INT UNSIGNED DEFAULT NULL', $log);
                    self::addIndex('devices', 'idx_device_site',
                        'KEY idx_device_site (organization_id, site_id)', $log);

                    // Equipment moving between offices is its own journey, with
                    // its own tracking number and its own way of going missing.
                    self::createTable('device_transfers', '
                        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        organization_id INT UNSIGNED NOT NULL,
                        reference       VARCHAR(24)  NOT NULL,
                        device_id       INT UNSIGNED NOT NULL,
                        from_site_id    INT UNSIGNED DEFAULT NULL,
                        to_site_id      INT UNSIGNED NOT NULL,
                        status          ENUM("pending","in_transit","received","cancelled")
                                          NOT NULL DEFAULT "pending",
                        carrier         VARCHAR(64)  DEFAULT NULL,
                        tracking        VARCHAR(120) DEFAULT NULL,
                        sent_at         DATETIME     DEFAULT NULL,
                        received_at     DATETIME     DEFAULT NULL,
                        sent_by         INT UNSIGNED DEFAULT NULL,
                        received_by     INT UNSIGNED DEFAULT NULL,
                        notes           TEXT,
                        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        UNIQUE KEY uq_transfer_ref (reference),
                        KEY idx_transfer_device (device_id, status),
                        CONSTRAINT fk_transfer_org FOREIGN KEY (organization_id)
                          REFERENCES organizations (id) ON DELETE CASCADE,
                        CONSTRAINT fk_transfer_device FOREIGN KEY (device_id)
                          REFERENCES devices (id) ON DELETE CASCADE
                    ', $log);

                    // --- Hygiene ---------------------------------------------
                    // Shared equipment that touches ears, mouths and hands is
                    // cleaned between users. Recorded because "was it cleaned?"
                    // is asked after the fact, by someone who was not there.
                    self::createTable('sanitisation_events', '
                        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        organization_id INT UNSIGNED NOT NULL,
                        device_id       INT UNSIGNED NOT NULL,
                        loan_id         INT UNSIGNED DEFAULT NULL,
                        method          VARCHAR(120) DEFAULT NULL,
                        notes           TEXT,
                        cleaned_by      INT UNSIGNED DEFAULT NULL,
                        cleaned_at      DATETIME     NOT NULL,
                        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        KEY idx_sanitisation_device (device_id, cleaned_at),
                        CONSTRAINT fk_sanitise_org FOREIGN KEY (organization_id)
                          REFERENCES organizations (id) ON DELETE CASCADE,
                        CONSTRAINT fk_sanitise_device FOREIGN KEY (device_id)
                          REFERENCES devices (id) ON DELETE CASCADE
                    ', $log);

                    self::addColumn('devices', 'last_cleaned_at', 'DATETIME DEFAULT NULL', $log);
                    self::addColumn('devices', 'needs_cleaning', 'TINYINT(1) NOT NULL DEFAULT 0', $log);

                    // --- SMS and consent -------------------------------------
                    // A text reaches people an email does not. Opt-in is stored
                    // per client because consent to be texted is not implied by
                    // having given someone a mobile number.
                    self::addColumn('clients', 'mobile', 'VARCHAR(40) DEFAULT NULL', $log);
                    self::addColumn('clients', 'sms_opt_in', 'TINYINT(1) NOT NULL DEFAULT 0', $log);

                    self::createTable('sms_log', '
                        id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        organization_id INT UNSIGNED NOT NULL,
                        event_type      VARCHAR(48)  NOT NULL,
                        recipient       VARCHAR(40)  NOT NULL,
                        body            VARCHAR(500) NOT NULL,
                        loan_id         INT UNSIGNED DEFAULT NULL,
                        status          ENUM("sent","failed","skipped") NOT NULL DEFAULT "sent",
                        error_message   TEXT,
                        provider_ref    VARCHAR(120) DEFAULT NULL,
                        sent_at         DATETIME     DEFAULT NULL,
                        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        KEY idx_sms_org (organization_id, created_at),
                        CONSTRAINT fk_sms_org FOREIGN KEY (organization_id)
                          REFERENCES organizations (id) ON DELETE CASCADE
                    ', $log);

                    // --- Retention -------------------------------------------
                    // Client records are anonymised rather than deleted: loans
                    // reference them, and destroying the row would rewrite the
                    // history of who held what. The identifying fields go; the
                    // shape of the activity stays.
                    self::addColumn('clients', 'anonymised_at', 'DATETIME DEFAULT NULL', $log);

                    // --- Two-factor ------------------------------------------
                    // An administrator account reaches every client record in
                    // the agency. The secret is encrypted at rest with the same
                    // key as the Graph credentials.
                    self::addColumn('users', 'totp_secret', 'VARCHAR(255) DEFAULT NULL', $log);
                    self::addColumn('users', 'totp_enabled', 'TINYINT(1) NOT NULL DEFAULT 0', $log);
                    self::addColumn('users', 'totp_confirmed_at', 'DATETIME DEFAULT NULL', $log);

                    self::createTable('totp_recovery_codes', '
                        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
                        user_id    INT UNSIGNED NOT NULL,
                        code_hash  CHAR(64)     NOT NULL,
                        used_at    DATETIME     DEFAULT NULL,
                        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        KEY idx_recovery_user (user_id, used_at),
                        CONSTRAINT fk_recovery_user FOREIGN KEY (user_id)
                          REFERENCES users (id) ON DELETE CASCADE
                    ', $log);

                    // A half-finished sign-in: password accepted, code not yet
                    // given. Kept server-side so the browser cannot skip it.
                    self::createTable('pending_logins', '
                        id         CHAR(64)     NOT NULL,
                        user_id    INT UNSIGNED NOT NULL,
                        ip         VARCHAR(64)  DEFAULT NULL,
                        user_agent VARCHAR(255) DEFAULT NULL,
                        attempts   INT UNSIGNED NOT NULL DEFAULT 0,
                        expires_at DATETIME     NOT NULL,
                        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (id),
                        KEY idx_pending_user (user_id),
                        CONSTRAINT fk_pending_user FOREIGN KEY (user_id)
                          REFERENCES users (id) ON DELETE CASCADE
                    ', $log);
                },
            ],
            [
                'version' => 5,
                'name'    => 'Separate pending two-factor secret',
                'up'      => static function (array &$log): void {
                    // An enrolment in progress is kept apart from the secret
                    // that is actually in use. Writing the new one straight
                    // over the live one meant starting a set-up and walking
                    // away silently removed a working second factor.
                    self::addColumn('users', 'totp_pending_secret',
                        'VARCHAR(255) DEFAULT NULL', $log);
                },
            ],
            [
                'version' => 6,
                'name'    => 'Remember the last two-factor step used',
                'up'      => static function (array &$log): void {
                    // A TOTP code is valid for a window of about ninety
                    // seconds, and until this column existed it could be used
                    // any number of times inside that window. Someone who had
                    // the password and glimpsed one code could sign in after
                    // the owner had. The last accepted time step is kept so a
                    // code works once (RFC 6238 §5.2).
                    self::addColumn('users', 'totp_last_counter',
                        'BIGINT UNSIGNED DEFAULT NULL', $log);
                },
            ],
        ];
    }

    // -----------------------------------------------------------------------
    // Runner
    // -----------------------------------------------------------------------

    /** The version recorded in the database, or 0 if the marker is missing. */
    public static function currentVersion(): int
    {
        if (!self::tableExists('schema_meta')) {
            return 0;
        }

        return (int) (Db::value('SELECT schema_version FROM schema_meta WHERE id = 1') ?? 0);
    }

    /** Apply any migration newer than the recorded version. */
    public static function run(): array
    {
        $from    = self::currentVersion();
        $pending = array_filter(self::all(), static fn (array $m): bool => $m['version'] > $from);

        if ($pending === []) {
            return ['from' => $from, 'to' => $from, 'applied' => [], 'log' => []];
        }

        $log     = [];
        $applied = [];

        foreach ($pending as $migration) {
            $stepLog = [];

            try {
                ($migration['up'])($stepLog);
            } catch (\Throwable $e) {
                throw new \RuntimeException(sprintf(
                    'Database upgrade to version %d failed: %s. The application keeps running on the '
                    . 'previous schema; fix the cause and reload.',
                    $migration['version'],
                    $e->getMessage(),
                ), 0, $e);
            }

            Db::execute(
                'INSERT INTO schema_meta (id, schema_version, app_version)
                 VALUES (1, ?, ?)
                 ON DUPLICATE KEY UPDATE schema_version = VALUES(schema_version), app_version = VALUES(app_version)',
                [$migration['version'], APP_VERSION],
            );

            $applied[] = $migration['version'];
            $log       = array_merge($log, $stepLog);
        }

        return ['from' => $from, 'to' => self::currentVersion(), 'applied' => $applied, 'log' => $log];
    }
}
