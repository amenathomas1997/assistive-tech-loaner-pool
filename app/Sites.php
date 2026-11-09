<?php
/**
 * Sites, and equipment moving between them.
 *
 * A state agency holds stock in regional offices. Before this, `location` was
 * free text on the device, which cannot answer "what is in the Tulsa office?"
 * without everyone having typed it identically for years.
 *
 * A transfer is its own journey with its own tracking number and its own way
 * of going missing, so it is a record rather than an edit to a column. A
 * device in transit is in neither office, and saying so is the point.
 */

declare(strict_types=1);

namespace Loaner;

final class Sites
{
    public const TRANSFER_STATUSES = ['pending', 'in_transit', 'received', 'cancelled'];

    // -----------------------------------------------------------------------
    // Sites
    // -----------------------------------------------------------------------

    /** @return array<int, array<string, mixed>> */
    public static function all(int $organizationId, bool $includeInactive = false): array
    {
        return Db::all(
            'SELECT s.*,
                    (SELECT COUNT(*) FROM devices d
                      WHERE d.site_id = s.id AND d.status <> "retired") AS device_count,
                    (SELECT COUNT(*) FROM devices d
                      WHERE d.site_id = s.id AND d.status = "available") AS available_count,
                    (SELECT COUNT(*) FROM users u WHERE u.site_id = s.id AND u.active = 1)
                        AS staff_count
               FROM sites s
              WHERE s.organization_id = ?' . ($includeInactive ? '' : ' AND s.active = 1') . '
              ORDER BY s.name',
            [$organizationId],
        );
    }

    public static function get(int $organizationId, int $siteId): ?array
    {
        return Db::one(
            'SELECT * FROM sites WHERE id = ? AND organization_id = ?',
            [$siteId, $organizationId],
        );
    }

