<?php
/**
 * Database backup.
 *
 * Written in PHP rather than shelling out to mysqldump, because the hosting
 * this targets frequently has neither the binary nor exec(). A backup that
 * only works on a well-equipped server is not a backup for the people who
 * need one most.
 *
 * The output is plain SQL that restores with `mysql < file` or through
 * phpMyAdmin, so recovering does not need this application to be working —
 * which is the one circumstance a backup is for.
 *
 * This file is the whole database: every client, every loan, and the password
 * hashes of every account. It is gated like the updater and never written to
 * disk inside the web root.
 *
 * With one deliberate omission. A handful of tables hold live credentials and
 * transient state — session ids, half-finished sign-ins, reset tokens, phone
 * pairing codes — and their rows are left out. A backup is the file most
 * likely to be emailed, left on a laptop or restored somewhere less careful,
 * and a session id in it is a signed-in browser for up to fourteen days. The
 * tables themselves are still created, so a restore produces a complete,
 * working schema in which everyone simply has to sign in again — which is
 * what should happen after a restore anyway.
 */

declare(strict_types=1);

namespace Loaner;

final class Backup
{
    /** Rows read at a time. Bounded so a large table cannot exhaust memory. */
    private const CHUNK = 500;

    /**
     * Tables whose structure is dumped but whose rows are not.
     *
     * Each is either a live credential or state that is meaningless an hour
     * later. None is needed to restore the organisation's records.
     */
    private const STRUCTURE_ONLY = [
        'sessions'        => 'session ids are live sign-ins for up to fourteen days',
        'pending_logins'  => 'half-finished two-factor sign-ins, valid for ten minutes',
        'password_resets' => 'reset tokens, valid for an hour',
        'scan_channels'   => 'phone pairing codes, valid for a few hours',
        'scan_events'     => 'barcodes a phone sent to a desk, kept for twelve hours',
        'sso_states'      => 'Microsoft sign-ins in progress, valid for ten minutes',
    ];

    /**
     * Stream a backup to the browser.
     *
     * Streamed rather than built in memory: a pool with thousands of loans and
     * an audit trail going back years will not fit comfortably in a shared
     * host's memory limit, and the failure mode would be a blank page at the
     * moment somebody needed a backup.
     */
    public static function stream(array $auth, ?string $password): never
    {
        self::assertAllowed($auth, $password);

        $organizationId = (int) $auth['organizationId'];
        $organization   = Settings::organization($organizationId);

        $filename = sprintf(
            'loanerpool-%s-%s.sql',
            preg_replace('/[^a-z0-9]+/i', '-', strtolower($organization['slug'] ?? 'backup')),
            date('Y-m-d-His'),
        );

        // No Content-Length: the body is generated as it goes, and guessing
        // would truncate it.
        header('Content-Type: application/sql; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');

        // Shared hosts often buffer; flushing per table keeps the download
        // moving and stops a long backup looking like a hung request.
        while (ob_get_level() > 0) {
            ob_end_flush();
        }

        @set_time_limit(900);

        self::write(self::header($organization));

        foreach (self::tables() as $table) {
            self::dumpTable($table);
        }

        self::write("\nSET FOREIGN_KEY_CHECKS = 1;\n");
        // This line is the only way to tell a complete backup from one that
        // died half way: there is no Content-Length to check against, so a
        // truncated dump looks like a perfectly good file.
        self::write("-- Backup complete. If this line is missing, the file is truncated.\n");

        // Audited only once the whole file has gone out. Recording it up
        // front meant a dump that timed out mid-table still left an entry
        // saying a backup had been taken — read later by whoever is
        // deciding whether a restore is possible.
        Audit::record($auth, [
            'action'     => Audit::BACKUP_DOWNLOADED,
            'entityType' => 'backup',
            'summary'    => ($auth['fullName'] ?? 'An administrator')
                          . ' downloaded a database backup',
        ]);

        exit;
    }

    /**
     * Who may take one.
     *
     * The same gates as installing an update, and for the same reason: this
     * hands over every client record and every password hash in one file.
     */
    private static function assertAllowed(array $auth, ?string $password): void
    {
        if (($auth['actorType'] ?? '') !== 'user') {
            throw Util::forbidden(
                'Downloading a backup needs a signed-in administrator. An API key cannot do it: the '
                . 'file contains every client record and every password hash in this installation.',
            );
        }

        if (($auth['role'] ?? '') !== 'admin') {
            throw Util::forbidden('Only an administrator can download a backup.');
        }

        if (!is_string($password) || $password === '') {
            throw Util::badRequest(
                'Enter your password to confirm. A backup is a copy of everything, so it asks again '
                . 'rather than trusting the open session.',
                ['field' => 'password'],
            );
        }

        $user = Db::one(
            'SELECT password_hash FROM users WHERE id = ? AND organization_id = ?',
            [$auth['userId'], $auth['organizationId']],
        );

        if ($user === null || !Auth::verifyPassword($password, $user['password_hash'])) {
            Audit::record($auth, [
                'action'     => Audit::LOGIN_FAILED,
                'entityType' => 'backup',
                'summary'    => 'Failed password confirmation on a database backup',
            ]);

            throw Util::badRequest('That password is not correct.', ['field' => 'password']);
        }
    }

