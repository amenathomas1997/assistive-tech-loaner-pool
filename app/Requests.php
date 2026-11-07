<?php
/**
 * VRC loan requests and their fulfilment.
 *
 * Flow:
 *   VRC submits        -> status=submitted,  fulfillment=pending
 *   Tech approves      -> status=approved,   fulfillment=pending
 *   Tech starts work   -> fulfillment=provisioning
 *   Tech takes it out  -> fulfillment=in_transit    (deliver_to_client)
 *   Tech stages it     -> fulfillment=ready_pickup  (vrc_pickup)
 *   Handed over        -> status=fulfilled, fulfillment=delivered, loan created
 *
 * The two axes are kept separate on purpose: "approved but not yet
 * provisioned" and "approved and sitting on the shelf ready to collect" are
 * different things to the person asking where their equipment is.
 */

declare(strict_types=1);

namespace Loaner;

final class Requests
{
    public const STATUSES           = ['submitted', 'approved', 'denied', 'cancelled', 'fulfilled'];
    public const FULFILMENT_STATES  = ['pending', 'provisioning', 'in_transit', 'ready_pickup', 'delivered'];
    public const DELIVERY_MODES     = ['vrc_pickup', 'deliver_to_client', 'client_pickup'];

    public const FULFILMENT_LABELS = [
        'pending'      => 'Not started',
        'provisioning' => 'Being provisioned',
        'in_transit'   => 'On its way to the client',
        'ready_pickup' => 'Ready for pickup',
        'delivered'    => 'Delivered',
    ];

    /**
     * Which fulfilment states may follow which. Enforced so the tracker cannot
     * be driven into a state the counselor would read as progress when it is
     * not.
     */
    private const TRANSITIONS = [
        'pending'      => ['provisioning', 'in_transit', 'ready_pickup'],
        'provisioning' => ['in_transit', 'ready_pickup', 'pending'],
        'in_transit'   => ['delivered', 'ready_pickup', 'provisioning'],
        'ready_pickup' => ['delivered', 'in_transit', 'provisioning'],
        'delivered'    => [],
    ];

    private const SELECT = '
        SELECT r.*,
               u.full_name AS requester_name, u.email AS requester_email,
               c.first_name AS client_first_name, c.last_name AS client_last_name,
               c.email AS client_email, c.phone AS client_phone,
               p.name AS program_name,
               d.name AS device_name, d.barcode AS device_barcode, d.status AS device_status,
               t.full_name AS assigned_tech_name, t.email AS assigned_tech_email,
               rv.full_name AS reviewer_name,
               lp.name AS period_name, lp.days AS period_days,
               l.reference AS loan_reference, l.due_at AS loan_due_at
          FROM loan_requests r
          JOIN users u ON u.id = r.requested_by
          LEFT JOIN clients c ON c.id = r.client_id
          LEFT JOIN programs p ON p.id = r.program_id
          LEFT JOIN devices d ON d.id = r.device_id
          LEFT JOIN users t ON t.id = r.assigned_tech_id
          LEFT JOIN users rv ON rv.id = r.reviewed_by
          LEFT JOIN loan_periods lp ON lp.id = r.loan_period_id
          LEFT JOIN loans l ON l.id = r.loan_id';

    public static function get(int $organizationId, int $requestId): ?array
    {
        $row = Db::one(self::SELECT . ' WHERE r.id = ? AND r.organization_id = ?', [$requestId, $organizationId]);

        return $row === null ? null : self::decorate($row);
    }

    /**
     * Check that an id belongs to this organisation before it is written.
     *
     * Shared by create and review so a cross-tenant id cannot be attached by
     * either path.
     */
    private static function assertBelongs(
        string $table,
        mixed $id,
        int $organizationId,
        string $label,
        string $field,
    ): void {
        if (empty($id)) {
            return;
        }

        $exists = Db::value(
            "SELECT id FROM {$table} WHERE id = ? AND organization_id = ?",
            [$id, $organizationId],
        );

        if ($exists === null) {
            throw Util::badRequest("That {$label} does not exist.", ['field' => $field]);
        }
    }

