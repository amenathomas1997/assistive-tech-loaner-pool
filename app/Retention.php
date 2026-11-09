<?php
/**
 * Data retention.
 *
 * Client records here carry disability-adjacent personal information. Keeping
 * them forever is a liability, not an asset: the longer they sit, the more
 * there is to lose and the less anyone remembers why it was kept.
 *
 * Clients are anonymised rather than deleted. Loans reference them, and
 * destroying the row would rewrite the record of who held what — including
 * loans that are still open. The identifying fields go; the shape of the
 * activity stays, so utilisation and funding reporting still work.
 *
 * Off by default, and it says what it would do before it does it. Software
 * should not quietly start destroying records because nobody changed a
 * setting.
 */

declare(strict_types=1);

namespace Loaner;

final class Retention
{
    /** What the policy currently is, in plain terms. */
    public static function policy(int $organizationId): array
    {
        $settings = Settings::all($organizationId);

        return [
            'enabled'          => (bool) $settings['retention.enabled'],
            'client_years'     => (int) $settings['retention.client_years'],
            'audit_years'      => (int) $settings['retention.audit_years'],
            'email_log_days'   => (int) $settings['retention.email_log_days'],
            'describes' => [
                'Clients with no activity for ' . (int) $settings['retention.client_years']
                . ' years are anonymised: name, contact details and notes are removed. Their loans '
                . 'stay, so reporting is unaffected.',
                (int) $settings['retention.audit_years'] < 1
                    ? 'Audit entries are kept, because no limit is set.'
                    : 'Audit entries older than ' . (int) $settings['retention.audit_years']
                      . ' years are deleted.',
                (int) $settings['retention.email_log_days'] < 1
                    ? 'Email and text records are kept, because no limit is set.'
                    : 'Email and text records older than ' . (int) $settings['retention.email_log_days']
                      . ' days are deleted.',
            ],
            'never_touched' => [
                'A client with an open loan, an open request or a live waitlist entry is never '
                . 'anonymised, however old the record.',
                'Loans, devices and their history are never deleted.',
                'Signed agreements are never deleted.',
            ],
        ];
    }

    /**
     * What a purge would do right now, changing nothing.
     *
     * The dry run is the point. An administrator should be able to look at the
     * number before switching this on, and be unsurprised by it.
     */
    public static function preview(int $organizationId): array
    {
        $settings = Settings::all($organizationId);

        $clients = self::clientsDue($organizationId, (int) $settings['retention.client_years']);

        $auditCount = self::older('SELECT COUNT(*)', 'audit_log', $organizationId, (int) $settings['retention.audit_years'], 'YEAR');

        $emailCount = self::older('SELECT COUNT(*)', 'email_log', $organizationId, (int) $settings['retention.email_log_days'], 'DAY');

        $smsCount = self::older('SELECT COUNT(*)', 'sms_log', $organizationId, (int) $settings['retention.email_log_days'], 'DAY');

        return [
            'policy'  => self::policy($organizationId),
            'clients' => [
                'count'   => count($clients),
                'sample'  => array_slice(array_map(static fn (array $c): array => [
                    'id'            => (int) $c['id'],
                    'name'          => $c['first_name'] . ' ' . $c['last_name'],
                    'last_activity' => $c['last_activity'],
                ], $clients), 0, 20),
            ],
            'audit_entries' => $auditCount,
            'email_records' => $emailCount,
            'sms_records'   => $smsCount,
            'notice' => count($clients) === 0 && $auditCount === 0 && $emailCount === 0 && $smsCount === 0
                ? 'Nothing is old enough to be removed under the current policy.'
                : sprintf(
                    'A purge would anonymise %d client record%s and delete %d audit entr%s, '
                    . '%d email record%s and %d text record%s. Nothing has been changed.',
                    count($clients), count($clients) === 1 ? '' : 's',
                    $auditCount, $auditCount === 1 ? 'y' : 'ies',
                    $emailCount, $emailCount === 1 ? '' : 's',
                    $smsCount, $smsCount === 1 ? '' : 's',
                ),
        ];
    }

