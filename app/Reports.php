<?php
/**
 * Reporting.
 *
 * The rule throughout: aggregate one thing per query. Joining devices to
 * loans and summing a cost column multiplies that cost by the number of
 * loans, which is how an equipment budget ends up reported several times over.
 * Where two measures are needed they are gathered separately and combined in
 * PHP.
 *
 * Overdue is always derived from due_at against now, never read from a stored
 * flag, so a report run at any moment is correct without a job having run.
 */

declare(strict_types=1);

namespace Loaner;

final class Reports
{
    /** Dashboard counters. */
    public static function summary(int $organizationId): array
    {
        $devices = Db::one(
            'SELECT COUNT(*) AS total,
                    SUM(status = "available")    AS available,
                    SUM(status = "checked_out")  AS checked_out,
                    SUM(status = "reserved")     AS reserved,
                    SUM(status = "maintenance")  AS maintenance,
                    SUM(status = "retired")      AS retired,
                    SUM(status = "lost")         AS lost
               FROM devices WHERE organization_id = ?',
            [$organizationId],
        );

        $loans = Db::one(
            'SELECT SUM(status = "active") AS active,
                    SUM(status = "active" AND due_at IS NOT NULL AND due_at < NOW()) AS overdue,
                    SUM(status = "active" AND due_at IS NOT NULL
                        AND due_at >= NOW() AND due_at <= DATE_ADD(NOW(), INTERVAL ? DAY)) AS due_soon,
                    SUM(status = "returned" AND returned_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))
                        AS returned_30d,
                    SUM(checked_out_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS issued_30d
               FROM loans WHERE organization_id = ?',
            [(int) Settings::get($organizationId, 'notify.due_soon_days'), $organizationId],
        );

        $requests = Db::one(
            'SELECT SUM(status = "submitted") AS awaiting_review,
                    SUM(status = "approved" AND fulfillment_state = "pending")      AS not_started,
                    SUM(status = "approved" AND fulfillment_state = "provisioning") AS provisioning,
                    SUM(status = "approved" AND fulfillment_state = "in_transit")   AS in_transit,
                    SUM(status = "approved" AND fulfillment_state = "ready_pickup") AS ready_pickup
               FROM loan_requests WHERE organization_id = ?',
            [$organizationId],
        );

        $other = Db::one(
            'SELECT (SELECT COUNT(*) FROM reservations
                      WHERE organization_id = ? AND status = "waiting") AS waiting_reservations,
                    (SELECT COUNT(*) FROM reservations
                      WHERE organization_id = ? AND status = "ready")   AS ready_reservations,
                    (SELECT COUNT(*) FROM repairs
                      WHERE organization_id = ?
                        AND status NOT IN ("repaired","unrepairable","cancelled")) AS open_repairs',
            [$organizationId, $organizationId, $organizationId],
        );

        $total     = (int) $devices['total'];
        $checkedOut = (int) $devices['checked_out'];

