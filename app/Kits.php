<?php
/**
 * Kits, accessories and loan groups.
 *
 * Three related ideas, deliberately modelled differently:
 *
 *   Kit         — several barcoded devices lent together (laptop + reader +
 *                 switch interface). Each device keeps its own loan record, so
 *                 one piece can come back early without unpicking the rest.
 *   Accessory   — something not worth a barcode (a charger, a stylus) that is
 *                 nonetheless exactly what goes missing. A checklist on the
 *                 device, recorded on the loan at check-out and check-in.
 *   Group       — the shared reference that ties a kit's loans together so
 *                 they can be viewed and returned as one.
 */

declare(strict_types=1);

namespace Loaner;

final class Kits
{
    // -----------------------------------------------------------------------
    // Kits
    // -----------------------------------------------------------------------

    public static function list(int $organizationId, bool $includeInactive = false): array
    {
        $rows = Db::all(
            'SELECT k.*,
                    (SELECT COUNT(*) FROM kit_items ki WHERE ki.kit_id = k.id) AS item_count
               FROM kits k
              WHERE k.organization_id = ?' . ($includeInactive ? '' : ' AND k.active = 1') . '
              ORDER BY k.name',
            [$organizationId],
        );

        foreach ($rows as &$row) {
            $row['items'] = self::items((int) $row['id']);
            $row          = self::decorate($row);
        }

        return $rows;
    }

    public static function get(int $organizationId, int $kitId): ?array
    {
        $row = Db::one('SELECT * FROM kits WHERE id = ? AND organization_id = ?', [$kitId, $organizationId]);
        if ($row === null) {
            return null;
        }

        $row['items'] = self::items($kitId);

        return self::decorate($row);
    }

    /** @return array<int, array<string, mixed>> */
    private static function items(int $kitId): array
    {
        return Db::all(
            'SELECT ki.id, ki.device_id, ki.required, ki.sort_order,
                    d.name, d.barcode, d.category, d.status,
                    l.id AS active_loan_id, l.reference AS active_loan_reference, l.due_at
               FROM kit_items ki
               JOIN devices d ON d.id = ki.device_id
               LEFT JOIN loans l ON l.device_id = d.id AND l.status = "active"
              WHERE ki.kit_id = ?
              ORDER BY ki.sort_order, d.name',
            [$kitId],
        );
    }

    /**
     * A kit is only lendable when every required item is. Reporting that up
     * front avoids checking out half a kit and discovering the rest is out.
     */
    private static function decorate(array $kit): array
    {
        $blocking = [];

        foreach ($kit['items'] as $item) {
            if (!$item['required']) {
                continue;
            }
            if (!empty($item['active_loan_id'])) {
                $blocking[] = "{$item['name']} is on loan ({$item['active_loan_reference']})";
            } elseif ($item['status'] !== 'available') {
                $blocking[] = "{$item['name']} is marked " . str_replace('_', ' ', (string) $item['status']);
            }
        }

        $kit['item_count']    = count($kit['items']);
        $kit['can_check_out'] = $blocking === [] && $kit['items'] !== [];
        $kit['blocked_by']    = $blocking;
        $kit['availability'] = match (true) {
            $kit['items'] === [] => 'No devices in this kit yet',
            $blocking === []     => 'Ready to lend',
            default              => 'Not ready: ' . implode('; ', $blocking),
        };

        return $kit;
    }

    public static function create(?array $actor, int $organizationId, array $input): array
    {
        $name = Util::requiredStr($input['name'] ?? null, 'name', 190);

        $kitId = Db::transaction(static function () use ($organizationId, $name, $input): int {
            try {
                $kitId = Db::insert(
                    'INSERT INTO kits (organization_id, name, description, active) VALUES (?, ?, ?, ?)',
                    [$organizationId, $name, Util::str($input['description'] ?? null), Util::bool($input['active'] ?? true, true) ? 1 : 0],
                );
            } catch (\Throwable $e) {
                if (Db::isDuplicate($e)) {
                    throw Util::conflict("A kit called \"{$name}\" already exists.", ['field' => 'name']);
                }
                throw $e;
            }

            self::replaceItems($organizationId, $kitId, self::itemsFrom($input));

            return $kitId;
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::KIT_CREATED,
            'entityType'     => 'kit',
            'entityId'       => $kitId,
            'entityLabel'    => $name,
            'summary'        => "Kit \"{$name}\" created",
        ]);

        return self::get($organizationId, $kitId);
    }

