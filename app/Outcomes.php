<?php
/**
 * Trial outcomes.
 *
 * The reason an assistive technology loaner pool exists. Every other part of
 * this application records that a device went out and came back; this records
 * whether it actually worked for the person who borrowed it.
 *
 * That distinction matters more than it looks. A loan with no outcome is an
 * asset movement. A loan with an outcome is evidence: it tells a counselor
 * whether to authorise a purchase, tells a purchasing officer which models are
 * worth stocking, and tells an agency how much equipment it did not buy
 * because the trial said no. Device abandonment is the problem a loaner pool
 * exists to prevent, and it can only be measured if somebody writes down what
 * happened.
 *
 * Deliberately not mandatory. An outcome recorded under protest, by someone
 * who does not know, is worse than a blank — it would poison exactly the
 * reports this exists to produce.
 */

declare(strict_types=1);

namespace Loaner;

final class Outcomes
{
    public const VALUES = [
        'recommended', 'not_suitable', 'needs_training',
        'trying_alternative', 'client_declined', 'inconclusive',
    ];

    /**
     * Written as the technician would say them, because the technician is who
     * picks from this list, at a desk, with the client still in the room.
     */
    public const LABELS = [
        'recommended'        => 'Worked — recommend purchasing it',
        'not_suitable'       => 'Not suitable for this client',
        'needs_training'     => 'Right device, needs training first',
        'trying_alternative' => 'Moving on to a different device',
        'client_declined'    => 'Client decided against it',
        'inconclusive'       => 'Not enough use to say',
    ];

    /** What each outcome means for the equipment budget. */
    public const HELP = [
        'recommended'        => 'The trial succeeded. This is the evidence for an authorisation.',
        'not_suitable'       => 'The trial did its job: a purchase that would have been wasted was avoided.',
        'needs_training'     => 'A training need, not an equipment problem — the device itself is right.',
        'trying_alternative' => 'Inconclusive for this device; the search continues.',
        'client_declined'    => 'The client did not want to go ahead, for their own reasons.',
        'inconclusive'       => 'Returned too soon, or barely used. No conclusion either way.',
    ];

    /** Outcomes that mean the trial reached a real answer. */
    private const CONCLUSIVE = ['recommended', 'not_suitable', 'needs_training', 'client_declined'];

