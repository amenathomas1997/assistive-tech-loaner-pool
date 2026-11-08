<?php
/**
 * Check-out, check-in and loan adjustments.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Agreements;
use Loaner\Attachments;
use Loaner\Audit;
use Loaner\Auth;
use Loaner\Loans;
use Loaner\Notifications;
use Loaner\Request;
use Loaner\Response;
use Loaner\Router;
use Loaner\Settings;
use Loaner\Util;

final class LoanRoutes
{
    public static function register(Router $router): void
    {
        $router->get('/loans', [self::class, 'index'], 'loans.read');
        $router->get('/loans/periods', [self::class, 'periods'], 'loans.read');
        $router->get('/loans/export.csv', [self::class, 'exportCsv'], 'loans.read');
        $router->get('/loans/overdue', [self::class, 'overdue'], 'loans.read');
        $router->get('/loans/due-soon', [self::class, 'dueSoon'], 'loans.read');

        $router->post('/loans/checkout', [self::class, 'checkOut'], 'loans.write');
        $router->post('/loans/checkin', [self::class, 'checkIn'], 'loans.write');

        $router->get('/loans/{id}', [self::class, 'show'], 'loans.read');
        $router->post('/loans/{id}/extend', [self::class, 'extend'], 'loans.write');
        $router->post('/loans/{id}/reduce', [self::class, 'reduce'], 'loans.write');
        $router->post('/loans/{id}/cancel', [self::class, 'cancel'], 'loans.cancel');
        $router->post('/loans/{id}/transfer', [self::class, 'transfer'], 'loans.write');
    }

    public static function index(Request $request): never
    {
        $auth       = $request->auth;
        $pagination = Util::pagination($request->query);

        $filters = [
            'status'    => $request->queryParam('status'),
            'deviceId'  => $request->queryParam('device_id'),
            'techId'    => $request->queryParam('tech_id'),
            'clientId'  => $request->queryParam('client_id'),
            'programId' => $request->queryParam('program_id'),
            'dueSoonDays' => $request->queryParam('days'),
            'from'      => $request->queryParam('from'),
            'to'        => $request->queryParam('to'),
            'search'    => $request->queryParam('search'),
        ];

        // A counselor sees loans for their own caseload. Enforced here rather
        // than in the browser, because a filter applied only in the interface
        // is not a restriction at all.
        $restrictedTo = Auth::ownRecordsOnly($auth);
        if ($restrictedTo !== null) {
            $filters['counselorId'] = $restrictedTo;
        }

        $result = Loans::list((int) $auth['organizationId'], $filters, [
            'limit'  => $pagination['limit'],
            'offset' => $pagination['offset'],
            'sort'   => $request->queryParam('sort'),
        ]);

        Response::json(Util::paged($result['rows'], $result['total'], $pagination));
    }

    public static function show(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $loanId         = (int) $request->param('id');

        // Throws "does not exist" when the caller is not entitled to it.
        Loans::getVisible($request->auth, $organizationId, $loanId);

        $loan = Loans::withTimeline($organizationId, $loanId);
        if ($loan === null) {
            throw Util::notFound('That loan does not exist.');
        }

        Response::json([
            'loan'        => $loan,
            'agreement'   => Agreements::forLoan($organizationId, $loanId),
            'attachments' => Attachments::forLoan($organizationId, $loanId),
        ]);
    }

    public static function periods(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];

        Response::json([
            'data'     => Settings::loanPeriods($organizationId),
            'default'  => Settings::defaultLoanPeriod($organizationId),
            'policy'   => [
                'allow_overdue_checkout' => (bool) Settings::get($organizationId, 'loans.allow_overdue_checkout'),
                'require_client_or_tech' => (bool) Settings::get($organizationId, 'loans.require_client_or_tech'),
                'max_per_client'         => (int) Settings::get($organizationId, 'loans.max_per_client'),
            ],
            'agreements' => Agreements::settings($organizationId),
            'photos'     => [
                'enabled'            => (bool) Settings::get($organizationId, 'photos.enabled'),
                'prompt_on_checkout' => (bool) Settings::get($organizationId, 'photos.prompt_on_checkout'),
                'prompt_on_checkin'  => (bool) Settings::get($organizationId, 'photos.prompt_on_checkin'),
                'max_per_phase'      => (int) Settings::get($organizationId, 'photos.max_per_phase'),
            ],
        ]);
    }

    public static function checkOut(Request $request): never
    {
        $auth           = $request->auth;
        $organizationId = (int) $auth['organizationId'];
        $body           = $request->body();

        $identifier = $body['device'] ?? $body['barcode'] ?? $body['device_id'] ?? $body['deviceId'] ?? null;

        if (empty($identifier)) {
            throw Util::badRequest(
                'Scan or choose the device being lent out.',
                ['field' => 'device'],
            );
        }

        $loan = Loans::checkOut(Audit::actor($request), [
            'organizationId'   => $organizationId,
            'deviceIdentifier' => $identifier,
            'techId'           => $body['tech_id'] ?? $body['techId'] ?? null,
            'clientId'         => $body['client_id'] ?? $body['clientId'] ?? null,
            'programId'        => $body['program_id'] ?? $body['programId'] ?? null,
            'loanPeriodId'     => $body['loan_period_id'] ?? $body['loanPeriodId'] ?? null,
            'customDays'       => $body['custom_days'] ?? $body['customDays'] ?? null,
            'conditionOut'     => Util::str($body['condition_out'] ?? $body['conditionOut'] ?? null, 190),
            'notes'            => Util::str($body['notes'] ?? null),
            'accessoriesOut'   => $body['accessories'] ?? $body['accessories_out']
                ?? $body['accessoriesOut'] ?? null,
            'requestId'        => $body['request_id'] ?? $body['requestId'] ?? null,
            // Lend a device that is held for somebody else. Explicit, and
            // audited against the hold it overrode; the person held for goes
            // back to the top of the queue.
            'overrideHold'     => Util::bool($body['override_hold'] ?? $body['overrideHold'] ?? false),
            // The VR authorisation the equipment goes out against. Without it
            // on the loan there is no way to tie what was lent back to the
            // case that paid for it.
            'authorizationRef' => Util::boundedStr(
                $body['authorization_ref'] ?? $body['authorizationRef'] ?? null,
                'authorization_ref', 64,
            ),
            // The scan station sends scanned:true rather than restating the
            // method, so the two cannot disagree about how it was done.
            'method'           => Util::bool($body['scanned'] ?? false)
                ? 'scan'
                : Util::oneOf(
                    $body['method'] ?? 'manual', ['scan', 'manual', 'api', 'request'], 'method', true,
                ),
            'actorId'          => $auth['userId'] ?? null,
        ]);

        $notification = Notifications::send(Audit::actor($request), $organizationId, 'checked_out',
            $loan + ['__loan_id' => (int) $loan['id']]);

        Response::json([
            'loan'   => $loan,
            'notice' => self::checkOutNotice($organizationId, $loan),
            // Surfaced so the desk learns the email did not go out while the
            // client is still standing there, rather than discovering it when
            // nobody turns up to return the device. Never fatal: the loan has
            // already happened by this point.
            'notification' => $notification,
        ], 201);
    }

    /**
     * What the person at the desk still has to do. Returned with the loan so
     * an agreement or a photo prompt is not something they have to remember.
     */
    private static function checkOutNotice(int $organizationId, array $loan): ?string
    {
        $parts = [];

        $agreements = Agreements::settings($organizationId);
        if ($agreements['enabled'] && Agreements::forLoan($organizationId, (int) $loan['id']) === null) {
            $parts[] = $agreements['required']
                ? 'This loan needs a signed agreement.'
                : 'You can capture a signed agreement for this loan.';
        }

        if (Settings::get($organizationId, 'photos.enabled')
            && Settings::get($organizationId, 'photos.prompt_on_checkout')
        ) {
            $parts[] = 'Take condition photos before it leaves.';
        }

        if (empty($loan['due_at'])) {
            $parts[] = 'This loan has no return date, so it will never appear as overdue.';
        }

        return $parts === [] ? null : implode(' ', $parts);
    }

    public static function checkIn(Request $request): never
    {
        $auth           = $request->auth;
        $organizationId = (int) $auth['organizationId'];
        $body           = $request->body();

        $identifier = $body['device'] ?? $body['barcode'] ?? null;
        $loanId     = $body['loan_id'] ?? $body['loanId'] ?? null;

        if (empty($identifier) && empty($loanId)) {
            throw Util::badRequest(
                'Scan the device, or choose the loan to check in. If no scanner is to hand, find the '
                . 'device by name and check it in from there.',
                ['fields' => ['device', 'loan_id']],
            );
        }

        $result = Loans::checkIn(Audit::actor($request), [
            'organizationId'   => $organizationId,
            'deviceIdentifier' => $identifier,
            'loanId'           => $loanId,
            'conditionIn'      => Util::str($body['condition_in'] ?? $body['conditionIn'] ?? null, 190),
            'notes'            => Util::str($body['notes'] ?? null),
            'accessoriesIn'    => $body['accessories'] ?? $body['accessories_in']
                ?? $body['accessoriesIn'] ?? null,
            'newDeviceStatus'  => Util::oneOf(
                $body['new_device_status'] ?? $body['newDeviceStatus'] ?? 'available',
                \Loaner\Devices::STATUSES, 'new_device_status', true,
            ),
            'method'           => Util::bool($body['scanned'] ?? false)
                ? 'scan'
                : Util::oneOf($body['method'] ?? 'manual', ['scan', 'manual', 'api'], 'method', true),
            'actorId'          => $auth['userId'] ?? null,
        ]);

        $notification = Notifications::send(Audit::actor($request), $organizationId, 'checked_in',
            $result['loan'] + ['__loan_id' => (int) $result['loan']['id']]);

        // What did not come back is the single most important thing to put in
        // front of the person at the desk, while the client is still standing
        // there. It never blocks the return.
        $missing = $result['missingAccessories'] ?? [];

        Response::json($result + [
            'missing_accessories' => $missing,
            'notice'  => self::checkInNotice($result, $missing),
            // A separate field from "notice" because the client raises this one
            // as its own warning: something physically did not come back, and
            // it has to be noticed now rather than read in a summary line.
            'warning' => $missing === []
                ? null
                : 'Not returned: ' . implode(', ', $missing) . '.',
            'notification' => $notification,
        ]);
    }

    /** The one line the desk needs after a return. Null when all is well. */
    private static function checkInNotice(array $result, array $missing): ?string
    {
        $parts = [];

        if ($missing !== []) {
            $parts[] = 'Not returned: ' . implode(', ', $missing) . '.';
        }

        if (!empty($result['wasOverdue'])) {
            $days = (int) ($result['daysLate'] ?? 0);
            $parts[] = sprintf('Returned %d day%s late.', $days, $days === 1 ? '' : 's');
        }

        if (!empty($result['promoted_reservation'])) {
            $parts[] = 'Someone was waiting for this device and has been notified.';
        }

        return $parts === [] ? null : implode(' ', $parts);
    }

    public static function extend(Request $request): never
    {
        Response::json(['loan' => self::adjust($request, 1)]);
    }

    public static function reduce(Request $request): never
    {
        Response::json(['loan' => self::adjust($request, -1)]);
    }

    /**
     * Extending and reducing are the same operation with the sign reversed, so
     * both come through here. `days` is always sent as a positive number by the
     * client and the sign comes from which endpoint was called, which avoids
     * the trap of "reduce by -7" meaning extend.
     *
     * Only the extension cap can be overridden, and only by somebody who can
     * change settings — otherwise the cap is a suggestion.
     */
    private static function adjust(Request $request, int $sign): array
    {
        $auth = $request->auth;
        $body = $request->body();

        $days     = $body['days'] ?? null;
        $newDueAt = $body['new_due_at'] ?? $body['newDueAt'] ?? null;

        if ($days !== null) {
            $days = Util::int($days, 'days', 1, 3650) * $sign;
        }

        // An explicit date has no sign to apply, so check it points the way the
        // endpoint says. Without this, "reduce" with a later date quietly
        // extends the loan and writes an "extended" entry to the timeline —
        // the audit trail would then disagree with the request that caused it.
        if ($newDueAt !== null && $newDueAt !== '') {
            $target = Util::dateTime($newDueAt, 'new_due_at');
            $loan   = Loans::getVisible($auth, (int) $auth['organizationId'], (int) $request->param('id'));
            $due    = empty($loan['due_at']) ? null : strtotime((string) $loan['due_at']);

            if ($target !== null && $due !== null) {
                $later = $target->getTimestamp() > $due;

                if ($later && $sign < 0) {
                    throw Util::badRequest(
                        'That date is later than the current return date, which would extend the loan '
                        . 'rather than shorten it. Use the extend action instead.',
                        ['field' => 'new_due_at'],
                    );
                }
                if (!$later && $sign > 0) {
                    throw Util::badRequest(
                        'That date is earlier than the current return date, which would shorten the loan '
                        . 'rather than extend it. Use the reduce action instead.',
                        ['field' => 'new_due_at'],
                    );
                }
            }
        }

        $override = Util::bool($body['override_limit'] ?? $body['overrideLimit'] ?? false);

        if ($override && !in_array('settings.write', $auth['capabilities'] ?? [], true)) {
            throw Util::forbidden(
                'Overriding the extension limit needs the "settings.write" permission. Ask an '
                . 'administrator to extend this loan.',
            );
        }

        return Loans::adjustDueDate(Audit::actor($request), [
            'organizationId'       => (int) $auth['organizationId'],
            'loanId'               => (int) $request->param('id'),
            'days'                 => $days,
            'newDueAt'             => $newDueAt,
            'reason'               => Util::str($body['reason'] ?? $body['notes'] ?? null),
            'ignoreExtensionLimit' => $override,
            'actorId'              => $auth['userId'] ?? null,
        ]);
    }

    public static function cancel(Request $request): never
    {
        $auth = $request->auth;

        $loan = Loans::cancel(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'loanId'         => (int) $request->param('id'),
            'reason'         => Util::str($request->input('reason')),
            'deviceStatus'   => Util::oneOf(
                $request->input('device_status') ?? 'available',
                \Loaner\Devices::STATUSES, 'device_status', true,
            ),
            'actorId'        => $auth['userId'] ?? null,
        ]);

        Response::json(['loan' => $loan]);
    }

    public static function transfer(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        $loan = Loans::transfer(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'loanId'         => (int) $request->param('id'),
            'techId'         => $body['tech_id'] ?? $body['techId'] ?? null,
            'clientId'       => $body['client_id'] ?? $body['clientId'] ?? null,
            'programId'      => $body['program_id'] ?? $body['programId'] ?? null,
            'reason'         => Util::str($body['reason'] ?? null),
            'actorId'        => $auth['userId'] ?? null,
        ]);

        Response::json(['loan' => $loan]);
    }

    public static function overdue(Request $request): never
    {
        Response::json(Util::collection(Loans::overdue((int) $request->auth['organizationId'])));
    }

    public static function dueSoon(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];
        $within         = (int) ($request->queryParam('days')
            ?? Settings::get($organizationId, 'notify.due_soon_days'));

        Response::json(Util::collection(
            Loans::dueSoon($organizationId, $within),
            ['within_days' => $within],
        ));
    }

    public static function exportCsv(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];

        $result = Loans::list($organizationId, [
            'status'   => $request->queryParam('status'),
            'from'     => $request->queryParam('from'),
            'to'       => $request->queryParam('to'),
            'search'   => $request->queryParam('search'),
        ], ['limit' => 10000, 'offset' => 0, 'sort' => 'checked_out_at']);

        $csv = Util::toCsv(
            ['reference', 'device', 'barcode', 'status', 'technician', 'client', 'program',
             'checked_out_at', 'due_at', 'returned_at', 'overdue', 'days_late', 'extensions',
             'condition_out', 'condition_in', 'notes'],
            array_map(static fn (array $l): array => [
                $l['reference'], $l['device_name'], $l['device_barcode'], $l['status'],
                $l['tech_name'], $l['client_name'], $l['program_name'],
                $l['checked_out_at'], $l['due_at'], $l['returned_at'],
                $l['is_overdue'] ? 'Yes' : 'No', $l['days_overdue'] ?? '',
                $l['extension_count'], $l['condition_out'], $l['condition_in'], $l['notes'],
            ], $result['rows']),
        );

        Response::csv($csv, 'loans-' . date('Y-m-d') . '.csv');
    }
}