    public static function create(?array $actor, int $organizationId, array $input): array
    {
        $name = Util::requiredStr($input['name'] ?? null, 'name', 190);

        try {
            $id = Db::insert(
                'INSERT INTO sites (organization_id, name, code, address, contact_email, phone, active)
                 VALUES (?, ?, ?, ?, ?, ?, ?)',
                [
                    $organizationId, $name,
                    Util::boundedStr($input['code'] ?? null, 'code', 32) ?: null,
                    Util::str($input['address'] ?? null),
                    Util::email($input['contact_email'] ?? $input['contactEmail'] ?? null, 'contact_email'),
                    Util::boundedStr($input['phone'] ?? null, 'phone', 40),
                    Util::bool($input['active'] ?? true, true) ? 1 : 0,
                ],
            );
        } catch (\Throwable $e) {
            if (Db::isDuplicate($e)) {
                throw Util::conflict('Another site already uses that code.', ['field' => 'code']);
            }
            throw $e;
        }

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::SITE_CREATED,
            'entityType'     => 'site',
            'entityId'       => $id,
            'entityLabel'    => $name,
            'summary'        => "Site \"{$name}\" added",
        ]);

        return self::get($organizationId, $id);
    }

    public static function update(?array $actor, int $organizationId, int $siteId, array $input): array
    {
        $before = self::get($organizationId, $siteId);
        if ($before === null) {
            throw Util::notFound('That site does not exist.');
        }

        $sets   = [];
        $params = [];

        foreach ([
            ['name', 190], ['code', 32], ['phone', 40],
        ] as [$column, $max]) {
            if (array_key_exists($column, $input)) {
                $sets[]   = "{$column} = ?";
                $params[] = Util::boundedStr($input[$column], $column, $max) ?: null;
            }
        }
        if (array_key_exists('address', $input)) {
            $sets[]   = 'address = ?';
            $params[] = Util::str($input['address']);
        }
        foreach (['contact_email', 'contactEmail'] as $key) {
            if (array_key_exists($key, $input)) {
                $sets[]   = 'contact_email = ?';
                $params[] = Util::email($input[$key], 'contact_email');
                break;
            }
        }
        if (array_key_exists('active', $input)) {
            $sets[]   = 'active = ?';
            $params[] = Util::bool($input['active']) ? 1 : 0;
        }

        if ($sets === []) {
            return $before;
        }

        $params[] = $siteId;
        $params[] = $organizationId;

        try {
            Db::execute(
                'UPDATE sites SET ' . implode(', ', $sets) . ' WHERE id = ? AND organization_id = ?',
                $params,
            );
        } catch (\Throwable $e) {
            if (Db::isDuplicate($e)) {
                throw Util::conflict('Another site already uses that code.', ['field' => 'code']);
            }
            throw $e;
        }

        $after = self::get($organizationId, $siteId);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::SITE_UPDATED,
            'entityType'     => 'site',
            'entityId'       => $siteId,
            'entityLabel'    => $after['name'],
            'summary'        => "Site \"{$after['name']}\" updated",
            'detail'         => Audit::diff($before, $after, ['name', 'code', 'contact_email', 'active']),
        ]);

        return $after;
    }

    // -----------------------------------------------------------------------
    // Transfers
    // -----------------------------------------------------------------------

    private const TRANSFER_SELECT = '
        SELECT t.*,
               d.name AS device_name, d.barcode AS device_barcode, d.status AS device_status,
               fs.name AS from_site_name, ts.name AS to_site_name,
               su.full_name AS sent_by_name, ru.full_name AS received_by_name
          FROM device_transfers t
          JOIN devices d ON d.id = t.device_id
          LEFT JOIN sites fs ON fs.id = t.from_site_id
          JOIN sites ts ON ts.id = t.to_site_id
          LEFT JOIN users su ON su.id = t.sent_by
          LEFT JOIN users ru ON ru.id = t.received_by';

    /**
     * Send a device to another site.
     *
     * Refuses while the device is on loan. A transfer and a loan are both
     * claims on where the thing physically is, and letting both be true at
     * once is how equipment becomes unfindable.
     */
    public static function send(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $deviceId       = (int) $input['deviceId'];
        $toSiteId       = (int) $input['toSiteId'];

        $created = Db::transaction(static function () use (
            $organizationId, $deviceId, $toSiteId, $input
        ): array {
            $device = Db::one(
                'SELECT * FROM devices WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$deviceId, $organizationId],
            );
            if ($device === null) {
                throw Util::notFound('That device does not exist.');
            }

            $destination = self::get($organizationId, $toSiteId);
            if ($destination === null) {
                throw Util::badRequest('That site does not exist.', ['field' => 'to_site_id']);
            }

            $open = Db::one(
                'SELECT reference FROM device_transfers
                  WHERE device_id = ? AND status IN ("pending", "in_transit")',
                [$deviceId],
            );
            if ($open !== null) {
                throw Util::conflict(
                    "{$device['name']} is already being transferred ({$open['reference']}).",
                    ['reference' => $open['reference']],
                );
            }

            if ((int) ($device['site_id'] ?? 0) === $toSiteId) {
                throw Util::conflict(
                    "{$device['name']} is already at {$destination['name']}.",
                    ['site_id' => $toSiteId],
                );
            }

            $loan = Loans::activeLoanForDevice($deviceId, true);
            if ($loan !== null) {
                throw Util::conflict(
                    "{$device['name']} is out on loan ({$loan['reference']}). It has to come back "
                    . 'before it can be sent to another site.',
                    ['loan_reference' => $loan['reference']],
                );
            }

            // Sending marks a device "maintenance" and receiving marks it
            // "available", so only a device that really is available can go
            // through that round trip. Anything else would come out the far
            // end with its real status gone: a retired device back in stock,
            // a device under repair ready to lend, a waitlist hold forgotten.
            if ($device['status'] !== 'available') {
                throw Util::conflict(
                    $device['status'] === 'reserved'
                        ? "{$device['name']} is being held for someone. Release the hold before sending it."
                        : sprintf(
                            '%s is marked "%s", so it cannot be sent to another site.',
                            $device['name'], str_replace('_', ' ', (string) $device['status']),
                        ),
                    ['status' => $device['status']],
                );
            }

            for ($attempt = 0; $attempt < 6; $attempt++) {
                $reference = Util::makeReference('TR');

                try {
                    $id = Db::insert(
                        'INSERT INTO device_transfers
                           (organization_id, reference, device_id, from_site_id, to_site_id,
                            status, carrier, tracking, sent_at, sent_by, notes)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            $organizationId, $reference, $deviceId,
                            $device['site_id'] ?? null, $toSiteId,
                            Util::bool($input['sendNow'] ?? true, true) ? 'in_transit' : 'pending',
                            Util::boundedStr($input['carrier'] ?? null, 'carrier', 64),
                            Util::boundedStr($input['tracking'] ?? null, 'tracking', 120),
                            Util::bool($input['sendNow'] ?? true, true) ? Util::mysqlDateTime('now') : null,
                            $input['actorId'] ?? null,
                            Util::str($input['notes'] ?? null),
                        ],
                    );

                    // In transit is neither here nor there, and the status says
                    // so rather than leaving it looking available at an office
                    // it has already left.
                    if (Util::bool($input['sendNow'] ?? true, true)) {
                        Db::execute(
                            'UPDATE devices SET status = "maintenance", updated_at = NOW() WHERE id = ?',
                            [$deviceId],
                        );
                    }

                    return ['id' => $id, 'reference' => $reference,
                            'device' => $device, 'destination' => $destination];
                } catch (\Throwable $e) {
                    if (Db::isDuplicate($e) && str_contains($e->getMessage(), 'reference')) {
                        continue;
                    }
                    throw $e;
                }
            }

            throw new \RuntimeException('Could not allocate a unique transfer reference.');
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::DEVICE_TRANSFERRED,
            'entityType'     => 'device',
            'entityId'       => $deviceId,
            'entityLabel'    => $created['device']['name'],
            'summary'        => sprintf(
                '%s sent to %s (%s)',
                $created['device']['name'], $created['destination']['name'], $created['reference'],
            ),
        ]);

        return self::transfer($organizationId, $created['id']);
    }

    /** Confirm a device arrived. This is what actually moves it. */
    public static function receive(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $transferId     = (int) $input['transferId'];

        $transfer = Db::transaction(static function () use ($organizationId, $transferId, $input): array {
            $transfer = Db::one(
                'SELECT * FROM device_transfers WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$transferId, $organizationId],
            );
            if ($transfer === null) {
                throw Util::notFound('That transfer does not exist.');
            }
            if (in_array($transfer['status'], ['received', 'cancelled'], true)) {
                throw Util::conflict(
                    "Transfer {$transfer['reference']} is already {$transfer['status']}.",
                    ['status' => $transfer['status']],
                );
            }

            $device = Db::one(
                'SELECT id, name, status, active_repair_id FROM devices WHERE id = ? FOR UPDATE',
                [$transfer['device_id']],
            );

            // A transfer that was only ever pending never took the device out
            // of service, so it can have been lent in the meantime.
            $loan = Loans::activeLoanForDevice((int) $device['id'], true);
            if ($loan !== null) {
                throw Util::conflict(
                    "{$device['name']} is out on loan ({$loan['reference']}), so it cannot be received "
                    . 'at another site. Cancel this transfer, or check the device in first.',
                    ['loan_reference' => $loan['reference']],
                );
            }

            Db::execute(
                'UPDATE device_transfers
                    SET status = "received", received_at = NOW(), received_by = ?,
                        notes = COALESCE(?, notes)
                  WHERE id = ?',
                [$input['actorId'] ?? null, Util::str($input['notes'] ?? null), $transferId],
            );

            // Arriving is what changes where the device is, and it comes back
            // into service at the far end.
            // Only undo what sending did. "maintenance" on a device with an
            // open repair is the repair's, not the courier's.
            Db::execute(
                'UPDATE devices
                    SET site_id = ?,
                        status = CASE WHEN ? = 1 AND status = "maintenance" AND active_repair_id IS NULL
                                      THEN "available" ELSE status END,
                        updated_at = NOW()
                  WHERE id = ?',
                [$transfer['to_site_id'], $transfer['status'] === 'in_transit' ? 1 : 0, $transfer['device_id']],
            );

            return $transfer;
        });

        $full = self::transfer($organizationId, $transferId);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::DEVICE_TRANSFERRED,
            'entityType'     => 'device',
            'entityId'       => (int) $transfer['device_id'],
            'entityLabel'    => $full['device_name'],
            'summary'        => sprintf(
                '%s received at %s (%s)',
                $full['device_name'], $full['to_site_name'], $full['reference'],
            ),
        ]);

        // Somebody at the destination may have been waiting for it.
        try {
            Reservations::promoteNextForDevice($actor, $organizationId, (int) $transfer['device_id']);
        } catch (\Throwable $e) {
            error_log('[sites] waitlist promotion failed: ' . $e->getMessage());
        }

        return $full;
    }

    public static function cancelTransfer(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $transferId     = (int) $input['transferId'];

        $transfer = Db::transaction(static function () use ($organizationId, $transferId, $input): array {
            $transfer = Db::one(
                'SELECT * FROM device_transfers WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$transferId, $organizationId],
            );
            if ($transfer === null) {
                throw Util::notFound('That transfer does not exist.');
            }
            if ($transfer['status'] === 'received') {
                throw Util::conflict(
                    'That transfer has already been received. Send it back the other way instead.',
                );
            }
            if ($transfer['status'] === 'cancelled') {
                throw Util::conflict('That transfer has already been cancelled.');
            }

            Db::execute(
                'UPDATE device_transfers SET status = "cancelled", notes = COALESCE(?, notes) WHERE id = ?',
                [Util::str($input['reason'] ?? null), $transferId],
            );

            // Put it back into service where it still physically is.
            // Only an in-transit transfer changed the status, and then only
            // if no repair has claimed the device since.
            if ($transfer['status'] === 'in_transit') {
                Db::execute(
                    'UPDATE devices SET status = "available", updated_at = NOW()
                      WHERE id = ? AND status = "maintenance" AND active_repair_id IS NULL',
                    [$transfer['device_id']],
                );
            }

            return $transfer;
        });

        $full = self::transfer($organizationId, $transferId);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::DEVICE_TRANSFERRED,
            'entityType'     => 'device',
            'entityId'       => (int) $transfer['device_id'],
            'entityLabel'    => $full['device_name'],
            'summary'        => "Transfer {$full['reference']} cancelled",
        ]);

        try {
            Reservations::promoteNextForDevice($actor, $organizationId, (int) $transfer['device_id']);
        } catch (\Throwable $e) {
            error_log('[sites] waitlist promotion after cancel failed: ' . $e->getMessage());
        }

        return $full;
    }

    public static function transfer(int $organizationId, int $transferId): ?array
    {
        return Db::one(
            self::TRANSFER_SELECT . ' WHERE t.id = ? AND t.organization_id = ?',
            [$transferId, $organizationId],
        );
    }

    public static function transfers(int $organizationId, array $filters = [], array $options = []): array
    {
        $limit  = (int) ($options['limit'] ?? 50);
        $offset = (int) ($options['offset'] ?? 0);

        $where  = ['t.organization_id = ?'];
        $params = [$organizationId];

        if (!empty($filters['status'])) {
            $where[]  = 't.status = ?';
            $params[] = $filters['status'];
        }
        if (!empty($filters['open'])) {
            $where[] = 't.status IN ("pending", "in_transit")';
        }
        if (!empty($filters['deviceId'])) {
            $where[]  = 't.device_id = ?';
            $params[] = $filters['deviceId'];
        }
        if (!empty($filters['siteId'])) {
            $where[]  = '(t.from_site_id = ? OR t.to_site_id = ?)';
            $params[] = $filters['siteId'];
            $params[] = $filters['siteId'];
        }

        $whereSql = implode(' AND ', $where);

        $rows = Db::all(
            self::TRANSFER_SELECT . " WHERE {$whereSql} ORDER BY t.created_at DESC "
            . "LIMIT {$limit} OFFSET {$offset}",
            $params,
        );

        $total = (int) Db::value(
            "SELECT COUNT(*) FROM device_transfers t WHERE {$whereSql}",
            $params,
        );

        return ['rows' => $rows, 'total' => $total];
    }
}
