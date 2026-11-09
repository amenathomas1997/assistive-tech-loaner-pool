<?php
/**
 * Loan lifecycle: check-out, check-in, extend, reduce, cancel, transfer.
 *
 * A device may be held by any combination of a technician, a program and a
 * client — all three holder columns are independent and nullable. The one
 * invariant enforced everywhere is that a device has at most one active loan,
 * and it is enforced with a row lock inside a transaction rather than by
 * checking devices.status first: two technicians scanning the same device at
 * one desk is a real scenario, not a theoretical one.
 */

declare(strict_types=1);

namespace Loaner;

final class Loans
{
    /** Statuses a device can be in and still be lent out. */
    public const LENDABLE = ['available', 'reserved'];

    private const SELECT = '
        SELECT l.*,
               d.name AS device_name, d.barcode AS device_barcode, d.asset_tag AS device_asset_tag,
               d.category AS device_category, d.manufacturer AS device_manufacturer, d.model AS device_model,
               d.item_type AS device_item_type, d.seats_total AS device_seats_total,
               t.full_name AS tech_name, t.email AS tech_email,
               c.first_name AS client_first_name, c.last_name AS client_last_name, c.email AS client_email,
               c.mobile AS client_mobile, c.sms_opt_in AS client_sms_opt_in,
               oru.full_name AS outcome_recorded_by_name,
               p.name AS program_name,
               lp.name AS period_name, lp.days AS period_days, lp.max_extensions AS period_max_extensions,
               ob.full_name AS checked_out_by_name,
               ib.full_name AS checked_in_by_name,
               r.reference AS request_reference
          FROM loans l
          JOIN devices d ON d.id = l.device_id
          LEFT JOIN users t ON t.id = l.tech_id
          LEFT JOIN clients c ON c.id = l.client_id
          LEFT JOIN programs p ON p.id = l.program_id
          LEFT JOIN loan_periods lp ON lp.id = l.loan_period_id
          LEFT JOIN users ob ON ob.id = l.checked_out_by
          LEFT JOIN users ib ON ib.id = l.checked_in_by
          LEFT JOIN users oru ON oru.id = l.outcome_recorded_by
          LEFT JOIN loan_requests r ON r.id = l.request_id';

    // -----------------------------------------------------------------------
    // Resolution
    // -----------------------------------------------------------------------

    /**
     * Resolve a device by barcode, asset tag or id — a scan, a typed value and
     * a click from a list all land here so the rules stay identical.
     *
     * $forUpdate takes a row lock; only valid inside a transaction.
     */
    public static function resolveDevice(int $organizationId, mixed $identifier, bool $forUpdate = false): ?array
    {
        if ($identifier === null || $identifier === '') {
            return null;
        }

        $lock = $forUpdate ? ' FOR UPDATE' : '';

        // Numeric ids come from the UI's own lists, never from a scanner.
        if (is_int($identifier) || (is_string($identifier) && ctype_digit($identifier))) {
            $byId = Db::one(
                "SELECT * FROM devices WHERE id = ? AND organization_id = ?{$lock}",
                [(int) $identifier, $organizationId],
            );
            if ($byId !== null) {
                return $byId;
            }
        }

        $scanned = Barcode::normaliseScan($identifier);
        if ($scanned === null) {
            return null;
        }

        // Barcode first: that is what a scanner produces, and it is unique.
        $byBarcode = Db::one(
            "SELECT * FROM devices WHERE barcode = ? AND organization_id = ?{$lock}",
            [$scanned, $organizationId],
        );
        if ($byBarcode !== null) {
            return $byBarcode;
        }

        // Fall back to the org's own asset tag, for hand-typed lookups.
        return Db::one(
            "SELECT * FROM devices WHERE asset_tag = ? AND organization_id = ?{$lock}",
            [$scanned, $organizationId],
        );
    }

    public static function activeLoanForDevice(int $deviceId, bool $forUpdate = false): ?array
    {
        return Db::one(
            'SELECT * FROM loans WHERE device_id = ? AND status = "active" LIMIT 1'
            . ($forUpdate ? ' FOR UPDATE' : ''),
            [$deviceId],
        );
    }

    /**
     * Compute a due date.
     *
     * days === 0 means an open-ended loan and yields null — distinct from "due
     * today", which a naive implementation would also produce for 0.
     */
    public static function computeDueDate(?int $days, ?\DateTimeInterface $from = null): ?\DateTimeImmutable
    {
        if ($days === null || $days <= 0) {
            return null;
        }

        $due = Util::addDays($from ?? new \DateTimeImmutable(), $days);

        // Due at end of the working day, not at the minute of check-out. A
        // device taken out at 16:55 is not overdue at 16:56 two weeks later.
        return $due->setTime(23, 59, 59);
    }

    // -----------------------------------------------------------------------
    // Check out
    // -----------------------------------------------------------------------