    /**
     * Record what came of a loan.
     *
     * Can be set after check-in as well as during it: the answer is often not
     * known on the day the equipment comes back, and forcing a guess at the
     * counter would be the quickest way to make this data worthless.
     */
    public static function record(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $loanId         = (int) $input['loanId'];
        $outcome        = is_array($input['outcome'] ?? null) ? 'not-a-value' : ($input['outcome'] ?? null);

        $loan = Loans::getVisible($input['auth'] ?? null, $organizationId, $loanId);

        if ($outcome === null || $outcome === '') {
            // Clearing is allowed: an outcome entered in error should be
            // removable rather than corrected by inventing a different wrong one.
            Db::execute(
                'UPDATE loans SET outcome = NULL, outcome_notes = NULL,
                        outcome_recorded_at = NULL, outcome_recorded_by = NULL, updated_at = NOW()
                  WHERE id = ? AND organization_id = ?',
                [$loanId, $organizationId],
            );

            Audit::record($actor, [
                'organizationId' => $organizationId,
                'action'         => Audit::LOAN_OUTCOME_RECORDED,
                'entityType'     => 'loan',
                'entityId'       => $loanId,
                'entityLabel'    => $loan['reference'],
                'summary'        => "Trial outcome cleared on {$loan['reference']}",
            ]);

            return Loans::get($organizationId, $loanId);
        }

        if (!in_array($outcome, self::VALUES, true)) {
            throw Util::badRequest(
                "\"{$outcome}\" is not a trial outcome.",
                ['field' => 'outcome', 'allowed' => self::VALUES],
            );
        }

        $notes = Util::str($input['notes'] ?? null);

        // "Not suitable" with no explanation is the least useful row in the
        // table: the next person to consider this device learns nothing.
        if (in_array($outcome, ['not_suitable', 'trying_alternative'], true)
            && ($notes === null || mb_strlen($notes) < 3)
        ) {
            throw Util::badRequest(
                'Say briefly why. Without it, the next person considering this device for a client '
                . 'learns nothing from this trial.',
                ['field' => 'notes'],
            );
        }

        Db::execute(
            'UPDATE loans
                SET outcome = ?, outcome_notes = ?, outcome_recorded_at = NOW(),
                    outcome_recorded_by = ?, updated_at = NOW()
              WHERE id = ? AND organization_id = ?',
            [$outcome, $notes, $input['actorId'] ?? null, $loanId, $organizationId],
        );

        Db::execute(
            'INSERT INTO loan_events (loan_id, event_type, actor_id, notes)
             VALUES (?, "note", ?, ?)',
            [
                $loanId, $input['actorId'] ?? null,
                'Trial outcome: ' . self::LABELS[$outcome] . ($notes !== null ? " — {$notes}" : ''),
            ],
        );

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::LOAN_OUTCOME_RECORDED,
            'entityType'     => 'loan',
            'entityId'       => $loanId,
            'entityLabel'    => $loan['reference'],
            'summary'        => sprintf(
                '%s on %s (%s): %s',
                self::LABELS[$outcome], $loan['reference'], $loan['device_name'],
                $notes ?? 'no note',
            ),
            'detail'         => ['outcome' => $outcome],
        ]);

        return Loans::get($organizationId, $loanId);
    }

    /** The picker's contents, for the check-in screen and the loan record. */
    public static function meta(): array
    {
        return [
            'outcomes' => array_map(static fn (string $value): array => [
                'value'        => $value,
                'label'        => self::LABELS[$value],
                'help'         => self::HELP[$value],
                'needs_notes'  => in_array($value, ['not_suitable', 'trying_alternative'], true),
                'conclusive'   => in_array($value, self::CONCLUSIVE, true),
            ], self::VALUES),
            'notice' => 'Leave it blank if you do not know yet. An outcome guessed at the counter is '
                      . 'worse than no outcome — it is the same data the purchasing reports are built on.',
        ];
    }

    /**
     * Returned loans with no outcome recorded.
     *
     * The working list for whoever chases them, and the honest denominator for
     * every percentage below.
     */
    public static function outstanding(int $organizationId, array $options = []): array
    {
        $limit  = (int) ($options['limit'] ?? 50);
        $offset = (int) ($options['offset'] ?? 0);

        $where  = 'l.organization_id = ? AND l.status = "returned" AND l.outcome IS NULL';
        $params = [$organizationId];

        if (!empty($options['counselorId'])) {
            $where .= ' AND (EXISTS (SELECT 1 FROM clients oc WHERE oc.id = l.client_id AND oc.counselor_id = ?)
                         OR EXISTS (SELECT 1 FROM loan_requests orq WHERE orq.id = l.request_id AND orq.requested_by = ?))';
            $params[] = (int) $options['counselorId'];
            $params[] = (int) $options['counselorId'];
        }

        $rows = Db::all(
            "SELECT l.id, l.reference, l.checked_out_at, l.returned_at,
                    d.name AS device_name, d.barcode AS device_barcode, d.category,
                    CONCAT(c.first_name, ' ', c.last_name) AS client_name,
                    u.full_name AS tech_name,
                    DATEDIFF(NOW(), l.returned_at) AS days_since_return
               FROM loans l
               JOIN devices d ON d.id = l.device_id
               LEFT JOIN clients c ON c.id = l.client_id
               LEFT JOIN users u ON u.id = l.tech_id
              WHERE {$where}
              ORDER BY l.returned_at DESC
              LIMIT {$limit} OFFSET {$offset}",
            $params,
        );

        $total = (int) Db::value("SELECT COUNT(*) FROM loans l WHERE {$where}", $params);

        return [
            'rows'   => $rows,
            'total'  => $total,
            'notice' => $total === 0
                ? 'Every completed trial has an outcome recorded.'
                : sprintf(
                    '%d completed trial%s without an outcome. Every percentage in the outcomes report '
                    . 'excludes these, so the more of them there are, the less the report is worth.',
                    $total, $total === 1 ? '' : 's',
                ),
        ];
    }

    /**
     * What the trials concluded.
     *
     * Reported against the loans that actually have an outcome, with the
     * unrecorded count stated alongside rather than hidden — a success rate
     * computed over a third of the data is a number that misleads.
     */
    public static function report(int $organizationId, ?string $from = null, ?string $to = null): array
    {
        $fromSql = Util::mysqlDateTime($from ?: '-1 year');
        $toSql   = Util::mysqlDateTime($to ?: 'now');

        $where  = 'l.organization_id = ? AND l.status = "returned"
                   AND l.returned_at >= ? AND l.returned_at <= ?';
        $params = [$organizationId, $fromSql, $toSql];

        $totals = Db::one(
            "SELECT COUNT(*) AS completed,
                    SUM(l.outcome IS NOT NULL) AS recorded,
                    SUM(l.outcome = 'recommended') AS recommended,
                    SUM(l.outcome = 'not_suitable') AS not_suitable,
                    SUM(l.outcome = 'needs_training') AS needs_training,
                    SUM(l.outcome = 'trying_alternative') AS trying_alternative,
                    SUM(l.outcome = 'client_declined') AS client_declined,
                    SUM(l.outcome = 'inconclusive') AS inconclusive
               FROM loans l WHERE {$where}",
            $params,
        );

        $recorded = (int) $totals['recorded'];

        $byDevice = Db::all(
            "SELECT d.id, d.name, d.barcode, d.category,
                    COUNT(*) AS trials,
                    SUM(l.outcome IS NOT NULL) AS recorded,
                    SUM(l.outcome = 'recommended') AS recommended,
                    SUM(l.outcome = 'not_suitable') AS not_suitable,
                    SUM(l.outcome = 'needs_training') AS needs_training
               FROM loans l JOIN devices d ON d.id = l.device_id
              WHERE {$where}
              GROUP BY d.id, d.name, d.barcode, d.category
              ORDER BY trials DESC
              LIMIT 100",
            $params,
        );

        foreach ($byDevice as &$row) {
            $row['trials']      = (int) $row['trials'];
            $row['recorded']    = (int) $row['recorded'];
            $row['recommended'] = (int) $row['recommended'];
            $row['not_suitable'] = (int) $row['not_suitable'];
            $row['needs_training'] = (int) $row['needs_training'];
            $row['success_rate'] = $row['recorded'] === 0
                ? null
                : round($row['recommended'] / $row['recorded'] * 100, 1);
        }
        unset($row);

        $byCategory = Db::all(
            "SELECT COALESCE(d.category, 'Uncategorised') AS category,
                    COUNT(*) AS trials,
                    SUM(l.outcome IS NOT NULL) AS recorded,
                    SUM(l.outcome = 'recommended') AS recommended,
                    SUM(l.outcome = 'needs_training') AS needs_training
               FROM loans l JOIN devices d ON d.id = l.device_id
              WHERE {$where}
              GROUP BY COALESCE(d.category, 'Uncategorised')
              ORDER BY trials DESC",
            $params,
        );

        foreach ($byCategory as &$row) {
            $row['trials']   = (int) $row['trials'];
            $row['recorded'] = (int) $row['recorded'];
            $row['recommended'] = (int) $row['recommended'];
            $row['needs_training'] = (int) $row['needs_training'];
            $row['success_rate'] = $row['recorded'] === 0
                ? null : round($row['recommended'] / $row['recorded'] * 100, 1);
            // A category where people keep needing training is a staffing gap,
            // not an equipment one, and the two get confused constantly.
            $row['training_rate'] = $row['recorded'] === 0
                ? null : round($row['needs_training'] / $row['recorded'] * 100, 1);
        }
        unset($row);

        $avoided = (int) $totals['not_suitable'] + (int) $totals['client_declined'];

        $avoidedValue = (float) (Db::value(
            "SELECT COALESCE(SUM(d.purchase_cost), 0)
               FROM loans l JOIN devices d ON d.id = l.device_id
              WHERE {$where} AND l.outcome IN ('not_suitable', 'client_declined')",
            $params,
        ) ?? 0);

        return [
            'range'  => ['from' => $fromSql, 'to' => $toSql],
            'totals' => [
                'completed'          => (int) $totals['completed'],
                'recorded'           => $recorded,
                'unrecorded'         => (int) $totals['completed'] - $recorded,
                'coverage_percent'   => (int) $totals['completed'] === 0
                    ? null : round($recorded / (int) $totals['completed'] * 100, 1),
                'recommended'        => (int) $totals['recommended'],
                'not_suitable'       => (int) $totals['not_suitable'],
                'needs_training'     => (int) $totals['needs_training'],
                'trying_alternative' => (int) $totals['trying_alternative'],
                'client_declined'    => (int) $totals['client_declined'],
                'inconclusive'       => (int) $totals['inconclusive'],
                'success_rate'       => $recorded === 0
                    ? null : round((int) $totals['recommended'] / $recorded * 100, 1),
            ],
            // The number that justifies the pool's existence to a funder: trials
            // that stopped a purchase, and roughly what that purchase would
            // have cost. Approximate on purpose — it uses the pool's own
            // purchase price, which is what it had to hand.
            'purchases_avoided' => [
                'count'            => $avoided,
                'approximate_value' => round($avoidedValue, 2),
                'notice'           => $avoided === 0
                    ? null
                    : sprintf(
                        '%d trial%s ended without a purchase being recommended. Valued at what this '
                        . 'pool paid for the same equipment, that is roughly %s of equipment not bought '
                        . 'for someone it would not have suited.',
                        $avoided, $avoided === 1 ? '' : 's',
                        '$' . number_format($avoidedValue, 2),
                    ),
            ],
            'by_device'   => $byDevice,
            'by_category' => $byCategory,
            'caveat' => $recorded === 0
                ? 'No outcomes have been recorded yet, so there is nothing to report.'
                : sprintf(
                    'Based on the %d completed trial%s that has an outcome recorded, out of %d. '
                    . 'Percentages exclude the rest.',
                    $recorded, $recorded === 1 ? '' : 's', (int) $totals['completed'],
                ),
        ];
    }

    /** Every trial a client has been through, for the case record. */
    public static function forClient(int $organizationId, int $clientId): array
    {
        $rows = Db::all(
            'SELECT l.id, l.reference, l.checked_out_at, l.returned_at, l.status,
                    l.outcome, l.outcome_notes, l.outcome_recorded_at,
                    d.name AS device_name, d.barcode AS device_barcode, d.category,
                    u.full_name AS outcome_recorded_by_name
               FROM loans l
               JOIN devices d ON d.id = l.device_id
               LEFT JOIN users u ON u.id = l.outcome_recorded_by
              WHERE l.organization_id = ? AND l.client_id = ?
              ORDER BY l.checked_out_at DESC',
            [$organizationId, $clientId],
        );

        foreach ($rows as &$row) {
            $row['outcome_label'] = $row['outcome'] === null
                ? null : (self::LABELS[$row['outcome']] ?? $row['outcome']);
        }

        return $rows;
    }
}