        return [
            'devices' => array_map('intval', $devices),
            'loans'   => array_map('intval', $loans),
            'requests' => array_map('intval', $requests),
            'reservations' => [
                'waiting' => (int) $other['waiting_reservations'],
                'ready'   => (int) $other['ready_reservations'],
            ],
            'repairs' => ['open' => (int) $other['open_repairs']],
            'utilisation_percent' => $total === 0 ? 0.0 : round($checkedOut / $total * 100, 1),
            'generated_at' => date('c'),
        ];
    }

    /**
     * The main report: activity over a date range.
     *
     * Each block is its own query against its own grain.
     */
    public static function overview(int $organizationId, ?string $from, ?string $to): array
    {
        [$fromSql, $toSql] = self::range($from, $to);

        $loanWhere  = 'l.organization_id = ? AND l.checked_out_at >= ? AND l.checked_out_at <= ?';
        $loanParams = [$organizationId, $fromSql, $toSql];

        $totals = Db::one(
            "SELECT COUNT(*) AS loans_issued,
                    SUM(l.status = 'returned') AS loans_returned,
                    SUM(l.status = 'active')   AS still_out,
                    SUM(l.status = 'cancelled') AS cancelled,
                    SUM(l.extension_count > 0) AS extended,
                    COUNT(DISTINCT l.device_id) AS distinct_devices,
                    COUNT(DISTINCT l.client_id) AS distinct_clients,
                    AVG(CASE WHEN l.returned_at IS NOT NULL
                             THEN TIMESTAMPDIFF(DAY, l.checked_out_at, l.returned_at) END) AS avg_days_out,
                    SUM(l.status = 'returned' AND l.due_at IS NOT NULL AND l.returned_at > l.due_at)
                        AS returned_late
               FROM loans l WHERE {$loanWhere}",
            $loanParams,
        );

        $byStatus = Db::all(
            "SELECT l.status, COUNT(*) AS loan_count FROM loans l
              WHERE {$loanWhere} GROUP BY l.status",
            $loanParams,
        );

        $byMethod = Db::all(
            "SELECT l.checkout_method AS method, COUNT(*) AS loan_count FROM loans l
              WHERE {$loanWhere} GROUP BY l.checkout_method ORDER BY loan_count DESC",
            $loanParams,
        );

        $byProgram = Db::all(
            "SELECT COALESCE(p.name, 'No program') AS program, COUNT(*) AS loan_count
               FROM loans l LEFT JOIN programs p ON p.id = l.program_id
              WHERE {$loanWhere}
              GROUP BY COALESCE(p.name, 'No program') ORDER BY loan_count DESC",
            $loanParams,
        );

        $byCategory = Db::all(
            "SELECT COALESCE(d.category, 'Uncategorised') AS category, COUNT(*) AS loan_count,
                    COUNT(DISTINCT l.device_id) AS device_count
               FROM loans l JOIN devices d ON d.id = l.device_id
              WHERE {$loanWhere}
              GROUP BY COALESCE(d.category, 'Uncategorised') ORDER BY loan_count DESC",
            $loanParams,
        );

        return [
            'range'  => ['from' => $fromSql, 'to' => $toSql],
            'totals' => [
                'loans_issued'     => (int) $totals['loans_issued'],
                'loans_returned'   => (int) $totals['loans_returned'],
                'still_out'        => (int) $totals['still_out'],
                'cancelled'        => (int) $totals['cancelled'],
                'extended'         => (int) $totals['extended'],
                'distinct_devices' => (int) $totals['distinct_devices'],
                'distinct_clients' => (int) $totals['distinct_clients'],
                'returned_late'    => (int) $totals['returned_late'],
                'avg_days_out'     => $totals['avg_days_out'] === null
                    ? null : round((float) $totals['avg_days_out'], 1),
                'on_time_rate'     => (int) $totals['loans_returned'] === 0 ? null : round(
                    (1 - (int) $totals['returned_late'] / (int) $totals['loans_returned']) * 100, 1,
                ),
            ],
            'by_status'   => $byStatus,
            'by_method'   => $byMethod,
            'by_program'  => $byProgram,
            'by_category' => $byCategory,
            'currently'   => [
                'overdue'  => count(Loans::overdue($organizationId)),
                'due_soon' => count(Loans::dueSoon($organizationId)),
            ],
        ];
    }

    /**
     * Device utilisation: how often each device actually goes out.
     *
     * This is the report that answers "what should we buy more of?" and
     * "what is sitting in a cupboard?".
     */
    public static function deviceUtilisation(
        int $organizationId,
        ?string $from = null,
        ?string $to = null,
        int $limit = 200,
    ): array {
        [$fromSql, $toSql] = self::range($from, $to);

        $rows = Db::all(
            'SELECT d.id, d.name, d.barcode, d.category, d.status, d.purchase_cost, d.funding_source,
                    COUNT(l.id) AS loan_count,
                    COALESCE(SUM(CASE WHEN l.returned_at IS NOT NULL
                                 THEN TIMESTAMPDIFF(DAY, l.checked_out_at, l.returned_at)
                                 WHEN l.status = "active"
                                 THEN TIMESTAMPDIFF(DAY, l.checked_out_at, NOW()) END), 0) AS days_out,
                    MAX(l.checked_out_at) AS last_out_at
               FROM devices d
               LEFT JOIN loans l
                      ON l.device_id = d.id
                     AND l.checked_out_at >= ? AND l.checked_out_at <= ?
                     AND l.status <> "cancelled"
              WHERE d.organization_id = ?
              GROUP BY d.id, d.name, d.barcode, d.category, d.status, d.purchase_cost, d.funding_source
              ORDER BY loan_count DESC, d.name
              LIMIT ' . max(1, min(1000, $limit)),
            [$fromSql, $toSql, $organizationId],
        );

        $span = max(1, (int) ceil((strtotime($toSql) - strtotime($fromSql)) / 86400));

        foreach ($rows as &$row) {
            $row['loan_count'] = (int) $row['loan_count'];
            $row['days_out']   = (int) $row['days_out'];
            // Share of the window the device was in someone's hands. Capped,
            // because overlapping historical loans can exceed the window.
            $row['utilisation_pct'] = min(100.0, round($row['days_out'] / $span * 100, 1));
            $row['never_loaned']    = $row['loan_count'] === 0;
        }

        return ['rows' => $rows, 'range' => ['from' => $fromSql, 'to' => $toSql], 'window_days' => $span];
    }

    /**
     * Demand by category, combining what went out with what people asked for
     * and could not have. Unmet demand is the useful half and is invisible in
     * loan data alone.
     */
    public static function categoryDemand(int $organizationId, ?string $from = null, ?string $to = null): array
    {
        [$fromSql, $toSql] = self::range($from, $to);

        $lent = Db::all(
            'SELECT COALESCE(d.category, "Uncategorised") AS category, COUNT(*) AS loan_count
               FROM loans l JOIN devices d ON d.id = l.device_id
              WHERE l.organization_id = ? AND l.checked_out_at >= ? AND l.checked_out_at <= ?
              GROUP BY COALESCE(d.category, "Uncategorised")',
            [$organizationId, $fromSql, $toSql],
        );

        $requested = Db::all(
            'SELECT COALESCE(NULLIF(r.requested_category, ""), d.category, "Unspecified") AS category,
                    COUNT(*) AS request_count,
                    SUM(r.status = "denied") AS denied_count
               FROM loan_requests r LEFT JOIN devices d ON d.id = r.device_id
              WHERE r.organization_id = ? AND r.created_at >= ? AND r.created_at <= ?
              GROUP BY COALESCE(NULLIF(r.requested_category, ""), d.category, "Unspecified")',
            [$organizationId, $fromSql, $toSql],
        );

        $waiting = Db::all(
            'SELECT COALESCE(NULLIF(rs.category, ""), d.category, "Unspecified") AS category,
                    COUNT(*) AS waiting_count
               FROM reservations rs LEFT JOIN devices d ON d.id = rs.device_id
              WHERE rs.organization_id = ? AND rs.created_at >= ? AND rs.created_at <= ?
              GROUP BY COALESCE(NULLIF(rs.category, ""), d.category, "Unspecified")',
            [$organizationId, $fromSql, $toSql],
        );

        $stock = Db::all(
            'SELECT COALESCE(category, "Uncategorised") AS category, COUNT(*) AS device_count
               FROM devices WHERE organization_id = ? AND status <> "retired"
              GROUP BY COALESCE(category, "Uncategorised")',
            [$organizationId],
        );

        $merged = [];

        foreach ([[$lent, 'loan_count'], [$stock, 'device_count']] as [$set, $field]) {
            foreach ($set as $row) {
                $merged[$row['category']][$field] = (int) $row[$field];
            }
        }
        foreach ($requested as $row) {
            $merged[$row['category']]['request_count'] = (int) $row['request_count'];
            $merged[$row['category']]['denied_count']  = (int) $row['denied_count'];
        }
        foreach ($waiting as $row) {
            $merged[$row['category']]['waiting_count'] = (int) $row['waiting_count'];
        }

        $rows = [];
        foreach ($merged as $category => $values) {
            $devices = $values['device_count'] ?? 0;
            $loans   = $values['loan_count']   ?? 0;

            $rows[] = [
                'category'      => $category,
                'device_count'  => $devices,
                'loan_count'    => $loans,
                'request_count' => $values['request_count'] ?? 0,
                'denied_count'  => $values['denied_count']  ?? 0,
                'waiting_count' => $values['waiting_count'] ?? 0,
                'unmet'         => ($values['waiting_count'] ?? 0) + ($values['denied_count'] ?? 0),
                // How many times the average device in this category went out
                // over the window. A high figure with people still waiting is
                // the clearest argument for buying another one.
                'turns_per_device' => $devices === 0 ? null : round($loans / $devices, 2),
            ];
        }

        usort($rows, static fn (array $a, array $b): int => ($b['unmet'] <=> $a['unmet'])
            ?: ($b['loan_count'] <=> $a['loan_count']));

        return ['rows' => $rows, 'range' => ['from' => $fromSql, 'to' => $toSql]];
    }

    /**
     * Who is borrowing: by technician, client or program.
     */
    public static function holderActivity(
        int $organizationId,
        string $holder,
        ?string $from = null,
        ?string $to = null,
        ?int $restrictToCounselor = null,
    ): array {
        [$fromSql, $toSql] = self::range($from, $to);

        [$join, $idColumn, $label] = match ($holder) {
            'tech'    => ['JOIN users u ON u.id = l.tech_id', 'l.tech_id', 'u.full_name'],
            'client'  => ['JOIN clients u ON u.id = l.client_id', 'l.client_id',
                          'CONCAT(u.first_name, " ", u.last_name)'],
            'program' => ['JOIN programs u ON u.id = l.program_id', 'l.program_id', 'u.name'],
            default   => throw Util::badRequest(
                "\"{$holder}\" is not a holder type.",
                ['field' => 'holder', 'allowed' => ['tech', 'client', 'program']],
            ),
        };

        $scope  = '';
        $params = [$organizationId, $fromSql, $toSql];

        // A counselor may see their own caseload here and nothing more. The
        // clause is only ever reached for the client view, because there is
        // nothing meaningful to narrow a technician or program breakdown to.
        if ($restrictToCounselor !== null) {
            $scope    = ' AND u.counselor_id = ?';
            $params[] = $restrictToCounselor;
        }

        $rows = Db::all(
            "SELECT {$idColumn} AS holder_id, {$label} AS holder_name,
                    COUNT(*) AS loan_count,
                    SUM(l.status = 'active') AS active_count,
                    SUM(l.status = 'active' AND l.due_at IS NOT NULL AND l.due_at < NOW()) AS overdue_count,
                    SUM(l.status = 'returned' AND l.due_at IS NOT NULL AND l.returned_at > l.due_at)
                        AS late_count,
                    MAX(l.checked_out_at) AS last_loan_at
               FROM loans l {$join}
              WHERE l.organization_id = ? AND l.checked_out_at >= ? AND l.checked_out_at <= ?
                    {$scope}
              GROUP BY {$idColumn}, {$label}
              ORDER BY loan_count DESC
              LIMIT 200",
            $params,
        );

        foreach ($rows as &$row) {
            $row['loan_count']    = (int) $row['loan_count'];
            $row['active_count']  = (int) $row['active_count'];
            $row['overdue_count'] = (int) $row['overdue_count'];
            $row['late_count']    = (int) $row['late_count'];
        }

        return ['holder' => $holder, 'rows' => $rows, 'range' => ['from' => $fromSql, 'to' => $toSql]];
    }

    /** Loans issued and returned per month, for a trend line. */
    public static function trend(int $organizationId, int $months = 12): array
    {
        $months = max(1, min(36, $months));

        $issued = Db::all(
            'SELECT DATE_FORMAT(checked_out_at, "%Y-%m") AS period, COUNT(*) AS loan_count
               FROM loans
              WHERE organization_id = ?
                AND checked_out_at >= DATE_SUB(DATE_FORMAT(NOW(), "%Y-%m-01"), INTERVAL ? MONTH)
              GROUP BY period ORDER BY period',
            [$organizationId, $months - 1],
        );

        $returned = Db::all(
            'SELECT DATE_FORMAT(returned_at, "%Y-%m") AS period, COUNT(*) AS loan_count
               FROM loans
              WHERE organization_id = ? AND returned_at IS NOT NULL
                AND returned_at >= DATE_SUB(DATE_FORMAT(NOW(), "%Y-%m-01"), INTERVAL ? MONTH)
              GROUP BY period ORDER BY period',
            [$organizationId, $months - 1],
        );

        $issuedBy   = array_column($issued, 'loan_count', 'period');
        $returnedBy = array_column($returned, 'loan_count', 'period');

        // Build every month in the window, so a quiet month shows as zero
        // rather than vanishing and distorting the shape of the line.
        $rows   = [];
        $cursor = new \DateTimeImmutable(date('Y-m-01'));
        $cursor = $cursor->modify('-' . ($months - 1) . ' months');

        for ($i = 0; $i < $months; $i++) {
            $period = $cursor->format('Y-m');
            $rows[] = [
                'period'   => $period,
                'label'    => $cursor->format('M Y'),
                'checked_out' => (int) ($issuedBy[$period] ?? 0),
                'checked_in'  => (int) ($returnedBy[$period] ?? 0),
            ];
            $cursor = $cursor->modify('+1 month');
        }

        return ['rows' => $rows, 'months' => $months];
    }

    /**
     * Devices nobody has borrowed for a long time.
     *
     * Reported as "days since last loan", with never-lent devices listed
     * first — they are the clearest sign of money spent on the wrong thing.
     */
    public static function idleDevices(int $organizationId, int $sinceDays = 90): array
    {
        $rows = Db::all(
            'SELECT d.id, d.name, d.barcode, d.category, d.status, d.location,
                    d.purchase_cost, d.purchase_date,
                    MAX(l.checked_out_at) AS last_out_at,
                    COUNT(l.id) AS lifetime_loans
               FROM devices d
               LEFT JOIN loans l ON l.device_id = d.id AND l.status <> "cancelled"
              WHERE d.organization_id = ? AND d.status NOT IN ("retired", "lost")
              GROUP BY d.id, d.name, d.barcode, d.category, d.status, d.location,
                       d.purchase_cost, d.purchase_date
             HAVING MAX(l.checked_out_at) IS NULL
                 OR MAX(l.checked_out_at) < DATE_SUB(NOW(), INTERVAL ? DAY)
              ORDER BY (MAX(l.checked_out_at) IS NOT NULL), MAX(l.checked_out_at), d.name',
            [$organizationId, max(1, $sinceDays)],
        );

        foreach ($rows as &$row) {
            $row['lifetime_loans'] = (int) $row['lifetime_loans'];
            $row['never_loaned'] = $row['last_out_at'] === null;
            $row['days_idle'] = $row['last_out_at'] === null
                ? null
                : max(0, (int) floor((time() - strtotime((string) $row['last_out_at'])) / 86400));
        }

        $idleValue = array_sum(array_map(
            static fn (array $r): float => (float) ($r['purchase_cost'] ?? 0),
            $rows,
        ));

        return [
            'rows'        => $rows,
            'total'       => count($rows),
            'since_days'  => $sinceDays,
            'idle_value'  => round($idleValue, 2),
        ];
    }

    /**
     * Funding report: what each funding source paid for, and how hard it works.
     *
     * Devices and loans are aggregated separately and joined in PHP. A single
     * query grouping devices by funding source while counting loans would
     * repeat each purchase cost once per loan.
     */
    public static function funding(int $organizationId, ?string $from = null, ?string $to = null): array
    {
        [$fromSql, $toSql] = self::range($from, $to);

        $devices = Db::all(
            'SELECT COALESCE(NULLIF(funding_source, ""), "Unattributed") AS funding_source,
                    COUNT(*) AS device_count,
                    COALESCE(SUM(purchase_cost), 0) AS total_cost,
                    SUM(status = "retired") AS retired_count,
                    SUM(status = "lost")    AS lost_count
               FROM devices WHERE organization_id = ?
              GROUP BY COALESCE(NULLIF(funding_source, ""), "Unattributed")',
            [$organizationId],
        );

        $loans = Db::all(
            'SELECT COALESCE(NULLIF(d.funding_source, ""), "Unattributed") AS funding_source,
                    COUNT(l.id) AS loan_count,
                    COUNT(DISTINCT l.device_id) AS devices_lent,
                    COUNT(DISTINCT l.client_id) AS clients_served
               FROM loans l JOIN devices d ON d.id = l.device_id
              WHERE l.organization_id = ? AND l.checked_out_at >= ? AND l.checked_out_at <= ?
                AND l.status <> "cancelled"
              GROUP BY COALESCE(NULLIF(d.funding_source, ""), "Unattributed")',
            [$organizationId, $fromSql, $toSql],
        );

        $repairs = Db::all(
            'SELECT COALESCE(NULLIF(d.funding_source, ""), "Unattributed") AS funding_source,
                    COUNT(r.id) AS repair_count,
                    COALESCE(SUM(r.cost), 0) AS repair_cost
               FROM repairs r JOIN devices d ON d.id = r.device_id
              WHERE r.organization_id = ? AND r.created_at >= ? AND r.created_at <= ?
              GROUP BY COALESCE(NULLIF(d.funding_source, ""), "Unattributed")',
            [$organizationId, $fromSql, $toSql],
        );

        $loansBy   = [];
        $repairsBy = [];
        foreach ($loans as $row) {
            $loansBy[$row['funding_source']] = $row;
        }
        foreach ($repairs as $row) {
            $repairsBy[$row['funding_source']] = $row;
        }

        $rows = [];
        foreach ($devices as $row) {
            $source = $row['funding_source'];
            $loanRow   = $loansBy[$source]   ?? [];
            $repairRow = $repairsBy[$source] ?? [];

            $deviceCount = (int) $row['device_count'];
            $loanCount   = (int) ($loanRow['loan_count'] ?? 0);
            $cost        = round((float) $row['total_cost'], 2);

            $rows[] = [
                'funding_source'  => $source,
                'device_count'    => $deviceCount,
                'total_cost'      => $cost,
                'retired_count'   => (int) $row['retired_count'],
                'lost_count'      => (int) $row['lost_count'],
                'loan_count'      => $loanCount,
                'devices_lent'    => (int) ($loanRow['devices_lent'] ?? 0),
                'clients_served'  => (int) ($loanRow['clients_served'] ?? 0),
                'repair_count'    => (int) ($repairRow['repair_count'] ?? 0),
                'repair_cost'     => round((float) ($repairRow['repair_cost'] ?? 0), 2),
                'cost_per_loan'   => $loanCount === 0 ? null : round($cost / $loanCount, 2),
                'loans_per_device' => $deviceCount === 0 ? null : round($loanCount / $deviceCount, 2),
                'idle_devices'    => max(0, $deviceCount - (int) ($loanRow['devices_lent'] ?? 0)),
            ];
        }

        usort($rows, static fn (array $a, array $b): int => $b['total_cost'] <=> $a['total_cost']);

        return [
            'rows'       => $rows,
            'by_program' => self::fundingByProgram($organizationId, $fromSql, $toSql),
            'range'      => ['from' => $fromSql, 'to' => $toSql],
            'totals' => [
                'device_count' => array_sum(array_column($rows, 'device_count')),
                'total_cost'   => round(array_sum(array_column($rows, 'total_cost')), 2),
                'loan_count'   => array_sum(array_column($rows, 'loan_count')),
                'repair_cost'  => round(array_sum(array_column($rows, 'repair_cost')), 2),
            ],
        ];
    }

    /**
     * The same money, grouped by the program that owns the equipment.
     *
     * Funders usually want to see it one way and program managers the other,
     * and deriving one from the other in the browser would be guesswork. Again
     * gathered separately from the loan counts so no cost is double-counted.
     */
    private static function fundingByProgram(int $organizationId, string $fromSql, string $toSql): array
    {
        $devices = Db::all(
            'SELECT COALESCE(p.name, "No program") AS program,
                    COUNT(*) AS device_count,
                    COALESCE(SUM(d.purchase_cost), 0) AS total_cost
               FROM devices d
               LEFT JOIN programs p ON p.id = d.owner_program_id
              WHERE d.organization_id = ?
              GROUP BY COALESCE(p.name, "No program")',
            [$organizationId],
        );

        $loans = Db::all(
            'SELECT COALESCE(p.name, "No program") AS program,
                    COUNT(l.id) AS loan_count,
                    COUNT(DISTINCT l.client_id) AS clients_served
               FROM loans l
               LEFT JOIN programs p ON p.id = l.program_id
              WHERE l.organization_id = ? AND l.checked_out_at >= ? AND l.checked_out_at <= ?
                AND l.status <> "cancelled"
              GROUP BY COALESCE(p.name, "No program")',
            [$organizationId, $fromSql, $toSql],
        );

        $loansBy = array_column($loans, null, 'program');
        $rows    = [];

        foreach ($devices as $row) {
            $loanRow = $loansBy[$row['program']] ?? [];

            $rows[] = [
                'program'        => $row['program'],
                'device_count'   => (int) $row['device_count'],
                'total_cost'     => round((float) $row['total_cost'], 2),
                'loan_count'     => (int) ($loanRow['loan_count'] ?? 0),
                'clients_served' => (int) ($loanRow['clients_served'] ?? 0),
            ];
        }

        usort($rows, static fn (array $a, array $b): int => $b['total_cost'] <=> $a['total_cost']);

        return $rows;
    }

    /**
     * How much of the work is actually being done with a scanner.
     *
     * Worth measuring because the scanning workflow is the whole reason for the
     * barcodes: if most check-outs are still being typed in by hand, either the
     * labels are not on the devices or the scanner is not where people work,
     * and both are fixable once visible.
     */
    public static function scanAdoption(int $organizationId, ?string $from = null, ?string $to = null): array
    {
        [$fromSql, $toSql] = self::range($from, $to);

        $out = Db::one(
            'SELECT COUNT(*) AS total,
                    SUM(checkout_method = "scan")    AS scanned,
                    SUM(checkout_method = "manual")  AS manual,
                    SUM(checkout_method = "api")     AS api,
                    SUM(checkout_method = "request") AS request
               FROM loans
              WHERE organization_id = ? AND checked_out_at >= ? AND checked_out_at <= ?',
            [$organizationId, $fromSql, $toSql],
        );

        $in = Db::one(
            'SELECT COUNT(*) AS total,
                    SUM(checkin_method = "scan")   AS scanned,
                    SUM(checkin_method = "manual") AS manual,
                    SUM(checkin_method = "api")    AS api
               FROM loans
              WHERE organization_id = ? AND returned_at IS NOT NULL
                AND returned_at >= ? AND returned_at <= ?',
            [$organizationId, $fromSql, $toSql],
        );

        $totalEvents   = (int) $out['total'] + (int) $in['total'];
        $scannedEvents = (int) $out['scanned'] + (int) $in['scanned'];

        $channels = Db::one(
            'SELECT COUNT(*) AS channel_count, COALESCE(SUM(scan_count), 0) AS phone_scans
               FROM scan_channels WHERE organization_id = ?',
            [$organizationId],
        );

        return [
            'range'         => ['from' => $fromSql, 'to' => $toSql],
            'scan_percent'  => $totalEvents === 0 ? null : round($scannedEvents / $totalEvents * 100, 1),
            'total_events'  => $totalEvents,
            'scanned_events' => $scannedEvents,
            'check_out' => [
                'total'   => (int) $out['total'],
                'scanned' => (int) $out['scanned'],
                'manual'  => (int) $out['manual'],
                'api'     => (int) $out['api'],
                'request' => (int) $out['request'],
                'scan_percent' => (int) $out['total'] === 0
                    ? null : round((int) $out['scanned'] / (int) $out['total'] * 100, 1),
            ],
            'check_in' => [
                'total'   => (int) $in['total'],
                'scanned' => (int) $in['scanned'],
                'manual'  => (int) $in['manual'],
                'api'     => (int) $in['api'],
                'scan_percent' => (int) $in['total'] === 0
                    ? null : round((int) $in['scanned'] / (int) $in['total'] * 100, 1),
            ],
            'phone_pairing' => [
                'channels_created' => (int) $channels['channel_count'],
                'scans_sent'       => (int) $channels['phone_scans'],
            ],
            'notice' => $totalEvents === 0
                ? 'No check-outs or check-ins in this period yet.'
                : null,
        ];
    }

    // -----------------------------------------------------------------------
    // CSV exports
    // -----------------------------------------------------------------------

    public static function deviceUtilisationCsv(int $organizationId, ?string $from, ?string $to): string
    {
        $report = self::deviceUtilisation($organizationId, $from, $to, 1000);

        // Headers are the field names, not prose. An export is read by
        // spreadsheets and by this application's own importer, and the importer
        // matches on these spellings.
        return Util::toCsv(
            ['barcode', 'name', 'category', 'status', 'loan_count', 'days_out', 'utilisation_percent',
             'last_checked_out', 'purchase_cost', 'funding_source'],
            array_map(static fn (array $r): array => [
                $r['barcode'], $r['name'], $r['category'], $r['status'],
                $r['loan_count'], $r['days_out'], $r['utilisation_pct'],
                $r['last_out_at'], $r['purchase_cost'], $r['funding_source'],
            ], $report['rows']),
        );
    }

    public static function fundingCsv(int $organizationId, ?string $from, ?string $to): string
    {
        $report = self::funding($organizationId, $from, $to);

        return Util::toCsv(
            ['funding_source', 'devices', 'total_cost', 'loans', 'devices_lent', 'idle_devices',
             'clients_served', 'repairs', 'repair_cost', 'cost_per_loan', 'loans_per_device',
             'retired', 'lost'],
            array_map(static fn (array $r): array => [
                $r['funding_source'], $r['device_count'], $r['total_cost'], $r['loan_count'],
                $r['devices_lent'], $r['idle_devices'], $r['clients_served'],
                $r['repair_count'], $r['repair_cost'], $r['cost_per_loan'], $r['loans_per_device'],
                $r['retired_count'], $r['lost_count'],
            ], $report['rows']),
        );
    }

    /**
     * Normalise a date range.
     *
     * Defaults to the last 90 days. An inverted range is swapped rather than
     * returning nothing, since a report that silently comes back empty looks
     * like missing data.
     */
    private static function range(?string $from, ?string $to): array
    {
        $toDate = $to !== null && $to !== ''
            ? (strtotime($to) ?: time())
            : time();

        $fromDate = $from !== null && $from !== ''
            ? (strtotime($from) ?: strtotime('-90 days', $toDate))
            : strtotime('-90 days', $toDate);

        if ($fromDate > $toDate) {
            [$fromDate, $toDate] = [$toDate, $fromDate];
        }

        return [
            date('Y-m-d 00:00:00', $fromDate),
            date('Y-m-d 23:59:59', $toDate),
        ];
    }
}
