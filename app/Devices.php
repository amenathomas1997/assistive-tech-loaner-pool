<?php
/**
 * Device inventory: CRUD, spreadsheet ingest and barcode assignment.
 *
 * Import is deliberately two-phase. A dry run parses, maps and validates
 * everything and reports exactly what would happen, without writing a row.
 * Only a second call with dryRun = false commits. Inventory imports are the
 * operation most likely to be run against the wrong file, and "undo" for a
 * 900-row import is not something this application can offer.
 */

declare(strict_types=1);

namespace Loaner;

final class Devices
{
    public const STATUSES = ['available', 'checked_out', 'reserved', 'maintenance', 'retired', 'lost'];

    /**
     * What kind of thing this row is.
     *
     * A device is one object with one holder. A licence is a number of seats.
     * A consumable goes out and does not come back. All three are lent,
     * searched for and reported on identically, which is why they share a
     * table rather than having three of them.
     */
    public const ITEM_TYPES = ['device', 'licence', 'consumable'];

    public const ITEM_TYPE_LABELS = [
        'device'     => 'Equipment — one item, one holder',
        'licence'    => 'Software licence — several seats',
        'consumable' => 'Consumable — issued, not returned',
    ];

    private const MAX_IMPORT_ROWS = 20000;

    /** Columns an import may write. */
    private const IMPORTABLE = [
        'barcode', 'asset_tag', 'serial_number', 'name', 'category', 'manufacturer', 'model',
        'description', 'status', 'condition_note', 'location', 'home_location',
        'purchase_date', 'purchase_cost', 'warranty_expires', 'funding_source', 'notes',
    ];

    private const SELECT = '
        SELECT d.*,
               p.name AS program_name,
               st.name AS site_name,
               (SELECT COUNT(*) FROM loans sl WHERE sl.device_id = d.id AND sl.status = "active")
                   AS seats_in_use,
               l.id AS active_loan_id, l.reference AS active_loan_reference,
               l.due_at AS active_loan_due_at, l.checked_out_at AS active_loan_checked_out_at,
               t.full_name AS active_loan_tech_name,
               c.first_name AS active_loan_client_first_name, c.last_name AS active_loan_client_last_name,
               lp.name AS active_loan_program_name
          FROM devices d
          LEFT JOIN programs p ON p.id = d.owner_program_id
          LEFT JOIN sites st ON st.id = d.site_id
          LEFT JOIN loans l ON l.device_id = d.id AND l.status = "active"
          LEFT JOIN users t ON t.id = l.tech_id
          LEFT JOIN clients c ON c.id = l.client_id
          LEFT JOIN programs lp ON lp.id = l.program_id';

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------

    public static function get(int $organizationId, int $deviceId): ?array
    {
        $row = Db::one(
            self::SELECT . ' WHERE d.id = ? AND d.organization_id = ?',
            [$deviceId, $organizationId],
        );

        return $row === null ? null : self::decorate($row);
    }

    public static function decorate(array $row): array
    {
        $holder = [];
        if (!empty($row['active_loan_client_first_name'])) {
            $holder[] = $row['active_loan_client_first_name'] . ' ' . $row['active_loan_client_last_name'];
        }
        if (!empty($row['active_loan_tech_name'])) {
            $holder[] = $row['active_loan_tech_name'];
        }
        if (!empty($row['active_loan_program_name'])) {
            $holder[] = $row['active_loan_program_name'];
        }

        $row['custom_fields'] = $row['custom_fields'] !== null
            ? (json_decode((string) $row['custom_fields'], true) ?: null)
            : null;

        $row['item_type']       = $row['item_type'] ?? 'device';
        $row['item_type_label']  = self::ITEM_TYPE_LABELS[$row['item_type']] ?? $row['item_type'];
        $row['seats_total']      = max(1, (int) ($row['seats_total'] ?? 1));

        // Worked out here so no screen has to do its own arithmetic and get a
        // different answer.
        $row['seats_in_use'] = (int) ($row['seats_in_use'] ?? 0);
        $row['seats_free']   = max(0, $row['seats_total'] - $row['seats_in_use']);

        $row['is_available'] = $row['seats_total'] > 1
            ? ($row['seats_free'] > 0 && !in_array($row['status'], ['retired', 'lost', 'maintenance'], true))
            : ($row['status'] === 'available' && empty($row['active_loan_id']));

        $row['licence_expired'] = !empty($row['licence_expires'])
            && strtotime((string) $row['licence_expires']) < strtotime('today');
        $row['current_holder'] = $holder === [] ? null : implode(' / ', $holder);
        $row['is_overdue']     = !empty($row['active_loan_id'])
                              && !empty($row['active_loan_due_at'])
                              && strtotime((string) $row['active_loan_due_at']) < time();

        return $row;
    }

    /**
     * Take other people's clients out of device rows for a counselor.
     *
     * Anyone who can see the inventory can see that a device is out and when
     * it is due. Who has it is a client record, so a counselor sees that only
     * for their own caseload. Done as one query over the page, not per row.
     *
     * @param list<array<string, mixed>> $rows
     * @return list<array<string, mixed>>
     */
    public static function redactHolders(?array $auth, array $rows): array
    {
        $counselor = Auth::ownRecordsOnly($auth);
        if ($counselor === null) {
            return $rows;
        }

        $loanIds = array_values(array_filter(array_map(
            static fn (array $d): int => (int) ($d['active_loan_id'] ?? 0),
            $rows,
        )));

        $visible = [];
        if ($loanIds !== []) {
            $marks = implode(',', array_fill(0, count($loanIds), '?'));
            foreach (Db::all(
                "SELECT l.id FROM loans l
                   LEFT JOIN clients c ON c.id = l.client_id
                   LEFT JOIN loan_requests r ON r.id = l.request_id
                  WHERE l.id IN ({$marks}) AND (c.counselor_id = ? OR r.requested_by = ?)",
                [...$loanIds, $counselor, $counselor],
            ) as $row) {
                $visible[(int) $row['id']] = true;
            }
        }

        foreach ($rows as &$device) {
            if (empty($device['active_loan_id']) || isset($visible[(int) $device['active_loan_id']])) {
                continue;
            }
            foreach (['active_loan_client_first_name', 'active_loan_client_last_name',
                      'active_loan_tech_name', 'active_loan_program_name'] as $field) {
                $device[$field] = null;
            }
            $device['current_holder'] = null;
        }
        unset($device);

        return $rows;
    }

