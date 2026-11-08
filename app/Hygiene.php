<?php
/**
 * Cleaning records for shared equipment.
 *
 * Assistive technology goes against ears, mouths, eyes and hands, and then
 * goes to the next person. Agencies that lend it are asked, sometimes long
 * afterwards and sometimes by a lawyer, whether a particular device was
 * cleaned between two particular people. "We always do" is not an answer;
 * a row with a date, a person and a method is.
 *
 * Off by default. Not every pool lends equipment where this matters, and
 * switching on a workflow nobody needs is how a system gets abandoned.
 */

declare(strict_types=1);

namespace Loaner;

final class Hygiene
{
    /**
     * Record that a device was cleaned.
     *
     * Clears the flag set at check-in, which is what lets the device go out
     * again when an organisation requires cleaning between users.
     */
    public static function record(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $deviceId       = (int) $input['deviceId'];

        $device = Db::one(
            'SELECT id, name, barcode FROM devices WHERE id = ? AND organization_id = ?',
            [$deviceId, $organizationId],
        );

        if ($device === null) {
            throw Util::notFound('That device does not exist.');
        }

        $method = Util::str($input['method'] ?? null, 120)
            ?: (Util::str(Settings::get($organizationId, 'hygiene.default_method'), 120) ?: null);

        $cleanedAt = Util::mysqlDateTime($input['cleanedAt'] ?? 'now') ?? Util::mysqlDateTime('now');

        Db::transaction(static function () use (
            $organizationId, $deviceId, $input, $method, $cleanedAt
        ): void {
            Db::insert(
                'INSERT INTO sanitisation_events
                   (organization_id, device_id, loan_id, method, notes, cleaned_by, cleaned_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)',
                [
                    $organizationId, $deviceId,
                    $input['loanId'] ?? null, $method,
                    Util::str($input['notes'] ?? null),
                    $input['actorId'] ?? null, $cleanedAt,
                ],
            );

            Db::execute(
                'UPDATE devices SET last_cleaned_at = ?, needs_cleaning = 0, updated_at = NOW()
                  WHERE id = ?',
                [$cleanedAt, $deviceId],
            );
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::DEVICE_SANITISED,
            'entityType'     => 'device',
            'entityId'       => $deviceId,
            'entityLabel'    => $device['name'],
            'summary'        => sprintf(
                '%s (%s) cleaned%s',
                $device['name'], $device['barcode'],
                $method !== null ? " — {$method}" : '',
            ),
        ]);

        return [
            'device'  => Devices::get($organizationId, $deviceId),
            'history' => self::forDevice($organizationId, $deviceId),
        ];
    }

    /** @return array<int, array<string, mixed>> */
    public static function forDevice(int $organizationId, int $deviceId, int $limit = 25): array
    {
        return Db::all(
            'SELECT s.*, u.full_name AS cleaned_by_name, l.reference AS loan_reference
               FROM sanitisation_events s
               LEFT JOIN users u ON u.id = s.cleaned_by
               LEFT JOIN loans l ON l.id = s.loan_id
              WHERE s.device_id = ? AND s.organization_id = ?
              ORDER BY s.cleaned_at DESC
              LIMIT ' . max(1, min(200, $limit)),
            [$deviceId, $organizationId],
        );
    }

    /**
     * Everything waiting to be cleaned.
     *
     * The working list for whoever does it, and the thing that is blocking
     * check-out if the organisation requires cleaning between users.
     */
    public static function queue(int $organizationId): array
    {
        $rows = Db::all(
            'SELECT d.id, d.name, d.barcode, d.category, d.status, d.location,
                    d.needs_cleaning, d.last_cleaned_at,
                    (SELECT MAX(l.returned_at) FROM loans l WHERE l.device_id = d.id) AS last_returned_at
               FROM devices d
              WHERE d.organization_id = ? AND d.needs_cleaning = 1 AND d.status <> "retired"
              ORDER BY last_returned_at DESC',
            [$organizationId],
        );

        $required = (bool) Settings::get($organizationId, 'hygiene.require_between_loans');

        return [
            'rows'     => $rows,
            'total'    => count($rows),
            'blocking' => $required,
            'notice'   => $rows === []
                ? 'Nothing is waiting to be cleaned.'
                : sprintf(
                    '%d device%s waiting to be cleaned.%s',
                    count($rows), count($rows) === 1 ? '' : 's',
                    $required
                        ? ' They cannot be lent out until the cleaning is recorded.'
                        : ' They can still be lent out; this pool does not require cleaning first.',
                ),
        ];
    }

    /**
     * Cleaning activity over a period, for an infection-control report.
     *
     * Reports the gap it cannot close as well: devices lent with no cleaning
     * recorded between returns. An organisation asking this question needs to
     * know where the record is thin, not just where it is good.
     */
    public static function report(int $organizationId, ?string $from = null, ?string $to = null): array
    {
        $fromSql = Util::mysqlDateTime($from ?: '-90 days');
        $toSql   = Util::mysqlDateTime($to ?: 'now');

        $totals = Db::one(
            'SELECT COUNT(*) AS cleanings, COUNT(DISTINCT device_id) AS devices_cleaned
               FROM sanitisation_events
              WHERE organization_id = ? AND cleaned_at >= ? AND cleaned_at <= ?',
            [$organizationId, $fromSql, $toSql],
        );

        $returns = (int) Db::value(
            'SELECT COUNT(*) FROM loans
              WHERE organization_id = ? AND returned_at >= ? AND returned_at <= ?',
            [$organizationId, $fromSql, $toSql],
        );

        $byDevice = Db::all(
            'SELECT d.id, d.name, d.barcode, d.category, d.needs_cleaning, d.last_cleaned_at,
                    COUNT(s.id) AS cleanings
               FROM devices d
               LEFT JOIN sanitisation_events s
                      ON s.device_id = d.id AND s.cleaned_at >= ? AND s.cleaned_at <= ?
              WHERE d.organization_id = ? AND d.status <> "retired"
              GROUP BY d.id, d.name, d.barcode, d.category, d.needs_cleaning, d.last_cleaned_at
              ORDER BY cleanings DESC, d.name
              LIMIT 200',
            [$fromSql, $toSql, $organizationId],
        );

        $cleanings = (int) $totals['cleanings'];

        return [
            'range'  => ['from' => $fromSql, 'to' => $toSql],
            'totals' => [
                'cleanings'       => $cleanings,
                'devices_cleaned' => (int) $totals['devices_cleaned'],
                'returns'         => $returns,
                // Not a compliance score. Equipment is cleaned at other times
                // too, and one return can involve several cleanings, so this is
                // a ratio to look at rather than a percentage to report.
                'cleanings_per_return' => $returns === 0 ? null : round($cleanings / $returns, 2),
            ],
            'by_device' => $byDevice,
            'enabled'   => (bool) Settings::get($organizationId, 'hygiene.enabled'),
            'required'  => (bool) Settings::get($organizationId, 'hygiene.require_between_loans'),
            'caveat'    => 'Counts recorded cleanings against returns in the same period. It is a '
                         . 'measure of what was written down, not of what was done.',
        ];
    }
}
