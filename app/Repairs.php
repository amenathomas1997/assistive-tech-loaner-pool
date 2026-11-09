<?php
/**
 * Repair and maintenance tracking.
 *
 * A device that is broken is not "available", and a technician who checks it
 * back in needs somewhere to say why. Opening a repair takes the device out of
 * circulation; closing one puts it back, or retires it.
 *
 * Every status change is appended to repair_events rather than overwriting a
 * single field, so "how long do vendor repairs actually take?" is answerable.
 */

declare(strict_types=1);

namespace Loaner;

final class Repairs
{
    public const STATUSES = [
        'reported', 'diagnosing', 'awaiting_parts', 'with_vendor',
        'repaired', 'unrepairable', 'cancelled',
    ];

    public const STATUS_LABELS = [
        'reported'       => 'Reported',
        'diagnosing'     => 'Being diagnosed',
        'awaiting_parts' => 'Waiting for parts',
        'with_vendor'    => 'With the vendor',
        'repaired'       => 'Repaired',
        'unrepairable'   => 'Beyond repair',
        'cancelled'      => 'Cancelled',
    ];

    /** Statuses that mean the repair is finished. */
    public const CLOSED = ['repaired', 'unrepairable', 'cancelled'];

    private const SELECT = '
        SELECT r.*,
               d.name AS device_name, d.barcode AS device_barcode, d.category AS device_category,
               d.status AS device_status, d.serial_number, d.manufacturer, d.model,
               d.warranty_expires,
               l.reference AS loan_reference,
               rb.full_name AS reported_by_name,
               at.full_name AS assigned_to_name
          FROM repairs r
          JOIN devices d ON d.id = r.device_id
          LEFT JOIN loans l ON l.id = r.loan_id
          LEFT JOIN users rb ON rb.id = r.reported_by
          LEFT JOIN users at ON at.id = r.assigned_to';

    public static function get(int $organizationId, int $repairId): ?array
    {
        $row = Db::one(self::SELECT . ' WHERE r.id = ? AND r.organization_id = ?', [$repairId, $organizationId]);
        if ($row === null) {
            return null;
        }

        $row['events']      = self::events($repairId);
        $row['attachments'] = Attachments::forRepair($organizationId, $repairId);

        return self::decorate($row);
    }

    /** @return array<int, array<string, mixed>> */
    public static function events(int $repairId): array
    {
        return Db::all(
            'SELECT e.*, u.full_name AS actor_name
               FROM repair_events e
               LEFT JOIN users u ON u.id = e.actor_id
              WHERE e.repair_id = ?
              ORDER BY e.created_at, e.id',
            [$repairId],
        );
    }

    public static function decorate(array $row): array
    {
        // A DECIMAL column arrives as a string, and every screen formats this
        // as a number: one costed repair took the whole repairs list down.
        $row['cost'] = $row['cost'] === null ? null : (float) $row['cost'];

        $row['status_label'] = self::STATUS_LABELS[$row['status']] ?? $row['status'];
        $row['is_open']      = !in_array($row['status'], self::CLOSED, true);

        $start = strtotime((string) $row['created_at']);
        $end   = $row['closed_at'] !== null ? strtotime((string) $row['closed_at']) : time();
        $row['days_open'] = max(0, (int) floor(($end - $start) / 86400));

        // Warranty is the single most valuable thing to notice before paying
        // for a repair, so it is computed rather than left to be eyeballed.
        $row['warranty_active'] = !empty($row['warranty_expires'])
            && strtotime((string) $row['warranty_expires']) >= $start;

        return $row;
    }