    public static function update(?array $actor, int $organizationId, int $kitId, array $input): array
    {
        $before = self::get($organizationId, $kitId);
        if ($before === null) {
            throw Util::notFound('That kit does not exist.');
        }

        Db::transaction(static function () use ($organizationId, $kitId, $input): void {
            $sets   = [];
            $params = [];

            if (array_key_exists('name', $input)) {
                $sets[]   = 'name = ?';
                $params[] = Util::requiredStr($input['name'], 'name', 190);
            }
            if (array_key_exists('description', $input)) {
                $sets[]   = 'description = ?';
                $params[] = Util::str($input['description']);
            }
            if (array_key_exists('active', $input)) {
                $sets[]   = 'active = ?';
                $params[] = Util::bool($input['active']) ? 1 : 0;
            }

            if ($sets !== []) {
                $params[] = $kitId;
                try {
                    Db::execute('UPDATE kits SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
                } catch (\Throwable $e) {
                    if (Db::isDuplicate($e)) {
                        throw Util::conflict('Another kit already has that name.', ['field' => 'name']);
                    }
                    throw $e;
                }
            }

            // Only touch membership when it was actually supplied: a PATCH that
            // renames a kit must not silently empty it.
            if (array_key_exists('items', $input) || array_key_exists('device_ids', $input)
                || array_key_exists('deviceIds', $input)
            ) {
                self::replaceItems($organizationId, $kitId, self::itemsFrom($input));
            }
        });

        $after = self::get($organizationId, $kitId);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::KIT_UPDATED,
            'entityType'     => 'kit',
            'entityId'       => $kitId,
            'entityLabel'    => $after['name'],
            'summary'        => "Kit \"{$after['name']}\" updated",
            'detail'         => Audit::diff($before, $after, ['name', 'description', 'active', 'item_count']),
        ]);