    public static function list(int $organizationId, array $filters = [], array $options = []): array
    {
        $limit  = (int) ($options['limit'] ?? 50);
        $offset = (int) ($options['offset'] ?? 0);

        $where  = ['d.organization_id = ?'];
        $params = [$organizationId];

        if (($filters['status'] ?? null) === 'available') {
            $where[] = 'd.status = "available" AND l.id IS NULL';
        } elseif (!empty($filters['status'])) {
            $where[]  = 'd.status = ?';
            $params[] = $filters['status'];
        }

        if (!empty($filters['category']))  { $where[] = 'd.category = ?';         $params[] = $filters['category']; }
        if (!empty($filters['programId'])) { $where[] = 'd.owner_program_id = ?'; $params[] = $filters['programId']; }
        if (!empty($filters['location']))  { $where[] = 'd.location = ?';         $params[] = $filters['location']; }

        if (!empty($filters['overdue'])) {
            $where[] = 'l.id IS NOT NULL AND l.due_at IS NOT NULL AND l.due_at < NOW()';
        }

        if (!empty($filters['search'])) {
            $where[] = '(d.name LIKE ? OR d.barcode LIKE ? OR d.asset_tag LIKE ? OR d.serial_number LIKE ? '
                     . 'OR d.manufacturer LIKE ? OR d.model LIKE ? OR d.category LIKE ?)';
            $like = '%' . $filters['search'] . '%';
            array_push($params, $like, $like, $like, $like, $like, $like, $like);
        }

        $whereSql = implode(' AND ', $where);

        $sortColumns = [
            'name' => 'd.name', 'barcode' => 'd.barcode', 'status' => 'd.status',
            'category' => 'd.category', 'created_at' => 'd.created_at',
            'asset_tag' => 'd.asset_tag', 'due_at' => 'l.due_at',
        ];
        $order = Util::orderBy($options['sort'] ?? null, $sortColumns, 'd.name ASC');

        $rows = Db::all(
            self::SELECT . " WHERE {$whereSql} ORDER BY {$order} LIMIT {$limit} OFFSET {$offset}",
            $params,
        );

        $total = (int) Db::value(
            "SELECT COUNT(DISTINCT d.id) FROM devices d
               LEFT JOIN loans l ON l.device_id = d.id AND l.status = 'active'
              WHERE {$whereSql}",
            $params,
        );

        return ['rows' => array_map([self::class, 'decorate'], $rows), 'total' => $total];
    }

    /** Distinct categories, locations and statuses, for filter dropdowns. */
    public static function facets(int $organizationId): array
    {
        return [
            'categories' => Db::all(
                'SELECT category AS value, COUNT(*) AS count FROM devices
                  WHERE organization_id = ? AND category IS NOT NULL AND category <> ""
                  GROUP BY category ORDER BY category',
                [$organizationId],
            ),
            'locations' => Db::all(
                'SELECT location AS value, COUNT(*) AS count FROM devices
                  WHERE organization_id = ? AND location IS NOT NULL AND location <> ""
                  GROUP BY location ORDER BY location',
                [$organizationId],
            ),
            'statuses' => Db::all(
                'SELECT status AS value, COUNT(*) AS count FROM devices
                  WHERE organization_id = ? GROUP BY status',
                [$organizationId],
            ),
        ];
    }

    // -----------------------------------------------------------------------
    // Create and update
    // -----------------------------------------------------------------------