    /**
     * Open a repair. Takes the device out of circulation, and ends any active
     * loan only if asked — a device can be reported faulty while still out.
     */
    public static function open(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $fault          = Util::requiredStr($input['fault'] ?? null, 'fault');
        $actorId        = $input['actorId'] ?? null;

        $created = Db::transaction(static function () use ($organizationId, $input, $fault, $actorId): array {
            $device = Loans::resolveDevice($organizationId, $input['deviceIdentifier'] ?? null, true);
            if ($device === null) {
                throw Util::notFound('That device does not exist.');
            }

            if (in_array($device['status'], ['retired', 'lost'], true)) {
                throw Util::conflict(
                    "{$device['name']} is marked \"{$device['status']}\". Change that first if it is "
                    . 'back in service; closing a repair would otherwise put it back in stock.',
                    ['status' => $device['status']],
                );
            }

            Loans::assertBelongs('users', $input['assignedTo'] ?? null, $organizationId, 'assignee');

            $existing = Db::one(
                'SELECT reference FROM repairs
                  WHERE device_id = ? AND status NOT IN ("repaired", "unrepairable", "cancelled")',
                [$device['id']],
            );
            if ($existing !== null) {
                throw Util::conflict(
                    "{$device['name']} already has an open repair ({$existing['reference']}). "
                    . 'Add a note to that one rather than opening a second.',
                    ['reference' => $existing['reference']],
                );
            }

            $activeLoan = Loans::activeLoanForDevice((int) $device['id'], true);

            for ($attempt = 0; $attempt < 6; $attempt++) {
                $reference = Util::makeReference('RP');
                try {
                    $repairId = Db::insert(
                        'INSERT INTO repairs
                           (organization_id, reference, device_id, loan_id, status, fault,
                            vendor, vendor_ref, cost, under_warranty, reported_by, assigned_to)
                         VALUES (?, ?, ?, ?, "reported", ?, ?, ?, ?, ?, ?, ?)',
                        [
                            $organizationId, $reference, $device['id'],
                            $activeLoan['id'] ?? null, $fault,
                            Util::str($input['vendor'] ?? null, 190),
                            Util::str($input['vendorRef'] ?? null, 120),
                            Util::decimal($input['cost'] ?? null, 'cost'),
                            Util::bool($input['underWarranty'] ?? false) ? 1 : 0,
                            $actorId, ($input['assignedTo'] ?? null) ?: null,
                        ],
                    );

                    Db::execute(
                        'INSERT INTO repair_events (repair_id, event_type, to_status, actor_id, notes)
                         VALUES (?, "opened", "reported", ?, ?)',
                        [$repairId, $actorId, $fault],
                    );

                    return ['id' => $repairId, 'reference' => $reference, 'device' => $device,
                            'loan' => $activeLoan];
                } catch (\Throwable $e) {
                    if (Db::isDuplicate($e) && str_contains($e->getMessage(), 'reference')) {
                        continue;
                    }
                    throw $e;
                }
            }

            throw new \RuntimeException('Could not allocate a unique repair reference.');
        });

        // Outside the transaction: checking the loan in is itself transactional
        // and raises its own events.
        if (!empty($created['loan']) && Util::bool($input['checkInFirst'] ?? false)) {
            Loans::checkIn($actor, [
                'organizationId'  => $organizationId,
                'loanId'          => (int) $created['loan']['id'],
                'conditionIn'     => 'Faulty — see repair ' . $created['reference'],
                'notes'           => $fault,
                'newDeviceStatus' => 'maintenance',
                'method'          => $input['method'] ?? 'manual',
                'actorId'         => $actorId,
            ]);
        }

        // A device promised to someone on the waitlist is not going to be
        // collected now. They go back in the queue, keeping their place.
        Reservations::releaseHoldsOnDevice($organizationId, (int) $created['device']['id']);

        Db::execute(
            'UPDATE devices SET status = CASE WHEN status = "checked_out" THEN status ELSE "maintenance" END,
                    active_repair_id = ?, updated_at = NOW()
              WHERE id = ?',
            [$created['id'], $created['device']['id']],
        );

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::REPAIR_OPENED,
            'entityType'     => 'repair',
            'entityId'       => $created['id'],
            'entityLabel'    => $created['reference'],
            'summary'        => "Repair {$created['reference']} opened for {$created['device']['name']}: {$fault}",
            'detail'         => ['device_id' => (int) $created['device']['id']],
        ]);

        return self::get($organizationId, $created['id']);
    }

    /**
     * Update a repair. Status changes append an event and, when the repair
     * closes, return the device to service or retire it.
     */
    public static function update(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $repairId       = (int) $input['repairId'];
        $actorId        = $input['actorId'] ?? null;

        $result = Db::transaction(static function () use ($organizationId, $repairId, $input, $actorId): array {
            $repair = Db::one(
                'SELECT * FROM repairs WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$repairId, $organizationId],
            );
            if ($repair === null) {
                throw Util::notFound('That repair does not exist.');
            }

            $newStatus = Util::str($input['status'] ?? null, 32);

            if ($newStatus !== null && !in_array($newStatus, self::STATUSES, true)) {
                throw Util::badRequest(
                    "\"{$newStatus}\" is not a repair status.",
                    ['allowed' => self::STATUSES],
                );
            }

            if ($newStatus !== null
                && in_array($repair['status'], self::CLOSED, true)
                && $newStatus !== $repair['status']
            ) {
                throw Util::conflict(
                    "Repair {$repair['reference']} is closed as \""
                    . self::STATUS_LABELS[$repair['status']]
                    . '" and cannot be reopened. Open a new repair for the device instead.',
                    ['status' => $repair['status']],
                );
            }

            $sets   = [];
            $params = [];

            foreach ([
                ['diagnosis', 'diagnosis', 'text'], ['resolution', 'resolution', 'text'],
                ['vendor', 'vendor', 190], ['vendorRef', 'vendor_ref', 120],
            ] as [$key, $column, $limit]) {
                if (array_key_exists($key, $input)) {
                    $sets[]   = "{$column} = ?";
                    $params[] = is_int($limit) ? Util::str($input[$key], $limit) : Util::str($input[$key]);
                }
            }

            if (array_key_exists('cost', $input)) {
                $sets[]   = 'cost = ?';
                $params[] = $input['cost'] === null || $input['cost'] === ''
                    ? null
                    : Util::decimal($input['cost'], 'cost');
            }
            if (array_key_exists('underWarranty', $input)) {
                $sets[]   = 'under_warranty = ?';
                $params[] = Util::bool($input['underWarranty']) ? 1 : 0;
            }
            if (array_key_exists('assignedTo', $input)) {
                Loans::assertBelongs('users', $input['assignedTo'], $organizationId, 'assignee');
                $sets[]   = 'assigned_to = ?';
                $params[] = $input['assignedTo'] ?: null;
            }
            if (array_key_exists('sentAt', $input)) {
                $sets[]   = 'sent_at = ?';
                $params[] = Util::mysqlDateTime(Util::dateTime($input['sentAt'], 'sent_at'));
            }
            if (array_key_exists('returnedAt', $input)) {
                $sets[]   = 'returned_at = ?';
                $params[] = Util::mysqlDateTime(Util::dateTime($input['returnedAt'], 'returned_at'));
            }

            $statusChanged = $newStatus !== null && $newStatus !== $repair['status'];

            if ($statusChanged) {
                $sets[]   = 'status = ?';
                $params[] = $newStatus;

                if (in_array($newStatus, self::CLOSED, true)) {
                    $sets[] = 'closed_at = NOW()';
                }
                // Moving a repair to "with vendor" without a date is the single
                // most common omission, so fill it in rather than nag.
                if ($newStatus === 'with_vendor' && empty($repair['sent_at']) && !array_key_exists('sentAt', $input)) {
                    $sets[] = 'sent_at = NOW()';
                }
            }

            if ($sets !== []) {
                $sets[]   = 'updated_at = NOW()';
                $params[] = $repairId;
                Db::execute('UPDATE repairs SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
            }

            $notes = Util::str($input['notes'] ?? null);

            if ($statusChanged || $notes !== null) {
                Db::execute(
                    'INSERT INTO repair_events (repair_id, event_type, from_status, to_status, actor_id, notes)
                     VALUES (?, ?, ?, ?, ?, ?)',
                    [
                        $repairId,
                        $statusChanged ? 'status_changed' : 'note',
                        $statusChanged ? $repair['status'] : null,
                        $statusChanged ? $newStatus : null,
                        $actorId, $notes,
                    ],
                );
            }

            // Closing a repair decides what happens to the device. A device
            // still out on loan keeps that status: it is not back on the shelf.
            if ($statusChanged && in_array($newStatus, self::CLOSED, true)) {
                $deviceStatus = match ($newStatus) {
                    'unrepairable' => 'retired',
                    default        => 'available',
                };

                Db::execute(
                    'UPDATE devices
                        SET status = CASE WHEN status = "checked_out" THEN status ELSE ? END,
                            active_repair_id = NULL, updated_at = NOW()
                      WHERE id = ?',
                    [$deviceStatus, $repair['device_id']],
                );
            }

            return ['repair' => $repair, 'statusChanged' => $statusChanged, 'newStatus' => $newStatus];
        });

        $after = self::get($organizationId, $repairId);

        if ($result['statusChanged']) {
            Audit::record($actor, [
                'organizationId' => $organizationId,
                'action'         => in_array($result['newStatus'], self::CLOSED, true)
                    ? Audit::REPAIR_CLOSED : Audit::REPAIR_UPDATED,
                'entityType'     => 'repair',
                'entityId'       => $repairId,
                'entityLabel'    => $after['reference'],
                'summary'        => sprintf(
                    'Repair %s: %s → %s',
                    $after['reference'],
                    self::STATUS_LABELS[$result['repair']['status']] ?? $result['repair']['status'],
                    self::STATUS_LABELS[$result['newStatus']] ?? $result['newStatus'],
                ),
                'detail' => ['from' => $result['repair']['status'], 'to' => $result['newStatus']],
            ]);
        } else {
            Audit::record($actor, [
                'organizationId' => $organizationId,
                'action'         => Audit::REPAIR_UPDATED,
                'entityType'     => 'repair',
                'entityId'       => $repairId,
                'entityLabel'    => $after['reference'],
                'summary'        => "Repair {$after['reference']} updated",
            ]);
        }

        // Promote anyone waiting, now the device is back.
        // Any close that leaves the device available, "cancelled" included.
        if ($result['statusChanged'] && in_array($result['newStatus'], ['repaired', 'cancelled'], true)) {
            try {
                Reservations::promoteNextForDevice($actor, $organizationId, (int) $after['device_id']);
            } catch (\Throwable $e) {
                error_log('[repairs] waitlist promotion failed: ' . $e->getMessage());
            }
        }

        return $after;
    }

    public static function list(int $organizationId, array $filters = [], array $options = []): array
    {
        $limit  = (int) ($options['limit'] ?? 50);
        $offset = (int) ($options['offset'] ?? 0);

        $where  = ['r.organization_id = ?'];
        $params = [$organizationId];

        if (!empty($filters['status'])) {
            $where[]  = 'r.status = ?';
            $params[] = $filters['status'];
        }
        if (!empty($filters['deviceId'])) {
            $where[]  = 'r.device_id = ?';
            $params[] = $filters['deviceId'];
        }
        if (!empty($filters['assignedTo'])) {
            $where[]  = 'r.assigned_to = ?';
            $params[] = $filters['assignedTo'];
        }
        if (!empty($filters['open'])) {
            $where[] = 'r.status NOT IN ("repaired", "unrepairable", "cancelled")';
        }
        if (!empty($filters['from'])) {
            $where[]  = 'r.created_at >= ?';
            $params[] = Util::mysqlDateTime($filters['from']);
        }
        if (!empty($filters['to'])) {
            $where[]  = 'r.created_at <= ?';
            $params[] = Util::mysqlDateTime($filters['to']);
        }
        if (!empty($filters['search'])) {
            $where[] = '(r.reference LIKE ? OR r.fault LIKE ? OR r.vendor LIKE ? OR d.name LIKE ? '
                     . 'OR d.barcode LIKE ?)';
            $like = '%' . $filters['search'] . '%';
            array_push($params, $like, $like, $like, $like, $like);
        }

        $whereSql = implode(' AND ', $where);

        $order = Util::orderBy($options['sort'] ?? null, [
            'created_at' => 'r.created_at', 'status' => 'r.status',
            'device' => 'd.name', 'cost' => 'r.cost', 'reference' => 'r.reference',
        ], 'r.created_at DESC');

        $rows = Db::all(
            self::SELECT . " WHERE {$whereSql} ORDER BY {$order} LIMIT {$limit} OFFSET {$offset}",
            $params,
        );

        $total = (int) Db::value(
            "SELECT COUNT(*) FROM repairs r JOIN devices d ON d.id = r.device_id WHERE {$whereSql}",
            $params,
        );

        return ['rows' => array_map([self::class, 'decorate'], $rows), 'total' => $total];
    }

    /**
     * Repair cost and reliability summary.
     *
     * Costs come from the repairs table alone. Joining to loans to count usage
     * in the same query would multiply each cost by the number of loans, which
     * is how a maintenance budget ends up reported several times over.
     */
    public static function summary(int $organizationId, ?string $from = null, ?string $to = null): array
    {
        // Columns are qualified with "r." because the same clause is reused
        // against both the bare repairs table and queries that join devices,
        // where an unqualified organization_id is ambiguous.
        $where  = ['r.organization_id = ?'];
        $params = [$organizationId];

        if ($from !== null) {
            $where[]  = 'r.created_at >= ?';
            $params[] = Util::mysqlDateTime($from);
        }
        if ($to !== null) {
            $where[]  = 'r.created_at <= ?';
            $params[] = Util::mysqlDateTime($to);
        }
        $whereSql = implode(' AND ', $where);

        $totals = Db::one(
            "SELECT COUNT(*) AS repair_count,
                    SUM(r.status NOT IN ('repaired','unrepairable','cancelled')) AS open_count,
                    SUM(r.status = 'repaired') AS repaired_count,
                    SUM(r.status = 'unrepairable') AS written_off_count,
                    COALESCE(SUM(r.cost), 0) AS total_cost,
                    COALESCE(SUM(CASE WHEN r.under_warranty = 1 THEN r.cost ELSE 0 END), 0) AS warranty_cost,
                    AVG(CASE WHEN r.closed_at IS NOT NULL
                             THEN TIMESTAMPDIFF(DAY, r.created_at, r.closed_at) END) AS avg_days_to_close
               FROM repairs r WHERE {$whereSql}",
            $params,
        );

        $byDevice = Db::all(
            "SELECT r.device_id, d.name AS device_name, d.barcode, d.category,
                    COUNT(*) AS repair_count, COALESCE(SUM(r.cost), 0) AS total_cost
               FROM repairs r JOIN devices d ON d.id = r.device_id
              WHERE {$whereSql}
              GROUP BY r.device_id, d.name, d.barcode, d.category
              HAVING repair_count > 0
              ORDER BY repair_count DESC, total_cost DESC
              LIMIT 20",
            $params,
        );

        $byCategory = Db::all(
            "SELECT COALESCE(d.category, 'Uncategorised') AS category,
                    COUNT(*) AS repair_count, COALESCE(SUM(r.cost), 0) AS total_cost
               FROM repairs r JOIN devices d ON d.id = r.device_id
              WHERE {$whereSql}
              GROUP BY COALESCE(d.category, 'Uncategorised')
              ORDER BY repair_count DESC",
            $params,
        );

        // Devices that have been in more than once. The question behind the
        // report is "repair it again, or replace it?", and a device on its
        // third visit is usually answering that question itself.
        $repeatOffenders = [];
        foreach ($byDevice as $row) {
            if ((int) $row['repair_count'] < 2) {
                continue;
            }
            $repeatOffenders[] = [
                'id'           => (int) $row['device_id'],
                'name'         => $row['device_name'],
                'barcode'      => $row['barcode'],
                'category'     => $row['category'],
                'repair_count' => (int) $row['repair_count'],
                'total_cost'   => round((float) $row['total_cost'], 2),
            ];
        }

        // Who the work goes to, what it costs, and how long they keep it.
        // Turnaround is measured from sending to getting it back, not to the
        // ticket being closed, so paperwork does not count against a vendor.
        $byVendor = Db::all(
            "SELECT COALESCE(NULLIF(r.vendor, ''), 'In house') AS vendor,
                    COUNT(*) AS tickets,
                    COALESCE(SUM(r.cost), 0) AS cost,
                    AVG(CASE WHEN r.sent_at IS NOT NULL AND r.returned_at IS NOT NULL
                             THEN TIMESTAMPDIFF(DAY, r.sent_at, r.returned_at) END) AS avg_days
               FROM repairs r WHERE {$whereSql}
              GROUP BY COALESCE(NULLIF(r.vendor, ''), 'In house')
              ORDER BY cost DESC, tickets DESC",
            $params,
        );

        foreach ($byVendor as &$vendor) {
            $vendor['tickets']  = (int) $vendor['tickets'];
            $vendor['cost']     = round((float) $vendor['cost'], 2);
            // Zero, not null: this reads into "N days" on screen, and a
            // vendor nothing has been sent to yet has no turnaround at all.
            $vendor['avg_days'] = $vendor['avg_days'] === null
                ? 0 : round((float) $vendor['avg_days'], 1);
        }
        unset($vendor);

        $totalCost    = round((float) $totals['total_cost'], 2);
        $warrantyCost = round((float) $totals['warranty_cost'], 2);

        return [
            // Flattened alongside the grouped version. The reports screen
            // reads these names; the repairs screen reads totals. Both are
            // the same numbers, computed once.
            'open'          => (int) $totals['open_count'],
            'repaired'      => (int) $totals['repaired_count'],
            'unrepairable'  => (int) $totals['written_off_count'],
            'total_cost'    => $totalCost,
            'warranty_cost' => $warrantyCost,
            // What the organisation actually paid, as opposed to what was
            // covered. This is the figure a budget conversation needs.
            'out_of_warranty_cost' => round($totalCost - $warrantyCost, 2),
            'avg_days_to_close' => $totals['avg_days_to_close'] === null
                ? 0 : round((float) $totals['avg_days_to_close'], 1),
            'repeat_offenders'  => $repeatOffenders,
            'by_vendor'         => $byVendor,

            'totals' => [
                'repair_count'      => (int) $totals['repair_count'],
                'open_count'        => (int) $totals['open_count'],
                'repaired_count'    => (int) $totals['repaired_count'],
                'written_off_count' => (int) $totals['written_off_count'],
                'total_cost'        => round((float) $totals['total_cost'], 2),
                'warranty_cost'     => round((float) $totals['warranty_cost'], 2),
                'avg_days_to_close' => $totals['avg_days_to_close'] === null
                    ? null : round((float) $totals['avg_days_to_close'], 1),
            ],
            'by_device'   => $byDevice,
            'by_category' => $byCategory,
            'range'       => ['from' => $from, 'to' => $to],
        ];
    }

    /** Status list and technicians, for populating the repair form. */
    public static function meta(int $organizationId): array
    {
        return [
            'statuses' => array_map(
                static fn (string $s): array => ['value' => $s, 'label' => self::STATUS_LABELS[$s]],
                self::STATUSES,
            ),
            'closed_statuses' => self::CLOSED,
            'technicians'     => Db::all(
                'SELECT id, full_name FROM users
                  WHERE organization_id = ? AND active = 1 AND role IN ("admin", "tech")
                  ORDER BY full_name',
                [$organizationId],
            ),
        ];
    }
}