        return $after;
    }

    /**
     * Membership, however it was sent.
     *
     * `items` carries per-device detail (required or not); `device_ids` is the
     * short form for the common case where everything is required.
     *
     * @return array<int, mixed>
     */
    private static function itemsFrom(array $input): array
    {
        foreach (['items', 'device_ids', 'deviceIds'] as $key) {
            if (array_key_exists($key, $input) && is_array($input[$key])) {
                return $input[$key];
            }
        }

        return [];
    }

    /** @param array<int, mixed> $items */
    private static function replaceItems(int $organizationId, int $kitId, array $items): void
    {
        Db::execute('DELETE FROM kit_items WHERE kit_id = ?', [$kitId]);

        $seen  = [];
        $order = 0;

        foreach ($items as $item) {
            $deviceId = (int) (is_array($item) ? ($item['device_id'] ?? 0) : $item);
            if ($deviceId <= 0 || isset($seen[$deviceId])) {
                continue;
            }
            $seen[$deviceId] = true;

            $exists = Db::value(
                'SELECT id FROM devices WHERE id = ? AND organization_id = ?',
                [$deviceId, $organizationId],
            );
            if ($exists === null) {
                throw Util::badRequest("Device {$deviceId} is not in this inventory.", ['field' => 'items']);
            }

            Db::execute(
                'INSERT INTO kit_items (kit_id, device_id, required, sort_order) VALUES (?, ?, ?, ?)',
                [
                    $kitId, $deviceId,
                    is_array($item) ? (Util::bool($item['required'] ?? true, true) ? 1 : 0) : 1,
                    $order++,
                ],
            );
        }
    }

    public static function delete(?array $actor, int $organizationId, int $kitId): void
    {
        $kit = self::get($organizationId, $kitId);
        if ($kit === null) {
            throw Util::notFound('That kit does not exist.');
        }

        // Deleting a kit must not orphan the loans it produced. Those keep
        // their group reference; only the template goes.
        Db::execute('UPDATE loans SET kit_id = NULL WHERE kit_id = ?', [$kitId]);
        Db::execute('DELETE FROM kits WHERE id = ? AND organization_id = ?', [$kitId, $organizationId]);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::KIT_DELETED,
            'entityType'     => 'kit',
            'entityId'       => $kitId,
            'entityLabel'    => $kit['name'],
            'summary'        => "Kit \"{$kit['name']}\" deleted",
        ]);
    }

    /**
     * Check out every item in a kit under one group reference.
     *
     * Each device gets its own loan through Loans::checkOut, so every policy
     * check, audit entry and due date behaves exactly as it would at the desk.
     * If any required item fails, the whole thing is rolled back — handing over
     * a laptop with no screen reader dongle is worse than handing over nothing.
     */
    public static function checkOut(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $kitId          = (int) $input['kitId'];

        $kit = self::get($organizationId, $kitId);
        if ($kit === null) {
            throw Util::notFound('That kit does not exist.');
        }
        if ($kit['items'] === []) {
            throw Util::badRequest("Kit \"{$kit['name']}\" has no devices in it yet.");
        }

        $groupRef   = Util::makeReference('KIT');
        $skipUnavailable = Util::bool($input['skipUnavailable'] ?? false);

        $outcome = Db::transaction(static function () use (
            $organizationId, $kit, $kitId, $groupRef, $input, $actor, $skipUnavailable
        ): array {
            $loans   = [];
            $skipped = [];

            foreach ($kit['items'] as $item) {
                try {
                    $loan = Loans::checkOut($actor, [
                        'organizationId'   => $organizationId,
                        'deviceIdentifier' => (int) $item['device_id'],
                        'techId'           => $input['techId'] ?? null,
                        'clientId'         => $input['clientId'] ?? null,
                        'programId'        => $input['programId'] ?? null,
                        'loanPeriodId'     => $input['loanPeriodId'] ?? null,
                        'customDays'       => $input['customDays'] ?? null,
                        'notes'            => $input['notes'] ?? null,
                        'conditionOut'     => $input['conditionOut'] ?? null,
                        'method'           => $input['method'] ?? 'manual',
                        'actorId'          => $input['actorId'] ?? null,
                    ]);
                } catch (HttpError $e) {
                    // An optional item that is out is a note, not a failure.
                    if (!$item['required'] || $skipUnavailable) {
                        $skipped[] = ['device_id' => (int) $item['device_id'], 'name' => $item['name'],
                                      'reason' => $e->getMessage()];
                        continue;
                    }
                    throw Util::conflict(
                        "Kit \"{$kit['name']}\" cannot go out: {$e->getMessage()}",
                        ['device_id' => (int) $item['device_id'], 'kit_id' => $kitId],
                    );
                }

                Db::execute('UPDATE loans SET group_ref = ?, kit_id = ? WHERE id = ?',
                    [$groupRef, $kitId, $loan['id']]);

                $loans[] = $loan;
            }

            if ($loans === []) {
                throw Util::conflict("No device in kit \"{$kit['name']}\" is available to lend.");
            }

            return ['loans' => $loans, 'skipped' => $skipped];
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::KIT_CHECKED_OUT,
            'entityType'     => 'kit',
            'entityId'       => $kitId,
            'entityLabel'    => $kit['name'],
            'summary'        => sprintf(
                'Kit "%s" checked out as %s (%d device%s)',
                $kit['name'], $groupRef, count($outcome['loans']), count($outcome['loans']) === 1 ? '' : 's',
            ),
            'detail' => ['group_ref' => $groupRef, 'skipped' => $outcome['skipped']],
        ]);

        return [
            'group_ref' => $groupRef,
            'kit'       => self::get($organizationId, $kitId),
            'loans'     => $outcome['loans'],
            'skipped'   => $outcome['skipped'],
            // "complete" means every device in the kit actually went out. A
            // kit handed over with a piece missing is the thing the person at
            // the desk must be told about, not left to infer from counts.
            'complete'  => $outcome['skipped'] === [],
            'summary'   => sprintf(
                '%d of %d device%s checked out under %s.%s',
                count($outcome['loans']), count($kit['items']),
                count($kit['items']) === 1 ? '' : 's', $groupRef,
                $outcome['skipped'] === []
                    ? ''
                    : ' Not included: ' . implode(', ', array_column($outcome['skipped'], 'name')) . '.',
            ),
        ];
    }

    // -----------------------------------------------------------------------
    // Groups
    // -----------------------------------------------------------------------

    public static function group(int $organizationId, string $groupRef): ?array
    {
        $loans = Db::all(
            'SELECT l.id FROM loans l WHERE l.organization_id = ? AND l.group_ref = ? ORDER BY l.id',
            [$organizationId, $groupRef],
        );

        if ($loans === []) {
            return null;
        }

        $full = [];
        foreach ($loans as $row) {
            $loan = Loans::get($organizationId, (int) $row['id']);
            if ($loan !== null) {
                $full[] = $loan;
            }
        }

        $active   = array_filter($full, static fn (array $l): bool => $l['status'] === 'active');
        $kitId    = $full[0]['kit_id'] ?? null;

        return [
            'group_ref'    => $groupRef,
            'kit'          => $kitId ? self::get($organizationId, (int) $kitId) : null,
            'loans'        => $full,
            'total'        => count($full),
            'active_count' => count($active),
            'all_returned' => $active === [],
        ];
    }

    /**
     * Check in everything still out in a group.
     *
     * Partial failure is reported rather than rolled back: if three of four
     * came back, three should be recorded as back.
     */
    public static function checkInGroup(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $groupRef       = (string) $input['groupRef'];

        $group = self::group($organizationId, $groupRef);
        if ($group === null) {
            throw Util::notFound("No loan group matches \"{$groupRef}\".");
        }

        $checkedIn = [];
        $failed    = [];

        foreach ($group['loans'] as $loan) {
            if ($loan['status'] !== 'active') {
                continue;
            }

            try {
                $checkedIn[] = Loans::checkIn($actor, [
                    'organizationId' => $organizationId,
                    'loanId'         => (int) $loan['id'],
                    'conditionIn'    => $input['conditionIn'] ?? null,
                    'notes'          => $input['notes'] ?? null,
                    'method'         => $input['method'] ?? 'manual',
                    'actorId'        => $input['actorId'] ?? null,
                ]);
            } catch (\Throwable $e) {
                $failed[] = ['loan_id' => (int) $loan['id'], 'reference' => $loan['reference'],
                             'reason' => $e->getMessage()];
            }
        }

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::KIT_CHECKED_IN,
            'entityType'     => 'kit',
            'entityId'       => $group['kit']['id'] ?? null,
            'entityLabel'    => $groupRef,
            'summary'        => sprintf(
                'Group %s checked in: %d returned%s',
                $groupRef, count($checkedIn),
                $failed === [] ? '' : ', ' . count($failed) . ' could not be',
            ),
            'detail' => ['failed' => $failed],
        ]);

        $group = self::group($organizationId, $groupRef);

        return [
            'group_ref'  => $groupRef,
            'checked_in' => $checkedIn,
            // Same list under the name the client counts. Kept as an alias
            // rather than renamed because "checked_in" is a count on the bulk
            // endpoint, and one name meaning two shapes is how this broke.
            'returned'   => $checkedIn,
            'failed'     => $failed,
            'group'      => $group,
            // Complete means nothing from this group is still out.
            'complete'   => $failed === [] && ($group['all_returned'] ?? false),
            'summary'    => sprintf(
                '%d device%s returned under %s.%s',
                count($checkedIn), count($checkedIn) === 1 ? '' : 's', $groupRef,
                $failed === [] ? '' : ' ' . count($failed) . ' could not be checked in.',
            ),
        ];
    }

    // -----------------------------------------------------------------------
    // Accessories
    // -----------------------------------------------------------------------

    /** @return array<int, array<string, mixed>> */
    public static function accessories(int $organizationId, int $deviceId): array
    {
        $device = Db::value(
            'SELECT id FROM devices WHERE id = ? AND organization_id = ?',
            [$deviceId, $organizationId],
        );
        if ($device === null) {
            throw Util::notFound('That device does not exist.');
        }

        return Db::all(
            'SELECT id, name, required, sort_order FROM device_accessories
              WHERE device_id = ? ORDER BY sort_order, name',
            [$deviceId],
        );
    }

    /**
     * Replace a device's accessory checklist.
     *
     * @param array<int, mixed> $accessories
     */
    public static function setAccessories(
        ?array $actor,
        int $organizationId,
        int $deviceId,
        array $accessories,
    ): array {
        $device = Db::one(
            'SELECT id, name FROM devices WHERE id = ? AND organization_id = ?',
            [$deviceId, $organizationId],
        );
        if ($device === null) {
            throw Util::notFound('That device does not exist.');
        }

        Db::transaction(static function () use ($deviceId, $accessories): void {
            Db::execute('DELETE FROM device_accessories WHERE device_id = ?', [$deviceId]);

            $order = 0;
            foreach ($accessories as $accessory) {
                $name = Util::str(is_array($accessory) ? ($accessory['name'] ?? null) : $accessory, 120);
                if ($name === null || $name === '') {
                    continue;
                }

                Db::execute(
                    'INSERT INTO device_accessories (device_id, name, required, sort_order) VALUES (?, ?, ?, ?)',
                    [
                        $deviceId, $name,
                        is_array($accessory) ? (Util::bool($accessory['required'] ?? true, true) ? 1 : 0) : 1,
                        $order++,
                    ],
                );
            }
        });

        $saved = self::accessories($organizationId, $deviceId);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::DEVICE_UPDATED,
            'entityType'     => 'device',
            'entityId'       => $deviceId,
            'entityLabel'    => $device['name'],
            'summary'        => sprintf(
                '%s accessory checklist set to %d item%s',
                $device['name'], count($saved), count($saved) === 1 ? '' : 's',
            ),
            'detail' => ['accessories' => array_column($saved, 'name')],
        ]);

        return $saved;
    }
}