    public static function checkOut(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $techId         = $input['techId'] ?? null;
        $clientId       = $input['clientId'] ?? null;
        $programId      = $input['programId'] ?? null;
        $method         = $input['method'] ?? 'manual';
        $actorId        = $input['actorId'] ?? null;

        $settings = Settings::all($organizationId);

        if ($settings['loans.require_client_or_tech'] && !$techId && !$clientId && !$programId) {
            throw Util::badRequest(
                'A loan must be assigned to at least one of: a technician, a client, or a program.',
                ['fields' => ['tech_id', 'client_id', 'program_id']],
            );
        }

        $result = Db::transaction(static function () use (
            $organizationId, $input, $techId, $clientId, $programId, $method, $actorId, $settings
        ): array {
            $device = self::resolveDevice($organizationId, $input['deviceIdentifier']);
            if ($device === null) {
                throw Util::notFound("No device matches \"{$input['deviceIdentifier']}\".");
            }

            // Lock the row for the duration. A concurrent check-out of the same
            // device blocks here and then correctly sees it as already out.
            $locked = Db::one('SELECT * FROM devices WHERE id = ? FOR UPDATE', [$device['id']]);

            // How many of this can be out at once. A physical device is one;
            // a software licence is however many seats were bought. Modelled
            // here rather than as a separate kind of thing, because everything
            // else about lending a seat is identical to lending a device.
            $seats = max(1, (int) ($locked['seats_total'] ?? 1));
            $out   = (int) Db::value(
                'SELECT COUNT(*) FROM loans WHERE device_id = ? AND status = "active"',
                [$locked['id']],
            );

            if ($out >= $seats) {
                // Order matters for the single-seat case: naming the loan
                // reference is what the person at the desk actually needs.
                // "This device is marked checked out" is true but useless.
                $existing = self::activeLoanForDevice((int) $locked['id'], true);

                throw Util::conflict(
                    $seats === 1
                        ? "{$locked['name']} is already on loan ({$existing['reference']}). "
                          . 'Check it in before lending it again.'
                        : sprintf(
                            'All %d seats of %s are in use. One has to come back before another can '
                            . 'go out.', $seats, $locked['name'],
                        ),
                    [
                        'device_id'      => (int) $locked['id'],
                        'loan_id'        => $existing['id'] ?? null,
                        'loan_reference' => $existing['reference'] ?? null,
                        'seats_total'    => $seats,
                        'seats_in_use'   => $out,
                    ],
                );
            }

            if (!in_array($locked['status'], self::LENDABLE, true)) {
                throw Util::conflict(
                    "{$locked['name']} cannot be checked out because it is marked \""
                    . str_replace('_', ' ', $locked['status']) . '".',
                    ['device_id' => (int) $locked['id'], 'status' => $locked['status']],
                );
            }

            // A licence that has expired should not go out, whatever its
            // status says: the person receiving it would find it does not run.
            if (!empty($locked['licence_expires'])
                && strtotime((string) $locked['licence_expires']) < strtotime('today')
            ) {
                throw Util::conflict(
                    sprintf(
                        'The licence for %s expired on %s. Renew it before lending it, or the person '
                        . 'receiving it will find it does not work.',
                        $locked['name'], date('j M Y', strtotime((string) $locked['licence_expires'])),
                    ),
                    ['device_id' => (int) $locked['id'], 'licence_expires' => $locked['licence_expires']],
                );
            }

            // Equipment that touches ears, mouths and hands is cleaned between
            // users. Enforced only where an organisation has asked for it.
            if (!empty($settings['hygiene.enabled'])
                && !empty($settings['hygiene.require_between_loans'])
                && !empty($locked['needs_cleaning'])
            ) {
                throw Util::conflict(
                    sprintf(
                        '%s has not been cleaned since it was last returned, and this organisation '
                        . 'requires cleaning between users. Record the cleaning, then lend it.',
                        $locked['name'],
                    ),
                    ['device_id' => (int) $locked['id'], 'needs_cleaning' => true],
                );
            }

            // Validate holders belong to this organisation. Skipping this would
            // let a crafted API call attach another tenant's client to a loan.
            self::assertBelongs('users', $techId, $organizationId, 'technician');
            self::assertBelongs('clients', $clientId, $organizationId, 'client');
            self::assertBelongs('programs', $programId, $organizationId, 'program');

            // A request id is a claim that this loan fulfils that request, so
            // it has to be this organisation's and still open. Unchecked, a
            // mistyped id was a foreign-key failure reported as "something
            // went wrong", and another tenant's id would have been stored and
            // its reference shown on the loan.
            $requestId = $input['requestId'] ?? null;
            if (!empty($requestId)) {
                $linked = Db::one(
                    'SELECT id, status, reference, device_id FROM loan_requests WHERE id = ? AND organization_id = ?',
                    [$requestId, $organizationId],
                );
                if ($linked === null) {
                    throw Util::badRequest('That request does not exist.', ['field' => 'request_id']);
                }

                // Fulfilling it with a different device would leave the one
                // that was promised marked "reserved" for nobody.
                if ($linked['device_id'] !== null && (int) $linked['device_id'] !== (int) $locked['id']) {
                    throw Util::conflict(
                        "Request {$linked['reference']} is for a different device. Change the device on "
                        . 'the request first, or check this one out without linking it.',
                        ['field' => 'request_id', 'device_id' => (int) $linked['device_id']],
                    );
                }
                if ($linked['status'] !== 'approved') {
                    throw Util::conflict(
                        "Request {$linked['reference']} is {$linked['status']}, so a loan cannot be "
                        . 'recorded against it.',
                        ['field' => 'request_id', 'status' => $linked['status']],
                    );
                }
            }

            // Is somebody already promised this device?
            //
            // "reserved" is lendable, because the person it is held for has to
            // be able to collect it — but only them. Until this check existed
            // the hold was a status and nothing more: a walk-in could take a
            // device the waitlist had just told someone was ready, and when
            // the right person did collect it nothing recorded that either, so
            // every fulfilled reservation went on to "expire".
            $hold = $locked['status'] === 'reserved'
                ? self::holdOn($organizationId, (int) $locked['id'])
                : null;

            $holdOutcome = null;

            if ($hold !== null) {
                $matches = self::holderMatches($hold, $techId, $clientId, $programId);

                if ($matches) {
                    $holdOutcome = 'fulfilled';
                    // Collecting a device an approved request reserved IS
                    // fulfilling that request, whichever screen it happened on.
                    if ($hold['kind'] === 'request' && empty($requestId)) {
                        $requestId = (int) $hold['id'];
                    }
                } elseif (!empty($input['overrideHold'])) {
                    $holdOutcome = 'overridden';
                } else {
                    throw new HttpError(
                        409,
                        'device_held',
                        sprintf(
                            '%s is held for %s (%s%s). Check it out to them, or override the hold to '
                            . 'lend it to somebody else — they will go back to waiting.',
                            $locked['name'], $hold['held_for'], $hold['reference'],
                            $hold['until'] !== null ? ', until ' . $hold['until'] : '',
                        ),
                        [
                            'device_id'    => (int) $locked['id'],
                            'held_for'     => $hold['held_for'],
                            'hold_kind'    => $hold['kind'],
                            'hold_id'      => (int) $hold['id'],
                            'reference'    => $hold['reference'],
                            'can_override' => true,
                        ],
                    );
                }
            }

            $maxPerClient = (int) $settings['loans.max_per_client'];
            if ($clientId && $maxPerClient > 0) {
                $count = (int) Db::value(
                    'SELECT COUNT(*) FROM loans WHERE client_id = ? AND status = "active"',
                    [$clientId],
                );
                if ($count >= $maxPerClient) {
                    throw Util::conflict(
                        "This client already has {$count} device(s) on loan, which is the configured "
                        . "maximum of {$maxPerClient}.",
                        ['client_id' => $clientId, 'active_loans' => $count, 'max' => $maxPerClient],
                    );
                }
            }

            if ($clientId && !$settings['loans.allow_overdue_checkout']) {
                $overdue = Db::one(
                    'SELECT reference, due_at FROM loans
                      WHERE client_id = ? AND status = "active" AND due_at IS NOT NULL AND due_at < NOW()
                      LIMIT 1',
                    [$clientId],
                );
                if ($overdue !== null) {
                    throw Util::conflict(
                        "This client has an overdue loan ({$overdue['reference']}). Return or extend it "
                        . 'first, or enable "allow check-out with overdue loans" in settings.',
                        ['client_id' => $clientId, 'overdue_reference' => $overdue['reference']],
                    );
                }
            }

            ['periodId' => $periodId, 'days' => $days] = self::resolvePeriod(
                $organizationId,
                $input['loanPeriodId'] ?? null,
                $input['customDays'] ?? null,
            );

            $now   = new \DateTimeImmutable();
            $dueAt = self::computeDueDate($days, $now);

            $loanId = null;
            $reference = null;

            for ($attempt = 0; $attempt < 6; $attempt++) {
                $reference = Util::makeReference('LN');
                try {
                    $loanId = Db::insert(
                        'INSERT INTO loans
                           (organization_id, reference, device_id, request_id, tech_id, client_id, program_id,
                            loan_period_id, status, checked_out_at, checked_out_by, checkout_method,
                            due_at, original_due_at, condition_out, notes, authorization_ref)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, "active", ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            $organizationId, $reference, $locked['id'], $requestId ?: null,
                            $techId, $clientId, $programId, $periodId,
                            Util::mysqlDateTime($now), $actorId, $method,
                            Util::mysqlDateTime($dueAt), Util::mysqlDateTime($dueAt),
                            $input['conditionOut'] ?? null, $input['notes'] ?? null,
                            $input['authorizationRef'] ?? null,
                        ],
                    );
                    break;
                } catch (\Throwable $e) {
                    if (Db::isDuplicate($e) && str_contains($e->getMessage(), 'reference')) {
                        continue;
                    }
                    throw $e;
                }
            }

            if ($loanId === null) {
                throw new \RuntimeException('Could not allocate a unique loan reference.');
            }

            // A multi-seat item stays available while seats remain. Marking it
            // checked out after the first seat would hide the other nineteen.
            if ($out + 1 >= $seats) {
                Db::execute(
                    'UPDATE devices SET status = "checked_out", updated_at = NOW() WHERE id = ?',
                    [$locked['id']],
                );
            }

            Db::execute(
                'INSERT INTO loan_events (loan_id, event_type, new_due_at, actor_id, notes)
                 VALUES (?, "checkout", ?, ?, ?)',
                [$loanId, Util::mysqlDateTime($dueAt), $actorId, $input['notes'] ?? null],
            );

            // Record which accessories physically left with the device, so
            // check-in can report what did not come back.
            if (!empty($input['accessoriesOut'])) {
                Db::execute('UPDATE loans SET accessories_out = ? WHERE id = ?', [
                    json_encode($input['accessoriesOut']), $loanId,
                ]);
            }

            if (!empty($requestId)) {
                Db::execute(
                    'UPDATE loan_requests SET status = "fulfilled", fulfillment_state = "delivered",
                            loan_id = ?, updated_at = NOW()
                      WHERE id = ? AND organization_id = ? AND status = "approved"',
                    [$loanId, $requestId, $organizationId],
                );
            }

            // Settle the hold, in the same transaction as the loan it concerns.
            if ($hold !== null && $hold['kind'] === 'reservation') {
                if ($holdOutcome === 'fulfilled') {
                    Reservations::markFulfilled($organizationId, (int) $hold['id'], $loanId);
                } else {
                    // Back to the queue, not cancelled: they did nothing wrong,
                    // and the next return of a matching device will hold it
                    // for them again.
                    Reservations::releaseHold($organizationId, (int) $hold['id']);
                }
            }

            return ['loanId' => $loanId, 'reference' => $reference, 'device' => $locked,
                    'dueAt' => $dueAt, 'days' => $days, 'hold' => $hold, 'holdOutcome' => $holdOutcome,
                    'requestId' => $requestId];
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::LOAN_CHECKED_OUT,
            'entityType'     => 'loan',
            'entityId'       => $result['loanId'],
            'entityLabel'    => $result['reference'],
            'summary'        => sprintf(
                'Checked out %s (%s) — due %s',
                $result['device']['name'],
                $result['device']['barcode'],
                $result['dueAt'] ? $result['dueAt']->format('D j M Y') : 'open ended',
            ),
            'detail' => [
                'device_id' => (int) $result['device']['id'],
                'barcode'   => $result['device']['barcode'],
                'tech_id'   => $techId, 'client_id' => $clientId, 'program_id' => $programId,
                'days'      => $result['days'], 'method' => $method,
                'request_id' => $result['requestId'] ?: null,
                // Who it was held for and what became of that, because an
                // overridden hold is the thing somebody will ask about later.
                'hold' => $result['hold'] === null ? null : [
                    'kind' => $result['hold']['kind'], 'id' => (int) $result['hold']['id'],
                    'reference' => $result['hold']['reference'], 'held_for' => $result['hold']['held_for'],
                    'outcome' => $result['holdOutcome'],
                ],
            ],
        ]);

