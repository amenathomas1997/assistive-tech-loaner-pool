<?php
/**
 * Reservations and waitlist.
 *
 * Two kinds: a specific device ("hold this exact unit"), or a category ("the
 * next available magnifier"), which is what a waitlist actually is.
 *
 * When a device is checked in, the queue is consulted and the first matching
 * entry is promoted to `ready`, the device is held, and the requester is
 * notified. The hold expires after a configurable window so one person who
 * never collects cannot block everyone behind them indefinitely.
 *
 * Queue position is (priority DESC, created_at ASC) — computed, never stored,
 * because a stored position has to be renumbered on every insertion and
 * cancellation and is wrong the moment that fails halfway.
 */

declare(strict_types=1);

namespace Loaner;

final class Reservations
{
    public const STATUSES = ['waiting', 'ready', 'fulfilled', 'cancelled', 'expired'];

    private const SELECT = '
        SELECT r.*,
               d.name AS device_name, d.barcode AS device_barcode, d.status AS device_status,
               rd.name AS ready_device_name, rd.barcode AS ready_device_barcode,
               c.first_name AS client_first_name, c.last_name AS client_last_name, c.email AS client_email,
               p.name AS program_name,
               u.full_name AS requester_name, u.email AS requester_email,
               l.reference AS loan_reference
          FROM reservations r
          LEFT JOIN devices d ON d.id = r.device_id
          LEFT JOIN devices rd ON rd.id = r.ready_device_id
          LEFT JOIN clients c ON c.id = r.client_id
          LEFT JOIN programs p ON p.id = r.program_id
          LEFT JOIN users u ON u.id = r.requested_by
          LEFT JOIN loans l ON l.id = r.fulfilled_loan_id';

    /**
     * Join the queue.
     *
     * If the requested thing is free right now, that is reported back rather
     * than silently queued — telling someone they are "position 1 in the queue"
     * for a device sitting on the shelf is a good way to lose trust in it.
     */
    public static function create(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $requestedBy    = (int) $input['requestedBy'];
        // A form's <select> sends "12", not 12, and findAvailableMatch() takes
        // an ?int under strict_types. Normalised here so the waitlist form
        // cannot produce a server error by being a form.
        $deviceId       = Util::int($input['deviceId'] ?? null, 'device_id', 1);
        $category       = $input['category'] ?? null;

        if (!$deviceId && !$category) {
            throw Util::badRequest(
                'Choose a specific device or a category to wait for.',
                ['fields' => ['device_id', 'category']],
            );
        }

        $available = self::findAvailableMatch($organizationId, $deviceId, $category);

        $created = Db::transaction(static function () use ($organizationId, $input, $deviceId, $category, $requestedBy): array {
            if ($deviceId) {
                $device = Db::one(
                    'SELECT id, name FROM devices WHERE id = ? AND organization_id = ?',
                    [$deviceId, $organizationId],
                );
                if ($device === null) {
                    throw Util::badRequest('That device does not exist.', ['field' => 'device_id']);
                }

                $duplicate = Db::one(
                    'SELECT reference FROM reservations
                      WHERE device_id = ? AND requested_by = ? AND status IN ("waiting", "ready")',
                    [$deviceId, $requestedBy],
                );
                if ($duplicate !== null) {
                    throw Util::conflict(
                        "You are already on the waitlist for this device ({$duplicate['reference']}).",
                        ['reference' => $duplicate['reference']],
                    );
                }
            }

            // Checked here rather than left to the foreign key, so a bad id
            // comes back naming the field instead of as an opaque 500.
            foreach ([
                ['clients', $input['clientId'] ?? null, 'client', 'client_id'],
                ['programs', $input['programId'] ?? null, 'program', 'program_id'],
            ] as [$table, $id, $label, $field]) {
                if (empty($id)) {
                    continue;
                }
                $exists = Db::value(
                    "SELECT id FROM {$table} WHERE id = ? AND organization_id = ?",
                    [$id, $organizationId],
                );
                if ($exists === null) {
                    throw Util::badRequest("That {$label} does not exist.", ['field' => $field]);
                }
            }

            for ($attempt = 0; $attempt < 6; $attempt++) {
                $reference = Util::makeReference('RS');
                try {
                    $id = Db::insert(
                        'INSERT INTO reservations
                           (organization_id, reference, device_id, category, client_id, program_id,
                            request_id, requested_by, priority, needed_from, needed_to, notes)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            $organizationId, $reference, $deviceId, $category,
                            $input['clientId'] ?? null, $input['programId'] ?? null,
                            $input['requestId'] ?? null, $requestedBy,
                            (int) ($input['priority'] ?? 0),
                            $input['neededFrom'] ?? null, $input['neededTo'] ?? null,
                            $input['notes'] ?? null,
                        ],
                    );
                    return ['id' => $id, 'reference' => $reference];
                } catch (\Throwable $e) {
                    if (Db::isDuplicate($e) && str_contains($e->getMessage(), 'reference')) {
                        continue;
                    }
                    throw $e;
                }
            }

            throw new \RuntimeException('Could not allocate a unique reservation reference.');
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::RESERVATION_CREATED,
            'entityType'     => 'reservation',
            'entityId'       => $created['id'],
            'entityLabel'    => $created['reference'],
            'summary'        => "Waitlist entry {$created['reference']} for " . ($category ?? "device {$deviceId}"),
            'detail'         => ['device_id' => $deviceId, 'category' => $category,
                                 'available_now' => $available !== null],
        ]);