    private static function header(?array $organization): string
    {
        $version = Db::value('SELECT VERSION()');

        return "-- Loaner Pool database backup\n"
            . '-- Organisation: ' . ($organization['name'] ?? 'unknown') . "\n"
            . '-- Taken:        ' . date('c') . "\n"
            . '-- Application:  ' . APP_VERSION . ' (schema ' . Migrations::currentVersion() . ")\n"
            . '-- Server:       ' . $version . "\n"
            . "--\n"
            . "-- Check the last line reads 'Backup complete' before relying on this\n"
            . "-- file. A dump cut short by a timeout otherwise looks identical.\n"
            . "--\n"
            . "-- Restore with:\n"
            . "--   mysql -u USER -p DATABASE < this-file.sql\n"
            . "-- or by importing it in phpMyAdmin. Restore into an EMPTY database:\n"
            . "-- each table is dropped and recreated below.\n"
            . "--\n"
            . "-- This file contains personal data about clients and the password\n"
            . "-- hashes of every account. Store it accordingly.\n"
            . "--\n"
            . "-- Sessions, pending sign-ins, reset tokens and phone pairing codes are\n"
            . "-- created empty: after a restore everyone signs in again.\n\n"
            . "SET FOREIGN_KEY_CHECKS = 0;\n"
            . "SET NAMES utf8mb4;\n"
            . "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n\n";
    }

    /** @return array<int, string> */
    private static function tables(): array
    {
        $rows   = Db::all('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"');
        $tables = [];

        foreach ($rows as $row) {
            // The column is named after the database, so take the first value
            // rather than guessing its key.
            $tables[] = (string) array_values($row)[0];
        }

        sort($tables);

        return $tables;
    }

    private static function dumpTable(string $table): void
    {
        $quoted = '`' . str_replace('`', '``', $table) . '`';

        $create = Db::one("SHOW CREATE TABLE {$quoted}");
        $ddl    = $create['Create Table'] ?? ($create['Create View'] ?? null);

        if ($ddl === null) {
            return;
        }

        self::write("\n--\n-- Table: {$table}\n--\n\n");
        self::write("DROP TABLE IF EXISTS {$quoted};\n");
        self::write($ddl . ";\n\n");

        if (isset(self::STRUCTURE_ONLY[$table])) {
            self::write('-- (rows deliberately not included: ' . self::STRUCTURE_ONLY[$table] . ")\n");
            return;
        }

        $count = (int) Db::value("SELECT COUNT(*) FROM {$quoted}");

        if ($count === 0) {
            self::write("-- (no rows)\n");
            return;
        }

        self::write("-- {$count} row(s)\n");

        for ($offset = 0; $offset < $count; $offset += self::CHUNK) {
            $rows = Db::all("SELECT * FROM {$quoted} LIMIT " . self::CHUNK . " OFFSET {$offset}");

            if ($rows === []) {
                break;
            }

            $columns = '`' . implode('`, `', array_keys($rows[0])) . '`';
            $values  = [];

            foreach ($rows as $row) {
                $cells = [];

                foreach ($row as $value) {
                    $cells[] = self::quote($value);
                }

                $values[] = '(' . implode(', ', $cells) . ')';
            }

            self::write("INSERT INTO {$quoted} ({$columns}) VALUES\n"
                . implode(",\n", $values) . ";\n");
        }
    }

    /**
     * Quote a value for SQL.
     *
     * Uses the driver's own quoting rather than hand-rolled escaping: a
     * backup that corrupts on an apostrophe in a client's name is worse than
     * no backup, because it fails at restore time when it is too late.
     */
    private static function quote(mixed $value): string
    {
        if ($value === null) {
            return 'NULL';
        }

        if (is_int($value) || is_float($value)) {
            return (string) $value;
        }

        if (is_bool($value)) {
            return $value ? '1' : '0';
        }

        $string = (string) $value;

        // Binary-ish content is written as a hex literal so no byte can end
        // the string early or break the file's encoding.
        if ($string !== '' && !mb_check_encoding($string, 'UTF-8')) {
            return '0x' . bin2hex($string);
        }

        return Db::connection()->quote($string);
    }

    private static function write(string $chunk): void
    {
        echo $chunk;
        flush();
    }

    /**
     * What a backup would contain, without producing one.
     *
     * Shown before the button is pressed, so somebody on a slow connection
     * knows whether they are about to download two megabytes or two hundred.
     */
    public static function summary(int $organizationId): array
    {
        $rows  = [];
        $bytes = 0;

        foreach (Db::all(
            'SELECT TABLE_NAME AS name, TABLE_ROWS AS row_estimate,
                    (DATA_LENGTH + INDEX_LENGTH) AS bytes
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = "BASE TABLE"
              ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC',
        ) as $table) {
            $bytes += (int) $table['bytes'];

            $rows[] = [
                'name'         => $table['name'],
                'row_estimate' => (int) $table['row_estimate'],
                'bytes'        => (int) $table['bytes'],
            ];
        }

        $last = Db::one(
            'SELECT created_at, actor_label FROM audit_log
              WHERE organization_id = ? AND action = ?
              ORDER BY id DESC LIMIT 1',
            [$organizationId, Audit::BACKUP_DOWNLOADED],
        );

        $daysSince = $last === null
            ? null
            : max(0, (int) floor((time() - strtotime((string) $last['created_at'])) / 86400));

        return [
            'tables'          => $rows,
            'table_count'     => count($rows),
            'approximate_bytes' => $bytes,
            'approximate_size'  => Attachments::humanSize($bytes),
            'last_backup'     => $last === null ? null : [
                'at'         => $last['created_at'],
                'by'         => $last['actor_label'],
                'days_ago'   => $daysSince,
            ],
            // The honest nag. Nobody sets up a backup schedule until something
            // has gone wrong once.
            'notice' => match (true) {
                $last === null => 'No backup has ever been downloaded from this installation. '
                                . 'The files are backed up before an update; your data is not.',
                $daysSince > 30 => "The last backup was {$daysSince} days ago.",
                default         => null,
            },
            'warning' => 'A backup contains every client record and the password hash of every '
                       . 'account. Keep it somewhere you would keep the same information on paper.',
        ];
    }
}