    public static function decorate(array $row): array
    {
        $row['client_name'] = !empty($row['client_first_name'])
            ? $row['client_first_name'] . ' ' . $row['client_last_name']
            : null;

        $row['fulfillment_label']  = self::FULFILMENT_LABELS[$row['fulfillment_state']] ?? $row['fulfillment_state'];
        $row['tracking_summary']   = self::describeTracking($row);
        $row['can_be_cancelled']   = in_array($row['status'], ['submitted', 'approved'], true);
        $row['next_states']        = self::TRANSITIONS[$row['fulfillment_state']] ?? [];

        return $row;
    }

    /** What the requester is actually waiting on, in one phrase. */
    private static function describeTracking(array $row): string
    {
        return match (true) {
            $row['status'] === 'submitted' => 'Waiting for a technician to review it',
            $row['status'] === 'denied'    => 'Declined',
            $row['status'] === 'cancelled' => 'Cancelled',
            $row['status'] === 'fulfilled' => 'Delivered',
            default => match ($row['fulfillment_state']) {
                'pending'      => 'Approved — not yet started',
                'provisioning' => 'A technician is setting up the device',
                'in_transit'   => 'On its way to the client',
                'ready_pickup' => 'Ready for you to collect',
                default        => self::FULFILMENT_LABELS[$row['fulfillment_state']] ?? 'In progress',
            },
        };
    }