        return [
            'reservation'   => self::get($organizationId, $created['id']),
            // Surfaced so the UI can say "this is actually free now" instead of
            // pretending a queue is needed.
            'available_now' => $available === null ? null : [
                'id' => (int) $available['id'], 'name' => $available['name'], 'barcode' => $available['barcode'],
            ],
        ];
    }

    private static function findAvailableMatch(int $organizationId, ?int $deviceId, ?string $category): ?array
    {
        if ($deviceId) {
            return Db::one(
                'SELECT d.id, d.name, d.barcode FROM devices d
                  WHERE d.id = ? AND d.organization_id = ? AND d.status = "available"
                    AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.device_id = d.id AND l.status = "active")',
                [$deviceId, $organizationId],
            );
        }

        return Db::one(
            'SELECT d.id, d.name, d.barcode FROM devices d
              WHERE d.organization_id = ? AND d.category = ? AND d.status = "available"
                AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.device_id = d.id AND l.status = "active")
                AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.ready_device_id = d.id AND r.status = "ready")
              ORDER BY d.id ASC LIMIT 1',
            [$organizationId, $category],
        );
    }

    /**
     * Called after a device is checked in or otherwise becomes free.
     *
     * Promotes at most one waiting entry, because only one device became free.
     * Returns null when nobody is waiting, which is the common case and must
     * therefore be cheap.
     */
    public static function promoteNextForDevice(?array $actor, int $organizationId, int $deviceId): ?array
    {
        $holdHours = (int) Settings::get($organizationId, 'reservations.hold_hours') ?: 48;

        $promoted = Db::transaction(static function () use ($organizationId, $deviceId, $holdHours): ?array {
            $device = Db::one(
                'SELECT id, name, barcode, category, status FROM devices
                  WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$deviceId, $organizationId],
            );

            if ($device === null || $device['status'] !== 'available') {
                return null;
            }

            // Anyone waiting for this exact device outranks the category queue:
            // they asked for this unit specifically.
            //
            // needed_from and needed_to were stored and never read. Somebody
            // who reserved a magnifier for a course starting in three weeks
            // was promoted the day one came back, told to collect it within
            // the hold window, and expired when they did not — their place
            // gone before the course began. A hold is only offered to someone
            // whose window has opened, or opens before the hold would lapse,
            // and has not already closed.
            $holdDays = max(1, (int) ceil($holdHours / 24));

            $candidate = Db::one(
                'SELECT * FROM reservations
                  WHERE organization_id = ? AND status = "waiting"
                    AND (device_id = ? OR (device_id IS NULL AND category <=> ?))
                    AND (needed_from IS NULL OR needed_from <= DATE_ADD(CURDATE(), INTERVAL ? DAY))
                    AND (needed_to IS NULL OR needed_to >= CURDATE())
                  ORDER BY (device_id IS NULL) ASC, priority DESC, created_at ASC
                  LIMIT 1
                  FOR UPDATE',
                [$organizationId, $deviceId, $device['category'], $holdDays],
            );

            if ($candidate === null) {
                return null;
            }

            $expiresAt = new \DateTimeImmutable("+{$holdHours} hours");

            Db::execute(
                'UPDATE reservations
                    SET status = "ready", ready_device_id = ?, notified_at = NOW(),
                        claim_expires_at = ?, updated_at = NOW()
                  WHERE id = ?',
                [$device['id'], Util::mysqlDateTime($expiresAt), $candidate['id']],
            );

            // Hold the device so a walk-in check-out cannot take it from under
            // the person who has just been told it is ready.
            Db::execute('UPDATE devices SET status = "reserved", updated_at = NOW() WHERE id = ?', [$device['id']]);

            return ['reservation' => $candidate, 'device' => $device, 'expiresAt' => $expiresAt];
        });

        if ($promoted === null) {
            return null;
        }

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::RESERVATION_READY,
            'entityType'     => 'reservation',
            'entityId'       => (int) $promoted['reservation']['id'],
            'entityLabel'    => $promoted['reservation']['reference'],
            'summary'        => sprintf(
                '%s held for %s until %s',
                $promoted['device']['name'],
                $promoted['reservation']['reference'],
                $promoted['expiresAt']->format('D j M Y'),
            ),
            'detail' => ['device_id' => (int) $promoted['device']['id'], 'hold_hours' => $holdHours],
        ]);

        $reservation = self::get($organizationId, (int) $promoted['reservation']['id']);

        if (Settings::get($organizationId, 'notify.reservation_ready')) {
            Notifications::reservationReady($actor, $organizationId, $reservation);
        }

        return $reservation;
    }

    /**
     * Release holds nobody collected, and pass the device to the next in line.
     * Called by the scheduled job.
     */
    public static function expireStaleClaims(int $organizationId): int
    {
        $stale = Db::all(
            'SELECT id, reference, ready_device_id FROM reservations
              WHERE organization_id = ? AND status = "ready"
                AND claim_expires_at IS NOT NULL AND claim_expires_at < NOW()',
            [$organizationId],
        );

        foreach ($stale as $row) {
            Db::transaction(static function () use ($row): void {
                Db::execute(
                    'UPDATE reservations SET status = "expired", closed_at = NOW(), updated_at = NOW() WHERE id = ?',
                    [$row['id']],
                );
                if ($row['ready_device_id'] !== null) {
                    Db::execute(
                        'UPDATE devices SET status = "available", updated_at = NOW()
                          WHERE id = ? AND status = "reserved"',
                        [$row['ready_device_id']],
                    );
                }
            });

            // The device is free again — offer it to whoever is next.
            if ($row['ready_device_id'] !== null) {
                try {
                    self::promoteNextForDevice(
                        Audit::system($organizationId),
                        $organizationId,
                        (int) $row['ready_device_id'],
                    );
                } catch (\Throwable) {
                }
            }
        }

        return count($stale);
    }

    public static function cancel(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $reservationId  = (int) $input['reservationId'];
        $reason         = $input['reason'] ?? null;
        $auth           = $input['auth'] ?? null;

        $reservation = Db::transaction(static function () use ($organizationId, $reservationId, $reason, $auth): array {
            $reservation = Db::one(
                'SELECT * FROM reservations WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$reservationId, $organizationId],
            );
            if ($reservation === null) {
                throw Util::notFound('That reservation does not exist.');
            }

            if (Auth::isRestrictedToOwnRecords($auth) && (int) $reservation['requested_by'] !== (int) $auth['userId']) {
                throw Util::forbidden('You can only cancel waitlist entries you created.');
            }
            if (!in_array($reservation['status'], ['waiting', 'ready'], true)) {
                throw Util::conflict(
                    "That reservation is already {$reservation['status']}.",
                    ['status' => $reservation['status']],
                );
            }

            Db::execute(
                'UPDATE reservations
                    SET status = "cancelled", closed_at = NOW(), updated_at = NOW(),
                        notes = CASE WHEN ? IS NULL THEN notes ELSE CONCAT(COALESCE(notes, ""), ?) END
                  WHERE id = ?',
                [$reason, $reason !== null ? "\n[cancelled] {$reason}" : null, $reservationId],
            );

            if ($reservation['ready_device_id'] !== null) {
                Db::execute(
                    'UPDATE devices SET status = "available", updated_at = NOW()
                      WHERE id = ? AND status = "reserved"',
                    [$reservation['ready_device_id']],
                );
            }

            return $reservation;
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::RESERVATION_CANCELLED,
            'entityType'     => 'reservation',
            'entityId'       => $reservationId,
            'entityLabel'    => $reservation['reference'],
            'summary'        => "Waitlist entry {$reservation['reference']} cancelled"
                              . ($reason !== null ? ": {$reason}" : ''),
        ]);

        // Their held device goes to the next person straight away.
        if ($reservation['ready_device_id'] !== null) {
            try {
                self::promoteNextForDevice($actor, $organizationId, (int) $reservation['ready_device_id']);
            } catch (\Throwable) {
            }
        }

        return self::get($organizationId, $reservationId);
    }

    /**
     * Mark a reservation as satisfied by a loan.
     *
     * Called by Loans::checkOut from inside its transaction, when the device a
     * hold was for goes out to the person it was held for. Until that call
     * existed nothing invoked this at all, so every collected reservation sat
     * at "ready" until the hold lapsed and it was recorded as expired — the
     * waitlist's own history said nobody ever collected anything.
     */
    public static function markFulfilled(int $organizationId, int $reservationId, int $loanId): void
    {
        $changed = Db::execute(
            'UPDATE reservations
                SET status = "fulfilled", fulfilled_loan_id = ?, closed_at = NOW(), updated_at = NOW()
              WHERE id = ? AND organization_id = ? AND status IN ("ready", "waiting")',
            [$loanId, $reservationId, $organizationId],
        );

        if ($changed === 1) {
            Audit::record(Audit::system($organizationId), [
                'organizationId' => $organizationId,
                'action'         => Audit::RESERVATION_FULFILLED,
                'entityType'     => 'reservation',
                'entityId'       => $reservationId,
                'summary'        => "Waitlist entry satisfied by loan {$loanId}",
                'detail'         => ['loan_id' => $loanId],
            ]);
        }
    }

    /**
     * Put a held reservation back in the queue.
     *
     * For a hold that was overridden at the desk: the person did nothing
     * wrong, so they keep their priority and their place by date, and the next
     * matching return holds a device for them again.
     */
    public static function releaseHold(int $organizationId, int $reservationId): void
    {
        Db::execute(
            'UPDATE reservations
                SET status = "waiting", ready_device_id = NULL, claim_expires_at = NULL,
                    notified_at = NULL, updated_at = NOW()
              WHERE id = ? AND organization_id = ? AND status = "ready"',
            [$reservationId, $organizationId],
        );
    }

    /** @deprecated Use markFulfilled(); kept so an older caller does not fatally error. */
    public static function fulfil(?array $actor, int $organizationId, int $reservationId, int $loanId): ?array
    {
        self::markFulfilled($organizationId, $reservationId, $loanId);

        return self::get($organizationId, $reservationId);
    }

    public static function get(int $organizationId, int $reservationId): ?array
    {
        $row = Db::one(self::SELECT . ' WHERE r.id = ? AND r.organization_id = ?', [$reservationId, $organizationId]);

        return $row === null ? null : self::decorate($row);
    }

    private static function decorate(array $row): array
    {
        $row['client_name'] = !empty($row['client_first_name'])
            ? $row['client_first_name'] . ' ' . $row['client_last_name']
            : null;

        $row['wants'] = $row['device_name'] ?? $row['category'] ?? 'Unspecified';

        $row['queue_position'] = $row['status'] === 'waiting' ? self::positionOf($row) : null;

        $row['claim_expires_in_hours'] = $row['claim_expires_at'] !== null
            ? max(0, (int) round((strtotime((string) $row['claim_expires_at']) - time()) / 3600))
            : null;

        return $row;
    }

    /** Position is computed from the ordering, never stored. */
    private static function positionOf(array $row): int
    {
        $column = $row['device_id'] !== null ? 'device_id = ?' : 'category <=> ?';
        $value  = $row['device_id'] ?? $row['category'];

        return 1 + (int) Db::value(
            "SELECT COUNT(*) FROM reservations
              WHERE organization_id = ? AND status = 'waiting'
                AND {$column}
                AND (priority > ? OR (priority = ? AND created_at < ?))",
            [$row['organization_id'], $value, $row['priority'], $row['priority'], $row['created_at']],
        );
    }

    public static function list(int $organizationId, array $filters = [], array $options = []): array
    {
        $limit  = (int) ($options['limit'] ?? 50);
        $offset = (int) ($options['offset'] ?? 0);

        $where  = ['r.organization_id = ?'];
        $params = [$organizationId];

        if (!empty($filters['status']))      { $where[] = 'r.status = ?';       $params[] = $filters['status']; }
        if (!empty($filters['open']))        { $where[] = 'r.status IN ("waiting", "ready")'; }
        if (!empty($filters['deviceId']))    { $where[] = 'r.device_id = ?';    $params[] = $filters['deviceId']; }
        if (!empty($filters['category']))    { $where[] = 'r.category = ?';     $params[] = $filters['category']; }
        if (!empty($filters['clientId']))    { $where[] = 'r.client_id = ?';    $params[] = $filters['clientId']; }
        if (!empty($filters['requestedBy'])) { $where[] = 'r.requested_by = ?'; $params[] = $filters['requestedBy']; }

        $whereSql = implode(' AND ', $where);

        $rows = Db::all(
            self::SELECT . " WHERE {$whereSql}
              ORDER BY FIELD(r.status, 'ready', 'waiting', 'fulfilled', 'expired', 'cancelled'),
                       r.priority DESC, r.created_at ASC
              LIMIT {$limit} OFFSET {$offset}",
            $params,
        );

        $total = (int) Db::value("SELECT COUNT(*) FROM reservations r WHERE {$whereSql}", $params);

        return ['rows' => array_map([self::class, 'decorate'], $rows), 'total' => $total];
    }

    /** Anyone waiting on a given device or its category, for the device screen. */
    public static function forDevice(int $organizationId, int $deviceId): array
    {
        $device = Db::one('SELECT category FROM devices WHERE id = ? AND organization_id = ?', [$deviceId, $organizationId]);

        if ($device === null) {
            return [];
        }

        $rows = Db::all(
            self::SELECT . '
              WHERE r.organization_id = ? AND r.status IN ("waiting", "ready")
                AND (r.device_id = ? OR (r.device_id IS NULL AND r.category <=> ?))
              ORDER BY (r.device_id IS NULL) ASC, r.priority DESC, r.created_at ASC',
            [$organizationId, $deviceId, $device['category']],
        );

        return array_map([self::class, 'decorate'], $rows);
    }
}