    /**
     * Clients eligible for anonymisation.
     *
     * "No activity" means no loan, no request and no waitlist entry within the
     * window, measured from whichever is latest. A client with an open loan,
     * an open request or a live waitlist entry is excluded whatever the dates
     * say — they are holding equipment, or about to.
     *
     * The waitlist was not counted at first. A client who joined it yesterday
     * after years away was eligible, and the "your device is ready" notice
     * would have gone to an address that had just been blanked.
     */
    private static function clientsDue(int $organizationId, int $years): array
    {
        if ($years < 1) {
            return [];
        }

        return Db::all(
            'SELECT c.id, c.first_name, c.last_name,
                    GREATEST(
                        COALESCE((SELECT MAX(l.checked_out_at) FROM loans l WHERE l.client_id = c.id), 0),
                        COALESCE((SELECT MAX(r.created_at) FROM loan_requests r WHERE r.client_id = c.id), 0),
                        COALESCE((SELECT MAX(w.created_at) FROM reservations w WHERE w.client_id = c.id), 0),
                        c.created_at
                    ) AS last_activity
               FROM clients c
              WHERE c.organization_id = ?
                AND c.anonymised_at IS NULL
                AND NOT EXISTS (
                      SELECT 1 FROM loans l
                       WHERE l.client_id = c.id AND l.status = "active"
                    )
                AND NOT EXISTS (
                      SELECT 1 FROM loan_requests r
                       WHERE r.client_id = c.id AND r.status IN ("submitted", "approved")
                    )
                AND NOT EXISTS (
                      SELECT 1 FROM reservations w
                       WHERE w.client_id = c.id AND w.status IN ("waiting", "ready")
                    )
             HAVING last_activity < DATE_SUB(NOW(), INTERVAL ? YEAR)
              ORDER BY last_activity',
            [$organizationId, $years],
        );
    }

    /**
     * Count or delete the rows of a log that are past their limit.
     *
     * A limit below one means "keep them", as it always has for clients. It
     * used to mean the opposite here: INTERVAL 0 YEAR is "older than right
     * now", which is every row, and the settings form saves a cleared box as
     * zero. So emptying the audit box and saving had the next scheduled run
     * delete the entire audit log.
     *
     * @param string $verb  'SELECT COUNT(*)' or 'DELETE'; a constant from this class
     * @param string $table a constant from this class
     * @param string $unit  'YEAR' or 'DAY'; a constant from this class
     */
    private static function older(string $verb, string $table, int $organizationId, int $limit, string $unit): int
    {
        if ($limit < 1) {
            return 0;
        }

        $sql = "{$verb} FROM {$table}
                 WHERE organization_id = ? AND created_at < DATE_SUB(NOW(), INTERVAL ? {$unit})";

        return $verb === 'DELETE'
            ? Db::execute($sql, [$organizationId, $limit])
            : (int) Db::value($sql, [$organizationId, $limit]);
    }

    /**
     * Apply the policy.
     *
     * Called by the scheduled job, and by an administrator pressing the button.
     * Does nothing at all unless retention is switched on.
     */
    public static function purge(?array $actor, int $organizationId): array
    {
        $settings = Settings::all($organizationId);

        if (!$settings['retention.enabled']) {
            return [
                'ran'     => false,
                'summary' => 'Retention is switched off, so nothing was removed.',
            ];
        }

        $clients = self::clientsDue($organizationId, (int) $settings['retention.client_years']);

        $anonymised = 0;

        foreach ($clients as $client) {
            Db::execute(
                'UPDATE clients
                    SET first_name = "Removed", last_name = "record",
                        email = NULL, phone = NULL, mobile = NULL, notes = NULL,
                        external_ref = NULL, case_number = NULL,
                        sms_opt_in = 0, active = 0,
                        anonymised_at = NOW(), updated_at = NOW()
                  WHERE id = ? AND organization_id = ?',
                [$client['id'], $organizationId],
            );
            $anonymised++;
        }

        $auditDeleted = self::older('DELETE', 'audit_log', $organizationId, (int) $settings['retention.audit_years'], 'YEAR');

        $emailDeleted = self::older('DELETE', 'email_log', $organizationId, (int) $settings['retention.email_log_days'], 'DAY');

        $smsDeleted = self::older('DELETE', 'sms_log', $organizationId, (int) $settings['retention.email_log_days'], 'DAY');

        $summary = sprintf(
            '%d client record(s) anonymised; %d audit, %d email and %d text record(s) deleted.',
            $anonymised, $auditDeleted, $emailDeleted, $smsDeleted,
        );

        // Recorded even though it deletes audit entries: this entry is new, so
        // it survives its own purge, and "who destroyed those records and when"
        // has to be answerable.
        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::RETENTION_PURGE,
            'entityType'     => 'retention',
            'summary'        => 'Retention policy applied: ' . $summary,
            'detail'         => [
                'clients_anonymised' => $anonymised,
                'audit_deleted'      => $auditDeleted,
                'email_deleted'      => $emailDeleted,
                'sms_deleted'        => $smsDeleted,
            ],
        ]);

        return [
            'ran'                => true,
            'clients_anonymised' => $anonymised,
            'audit_deleted'      => $auditDeleted,
            'email_deleted'      => $emailDeleted,
            'sms_deleted'        => $smsDeleted,
            'summary'            => $summary,
        ];
    }
}