    public static function create(?array $actor, int $organizationId, array $data, string $barcodePrefix = 'LP'): array
    {
        $barcode = !empty($data['barcode'])
            ? Barcode::normaliseScan($data['barcode'])
            : Barcode::allocate(
                static fn (string $candidate): bool =>
                    Db::value('SELECT id FROM devices WHERE barcode = ?', [$candidate]) !== null,
                $barcodePrefix,
            );

        $itemType = $data['item_type'] ?? 'device';

        if (!in_array($itemType, self::ITEM_TYPES, true)) {
            throw Util::badRequest(
                "\"{$itemType}\" is not a kind of item.",
                ['field' => 'item_type', 'allowed' => self::ITEM_TYPES],
            );
        }

        // Seats only mean something for a licence. A physical device with
        // twelve seats would be a claim that twelve people can hold the same
        // object, so the value is pinned to 1 rather than trusted.
        $seats = $itemType === 'licence'
            ? max(1, (int) ($data['seats_total'] ?? 1))
            : 1;

        $id = Db::insert(
            'INSERT INTO devices
               (organization_id, barcode, asset_tag, serial_number, name, category, manufacturer, model,
                description, status, condition_note, location, home_location, owner_program_id,
                purchase_date, purchase_cost, warranty_expires, funding_source, notes,
                item_type, seats_total, licence_key, licence_expires, site_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $organizationId, $barcode, $data['asset_tag'] ?? null, $data['serial_number'] ?? null,
                $data['name'], $data['category'] ?? null, $data['manufacturer'] ?? null,
                $data['model'] ?? null, $data['description'] ?? null, $data['status'] ?? 'available',
                $data['condition_note'] ?? null, $data['location'] ?? null, $data['home_location'] ?? null,
                $data['owner_program_id'] ?? null, $data['purchase_date'] ?? null,
                $data['purchase_cost'] ?? null, $data['warranty_expires'] ?? null,
                $data['funding_source'] ?? null, $data['notes'] ?? null,
                $itemType, $seats, $data['licence_key'] ?? null,
                $data['licence_expires'] ?? null, $data['site_id'] ?? null,
            ],
        );

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::DEVICE_CREATED,
            'entityType'     => 'device',
            'entityId'       => $id,
            'entityLabel'    => $data['name'],
            'summary'        => "Added device {$data['name']} ({$barcode})",
            'detail'         => ['barcode' => $barcode, 'asset_tag' => $data['asset_tag'] ?? null],
        ]);

        return self::get($organizationId, $id);
    }

    /**
     * Seats cannot be cut below the number currently in use.
     *
     * Allowing it would show "20 of 12 seats in use", and the next person to
     * look would not know which number was wrong.
     */
    private static function validateSeats(int $organizationId, int $deviceId, mixed $value): int
    {
        $seats = Util::int($value, 'seats_total', 1, 10000) ?? 1;

        $inUse = (int) Db::value(
            'SELECT COUNT(*) FROM loans WHERE device_id = ? AND status = "active"',
            [$deviceId],
        );

        if ($seats < $inUse) {
            throw Util::conflict(
                sprintf(
                    '%d seat(s) are in use right now, so the total cannot be set below that. Check '
                    . 'some in first, or raise the number.',
                    $inUse,
                ),
                ['field' => 'seats_total', 'seats_in_use' => $inUse],
            );
        }

        return $seats;
    }

    /** Fields an edit may change. Barcode is deliberately not among them. */
    /**
     * What a device can become when a loan ends. "checked_out" and "reserved"
     * both claim something about a person, and neither would be true: the
     * first would leave a device marked out with no loan, the second one
     * marked held for nobody.
     */
    public const RETURN_STATUSES = ['available', 'maintenance', 'retired', 'lost'];

    private const EDITABLE = [
        'asset_tag', 'serial_number', 'name', 'category', 'manufacturer', 'model',
        'description', 'status', 'condition_note', 'location', 'home_location',
        'owner_program_id', 'purchase_date', 'purchase_cost', 'warranty_expires',
        'funding_source', 'notes',
        'item_type', 'seats_total', 'licence_key', 'licence_expires', 'site_id',
    ];

    /**
     * Edit a device.
     *
     * Only supplied fields are touched, so a form that posts three fields
     * cannot blank the other fourteen. The barcode is changed through
     * reassignBarcode(), which records the old value — a silent barcode edit
     * would leave printed labels pointing at nothing with no trace of why.
     */
    public static function update(?array $actor, int $organizationId, int $deviceId, array $data): array
    {
        $before = self::get($organizationId, $deviceId);
        if ($before === null) {
            throw Util::notFound('That device does not exist.');
        }

        $sets   = [];
        $params = [];

        foreach (self::EDITABLE as $column) {
            // Accept both snake_case and camelCase so the API is forgiving
            // about which convention a third-party client happens to use.
            $camel = lcfirst(str_replace(' ', '', ucwords(str_replace('_', ' ', $column))));
            $key   = array_key_exists($column, $data) ? $column
                : (array_key_exists($camel, $data) ? $camel : null);

            if ($key === null) {
                continue;
            }

            $value = $data[$key];

            // Lengths match the columns exactly, and the identifier-like
            // fields refuse an over-long value instead of trimming it.
            $value = match ($column) {
                'name'             => Util::requiredStr($value, 'name', 190),
                'status'           => Util::oneOf($value, self::STATUSES, 'status', true),
                'purchase_cost'    => $value === null || $value === '' ? null : Util::decimal($value, 'purchase_cost'),
                'purchase_date',
                'warranty_expires' => $value === null || $value === '' ? null : Util::dateOnly($value, $column),
                'owner_program_id',
                'site_id'          => $value ?: null,
                'item_type'        => Util::oneOf($value, self::ITEM_TYPES, 'item_type', true),
                // Seats cannot drop below what is already out: the holders of
                // those seats exist, and the number would then be a lie.
                'seats_total'      => self::validateSeats($organizationId, $deviceId, $value),
                'licence_key'      => Util::str($value, 255),
                'licence_expires'  => $value === null || $value === ''
                    ? null : Util::dateOnly($value, 'licence_expires'),
                'asset_tag'        => Util::boundedStr($value, 'asset_tag', 64) ?: null,
                'serial_number'    => Util::boundedStr($value, 'serial_number', 128) ?: null,
                'category'         => Util::boundedStr($value, 'category', 96),
                'manufacturer'     => Util::boundedStr($value, 'manufacturer', 120),
                'model'            => Util::boundedStr($value, 'model', 120),
                'funding_source'   => Util::boundedStr($value, 'funding_source', 120),
                'condition_note'   => Util::boundedStr($value, 'condition_note', 190),
                'location'         => Util::boundedStr($value, 'location', 190),
                'home_location'    => Util::boundedStr($value, 'home_location', 190),
                'description',
                'notes'            => Util::str($value),
                default            => Util::str($value, 190),
            };

            $sets[]   = "{$column} = ?";
            $params[] = $value;
        }

        if ($sets === []) {
            return $before;
        }

        // "On loan" is the result of a check-out, not something to type in.
        if (($data['status'] ?? null) === 'checked_out' && empty($before['active_loan_id'])
            && $before['status'] !== 'checked_out'
        ) {
            throw Util::conflict(
                "{$before['name']} has no loan to be out on. Check it out to someone instead.",
                ['field' => 'status'],
            );
        }

        foreach ([['owner_program_id', 'ownerProgramId', 'programs', 'program'],
                  ['site_id', 'siteId', 'sites', 'site']] as [$snake, $camel, $table, $label]) {
            Loans::assertBelongs($table, $data[$snake] ?? $data[$camel] ?? null, $organizationId, $label);
        }

        // Changing status by hand must not contradict an active loan: a device
        // someone is holding is not "available", whatever the form says.
        if (array_key_exists('status', $data) && !empty($before['active_loan_id'])
            && in_array($data['status'], ['available', 'reserved'], true)
        ) {
            throw Util::conflict(
                "{$before['name']} is out on loan {$before['active_loan_reference']}. Check it in rather "
                . 'than changing its status by hand.',
                ['loan_reference' => $before['active_loan_reference']],
            );
        }

        if (!empty($data['owner_program_id'] ?? $data['ownerProgramId'] ?? null)) {
            $programId = $data['owner_program_id'] ?? $data['ownerProgramId'];
            $exists    = Db::value(
                'SELECT id FROM programs WHERE id = ? AND organization_id = ?',
                [$programId, $organizationId],
            );
            if ($exists === null) {
                throw Util::badRequest('That program does not exist.', ['field' => 'owner_program_id']);
            }
        }

        $sets[]   = 'updated_at = NOW()';
        $params[] = $deviceId;
        $params[] = $organizationId;

        try {
            Db::execute(
                'UPDATE devices SET ' . implode(', ', $sets) . ' WHERE id = ? AND organization_id = ?',
                $params,
            );
        } catch (\Throwable $e) {
            throw self::translateDuplicate($e);
        }

        $after = self::get($organizationId, $deviceId);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => array_key_exists('status', $data) && $before['status'] !== $after['status']
                ? Audit::DEVICE_STATUS_CHANGED : Audit::DEVICE_UPDATED,
            'entityType'     => 'device',
            'entityId'       => $deviceId,
            'entityLabel'    => $after['name'],
            'summary'        => $before['status'] !== $after['status']
                ? sprintf('%s: status %s → %s', $after['name'],
                    str_replace('_', ' ', (string) $before['status']),
                    str_replace('_', ' ', (string) $after['status']))
                : "Updated {$after['name']}",
            'detail'         => Audit::diff($before, $after, self::EDITABLE),
        ]);

        // A device returning to service may have someone waiting for it.
        if ($before['status'] !== 'available' && $after['status'] === 'available') {
            try {
                Reservations::promoteNextForDevice($actor, $organizationId, $deviceId);
            } catch (\Throwable $e) {
                error_log('[devices] waitlist promotion failed: ' . $e->getMessage());
            }
        }

        return $after;
    }

    /**
     * Remove a device.
     *
     * Refused outright once it has any loan history: those loans are the
     * record of who had what, and a cascade would quietly delete them.
     * Retiring is offered instead, which is almost always what was meant.
     */
    public static function delete(?array $actor, int $organizationId, int $deviceId): array
    {
        $device = self::get($organizationId, $deviceId);
        if ($device === null) {
            throw Util::notFound('That device does not exist.');
        }

        if (!empty($device['active_loan_id'])) {
            throw Util::conflict(
                "{$device['name']} is out on loan {$device['active_loan_reference']} and cannot be removed.",
                ['loan_reference' => $device['active_loan_reference']],
            );
        }

        $loanCount = (int) Db::value('SELECT COUNT(*) FROM loans WHERE device_id = ?', [$deviceId]);

        if ($loanCount > 0) {
            throw Util::conflict(
                sprintf(
                    '%s has %d loan%s in its history, which would be deleted with it. Mark it retired '
                    . 'instead — it then disappears from the pickers but the record of who borrowed it '
                    . 'stays intact.',
                    $device['name'], $loanCount, $loanCount === 1 ? '' : 's',
                ),
                ['loan_count' => $loanCount, 'suggestion' => 'retire'],
            );
        }

        Db::execute('DELETE FROM devices WHERE id = ? AND organization_id = ?', [$deviceId, $organizationId]);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::DEVICE_DELETED,
            'entityType'     => 'device',
            'entityId'       => $deviceId,
            'entityLabel'    => $device['name'],
            'summary'        => "Deleted device {$device['name']} ({$device['barcode']}), which had no loan history",
        ]);

        return ['deleted' => true, 'device' => $device];
    }

    public const DISPOSAL_METHODS = [
        'transferred', 'donated', 'recycled', 'destroyed', 'sold', 'lost', 'returned_to_funder',
    ];

    public const DISPOSAL_LABELS = [
        'transferred'        => 'Transferred to another agency',
        'donated'            => 'Donated',
        'recycled'           => 'Recycled or e-wasted',
        'destroyed'          => 'Destroyed',
        'sold'               => 'Sold',
        'lost'               => 'Lost or stolen',
        'returned_to_funder' => 'Returned to the funder',
    ];

    /**
     * Record what became of a device.
     *
     * "Retired" on its own is not an answer to the question a funder asks
     * about equipment they paid for. This is the answer: what happened, when,
     * who decided, and any reference number — a disposal certificate, a
     * transfer agreement, a police report.
     */
    public static function dispose(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $deviceId       = (int) $input['deviceId'];
        $method         = Util::str($input['method'] ?? null, 32) ?? '';

        if (!in_array($method, self::DISPOSAL_METHODS, true)) {
            throw Util::badRequest(
                'Choose what happened to the device.',
                ['field' => 'method', 'allowed' => self::DISPOSAL_METHODS],
            );
        }

        $device = self::get($organizationId, $deviceId);
        if ($device === null) {
            throw Util::notFound('That device does not exist.');
        }

        if (!empty($device['active_loan_id'])) {
            throw Util::conflict(
                "{$device['name']} is out on loan ({$device['active_loan_reference']}). It cannot be "
                . 'disposed of while somebody has it — unless it is lost, in which case check it in '
                . 'as lost first.',
                ['loan_reference' => $device['active_loan_reference']],
            );
        }

        if (!empty($device['disposed_at'])) {
            throw Util::conflict(
                sprintf(
                    '%s was already disposed of on %s (%s).',
                    $device['name'], date('j M Y', strtotime((string) $device['disposed_at'])),
                    self::DISPOSAL_LABELS[$device['disposal_method']] ?? $device['disposal_method'],
                ),
            );
        }

        // Funded equipment leaving the pool is exactly what a grant report
        // asks about, so an unexplained disposal of something expensive is
        // refused rather than quietly recorded.
        $notes = Util::str($input['notes'] ?? null);

        if ($method === 'lost' && ($notes === null || mb_strlen($notes) < 3)) {
            throw Util::badRequest(
                'Say what happened. A device recorded as lost with no explanation is the first thing '
                . 'an auditor asks about.',
                ['field' => 'notes'],
            );
        }

        Db::execute(
            'UPDATE devices
                SET status = ?, disposed_at = ?, disposal_method = ?, disposal_ref = ?,
                    disposal_notes = ?, disposed_by = ?, updated_at = NOW()
              WHERE id = ? AND organization_id = ?',
            [
                $method === 'lost' ? 'lost' : 'retired',
                Util::mysqlDateTime($input['disposedAt'] ?? 'now'),
                $method,
                Util::boundedStr($input['reference'] ?? null, 'reference', 120),
                $notes,
                $input['actorId'] ?? null,
                $deviceId, $organizationId,
            ],
        );

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::DEVICE_DISPOSED,
            'entityType'     => 'device',
            'entityId'       => $deviceId,
            'entityLabel'    => $device['name'],
            'summary'        => sprintf(
                '%s (%s) disposed of: %s%s',
                $device['name'], $device['barcode'],
                self::DISPOSAL_LABELS[$method],
                $notes !== null ? " — {$notes}" : '',
            ),
            'detail' => [
                'method'         => $method,
                'reference'      => $input['reference'] ?? null,
                'purchase_cost'  => $device['purchase_cost'],
                'funding_source' => $device['funding_source'],
            ],
        ]);

        return self::get($organizationId, $deviceId);
    }

    /**
     * Everything that has left the pool, for a funder's asset report.
     *
     * Grouped by funding source because that is who asks.
     */
    public static function disposalReport(int $organizationId, ?string $from = null, ?string $to = null): array
    {
        $fromSql = Util::mysqlDateTime($from ?: '-1 year');
        $toSql   = Util::mysqlDateTime($to ?: 'now');

        $rows = Db::all(
            'SELECT d.id, d.name, d.barcode, d.asset_tag, d.serial_number, d.category,
                    d.purchase_date, d.purchase_cost, d.funding_source,
                    d.disposed_at, d.disposal_method, d.disposal_ref, d.disposal_notes,
                    u.full_name AS disposed_by_name,
                    (SELECT COUNT(*) FROM loans l WHERE l.device_id = d.id) AS lifetime_loans
               FROM devices d
               LEFT JOIN users u ON u.id = d.disposed_by
              WHERE d.organization_id = ? AND d.disposed_at IS NOT NULL
                AND d.disposed_at >= ? AND d.disposed_at <= ?
              ORDER BY d.disposed_at DESC',
            [$organizationId, $fromSql, $toSql],
        );

        $byFunder = [];
        $byMethod = [];

        foreach ($rows as &$row) {
            $row['lifetime_loans']  = (int) $row['lifetime_loans'];
            $row['disposal_label']  = self::DISPOSAL_LABELS[$row['disposal_method']]
                ?? $row['disposal_method'];

            // Service life is the number that tells a funder whether the
            // equipment lasted as long as it was meant to.
            $row['years_in_service'] = empty($row['purchase_date'])
                ? null
                : round(
                    (strtotime((string) $row['disposed_at']) - strtotime((string) $row['purchase_date']))
                    / 31557600, 1,
                );

            $funder = $row['funding_source'] ?: 'Unattributed';
            $byFunder[$funder]['count'] = ($byFunder[$funder]['count'] ?? 0) + 1;
            $byFunder[$funder]['value'] = ($byFunder[$funder]['value'] ?? 0)
                + (float) ($row['purchase_cost'] ?? 0);

            $byMethod[$row['disposal_method']] = ($byMethod[$row['disposal_method']] ?? 0) + 1;
        }
        unset($row);

        $funders = [];
        foreach ($byFunder as $name => $totals) {
            $funders[] = [
                'funding_source' => $name,
                'count'          => $totals['count'],
                'original_value' => round($totals['value'], 2),
            ];
        }
        usort($funders, static fn ($a, $b) => $b['original_value'] <=> $a['original_value']);

        return [
            'range'     => ['from' => $fromSql, 'to' => $toSql],
            'rows'      => $rows,
            'total'     => count($rows),
            'by_funder' => $funders,
            'by_method' => $byMethod,
            'original_value' => round(array_sum(array_column($funders, 'original_value')), 2),
            'caveat'    => 'Values are what this pool paid, not what the equipment was worth when it '
                         . 'left. They are for reconciling against a purchase record, not for '
                         . 'claiming a loss.',
        ];
    }

    /**
     * Change the status of many devices at once.
     *
     * Partial success is reported rather than rolled back: a stocktake that
     * marks forty devices and finds one out on loan should still record the
     * thirty-nine.
     */
    public static function bulkStatus(?array $actor, int $organizationId, array $ids, string $status, ?string $note = null): array
    {
        Util::oneOf($status, self::STATUSES, 'status', true);

        $changed = [];
        $skipped = [];

        foreach ($ids as $rawId) {
            $deviceId = (int) $rawId;
            if ($deviceId <= 0) {
                continue;
            }

            try {
                $device = self::update($actor, $organizationId, $deviceId, array_filter([
                    'status'         => $status,
                    'condition_note' => $note,
                ], static fn ($v): bool => $v !== null));

                $changed[] = ['id' => $deviceId, 'name' => $device['name'], 'status' => $device['status']];
            } catch (\Throwable $e) {
                $skipped[] = [
                    'id'     => $deviceId,
                    'reason' => $e instanceof HttpError ? $e->getMessage() : 'That one failed on the server.',
                ];
            }
        }

        return [
            'changed'      => count($changed),
            'failed_count' => count($skipped),
            'devices'      => $changed,
            'failed'       => $skipped,
            'summary'      => sprintf(
                '%d device%s set to %s%s.',
                count($changed), count($changed) === 1 ? '' : 's',
                str_replace('_', ' ', $status),
                $skipped === [] ? '' : ', ' . count($skipped) . ' could not be changed',
            ),
        ];
    }

    /** Re-issue a barcode, e.g. after a label is damaged or duplicated. */
    public static function reassignBarcode(?array $actor, int $organizationId, int $deviceId, string $prefix = 'LP'): array
    {
        $device = Db::one('SELECT * FROM devices WHERE id = ? AND organization_id = ?', [$deviceId, $organizationId]);
        if ($device === null) {
            throw Util::notFound('That device does not exist.');
        }

        $newBarcode = Barcode::allocate(
            static fn (string $candidate): bool =>
                Db::value('SELECT id FROM devices WHERE barcode = ?', [$candidate]) !== null,
            $prefix,
        );

        Db::execute('UPDATE devices SET barcode = ?, updated_at = NOW() WHERE id = ?', [$newBarcode, $deviceId]);

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::DEVICE_BARCODE_ASSIGNED,
            'entityType'     => 'device',
            'entityId'       => $deviceId,
            'entityLabel'    => $device['name'],
            'summary'        => "Reassigned barcode for {$device['name']}: {$device['barcode']} → {$newBarcode}",
            'detail'         => ['old_barcode' => $device['barcode'], 'new_barcode' => $newBarcode],
        ]);

        return self::get($organizationId, $deviceId);
    }

    /** Give barcodes to devices that somehow lack one. Safe to re-run. */
    public static function backfillBarcodes(?array $actor, int $organizationId, string $prefix = 'LP'): array
    {
        $missing = Db::all(
            'SELECT id, name FROM devices WHERE organization_id = ? AND (barcode IS NULL OR barcode = "")',
            [$organizationId],
        );

        foreach ($missing as $device) {
            $barcode = Barcode::allocate(
                static fn (string $candidate): bool =>
                    Db::value('SELECT id FROM devices WHERE barcode = ?', [$candidate]) !== null,
                $prefix,
            );
            Db::execute('UPDATE devices SET barcode = ?, updated_at = NOW() WHERE id = ?', [$barcode, $device['id']]);
        }

        if ($missing !== []) {
            Audit::record($actor, [
                'organizationId' => $organizationId,
                'action'         => Audit::DEVICE_BARCODE_ASSIGNED,
                'entityType'     => 'device',
                'summary'        => 'Assigned barcodes to ' . count($missing) . ' device(s) that had none',
            ]);
        }

        return ['assigned' => count($missing)];
    }

    /** Turn a duplicate-key error into a message naming the actual field. */
    public static function translateDuplicate(\Throwable $e): \Throwable
    {
        if (!Db::isDuplicate($e)) {
            return $e;
        }

        $message = $e->getMessage();

        return match (true) {
            str_contains($message, 'uq_device_barcode') => Util::conflict('Another device already uses that barcode.', ['field' => 'barcode']),
            str_contains($message, 'uq_device_asset')   => Util::conflict('Another device already uses that asset tag.', ['field' => 'asset_tag']),
            str_contains($message, 'uq_device_serial')  => Util::conflict('Another device already uses that serial number.', ['field' => 'serial_number']),
            default => Util::conflict('That value is already in use by another device.'),
        };
    }

    // -----------------------------------------------------------------------
    // Import
    // -----------------------------------------------------------------------

    /** Parse and propose a mapping without touching the database. */
    public static function previewImport(string $text, ?string $delimiter = null): array
    {
        ['headers' => $headers, 'records' => $records] = Csv::toRecords($text, $delimiter);

        if (count($records) > self::MAX_IMPORT_ROWS) {
            throw Util::badRequest(sprintf(
                'That file has %d rows, which is over the %d row limit. Split it into smaller files.',
                count($records),
                self::MAX_IMPORT_ROWS,
            ));
        }

        ['mapping' => $mapping, 'unmapped' => $unmapped] = Csv::suggestMapping($headers);

        $samples = [];
        foreach (array_slice($records, 0, 5) as $record) {
            unset($record['__line']);
            $samples[] = $record;
        }

        return [
            'row_count'         => count($records),
            'headers'           => $headers,
            'suggested_mapping' => $mapping,
            'unmapped_headers'  => $unmapped,
            'importable_fields' => array_keys(Csv::DEVICE_ALIASES),
            'sample_rows'       => $samples,
        ];
    }

    /**
     * Import devices.
     *
     * Matching for updates, in priority order: barcode, then serial number,
     * then asset tag — the order of how uniquely each identifies real hardware.
     */
    public static function import(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $dryRun         = (bool) ($input['dryRun'] ?? true);
        $updateExisting = (bool) ($input['updateExisting'] ?? true);
        $defaultStatus  = (string) ($input['defaultStatus'] ?? 'available');
        $prefix         = (string) ($input['barcodePrefix'] ?? 'LP');
        $filename       = $input['filename'] ?? null;

        ['headers' => $headers, 'records' => $records] = Csv::toRecords($input['text'], $input['delimiter'] ?? null);

        if ($records === []) {
            throw Util::badRequest('That file has a header row but no data rows.');
        }
        if (count($records) > self::MAX_IMPORT_ROWS) {
            throw Util::badRequest('That file has ' . count($records) . ' rows, over the limit.');
        }

        $mapping = $input['mapping'] ?? Csv::suggestMapping($headers)['mapping'];
        $ignored = $input['ignoreHeaders'] ?? [];

        // A device needs something to be called. Refusing up front beats
        // importing 800 rows named "Unnamed device".
        $mappedFields = array_values($mapping);
        if (!array_intersect(['name', 'model', 'asset_tag'], $mappedFields)) {
            throw Util::badRequest(
                'The import needs at least one column mapped to "name", "model" or "asset_tag" '
                . 'so each device can be identified.',
                ['mapped_fields' => $mappedFields],
            );
        }

        // Program names resolve to ids once, not per row.
        $programs = [];
        foreach (Db::all('SELECT id, name, code FROM programs WHERE organization_id = ?', [$organizationId]) as $p) {
            $programs[strtolower($p['name'])] = (int) $p['id'];
            if (!empty($p['code'])) {
                $programs[strtolower($p['code'])] = (int) $p['id'];
            }
        }

        $errors       = [];
        $plan         = [];
        $seenBarcodes = [];
        $seenSerials  = [];
        $seenAssets   = [];

        foreach ($records as $record) {
            $line      = $record['__line'];
            $rowErrors = [];
            $device    = [];
            $custom    = [];

            foreach ($headers as $header) {
                if ($header === '__line') {
                    continue;
                }

                $raw   = $record[$header] ?? '';
                $field = $mapping[$header] ?? null;

                if ($field === null || $field === '__ignore') {
                    if (!in_array($header, $ignored, true) && trim((string) $raw) !== '') {
                        $custom[$header] = $raw;
                    }
                    continue;
                }

                $value = Util::str($raw);
                if ($value === null) {
                    continue;
                }

                switch ($field) {
                    case 'purchase_date':
                    case 'warranty_expires':
                        $parsed = Csv::parseDate($value);
                        if ($parsed === null) {
                            $rowErrors[] = "\"{$header}\" value \"{$value}\" is not a date this importer recognises";
                        } else {
                            $device[$field] = $parsed;
                        }
                        break;

                    case 'purchase_cost':
                        $parsed = Csv::parseMoney($value);
                        if ($parsed === null) {
                            $rowErrors[] = "\"{$header}\" value \"{$value}\" is not a number";
                        } else {
                            $device[$field] = $parsed;
                        }
                        break;

                    case 'status':
                        $parsed = Csv::normaliseStatus($value);
                        if ($parsed === null) {
                            $rowErrors[] = "\"{$header}\" value \"{$value}\" is not a status this importer recognises";
                        } else {
                            $device[$field] = $parsed;
                        }
                        break;

                    case 'program':
                        $programId = $programs[strtolower($value)] ?? null;
                        if ($programId === null) {
                            $rowErrors[] = "program \"{$value}\" does not exist — create it first, or leave the column unmapped";
                        } else {
                            $device['owner_program_id'] = $programId;
                        }
                        break;

                    case 'barcode':
                        $parsed = Barcode::normaliseScan($value);
                        if ($parsed === null) {
                            $rowErrors[] = "\"{$header}\" is empty after cleanup";
                        } else {
                            $device['barcode'] = $parsed;
                        }
                        break;

                    default:
                        $device[$field] = $value;
                }
            }

            // Derive a name when the sheet has no explicit name column.
            if (empty($device['name'])) {
                $derived = trim(($device['manufacturer'] ?? '') . ' ' . ($device['model'] ?? ''));
                $device['name'] = $derived !== ''
                    ? $derived
                    : ($device['asset_tag'] ?? $device['serial_number'] ?? null);
            }
            if (empty($device['name'])) {
                $rowErrors[] = 'could not determine a device name from this row';
            }

            // Duplicates within the file itself, which the database would only
            // catch one at a time, halfway through the import.
            if (!empty($device['barcode'])) {
                if (in_array($device['barcode'], $seenBarcodes, true)) {
                    $rowErrors[] = "barcode \"{$device['barcode']}\" appears more than once in this file";
                }
                $seenBarcodes[] = $device['barcode'];
            }
            if (!empty($device['serial_number'])) {
                $key = strtoupper($device['serial_number']);
                if (in_array($key, $seenSerials, true)) {
                    $rowErrors[] = "serial number \"{$device['serial_number']}\" appears more than once in this file";
                }
                $seenSerials[] = $key;
            }
            if (!empty($device['asset_tag'])) {
                $key = strtoupper($device['asset_tag']);
                if (in_array($key, $seenAssets, true)) {
                    $rowErrors[] = "asset tag \"{$device['asset_tag']}\" appears more than once in this file";
                }
                $seenAssets[] = $key;
            }

            if ($rowErrors !== []) {
                $errors[] = [
                    'line'   => $line,
                    'errors' => $rowErrors,
                    'row'    => [
                        'name'          => $device['name'] ?? null,
                        'asset_tag'     => $device['asset_tag'] ?? null,
                        'serial_number' => $device['serial_number'] ?? null,
                        'barcode'       => $device['barcode'] ?? null,
                    ],
                ];
                continue;
            }

            if ($custom !== []) {
                $device['custom_fields'] = json_encode($custom, JSON_UNESCAPED_SLASHES);
            }
            if (empty($device['status'])) {
                $device['status'] = $defaultStatus;
            }

            $existing = self::findExisting($organizationId, $device);

            $plan[] = [
                'line'            => $line,
                'action'          => $existing === null ? 'create' : ($updateExisting ? 'update' : 'skip'),
                'existing_id'     => $existing['id'] ?? null,
                'existing_barcode' => $existing['barcode'] ?? null,
                'device'          => $device,
            ];
        }

        $toCreate = count(array_filter($plan, static fn (array $p): bool => $p['action'] === 'create'));
        $toUpdate = count(array_filter($plan, static fn (array $p): bool => $p['action'] === 'update'));
        $toSkip   = count(array_filter($plan, static fn (array $p): bool => $p['action'] === 'skip'));

        $summary = [
            'row_count'        => count($records),
            'to_create'        => $toCreate,
            'to_update'        => $toUpdate,
            'to_skip'          => $toSkip,
            'error_count'      => count($errors),
            'errors'           => array_slice($errors, 0, 200),
            'errors_truncated' => count($errors) > 200,
            'mapping'          => $mapping,
            'dry_run'          => $dryRun,
        ];

        if ($dryRun) {
            // Record the dry run so an admin can see a file was evaluated.
            Db::execute(
                'INSERT INTO device_imports
                   (organization_id, filename, row_count, created_count, updated_count, skipped_count,
                    error_count, column_mapping, errors, dry_run, imported_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
                [
                    $organizationId, $filename, count($records), $toCreate, $toUpdate, $toSkip,
                    count($errors), json_encode($mapping), json_encode(array_slice($errors, 0, 200)),
                    $actor['userId'] ?? null,
                ],
            );

            $summary['preview'] = array_map(
                static fn (array $e): array => [
                    'line'             => $e['line'],
                    'action'           => $e['action'],
                    'existing_id'      => $e['existing_id'],
                    'existing_barcode' => $e['existing_barcode'],
                    'name'             => $e['device']['name'],
                    'asset_tag'        => $e['device']['asset_tag'] ?? null,
                    'serial_number'    => $e['device']['serial_number'] ?? null,
                    'barcode'          => $e['device']['barcode'] ?? '(will be assigned)',
                ],
                array_slice($plan, 0, 25),
            );

            return $summary;
        }

        // --- Commit -----------------------------------------------------------
        $result = Db::transaction(static function () use ($plan, $organizationId, $filename, $records, $mapping, $errors, $actor, $prefix): array {
            $importId = Db::insert(
                'INSERT INTO device_imports
                   (organization_id, filename, row_count, column_mapping, errors, dry_run, imported_by)
                 VALUES (?, ?, ?, ?, ?, 0, ?)',
                [$organizationId, $filename, count($records), json_encode($mapping),
                 json_encode(array_slice($errors, 0, 200)), $actor['userId'] ?? null],
            );

            $created = 0;
            $updated = 0;
            $skipped = 0;

            $exists = static fn (string $candidate): bool =>
                Db::value('SELECT id FROM devices WHERE barcode = ?', [$candidate]) !== null;

            foreach ($plan as $entry) {
                if ($entry['action'] === 'skip') {
                    $skipped++;
                    continue;
                }

                $device = $entry['device'];

                if ($entry['action'] === 'create') {
                    $barcode = $device['barcode'] ?? Barcode::allocate($exists, $prefix);

                    Db::execute(
                        'INSERT INTO devices
                           (organization_id, barcode, asset_tag, serial_number, name, category, manufacturer,
                            model, description, status, condition_note, location, home_location,
                            owner_program_id, purchase_date, purchase_cost, warranty_expires, funding_source,
                            notes, custom_fields, import_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            $organizationId, $barcode, $device['asset_tag'] ?? null,
                            $device['serial_number'] ?? null, $device['name'], $device['category'] ?? null,
                            $device['manufacturer'] ?? null, $device['model'] ?? null,
                            $device['description'] ?? null, $device['status'],
                            $device['condition_note'] ?? null, $device['location'] ?? null,
                            $device['home_location'] ?? null, $device['owner_program_id'] ?? null,
                            $device['purchase_date'] ?? null, $device['purchase_cost'] ?? null,
                            $device['warranty_expires'] ?? null, $device['funding_source'] ?? null,
                            $device['notes'] ?? null, $device['custom_fields'] ?? null, $importId,
                        ],
                    );
                    $created++;
                    continue;
                }

                // Update: only overwrite columns the sheet actually supplied,
                // so a partial spreadsheet cannot blank out data it knows
                // nothing about.
                $updatable = array_values(array_filter(
                    array_merge(self::IMPORTABLE, ['owner_program_id', 'custom_fields']),
                    static fn (string $f): bool => $f !== 'barcode' && array_key_exists($f, $device),
                ));

                if ($updatable === []) {
                    $skipped++;
                    continue;
                }

                $sets   = implode(', ', array_map(static fn (string $f): string => "{$f} = ?", $updatable));
                $params = array_map(static fn (string $f) => $device[$f], $updatable);
                $params[] = $importId;
                $params[] = $entry['existing_id'];
                $params[] = $organizationId;

                Db::execute(
                    "UPDATE devices SET {$sets}, import_id = ?, updated_at = NOW()
                      WHERE id = ? AND organization_id = ?",
                    $params,
                );
                $updated++;
            }

            Db::execute(
                'UPDATE device_imports SET created_count = ?, updated_count = ?, skipped_count = ?, error_count = ?
                  WHERE id = ?',
                [$created, $updated, $skipped, count($errors), $importId],
            );

            return ['importId' => $importId, 'created' => $created, 'updated' => $updated, 'skipped' => $skipped];
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::DEVICE_IMPORTED,
            'entityType'     => 'device_import',
            'entityId'       => $result['importId'],
            'entityLabel'    => $filename,
            'summary'        => sprintf(
                'Imported %s: %d created, %d updated, %d skipped, %d rejected',
                $filename ?? 'spreadsheet',
                $result['created'],
                $result['updated'],
                $result['skipped'],
                count($errors),
            ),
            'detail' => $result + ['error_count' => count($errors)],
        ]);

        return $summary + [
            'dry_run'       => false,
            'import_id'     => $result['importId'],
            'created_count' => $result['created'],
            'updated_count' => $result['updated'],
            'skipped_count' => $result['skipped'],
        ];
    }

    private static function findExisting(int $organizationId, array $device): ?array
    {
        foreach ([['barcode', 'barcode'], ['serial_number', 'serial_number'], ['asset_tag', 'asset_tag']] as [$key, $column]) {
            if (empty($device[$key])) {
                continue;
            }

            $row = Db::one(
                "SELECT id, barcode FROM devices WHERE {$column} = ? AND organization_id = ?",
                [$device[$key], $organizationId],
            );

            if ($row !== null) {
                return $row;
            }
        }

        return null;
    }

    public static function importHistory(int $organizationId): array
    {
        $rows = Db::all(
            'SELECT i.*, u.full_name AS imported_by_name
               FROM device_imports i
               LEFT JOIN users u ON u.id = i.imported_by
              WHERE i.organization_id = ?
              ORDER BY i.created_at DESC LIMIT 50',
            [$organizationId],
        );

        foreach ($rows as &$row) {
            $row['column_mapping'] = $row['column_mapping'] !== null ? json_decode((string) $row['column_mapping'], true) : null;
            $row['errors']         = $row['errors'] !== null ? json_decode((string) $row['errors'], true) : null;
        }

        return $rows;
    }
}
