<?php
/**
 * VRC loan requests: submission, approval and fulfilment tracking.
 *
 * A counselor sees only their own requests. That is enforced here rather than
 * in the browser, because a filter applied only in the interface is not a
 * restriction at all.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Audit;
use Loaner\Auth;
use Loaner\Db;
use Loaner\Devices;
use Loaner\Notifications;
use Loaner\Request;
use Loaner\Requests;
use Loaner\Response;
use Loaner\Router;
use Loaner\Settings;
use Loaner\Util;

final class RequestRoutes
{
    public static function register(Router $router): void
    {
        $router->get('/requests', [self::class, 'index'], 'requests.read');
        $router->get('/requests/meta', [self::class, 'meta'], 'requests.read');
        $router->post('/requests', [self::class, 'create'], 'requests.write');

        $router->get('/requests/{id}', [self::class, 'show'], 'requests.read');
        $router->post('/requests/{id}/approve', [self::class, 'approve'], 'requests.approve');
        $router->post('/requests/{id}/deny', [self::class, 'deny'], 'requests.approve');
        $router->post('/requests/{id}/fulfillment', [self::class, 'fulfillment'], 'requests.fulfill');
        $router->post('/requests/{id}/fulfil', [self::class, 'fulfil'], 'requests.fulfill');
        $router->post('/requests/{id}/cancel', [self::class, 'cancel'], 'requests.write');
    }

    public static function index(Request $request): never
    {
        $auth       = $request->auth;
        $pagination = Util::pagination($request->query);

        $filters = [
            'status'            => $request->queryParam('status'),
            'fulfillmentState'  => $request->queryParam('fulfillment_state'),
            'assignedTechId'    => $request->queryParam('assigned_tech_id'),
            'clientId'          => $request->queryParam('client_id'),
            'programId'         => $request->queryParam('program_id'),
            'open'              => $request->queryParam('open'),
            'search'            => $request->queryParam('search'),
            'requestedBy'       => $request->queryParam('requested_by'),
        ];

        // A counselor's own requests, whatever they ask for.
        if (Auth::isRestrictedToOwnRecords($auth)) {
            $filters['requestedBy'] = $auth['userId'];
        }

        $result = Requests::list((int) $auth['organizationId'], $filters, [
            'limit'  => $pagination['limit'],
            'offset' => $pagination['offset'],
            'sort'   => $request->queryParam('sort'),
        ]);

        Response::json(Util::paged($result['rows'], $result['total'], $pagination));
    }

    public static function show(Request $request): never
    {
        $auth    = $request->auth;
        $loanReq = Requests::get((int) $auth['organizationId'], (int) $request->param('id'));

        if ($loanReq === null) {
            throw Util::notFound('That request does not exist.');
        }

        if (Auth::isRestrictedToOwnRecords($auth)
            && (int) $loanReq['requested_by'] !== (int) $auth['userId']
        ) {
            // "Not found" rather than "forbidden": confirming a request exists
            // would leak which clients other counselors are working with.
            throw Util::notFound('That request does not exist.');
        }

        Response::json(['request' => $loanReq]);
    }

    /** Everything the request form needs to populate its pickers. */
    public static function meta(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];

        Response::json([
            'delivery_modes' => [
                ['value' => 'vrc_pickup', 'label' => 'I will collect it'],
                ['value' => 'deliver_to_client', 'label' => 'Deliver to the client'],
                ['value' => 'client_pickup', 'label' => 'The client will collect it'],
            ],
            'fulfillment_states' => array_map(
                static fn (string $s): array => ['value' => $s, 'label' => Requests::FULFILMENT_LABELS[$s]],
                Requests::FULFILMENT_STATES,
            ),
            'statuses'  => Requests::STATUSES,
            'periods'   => Settings::loanPeriods($organizationId),
            'categories' => Db::all(
                'SELECT category AS value, COUNT(*) AS count FROM devices
                  WHERE organization_id = ? AND category IS NOT NULL AND category <> ""
                    AND status <> "retired"
                  GROUP BY category ORDER BY category',
                [$organizationId],
            ),
            'technicians' => Db::all(
                'SELECT id, full_name FROM users
                  WHERE organization_id = ? AND active = 1 AND role IN ("admin", "tech")
                  ORDER BY full_name',
                [$organizationId],
            ),
            'auto_approve' => (bool) Settings::get($organizationId, 'loans.auto_approve_vrc'),
        ]);
    }

    public static function create(Request $request): never
    {
        $auth           = $request->auth;
        $organizationId = (int) $auth['organizationId'];
        $body           = $request->body();

        $requestedBy = $auth['userId'] ?? null;

        // An API key has no person behind it, so it must name the requester.
        if ($requestedBy === null) {
            $requestedBy = Util::int($body['requested_by'] ?? $body['requestedBy'] ?? null,
                'requested_by', 1);
            if ($requestedBy === null) {
                throw Util::badRequest(
                    'An API key must say which user the request is on behalf of.',
                    ['field' => 'requested_by'],
                );
            }
        }

        $created = Requests::create(Audit::actor($request), [
            'organizationId'    => $organizationId,
            'requestedBy'       => $requestedBy,
            'clientId'          => $body['client_id'] ?? $body['clientId'] ?? null,
            'programId'         => $body['program_id'] ?? $body['programId'] ?? null,
            'deviceId'          => $body['device_id'] ?? $body['deviceId'] ?? null,
            'requestedCategory' => Util::str($body['requested_category'] ?? $body['requestedCategory'] ?? null, 96),
            'requestedDetails'  => Util::str($body['requested_details'] ?? $body['requestedDetails'] ?? null),
            'justification'     => Util::str($body['justification'] ?? null),
            'neededBy'          => empty($body['needed_by'] ?? $body['neededBy'] ?? null)
                ? null : Util::dateOnly($body['needed_by'] ?? $body['neededBy'], 'needed_by'),
            'loanPeriodId'      => $body['loan_period_id'] ?? $body['loanPeriodId'] ?? null,
            'requestedDays'     => Util::int($body['requested_days'] ?? $body['requestedDays'] ?? null,
                'requested_days', 0, 3650),
            'deliveryMode'      => Util::oneOf(
                $body['delivery_mode'] ?? $body['deliveryMode'] ?? 'vrc_pickup',
                Requests::DELIVERY_MODES, 'delivery_mode', true,
            ),
            'autoApprove'       => (bool) Settings::get($organizationId, 'loans.auto_approve_vrc'),
        ]);

        Notifications::send(Audit::actor($request), $organizationId, 'request_submitted',
            $created + ['__request_id' => (int) $created['id']]);

        Response::json(['request' => $created], 201);
    }

    public static function approve(Request $request): never
    {
        Response::json(self::review($request, 'approved'));
    }

    public static function deny(Request $request): never
    {
        Response::json(self::review($request, 'denied'));
    }

    private static function review(Request $request, string $decision): array
    {
        $auth           = $request->auth;
        $organizationId = (int) $auth['organizationId'];
        $body           = $request->body();

        if ($decision === 'denied' && empty($body['notes']) && empty($body['reason'])) {
            // A bare "denied" leaves the counselor with nothing to tell the
            // client, and they will simply ask again.
            throw Util::badRequest(
                'Give a reason for declining. The counselor sees it, so it is what they will pass on to '
                . 'the client — and without one they will simply ask again.',
                ['field' => 'notes'],
            );
        }

        $reviewed = Requests::review(Audit::actor($request), [
            'organizationId' => $organizationId,
            'requestId'      => (int) $request->param('id'),
            'decision'       => $decision,
            'notes'          => Util::str($body['notes'] ?? $body['reason'] ?? null),
            'deviceId'       => $body['device_id'] ?? $body['deviceId'] ?? null,
            'assignedTechId' => $body['assigned_tech_id'] ?? $body['assignedTechId'] ?? $auth['userId'] ?? null,
            'loanPeriodId'   => $body['loan_period_id'] ?? $body['loanPeriodId'] ?? null,
            'actorId'        => $auth['userId'] ?? null,
        ]);

        Notifications::send(
            Audit::actor($request),
            $organizationId,
            $decision === 'approved' ? 'request_approved' : 'request_denied',
            $reviewed + ['__request_id' => (int) $reviewed['id']],
        );

        return ['request' => $reviewed];
    }

    public static function fulfillment(Request $request): never
    {
        $auth           = $request->auth;
        $organizationId = (int) $auth['organizationId'];
        $body           = $request->body();

        $state = Util::requiredStr($body['state'] ?? null, 'state', 40);

        $updated = Requests::updateFulfillment(Audit::actor($request), [
            'organizationId' => $organizationId,
            'requestId'      => (int) $request->param('id'),
            'state'          => $state,
            'assignedTechId' => $body['assigned_tech_id'] ?? $body['assignedTechId'] ?? null,
            'deviceId'       => $body['device_id'] ?? $body['deviceId'] ?? null,
            'actorId'        => $auth['userId'] ?? null,
        ]);

        // "Ready for pickup" is the one state the requester must be told about
        // without being asked — it is the point at which they need to act.
        if ($state === 'ready_pickup') {
            Notifications::send(Audit::actor($request), $organizationId, 'ready_for_pickup',
                $updated + ['__request_id' => (int) $updated['id']]);
        }

        Response::json(['request' => $updated]);
    }

    public static function fulfil(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        $result = Requests::fulfil(Audit::actor($request), [
            'organizationId'   => (int) $auth['organizationId'],
            'requestId'        => (int) $request->param('id'),
            'deviceIdentifier' => $body['device'] ?? $body['barcode'] ?? $body['device_id']
                ?? $body['deviceId'] ?? null,
            'techId'           => $body['tech_id'] ?? $body['techId'] ?? null,
            'clientId'         => $body['client_id'] ?? $body['clientId'] ?? null,
            'programId'        => $body['program_id'] ?? $body['programId'] ?? null,
            'loanPeriodId'     => $body['loan_period_id'] ?? $body['loanPeriodId'] ?? null,
            'customDays'       => $body['custom_days'] ?? $body['customDays'] ?? null,
            'conditionOut'     => Util::str($body['condition_out'] ?? $body['conditionOut'] ?? null, 190),
            'notes'            => Util::str($body['notes'] ?? null),
            'method'           => 'request',
            'actorId'          => $auth['userId'] ?? null,
        ]);

        Notifications::send(Audit::actor($request), (int) $auth['organizationId'], 'checked_out',
            $result['loan'] + ['__loan_id' => (int) $result['loan']['id'],
                               '__request_id' => (int) $result['request']['id']]);

        Response::json($result);
    }

    public static function cancel(Request $request): never
    {
        $auth = $request->auth;

        $cancelled = Requests::cancel(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'requestId'      => (int) $request->param('id'),
            'reason'         => Util::str($request->input('reason')),
            'auth'           => $auth,
        ]);

        Response::json(['request' => $cancelled]);
    }
}