        if (($result['holdOutcome'] ?? null) === 'overridden') {
            Audit::record($actor, [
                'organizationId' => $organizationId,
                'action'         => Audit::LOAN_CHECKED_OUT,
                'entityType'     => $result['hold']['kind'],
                'entityId'       => (int) $result['hold']['id'],
                'entityLabel'    => $result['hold']['reference'],
                'summary'        => sprintf(
                    'Hold on %s for %s overridden; lent as %s instead',
                    $result['device']['name'], $result['hold']['held_for'], $result['reference'],
                ),
            ]);
        }

        return self::get($organizationId, (int) $result['loanId']);
    }

    /**
     * Who a reserved device is being held for, if anyone.
     *
     * Two things put a device into "reserved": the waitlist promoting someone
     * when it came back, and a technician approving a request against this
     * specific unit. Either is a promise to a named person, and a check-out
     * to anyone else has to know that.
     *
     * @return array{kind: string, id: int, reference: string, held_for: string,
     *               until: ?string, client_id: ?int, program_id: ?int, user_id: ?int}|null
     */
    public static function holdOn(int $organizationId, int $deviceId): ?array
    {
        $reservation = Db::one(
            'SELECT r.id, r.reference, r.client_id, r.program_id, r.requested_by, r.claim_expires_at,
                    c.first_name, c.last_name, p.name AS program_name, u.full_name AS requester_name
               FROM reservations r
               LEFT JOIN clients c ON c.id = r.client_id
               LEFT JOIN programs p ON p.id = r.program_id
               LEFT JOIN users u ON u.id = r.requested_by
              WHERE r.organization_id = ? AND r.status = "ready" AND r.ready_device_id = ?
              ORDER BY r.notified_at DESC LIMIT 1',
            [$organizationId, $deviceId],
        );

        if ($reservation !== null) {
            return [
                'kind'       => 'reservation',
                'id'         => (int) $reservation['id'],
                'reference'  => $reservation['reference'],
                'held_for'   => self::holderName($reservation),
                'until'      => $reservation['claim_expires_at'] !== null
                    ? date('D j M', strtotime((string) $reservation['claim_expires_at'])) : null,
                'client_id'  => $reservation['client_id'] !== null ? (int) $reservation['client_id'] : null,
                'program_id' => $reservation['program_id'] !== null ? (int) $reservation['program_id'] : null,
                'user_id'    => (int) $reservation['requested_by'],
            ];
        }

        $request = Db::one(
            'SELECT r.id, r.reference, r.client_id, r.program_id, r.requested_by,
                    c.first_name, c.last_name, p.name AS program_name, u.full_name AS requester_name
               FROM loan_requests r
               LEFT JOIN clients c ON c.id = r.client_id
               LEFT JOIN programs p ON p.id = r.program_id
               LEFT JOIN users u ON u.id = r.requested_by
              WHERE r.organization_id = ? AND r.status = "approved" AND r.device_id = ?
              ORDER BY r.reviewed_at DESC LIMIT 1',
            [$organizationId, $deviceId],
        );

        if ($request !== null) {
            return [
                'kind'       => 'request',
                'id'         => (int) $request['id'],
                'reference'  => $request['reference'],
                'held_for'   => self::holderName($request),
                'until'      => null,
                'client_id'  => $request['client_id'] !== null ? (int) $request['client_id'] : null,
                'program_id' => $request['program_id'] !== null ? (int) $request['program_id'] : null,
                'user_id'    => (int) $request['requested_by'],
            ];
        }

        // Reserved, but nothing live claims it — a hold that was cleaned up
        // incompletely. Not a reason to refuse anyone.
        return null;
    }

    private static function holderName(array $row): string
    {
        if (!empty($row['first_name'])) {
            return trim($row['first_name'] . ' ' . $row['last_name']);
        }
        if (!empty($row['program_name'])) {
            return $row['program_name'];
        }
        return $row['requester_name'] ?? 'somebody';
    }

    /**
     * Is this loan going to the person the hold was for?
     *
     * The most specific holder on the hold decides: a client if it names one,
     * else a program, else the staff member who asked.
     */
    private static function holderMatches(array $hold, mixed $techId, mixed $clientId, mixed $programId): bool
    {
        if ($hold['client_id'] !== null) {
            return (int) $clientId === $hold['client_id'];
        }
        if ($hold['program_id'] !== null) {
            return (int) $programId === $hold['program_id'];
        }
        return (int) $techId === $hold['user_id'];
    }

    public static function assertBelongs(string $table, mixed $id, int $organizationId, string $label): void
    {
        if (empty($id)) {
            return;
        }

        if (!is_scalar($id) || !ctype_digit((string) $id)) {
            throw Util::badRequest("That {$label} does not exist.", ['field' => "{$label}_id"]);
        }

        $row = Db::value("SELECT id FROM {$table} WHERE id = ? AND organization_id = ?", [$id, $organizationId]);

        if ($row === null) {
            throw Util::badRequest("That {$label} does not exist.", ['field' => "{$label}_id", 'value' => $id]);
        }
    }

    private static function resolvePeriod(int $organizationId, mixed $periodId, mixed $customDays): array
    {
        // `mixed`, not `?int`: a browser <select> submits its value as a string,
        // so loan_period_id arrives as "2". Under strict_types a typed ?int
        // parameter made that a TypeError — a 500 for anyone who picked a loan
        // period by name at the desk — while curl, which sends numbers, never
        // saw it. Validated here instead, once, for every caller.
        $periodId = Util::int($periodId, 'loan_period_id', 1);

        // An explicit custom duration always wins — that is the point of it.
        if ($customDays !== null && $customDays !== '') {
            $days = (int) $customDays;
            if ($days < 0 || $days > 3650) {
                throw Util::badRequest(
                    'A custom loan length must be a whole number of days between 0 and 3650.',
                    ['field' => 'custom_days'],
                );
            }
            return ['periodId' => null, 'days' => $days];
        }

        if ($periodId) {
            $period = Db::one(
                'SELECT * FROM loan_periods WHERE id = ? AND organization_id = ?',
                [$periodId, $organizationId],
            );
            if ($period === null) {
                throw Util::badRequest('That loan period does not exist.', ['field' => 'loan_period_id']);
            }
            return ['periodId' => (int) $period['id'], 'days' => (int) $period['days']];
        }

        $fallback = Settings::defaultLoanPeriod($organizationId);
        if ($fallback === null) {
            throw Util::unprocessable(
                'No loan periods are configured. An administrator must add at least one under '
                . 'Settings → Loan periods.'
            );
        }

        return ['periodId' => (int) $fallback['id'], 'days' => (int) $fallback['days']];
    }

    // -----------------------------------------------------------------------
    // Check in
    // -----------------------------------------------------------------------

    public static function checkIn(?array $actor, array $input): array
    {
        $organizationId  = (int) $input['organizationId'];
        $method          = $input['method'] ?? 'manual';
        $actorId         = $input['actorId'] ?? null;
        $newDeviceStatus = $input['newDeviceStatus'] ?? 'available';
        $conditionIn     = $input['conditionIn'] ?? null;
        $notes           = $input['notes'] ?? null;
        $accessoriesIn   = $input['accessoriesIn'] ?? null;

        if (empty($input['deviceIdentifier']) && empty($input['loanId'])) {
            throw Util::badRequest('Provide either a device barcode or a loan to check in.');
        }

        $result = Db::transaction(static function () use (
            $organizationId, $input, $conditionIn, $notes, $method, $actorId, $newDeviceStatus, $accessoriesIn
        ): array {
            if (!empty($input['loanId'])) {
                $loan = Db::one(
                    'SELECT * FROM loans WHERE id = ? AND organization_id = ? FOR UPDATE',
                    [$input['loanId'], $organizationId],
                );
                if ($loan === null) {
                    throw Util::notFound('That loan does not exist.');
                }
                $device = Db::one('SELECT * FROM devices WHERE id = ? FOR UPDATE', [$loan['device_id']]);
            } else {
                $device = self::resolveDevice($organizationId, $input['deviceIdentifier']);
                if ($device === null) {
                    throw Util::notFound(
                        "No device matches \"{$input['deviceIdentifier']}\". If this label was printed by "
                        . 'another system, find the device by name and check it in manually.'
                    );
                }
                $device = Db::one('SELECT * FROM devices WHERE id = ? FOR UPDATE', [$device['id']]);
                $loan   = self::activeLoanForDevice((int) $device['id'], true);
            }

            if ($loan === null) {
                // Not worth failing silently: a technician must know the scan
                // did not register, even though nothing is wrong with the device.
                throw Util::conflict(
                    "{$device['name']} ({$device['barcode']}) is not currently on loan.",
                    ['device_id' => (int) $device['id'], 'device_status' => $device['status'],
                     'already_returned' => true],
                );
            }

            if ($loan['status'] !== 'active') {
                throw Util::conflict(
                    "Loan {$loan['reference']} is already {$loan['status']}.",
                    ['loan_id' => (int) $loan['id'], 'status' => $loan['status']],
                );
            }

            $now        = new \DateTimeImmutable();
            $wasOverdue = Util::isOverdue($loan, $now);
            $daysLate   = $wasOverdue
                ? (int) ceil(($now->getTimestamp() - strtotime((string) $loan['due_at'])) / 86400)
                : 0;

            Db::execute(
                'UPDATE loans
                    SET status = "returned", returned_at = ?, checked_in_by = ?, checkin_method = ?,
                        condition_in = ?,
                        notes = CASE WHEN ? IS NULL THEN notes ELSE CONCAT(COALESCE(notes, ""), ?) END,
                        updated_at = NOW()
                  WHERE id = ?',
                [
                    Util::mysqlDateTime($now), $actorId, $method, $conditionIn,
                    $notes, $notes !== null ? "\n[check-in] {$notes}" : null,
                    $loan['id'],
                ],
            );

            // Returning a seat makes a multi-seat item available again even
            // though other seats are still out, so "available" is decided by
            // what remains rather than by this one return.
            $seats = max(1, (int) ($device['seats_total'] ?? 1));

            $stillOut = (int) Db::value(
                'SELECT COUNT(*) FROM loans WHERE device_id = ? AND status = "active" AND id <> ?',
                [$device['id'], $loan['id']],
            );

            $resolvedStatus = ($newDeviceStatus === 'available' && $stillOut > 0 && $stillOut >= $seats)
                ? 'checked_out'
                : $newDeviceStatus;

            // A repair opened while the device was out is still open. Coming
            // back does not mend it, and "available" would lend a faulty
            // device to the next person.
            if ($resolvedStatus === 'available' && !empty($device['active_repair_id'])) {
                $resolvedStatus = 'maintenance';
            }

            // Flagged for cleaning on the way back in, not on the way out:
            // this is the moment it stopped being with someone.
            $hygiene = !empty(Settings::all($organizationId)['hygiene.enabled']);

            Db::execute(
                'UPDATE devices
                    SET status = ?, condition_note = COALESCE(?, condition_note),
                        needs_cleaning = CASE WHEN ? = 1 THEN 1 ELSE needs_cleaning END,
                        updated_at = NOW()
                  WHERE id = ?',
                [$resolvedStatus, $conditionIn, $hygiene ? 1 : 0, $device['id']],
            );

            Db::execute(
                'INSERT INTO loan_events (loan_id, event_type, old_due_at, actor_id, notes)
                 VALUES (?, "checkin", ?, ?, ?)',
                [$loan['id'], Util::mysqlDateTime($loan['due_at']), $actorId, $notes],
            );

            // Compare what went out against what came back, so a missing
            // charger is recorded the moment it is noticed.
            $missing = [];
            if ($accessoriesIn !== null) {
                Db::execute('UPDATE loans SET accessories_in = ? WHERE id = ?', [
                    json_encode($accessoriesIn), $loan['id'],
                ]);

                $wentOut = $loan['accessories_out'] !== null
                    ? (json_decode((string) $loan['accessories_out'], true) ?: [])
                    : [];

                foreach ($wentOut as $name => $out) {
                    if ($out && empty($accessoriesIn[$name])) {
                        $missing[] = $name;
                    }
                }

                if ($missing !== []) {
                    Db::execute(
                        'INSERT INTO loan_events (loan_id, event_type, actor_id, notes)
                         VALUES (?, "note", ?, ?)',
                        [$loan['id'], $actorId, 'Accessories not returned: ' . implode(', ', $missing)],
                    );
                }
            }

            return ['loan' => $loan, 'device' => $device, 'wasOverdue' => $wasOverdue,
                    'daysLate' => $daysLate, 'missing' => $missing];
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::LOAN_CHECKED_IN,
            'entityType'     => 'loan',
            'entityId'       => (int) $result['loan']['id'],
            'entityLabel'    => $result['loan']['reference'],
            'summary'        => "Checked in {$result['device']['name']} ({$result['device']['barcode']})"
                              . ($result['wasOverdue'] ? " — {$result['daysLate']} day(s) overdue" : ''),
            'detail' => [
                'device_id' => (int) $result['device']['id'],
                'was_overdue' => $result['wasOverdue'], 'days_late' => $result['daysLate'],
                'method' => $method, 'new_device_status' => $newDeviceStatus,
            ],
        ]);

        // The device is free again — offer it to whoever is next on the
        // waitlist. Deliberately after the transaction, and never fatal: a
        // failure here must not undo a completed return.
        $promoted = null;
        if ($newDeviceStatus === 'available') {
            try {
                $promoted = Reservations::promoteNextForDevice($actor, $organizationId, (int) $result['device']['id']);
            } catch (\Throwable $e) {
                error_log('[loans] waitlist promotion failed: ' . $e->getMessage());
            }
        }

        return [
            'loan'                 => self::get($organizationId, (int) $result['loan']['id']),
            'device'               => $result['device'],
            'wasOverdue'           => $result['wasOverdue'],
            'daysLate'             => $result['daysLate'],
            'missingAccessories'   => $result['missing'],
            'promoted_reservation' => $promoted,
        ];
    }

    // -----------------------------------------------------------------------
    // Adjust
    // -----------------------------------------------------------------------

    /**
     * Change a loan's due date.
     *
     * Extending and reducing share this path because they are the same
     * operation with a different sign; keeping them together means the
     * extension cap, the audit entry and the timeline event cannot drift apart.
     */
    public static function adjustDueDate(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $loanId         = (int) $input['loanId'];
        $days           = $input['days'] ?? null;
        $newDueAt       = $input['newDueAt'] ?? null;
        $reason         = $input['reason'] ?? null;
        $actorId        = $input['actorId'] ?? null;
        $ignoreLimit    = (bool) ($input['ignoreExtensionLimit'] ?? false);

        if ($days === null && $newDueAt === null) {
            throw Util::badRequest('Provide either a number of days to change by, or a new due date.');
        }

        $result = Db::transaction(static function () use (
            $organizationId, $loanId, $days, $newDueAt, $reason, $actorId, $ignoreLimit
        ): array {
            $loan = Db::one(
                'SELECT * FROM loans WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$loanId, $organizationId],
            );
            if ($loan === null) {
                throw Util::notFound('That loan does not exist.');
            }
            if ($loan['status'] !== 'active') {
                throw Util::conflict(
                    "Loan {$loan['reference']} is {$loan['status']} and cannot be changed.",
                    ['status' => $loan['status']],
                );
            }

            $oldDueAt = $loan['due_at'] !== null ? new \DateTimeImmutable((string) $loan['due_at']) : null;

            if ($newDueAt !== null) {
                $target = $newDueAt instanceof \DateTimeInterface
                    ? \DateTimeImmutable::createFromInterface($newDueAt)
                    : new \DateTimeImmutable((string) $newDueAt);
            } else {
                $target = Util::addDays($oldDueAt ?? new \DateTimeImmutable(), (int) $days);
            }
            $target = $target->setTime(23, 59, 59);

            $isExtension = $oldDueAt === null || $target > $oldDueAt;

            if ($target->getTimestamp() < strtotime((string) $loan['checked_out_at'])) {
                throw Util::badRequest('A due date cannot be earlier than the date the device went out.');
            }

            if ($isExtension && !$ignoreLimit && $loan['loan_period_id'] !== null) {
                $period = Db::one('SELECT * FROM loan_periods WHERE id = ?', [$loan['loan_period_id']]);
                $max    = (int) ($period['max_extensions'] ?? 0);

                if ($period !== null && $max > 0 && (int) $loan['extension_count'] >= $max) {
                    throw Util::conflict(
                        "Loan {$loan['reference']} has already been extended {$loan['extension_count']} time(s), "
                        . "which is the maximum for the \"{$period['name']}\" period. An administrator can "
                        . 'override this.',
                        ['loan_id' => (int) $loan['id'], 'extension_count' => (int) $loan['extension_count'],
                         'max_extensions' => $max],
                    );
                }
            }

            Db::execute(
                'UPDATE loans SET due_at = ?, extension_count = extension_count + ?, updated_at = NOW()
                  WHERE id = ?',
                [Util::mysqlDateTime($target), $isExtension ? 1 : 0, $loan['id']],
            );

            Db::execute(
                'INSERT INTO loan_events (loan_id, event_type, old_due_at, new_due_at, actor_id, notes)
                 VALUES (?, ?, ?, ?, ?, ?)',
                [
                    $loan['id'], $isExtension ? 'extend' : 'reduce',
                    Util::mysqlDateTime($oldDueAt), Util::mysqlDateTime($target), $actorId, $reason,
                ],
            );

            return ['loan' => $loan, 'oldDueAt' => $oldDueAt, 'target' => $target, 'isExtension' => $isExtension];
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => $result['isExtension'] ? Audit::LOAN_EXTENDED : Audit::LOAN_REDUCED,
            'entityType'     => 'loan',
            'entityId'       => $loanId,
            'entityLabel'    => $result['loan']['reference'],
            'summary'        => sprintf(
                '%s %s: %s → %s',
                $result['isExtension'] ? 'Extended' : 'Reduced',
                $result['loan']['reference'],
                $result['oldDueAt'] ? $result['oldDueAt']->format('D j M Y') : 'open ended',
                $result['target']->format('D j M Y'),
            ),
            'detail' => ['reason' => $reason],
        ]);

        return self::get($organizationId, $loanId);
    }

    /**
     * Cancel a loan.
     *
     * Distinct from check-in: cancelling means the loan should not have
     * happened (wrong device scanned, request withdrawn). The device returns to
     * the pool, but the loan is excluded from utilisation reporting.
     */
    public static function cancel(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $loanId         = (int) $input['loanId'];
        $reason         = $input['reason'] ?? null;
        $actorId        = $input['actorId'] ?? null;
        $deviceStatus   = $input['deviceStatus'] ?? 'available';

        $result = Db::transaction(static function () use ($organizationId, $loanId, $reason, $actorId, $deviceStatus): array {
            $loan = Db::one(
                'SELECT * FROM loans WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$loanId, $organizationId],
            );
            if ($loan === null) {
                throw Util::notFound('That loan does not exist.');
            }
            if ($loan['status'] !== 'active') {
                throw Util::conflict("Loan {$loan['reference']} is already {$loan['status']}.", ['status' => $loan['status']]);
            }

            $device = Db::one('SELECT * FROM devices WHERE id = ? FOR UPDATE', [$loan['device_id']]);

            Db::execute(
                'UPDATE loans SET status = "cancelled", returned_at = NOW(), checked_in_by = ?, updated_at = NOW()
                  WHERE id = ?',
                [$actorId, $loan['id']],
            );
            // Same rule as check-in: a cancelled loan does not close a repair.
            $finalStatus = $deviceStatus === 'available' && !empty($device['active_repair_id'])
                ? 'maintenance'
                : $deviceStatus;

            Db::execute('UPDATE devices SET status = ?, updated_at = NOW() WHERE id = ?', [$finalStatus, $device['id']]);
            Db::execute(
                'INSERT INTO loan_events (loan_id, event_type, old_due_at, actor_id, notes)
                 VALUES (?, "cancel", ?, ?, ?)',
                [$loan['id'], Util::mysqlDateTime($loan['due_at']), $actorId, $reason],
            );

            return ['loan' => $loan, 'device' => $device];
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::LOAN_CANCELLED,
            'entityType'     => 'loan',
            'entityId'       => $loanId,
            'entityLabel'    => $result['loan']['reference'],
            'summary'        => "Cancelled {$result['loan']['reference']} for {$result['device']['name']}"
                              . ($reason !== null ? ": {$reason}" : ''),
            'detail'         => ['reason' => $reason],
        ]);

        // The device is back on the shelf just as surely as after a check-in,
        // and somebody may be waiting for it. This path did not consult the
        // waitlist, so a device freed by cancellation sat available while the
        // queue for it stood still.
        if ($deviceStatus === 'available') {
            try {
                Reservations::promoteNextForDevice($actor, $organizationId, (int) $result['device']['id']);
            } catch (\Throwable $e) {
                error_log('[loans] waitlist promotion after cancel failed: ' . $e->getMessage());
            }
        }

        return self::get($organizationId, $loanId);
    }

    /** Move an active loan to a different holder without a return trip. */
    public static function transfer(?array $actor, array $input): array
    {
        $organizationId = (int) $input['organizationId'];
        $loanId         = (int) $input['loanId'];
        $techId         = $input['techId'] ?? null;
        $clientId       = $input['clientId'] ?? null;
        $programId      = $input['programId'] ?? null;
        $reason         = $input['reason'] ?? null;
        $actorId        = $input['actorId'] ?? null;

        $loan = Db::transaction(static function () use ($organizationId, $loanId, $techId, $clientId, $programId, $reason, $actorId): array {
            $loan = Db::one(
                'SELECT * FROM loans WHERE id = ? AND organization_id = ? FOR UPDATE',
                [$loanId, $organizationId],
            );
            if ($loan === null) {
                throw Util::notFound('That loan does not exist.');
            }
            if ($loan['status'] !== 'active') {
                throw Util::conflict("Loan {$loan['reference']} is {$loan['status']} and cannot be transferred.");
            }

            self::assertBelongs('users', $techId, $organizationId, 'technician');
            self::assertBelongs('clients', $clientId, $organizationId, 'client');
            self::assertBelongs('programs', $programId, $organizationId, 'program');

            if (!$techId && !$clientId && !$programId) {
                throw Util::badRequest('A transfer must name at least one new holder.');
            }

            Db::execute(
                'UPDATE loans SET tech_id = ?, client_id = ?, program_id = ?, updated_at = NOW() WHERE id = ?',
                [$techId, $clientId, $programId, $loan['id']],
            );
            Db::execute(
                'INSERT INTO loan_events (loan_id, event_type, actor_id, notes) VALUES (?, "transfer", ?, ?)',
                [$loan['id'], $actorId, $reason],
            );

            return $loan;
        });

        Audit::record($actor, [
            'organizationId' => $organizationId,
            'action'         => Audit::LOAN_TRANSFERRED,
            'entityType'     => 'loan',
            'entityId'       => $loanId,
            'entityLabel'    => $loan['reference'],
            'summary'        => "Transferred {$loan['reference']} to a new holder",
            'detail'         => ['to' => compact('techId', 'clientId', 'programId'), 'reason' => $reason],
        ]);

        return self::get($organizationId, $loanId);
    }

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------

    /**
     * Fetch a loan, enforcing what the caller is entitled to see.
     *
     * A counselor may see loans for their own clients and loans created from
     * their own requests, and nothing else. Anything outside that is reported
     * as "does not exist" rather than "forbidden": confirming that a loan
     * exists would itself disclose which clients other counselors are working
     * with, which is the thing being protected.
     */
    /**
     * Keep only the loans this person may see.
     *
     * For the lists that are not built through Loans::list(), which applies
     * the same rule in SQL. A counselor sees their own caseload; every other
     * role is unaffected, so this returns the rows untouched for them.
     */
    public static function visibleOnly(?array $auth, array $rows): array
    {
        if (Auth::ownRecordsOnly($auth) === null) {
            return $rows;
        }

        return array_values(array_filter(
            $rows,
            static fn (array $loan): bool => self::isVisibleTo($auth, $loan),
        ));
    }

    public static function getVisible(?array $auth, int $organizationId, int $loanId): array
    {
        $loan = self::get($organizationId, $loanId);

        if ($loan === null) {
            throw Util::notFound('That loan does not exist.');
        }

        if (!self::isVisibleTo($auth, $loan)) {
            throw Util::notFound('That loan does not exist.');
        }

        return $loan;
    }

    public static function isVisibleTo(?array $auth, array $loan): bool
    {
        $restrictedTo = Auth::ownRecordsOnly($auth);

        if ($restrictedTo === null) {
            return true;
        }

        if (!empty($loan['client_id'])) {
            $isTheirClient = Db::value(
                'SELECT id FROM clients WHERE id = ? AND counselor_id = ?',
                [$loan['client_id'], $restrictedTo],
            );
            if ($isTheirClient !== null) {
                return true;
            }
        }

        if (!empty($loan['request_id'])) {
            $isTheirRequest = Db::value(
                'SELECT id FROM loan_requests WHERE id = ? AND requested_by = ?',
                [$loan['request_id'], $restrictedTo],
            );
            if ($isTheirRequest !== null) {
                return true;
            }
        }

        return false;
    }

    public static function get(int $organizationId, int $loanId): ?array
    {
        $loan = Db::one(self::SELECT . ' WHERE l.id = ? AND l.organization_id = ?', [$loanId, $organizationId]);

        return $loan === null ? null : self::decorate($loan);
    }

    public static function withTimeline(int $organizationId, int $loanId): ?array
    {
        $loan = self::get($organizationId, $loanId);
        if ($loan === null) {
            return null;
        }

        $loan['timeline'] = Db::all(
            'SELECT e.*, u.full_name AS actor_name
               FROM loan_events e
               LEFT JOIN users u ON u.id = e.actor_id
              WHERE e.loan_id = ?
              ORDER BY e.created_at ASC, e.id ASC',
            [$loanId],
        );

        return $loan;
    }

    /**
     * Add derived fields the UI and API both need, so "overdue" is computed in
     * exactly one place.
     */
    public static function decorate(array $loan): array
    {
        $now     = time();
        $overdue = Util::isOverdue($loan);
        $dueAt   = $loan['due_at'] !== null ? strtotime((string) $loan['due_at']) : null;

        $loan['is_overdue']     = $overdue;
        $loan['days_until_due'] = ($dueAt !== null && $loan['status'] === 'active')
            ? (int) ceil(($dueAt - $now) / 86400)
            : null;
        $loan['days_overdue']   = $overdue ? (int) ceil(($now - $dueAt) / 86400) : 0;
        $loan['client_name']    = !empty($loan['client_first_name'])
            ? $loan['client_first_name'] . ' ' . $loan['client_last_name']
            : null;
        $loan['holder_summary'] = self::describeHolders($loan);

        $loan['outcome_label'] = empty($loan['outcome'])
            ? null
            : (Outcomes::LABELS[$loan['outcome']] ?? $loan['outcome']);

        // A returned trial with no outcome is the thing somebody has to chase.
        $loan['outcome_outstanding'] = $loan['status'] === 'returned' && empty($loan['outcome']);

        return $loan;
    }

    /** One-line description of who holds a device, for lists and notifications. */
    public static function describeHolders(array $loan): string
    {
        $parts = [];

        if (!empty($loan['client_first_name'])) {
            $parts[] = $loan['client_first_name'] . ' ' . $loan['client_last_name'];
        }
        if (!empty($loan['tech_name'])) {
            $parts[] = $loan['tech_name'];
        }
        if (!empty($loan['program_name'])) {
            $parts[] = $loan['program_name'];
        }

        return $parts === [] ? 'Unassigned' : implode(' / ', $parts);
    }

    public static function list(int $organizationId, array $filters = [], array $options = []): array
    {
        $limit  = (int) ($options['limit'] ?? 50);
        $offset = (int) ($options['offset'] ?? 0);

        $where  = ['l.organization_id = ?'];
        $params = [$organizationId];

        $status = $filters['status'] ?? null;

        if ($status === 'overdue') {
            $where[] = 'l.status = "active" AND l.due_at IS NOT NULL AND l.due_at < NOW()';
        } elseif ($status === 'due_soon') {
            $days    = (int) ($filters['dueSoonDays'] ?? 3);
            $where[] = 'l.status = "active" AND l.due_at IS NOT NULL AND l.due_at >= NOW() '
                     . "AND l.due_at <= DATE_ADD(NOW(), INTERVAL {$days} DAY)";
        } elseif ($status !== null && $status !== '') {
            $where[]  = 'l.status = ?';
            $params[] = $status;
        }

        foreach ([['deviceId', 'l.device_id'], ['techId', 'l.tech_id'], ['clientId', 'l.client_id'],
                  ['programId', 'l.program_id'], ['counselorId', 'c.counselor_id']] as [$key, $column]) {
            if (!empty($filters[$key])) {
                $where[]  = "{$column} = ?";
                $params[] = $filters[$key];
            }
        }

        if (!empty($filters['from'])) { $where[] = 'l.checked_out_at >= ?'; $params[] = Util::mysqlDateTime($filters['from']); }
        if (!empty($filters['to']))   { $where[] = 'l.checked_out_at <= ?'; $params[] = Util::mysqlDateTime($filters['to']); }

        if (!empty($filters['search'])) {
            $where[] = '(l.reference LIKE ? OR d.name LIKE ? OR d.barcode LIKE ? OR d.asset_tag LIKE ? '
                     . 'OR CONCAT(c.first_name, " ", c.last_name) LIKE ? OR t.full_name LIKE ?)';
            $like = '%' . $filters['search'] . '%';
            array_push($params, $like, $like, $like, $like, $like, $like);
        }

        $whereSql = implode(' AND ', $where);

        $order = Util::orderBy($options['sort'] ?? null, [
            'checked_out_at' => 'l.checked_out_at', 'due_at' => 'l.due_at',
            'reference' => 'l.reference', 'device' => 'd.name', 'status' => 'l.status',
        ], 'l.checked_out_at DESC');

        $rows = Db::all(
            // l.id last: see Devices::list() on why every paged list ends on a unique column.
            self::SELECT . " WHERE {$whereSql} ORDER BY {$order}, l.id LIMIT {$limit} OFFSET {$offset}",
            $params,
        );

        $total = (int) Db::value(
            "SELECT COUNT(*) FROM loans l
               JOIN devices d ON d.id = l.device_id
               LEFT JOIN clients c ON c.id = l.client_id
               LEFT JOIN users t ON t.id = l.tech_id
              WHERE {$whereSql}",
            $params,
        );

        return ['rows' => array_map([self::class, 'decorate'], $rows), 'total' => $total];
    }

    /** Loans approaching their due date, for the reminder job. */
    public static function dueSoon(int $organizationId, int $withinDays = 3): array
    {
        $rows = Db::all(
            self::SELECT . '
              WHERE l.organization_id = ? AND l.status = "active"
                AND l.due_at IS NOT NULL
                AND l.due_at >= NOW()
                AND l.due_at <= DATE_ADD(NOW(), INTERVAL ? DAY)
                AND NOT EXISTS (
                  SELECT 1 FROM loan_events e
                   WHERE e.loan_id = l.id AND e.event_type = "due_soon_notice"
                     AND e.created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)
                )
              ORDER BY l.due_at ASC',
            [$organizationId, $withinDays],
        );

        return array_map([self::class, 'decorate'], $rows);
    }

    /** Overdue loans that have not been chased in the last day. */
    public static function overdue(int $organizationId): array
    {
        $rows = Db::all(
            self::SELECT . '
              WHERE l.organization_id = ? AND l.status = "active"
                AND l.due_at IS NOT NULL AND l.due_at < NOW()
                AND NOT EXISTS (
                  SELECT 1 FROM loan_events e
                   WHERE e.loan_id = l.id AND e.event_type = "overdue_notice"
                     AND e.created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)
                )
              ORDER BY l.due_at ASC',
            [$organizationId],
        );

        return array_map([self::class, 'decorate'], $rows);
    }
}