    public static function create(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $requestedBy    = (int) $input['requestedBy'];
        $deviceId       = $input['deviceId'] ?? null;

        if (!$deviceId && empty($input['requestedCategory']) && empty($input['requestedDetails'])) {
            throw Util::badRequest(
                'Say what is needed: pick a specific device, or choose a category, or describe the requirement.',
                ['fields' => ['device_id', 'requested_category', 'requested_details']],
            );
        }

        $created = Db::transaction(static function () use ($organizationId, $input, $deviceId, $requestedBy): array {
            if (!empty($input['clientId'])) {
                $client = Db::value(
                    'SELECT id FROM clients WHERE id = ? AND organization_id = ?',
                    [$input['clientId'], $organizationId],
                );
                if ($client === null) {
                    throw Util::badRequest('That client does not exist.', ['field' => 'client_id']);
                }
            }

            if ($deviceId) {
                $device = Db::value(
                    'SELECT id FROM devices WHERE id = ? AND organization_id = ?',
                    [$deviceId, $organizationId],
                );
                if ($device === null) {
                    throw Util::badRequest('That device does not exist.', ['field' => 'device_id']);
                }
            }

            // Every id is checked against this organisation before it reaches
            // the insert. Leaving it to the foreign key would be safe but
            // unhelpful: the counselor filling in the form would get "something
            // went wrong on the server" and a reference number for what is
            // really "that program does not exist".
            self::assertBelongs('programs', $input['programId'] ?? null, $organizationId,
                'program', 'program_id');
            self::assertBelongs('loan_periods', $input['loanPeriodId'] ?? null, $organizationId,
                'loan period', 'loan_period_id');
            self::assertBelongs('users', $input['assignedTechId'] ?? null, $organizationId,
                'technician', 'assigned_tech_id');

            for ($attempt = 0; $attempt < 6; $attempt++) {
                $reference = Util::makeReference('RQ');
                try {
                    $id = Db::insert(
                        'INSERT INTO loan_requests
                           (organization_id, reference, requested_by, client_id, program_id, device_id,
                            requested_category, requested_details, justification, needed_by,
                            loan_period_id, requested_days, delivery_mode, status, fulfillment_state)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "pending")',
                        [
                            $organizationId, $reference, $requestedBy,
                            $input['clientId'] ?? null, $input['programId'] ?? null, $deviceId,
                            $input['requestedCategory'] ?? null, $input['requestedDetails'] ?? null,
                            $input['justification'] ?? null, $input['neededBy'] ?? null,
                            $input['loanPeriodId'] ?? null, $input['requestedDays'] ?? null,
                            $input['deliveryMode'] ?? 'vrc_pickup',
                            !empty($input['autoApprove']) ? 'approved' : 'submitted',
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

            throw new \RuntimeException('Could not allocate a unique request reference.');
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::REQUEST_SUBMITTED,
            'entityType'     => 'request',
            'entityId'       => $created['id'],
            'entityLabel'    => $created['reference'],
            'summary'        => "Loan request {$created['reference']} submitted",
            'detail'         => ['client_id' => $input['clientId'] ?? null, 'device_id' => $deviceId],
        ]);

        return self::get($organizationId, $created['id']);
    }

    /**
     * Approve or deny.
     *
     * Approving may reserve a specific device so it cannot be lent out from
     * under the request between approval and provisioning.
     */
    public static function review(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $requestId      = (int) $input['requestId'];
        $decision       = (string) $input['decision'];
        $notes          = $input['notes'] ?? null;
        $deviceId       = $input['deviceId'] ?? null;
        $actorId        = $input['actorId'] ?? null;

        if (!in_array($decision, ['approved', 'denied'], true)) {
            throw Util::badRequest('A review decision must be either "approved" or "denied".');
        }

        $request = Db::transaction(static function () use (
            $organizationId, $requestId, $decision, $notes, $deviceId, $input, $actorId
        ): array {
            $request = Db::one(
                'SELECT * FROM loan_requests WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$requestId, $organizationId],
            );
            if ($request === null) {
                throw Util::notFound('That request does not exist.');
            }
            if ($request['status'] !== 'submitted') {
                throw Util::conflict(
                    "Request {$request['reference']} has already been {$request['status']} and cannot be "
                    . 'reviewed again.',
                    ['status' => $request['status']],
                );
            }

            if ($decision === 'approved' && $deviceId) {
                $device = Db::one(
                    'SELECT * FROM devices WHERE id = ? AND organization_id = ? FOR UPDATE',
                    [$deviceId, $organizationId],
                );
                if ($device === null) {
                    throw Util::badRequest('That device does not exist.', ['field' => 'device_id']);
                }

                $activeLoan = Db::one(
                    'SELECT reference FROM loans WHERE device_id = ? AND status = "active"',
                    [$deviceId],
                );
                if ($activeLoan !== null) {
                    throw Util::conflict(
                        "{$device['name']} is already on loan ({$activeLoan['reference']}) and cannot be "
                        . 'reserved for this request.',
                        ['device_id' => $deviceId, 'loan_reference' => $activeLoan['reference']],
                    );
                }

                if (!in_array($device['status'], ['available', 'reserved'], true)) {
                    throw Util::conflict(
                        "{$device['name']} is marked \"{$device['status']}\" and cannot be reserved.",
                        ['device_id' => $deviceId, 'status' => $device['status']],
                    );
                }

                Db::execute('UPDATE devices SET status = "reserved", updated_at = NOW() WHERE id = ?', [$deviceId]);
            }

            self::assertBelongs('users', $input['assignedTechId'] ?? null, $organizationId,
                'technician', 'assigned_tech_id');
            self::assertBelongs('loan_periods', $input['loanPeriodId'] ?? null, $organizationId,
                'loan period', 'loan_period_id');

            Db::execute(
                'UPDATE loan_requests
                    SET status = ?, review_notes = ?, reviewed_by = ?, reviewed_at = NOW(),
                        device_id = COALESCE(?, device_id),
                        assigned_tech_id = COALESCE(?, assigned_tech_id),
                        loan_period_id = COALESCE(?, loan_period_id),
                        updated_at = NOW()
                  WHERE id = ?',
                [
                    $decision, $notes, $actorId, $deviceId,
                    $input['assignedTechId'] ?? null, $input['loanPeriodId'] ?? null, $requestId,
                ],
            );

            return $request;
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => $decision === 'approved' ? Audit::REQUEST_APPROVED : Audit::REQUEST_DENIED,
            'entityType'     => 'request',
            'entityId'       => $requestId,
            'entityLabel'    => $request['reference'],
            'summary'        => "Request {$request['reference']} {$decision}" . ($notes !== null ? ": {$notes}" : ''),
            'detail'         => ['decision' => $decision, 'device_id' => $deviceId],
        ]);

        return self::get($organizationId, $requestId);
    }

    /** Move an approved request along its fulfilment track. */
    public static function updateFulfillment(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $requestId      = (int) $input['requestId'];
        $state          = (string) $input['state'];

        if (!in_array($state, self::FULFILMENT_STATES, true)) {
            throw Util::badRequest("\"{$state}\" is not a fulfilment state.", ['allowed' => self::FULFILMENT_STATES]);
        }

        $result = Db::transaction(static function () use ($organizationId, $requestId, $state, $input): array {
            $request = Db::one(
                'SELECT * FROM loan_requests WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$requestId, $organizationId],
            );
            if ($request === null) {
                throw Util::notFound('That request does not exist.');
            }

            if ($request['status'] !== 'approved') {
                throw Util::conflict(
                    "Request {$request['reference']} is \"{$request['status']}\". Only an approved request can "
                    . 'be moved through fulfilment.',
                    ['status' => $request['status']],
                );
            }

            $allowed = self::TRANSITIONS[$request['fulfillment_state']] ?? [];

            if ($state !== $request['fulfillment_state'] && !in_array($state, $allowed, true)) {
                throw Util::conflict(
                    sprintf(
                        'A request cannot go from "%s" to "%s".',
                        self::FULFILMENT_LABELS[$request['fulfillment_state']],
                        self::FULFILMENT_LABELS[$state],
                    ),
                    ['from' => $request['fulfillment_state'], 'to' => $state, 'allowed' => $allowed],
                );
            }

            if ($state === 'delivered') {
                throw Util::badRequest(
                    'Mark a request delivered by checking the device out to its holder, not by setting the '
                    . 'state directly. Use the fulfil action so a loan record is created.'
                );
            }

            Db::execute(
                'UPDATE loan_requests
                    SET fulfillment_state = ?,
                        assigned_tech_id = COALESCE(?, assigned_tech_id),
                        device_id = COALESCE(?, device_id),
                        updated_at = NOW()
                  WHERE id = ?',
                [$state, $input['assignedTechId'] ?? null, $input['deviceId'] ?? null, $requestId],
            );

            return ['request' => $request, 'from' => $request['fulfillment_state']];
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::REQUEST_STATE_CHANGED,
            'entityType'     => 'request',
            'entityId'       => $requestId,
            'entityLabel'    => $result['request']['reference'],
            'summary'        => sprintf(
                'Request %s: %s → %s',
                $result['request']['reference'],
                self::FULFILMENT_LABELS[$result['from']],
                self::FULFILMENT_LABELS[$state],
            ),
            'detail' => ['from' => $result['from'], 'to' => $state],
        ]);

        return self::get($organizationId, $requestId);
    }

    /**
     * Hand the device over: creates the loan and closes the request.
     *
     * Delegates to Loans::checkOut so a request-originated loan is identical in
     * every respect to one created at the check-out desk.
     */
    public static function fulfil(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $requestId      = (int) $input['requestId'];

        $request = self::get($organizationId, $requestId);
        if ($request === null) {
            throw Util::notFound('That request does not exist.');
        }
        if ($request['status'] !== 'approved') {
            throw Util::conflict(
                "Request {$request['reference']} is \"{$request['status']}\". Approve it before fulfilling it.",
                ['status' => $request['status']],
            );
        }

        $device = $input['deviceIdentifier'] ?? $request['device_id'];
        if (empty($device)) {
            throw Util::badRequest('Scan or choose the device being handed over before fulfilling this request.');
        }

        // Releasing the hold and taking the loan have to be one transaction.
        // Done separately, the device is briefly unreserved and lendable: the
        // scan desk could check it out to somebody else in between, the
        // fulfilment would then fail with "already on loan", and the request
        // would be left approved with the hold it was relying on already gone.
        $loan = Db::transaction(static function () use ($request, $organizationId, $actor, $input, $device): array {
            if (!empty($request['device_id'])) {
                Db::execute(
                    'UPDATE devices SET status = "available"
                      WHERE id = ? AND organization_id = ? AND status = "reserved"',
                    [$request['device_id'], $organizationId],
                );
            }

            return Loans::checkOut($actor, [
                'organizationId'   => $organizationId,
                'deviceIdentifier' => $device,
                'techId'           => $input['techId'] ?? $request['assigned_tech_id'] ?? null,
                'clientId'         => $input['clientId'] ?? $request['client_id'] ?? null,
                'programId'        => $input['programId'] ?? $request['program_id'] ?? null,
                'loanPeriodId'     => $input['loanPeriodId'] ?? $request['loan_period_id'] ?? null,
                'customDays'       => $input['customDays'] ?? $request['requested_days'] ?? null,
                'notes'            => $input['notes'] ?? null,
                'conditionOut'     => $input['conditionOut'] ?? null,
                'method'           => $input['method'] ?? 'request',
                'requestId'        => $request['id'],
                'actorId'          => $input['actorId'] ?? null,
            ]);
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::REQUEST_FULFILLED,
            'entityType'     => 'request',
            'entityId'       => $requestId,
            'entityLabel'    => $request['reference'],
            'summary'        => "Request {$request['reference']} fulfilled as loan {$loan['reference']}",
            'detail'         => ['loan_id' => (int) $loan['id'], 'loan_reference' => $loan['reference']],
        ]);

        return ['request' => self::get($organizationId, $requestId), 'loan' => $loan];
    }

    public static function cancel(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $requestId      = (int) $input['requestId'];
        $reason         = $input['reason'] ?? null;
        $auth           = $input['auth'] ?? null;

        $request = Db::transaction(static function () use ($organizationId, $requestId, $reason, $auth): array {
            $request = Db::one(
                'SELECT * FROM loan_requests WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$requestId, $organizationId],
            );
            if ($request === null) {
                throw Util::notFound('That request does not exist.');
            }

            if (Auth::isRestrictedToOwnRecords($auth) && (int) $request['requested_by'] !== (int) $auth['userId']) {
                throw Util::forbidden('You can only cancel requests you submitted.');
            }
            if (!in_array($request['status'], ['submitted', 'approved'], true)) {
                throw Util::conflict(
                    "Request {$request['reference']} is {$request['status']} and cannot be cancelled.",
                    ['status' => $request['status']],
                );
            }

            if (!empty($request['device_id'])) {
                Db::execute(
                    'UPDATE devices SET status = "available", updated_at = NOW()
                      WHERE id = ? AND status = "reserved"',
                    [$request['device_id']],
                );
            }

            Db::execute(
                'UPDATE loan_requests SET status = "cancelled", review_notes = COALESCE(?, review_notes),
                        updated_at = NOW()
                  WHERE id = ?',
                [$reason, $requestId],
            );

            return $request;
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::REQUEST_CANCELLED,
            'entityType'     => 'request',
            'entityId'       => $requestId,
            'entityLabel'    => $request['reference'],
            'summary'        => "Request {$request['reference']} cancelled" . ($reason !== null ? ": {$reason}" : ''),
        ]);

        return self::get($organizationId, $requestId);
    }

    public static function list(int $organizationId, array $filters = [], array $options = []): array
    {
        $limit  = (int) ($options['limit'] ?? 50);
        $offset = (int) ($options['offset'] ?? 0);

        $where  = ['r.organization_id = ?'];
        $params = [$organizationId];

        foreach ([
            ['status', 'r.status'], ['fulfillmentState', 'r.fulfillment_state'],
            ['requestedBy', 'r.requested_by'], ['assignedTechId', 'r.assigned_tech_id'],
            ['clientId', 'r.client_id'], ['programId', 'r.program_id'],
        ] as [$key, $column]) {
            if (!empty($filters[$key])) {
                $where[]  = "{$column} = ?";
                $params[] = $filters[$key];
            }
        }

        if (!empty($filters['open'])) {
            $where[] = 'r.status IN ("submitted", "approved")';
        }

        if (!empty($filters['search'])) {
            $where[] = '(r.reference LIKE ? OR r.requested_category LIKE ? OR r.requested_details LIKE ? '
                     . 'OR CONCAT(c.first_name, " ", c.last_name) LIKE ? OR u.full_name LIKE ?)';
            $like = '%' . $filters['search'] . '%';
            array_push($params, $like, $like, $like, $like, $like);
        }

        $whereSql = implode(' AND ', $where);

        $order = Util::orderBy($options['sort'] ?? null, [
            'created_at' => 'r.created_at', 'needed_by' => 'r.needed_by',
            'status' => 'r.status', 'reference' => 'r.reference',
        ], 'r.created_at DESC');

        $rows = Db::all(
            self::SELECT . " WHERE {$whereSql} ORDER BY {$order} LIMIT {$limit} OFFSET {$offset}",
            $params,
        );

        $total = (int) Db::value(
            "SELECT COUNT(*) FROM loan_requests r
               JOIN users u ON u.id = r.requested_by
               LEFT JOIN clients c ON c.id = r.client_id
              WHERE {$whereSql}",
            $params,
        );

        return ['rows' => array_map([self::class, 'decorate'], $rows), 'total' => $total];
    }
}
