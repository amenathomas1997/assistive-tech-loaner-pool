<?php
/**
 * Trial outcomes, client import, hygiene, disposal and sites.
 *
 * Grouped because they are all the second wave of inventory and case work,
 * and each is small enough that a module apiece would be more navigation
 * than code.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Audit;
use Loaner\Auth;
use Loaner\ClientImport;
use Loaner\Csv;
use Loaner\Devices;
use Loaner\Hygiene;
use Loaner\Loans;
use Loaner\Outcomes;
use Loaner\Request;
use Loaner\Response;
use Loaner\Router;
use Loaner\Settings;
use Loaner\Sites;
use Loaner\Util;

final class OutcomeRoutes
{
    public static function register(Router $router): void
    {
        // --- Trial outcomes --------------------------------------------------
        $router->get('/outcomes/meta', [self::class, 'meta'], 'loans.read');
        $router->get('/outcomes/outstanding', [self::class, 'outstanding'], 'loans.read');
        $router->post('/loans/{id}/outcome', [self::class, 'record'], 'loans.write');
        $router->get('/reports/outcomes', [self::class, 'report'], 'reports.read');
        $router->get('/clients/{id}/outcomes', [self::class, 'forClient'], 'clients.read');

        // --- Client import ---------------------------------------------------
        $router->get('/clients/import/template.csv', [self::class, 'clientTemplate'], 'clients.write');
        $router->post('/clients/import/preview', [self::class, 'clientImportPreview'], 'clients.write');
        $router->post('/clients/import', [self::class, 'clientImport'], 'clients.write');

        // --- Hygiene ---------------------------------------------------------
        $router->get('/hygiene/queue', [self::class, 'cleaningQueue'], 'devices.read');
        $router->get('/reports/hygiene', [self::class, 'hygieneReport'], 'reports.read');
        $router->post('/devices/{id}/cleaned', [self::class, 'recordCleaning'], 'devices.write');
        $router->get('/devices/{id}/cleaning', [self::class, 'cleaningHistory'], 'devices.read');

        // --- Disposal --------------------------------------------------------
        $router->post('/devices/{id}/dispose', [self::class, 'dispose'], 'devices.delete');
        $router->get('/reports/disposals', [self::class, 'disposalReport'], 'reports.read');

        // --- Sites and transfers ---------------------------------------------
        $router->get('/sites', [self::class, 'sites'], 'devices.read');
        $router->post('/sites', [self::class, 'createSite'], 'settings.write');
        $router->get('/sites/{id}', [self::class, 'site'], 'devices.read');
        $router->patch('/sites/{id}', [self::class, 'updateSite'], 'settings.write');

        $router->get('/transfers', [self::class, 'transfers'], 'devices.read');
        $router->post('/transfers', [self::class, 'sendTransfer'], 'devices.write');
        $router->get('/transfers/{id}', [self::class, 'transfer'], 'devices.read');
        $router->post('/transfers/{id}/receive', [self::class, 'receiveTransfer'], 'devices.write');
        $router->post('/transfers/{id}/cancel', [self::class, 'cancelTransfer'], 'devices.write');

        // --- Shipping on a loan ----------------------------------------------
        $router->patch('/loans/{id}/shipping', [self::class, 'shipping'], 'loans.write');
    }

    // -----------------------------------------------------------------------
    // Outcomes
    // -----------------------------------------------------------------------

    public static function meta(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];

        Response::json(Outcomes::meta() + [
            'enabled'            => (bool) Settings::get($organizationId, 'outcomes.enabled'),
            'prompt_on_checkin'  => (bool) Settings::get($organizationId, 'outcomes.prompt_on_checkin'),
        ]);
    }

    public static function record(Request $request): never
    {
        $auth = $request->auth;

        $loan = Outcomes::record(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'loanId'         => (int) $request->param('id'),
            'outcome'        => $request->input('outcome'),
            'notes'          => $request->input('notes'),
            'auth'           => $auth,
            'actorId'        => $auth['userId'] ?? null,
        ]);

        Response::json(['loan' => $loan]);
    }

    public static function outstanding(Request $request): never
    {
        $pagination = Util::pagination($request->query);

        $result = Outcomes::outstanding((int) $request->auth['organizationId'], [
            'limit'  => $pagination['limit'],
            'offset' => $pagination['offset'],
        ]);

        Response::json(Util::paged($result['rows'], $result['total'], $pagination)
            + ['notice' => $result['notice']]);
    }

    public static function report(Request $request): never
    {
        Auth::requireFullRecordAccess($request, 'The trial outcomes report');

        Response::json(Outcomes::report(
            (int) $request->auth['organizationId'],
            $request->queryParam('from'),
            $request->queryParam('to'),
        ));
    }

    /**
     * Every trial this client has been through.
     *
     * Scoped like the client record itself: a counselor sees their own
     * caseload and nothing else.
     */
    public static function forClient(Request $request): never
    {
        $auth     = $request->auth;
        $clientId = (int) $request->param('id');

        $client = \Loaner\Directory::client((int) $auth['organizationId'], $clientId);

        if ($client === null
            || (Auth::isRestrictedToOwnRecords($auth)
                && (int) ($client['counselor_id'] ?? 0) !== (int) $auth['userId'])
        ) {
            throw Util::notFound('That client does not exist.');
        }

        $rows = Outcomes::forClient((int) $auth['organizationId'], $clientId);

        Response::json(Util::collection($rows, [
            'client_name' => $client['full_name'],
        ]));
    }

    // -----------------------------------------------------------------------
    // Client import
    // -----------------------------------------------------------------------

    public static function clientTemplate(Request $request): never
    {
        Response::csv(Csv::clientTemplate(), 'client-import-template.csv');
    }

    public static function clientImportPreview(Request $request): never
    {
        $content = $request->input('content');

        if (!is_string($content) || trim($content) === '') {
            throw Util::badRequest(
                'The file appears to be empty. Save it as CSV from your spreadsheet and try again.',
                ['field' => 'content'],
            );
        }

        Response::json(ClientImport::preview($content, $request->input('delimiter')));
    }

    public static function clientImport(Request $request): never
    {
        $body    = $request->body();
        $content = $body['content'] ?? null;

        if (!is_string($content) || trim($content) === '') {
            throw Util::badRequest('No spreadsheet content was supplied.', ['field' => 'content']);
        }

        Response::json(ClientImport::import(Audit::actor($request), [
            'organizationId' => (int) $request->auth['organizationId'],
            'text'           => $content,
            'delimiter'      => $body['delimiter'] ?? null,
            'mapping'        => $body['mapping'] ?? null,
            'filename'       => Util::str($body['filename'] ?? null, 255),
            'dryRun'         => Util::bool($body['dry_run'] ?? $body['dryRun'] ?? false),
            'updateExisting' => Util::bool($body['update_existing'] ?? $body['updateExisting'] ?? true, true),
        ]));
    }

    // -----------------------------------------------------------------------
    // Hygiene
    // -----------------------------------------------------------------------

    public static function cleaningQueue(Request $request): never
    {
        Response::json(Hygiene::queue((int) $request->auth['organizationId']));
    }

    public static function recordCleaning(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        Response::json(Hygiene::record(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'deviceId'       => (int) $request->param('id'),
            'loanId'         => $body['loan_id'] ?? $body['loanId'] ?? null,
            'method'         => $body['method'] ?? null,
            'notes'          => $body['notes'] ?? null,
            'cleanedAt'      => $body['cleaned_at'] ?? $body['cleanedAt'] ?? null,
            'actorId'        => $auth['userId'] ?? null,
        ]));
    }

    public static function cleaningHistory(Request $request): never
    {
        Response::json(Util::collection(Hygiene::forDevice(
            (int) $request->auth['organizationId'],
            (int) $request->param('id'),
        )));
    }

    public static function hygieneReport(Request $request): never
    {
        Response::json(Hygiene::report(
            (int) $request->auth['organizationId'],
            $request->queryParam('from'),
            $request->queryParam('to'),
        ));
    }

    // -----------------------------------------------------------------------
    // Disposal
    // -----------------------------------------------------------------------

    public static function dispose(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        $device = Devices::dispose(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'deviceId'       => (int) $request->param('id'),
            'method'         => $body['method'] ?? '',
            'reference'      => $body['reference'] ?? null,
            'notes'          => $body['notes'] ?? null,
            'disposedAt'     => $body['disposed_at'] ?? $body['disposedAt'] ?? null,
            'actorId'        => $auth['userId'] ?? null,
        ]);

        Response::json([
            'device'  => $device,
            'methods' => Devices::DISPOSAL_LABELS,
            'notice'  => 'This device is out of service. Its loan history stays intact, and it will '
                       . 'appear on the disposal report for its funding source.',
        ]);
    }

    public static function disposalReport(Request $request): never
    {
        Auth::requireFullRecordAccess($request, 'The disposal report');

        Response::json(Devices::disposalReport(
            (int) $request->auth['organizationId'],
            $request->queryParam('from'),
            $request->queryParam('to'),
        ));
    }

    // -----------------------------------------------------------------------
    // Sites
    // -----------------------------------------------------------------------

    public static function sites(Request $request): never
    {
        $organizationId = (int) $request->auth['organizationId'];

        Response::json(Util::collection(
            Sites::all($organizationId, Util::bool($request->queryParam('include_inactive') ?? false)),
            ['enabled' => (bool) Settings::get($organizationId, 'sites.enabled')],
        ));
    }

    public static function site(Request $request): never
    {
        $site = Sites::get((int) $request->auth['organizationId'], (int) $request->param('id'));

        if ($site === null) {
            throw Util::notFound('That site does not exist.');
        }

        Response::json(['site' => $site]);
    }

    public static function createSite(Request $request): never
    {
        Response::json([
            'site' => Sites::create(
                Audit::actor($request),
                (int) $request->auth['organizationId'],
                $request->body(),
            ),
        ], 201);
    }

    public static function updateSite(Request $request): never
    {
        Response::json([
            'site' => Sites::update(
                Audit::actor($request),
                (int) $request->auth['organizationId'],
                (int) $request->param('id'),
                $request->body(),
            ),
        ]);
    }

    // -----------------------------------------------------------------------
    // Transfers
    // -----------------------------------------------------------------------

    public static function transfers(Request $request): never
    {
        $pagination = Util::pagination($request->query);

        $result = Sites::transfers((int) $request->auth['organizationId'], [
            'status'   => $request->queryParam('status'),
            'open'     => $request->queryParam('open'),
            'deviceId' => $request->queryParam('device_id'),
            'siteId'   => $request->queryParam('site_id'),
        ], [
            'limit'  => $pagination['limit'],
            'offset' => $pagination['offset'],
        ]);

        Response::json(Util::paged($result['rows'], $result['total'], $pagination));
    }

    public static function transfer(Request $request): never
    {
        $transfer = Sites::transfer((int) $request->auth['organizationId'], (int) $request->param('id'));

        if ($transfer === null) {
            throw Util::notFound('That transfer does not exist.');
        }

        Response::json(['transfer' => $transfer]);
    }

    public static function sendTransfer(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        $deviceId = Util::int($body['device_id'] ?? $body['deviceId'] ?? null, 'device_id', 1);
        $toSiteId = Util::int($body['to_site_id'] ?? $body['toSiteId'] ?? null, 'to_site_id', 1);

        if ($deviceId === null || $toSiteId === null) {
            throw Util::badRequest(
                'Choose the device and the site it is going to.',
                ['fields' => ['device_id', 'to_site_id']],
            );
        }

        Response::json([
            'transfer' => Sites::send(Audit::actor($request), [
                'organizationId' => (int) $auth['organizationId'],
                'deviceId'       => $deviceId,
                'toSiteId'       => $toSiteId,
                'carrier'        => $body['carrier'] ?? null,
                'tracking'       => $body['tracking'] ?? null,
                'notes'          => $body['notes'] ?? null,
                'sendNow'        => $body['send_now'] ?? $body['sendNow'] ?? true,
                'actorId'        => $auth['userId'] ?? null,
            ]),
        ], 201);
    }

    public static function receiveTransfer(Request $request): never
    {
        $auth = $request->auth;

        Response::json([
            'transfer' => Sites::receive(Audit::actor($request), [
                'organizationId' => (int) $auth['organizationId'],
                'transferId'     => (int) $request->param('id'),
                'notes'          => $request->input('notes'),
                'actorId'        => $auth['userId'] ?? null,
            ]),
        ]);
    }

    public static function cancelTransfer(Request $request): never
    {
        Response::json([
            'transfer' => Sites::cancelTransfer(Audit::actor($request), [
                'organizationId' => (int) $request->auth['organizationId'],
                'transferId'     => (int) $request->param('id'),
                'reason'         => $request->input('reason'),
            ]),
        ]);
    }

    // -----------------------------------------------------------------------
    // Shipping
    // -----------------------------------------------------------------------

    /**
     * Record how a loan is travelling.
     *
     * Outbound and return are kept apart because they are different journeys
     * with different tracking numbers, and conflating them loses the first one
     * the moment the second is entered.
     */
    public static function shipping(Request $request): never
    {
        $auth   = $request->auth;
        $body   = $request->body();
        $loanId = (int) $request->param('id');

        $loan = Loans::getVisible($auth, (int) $auth['organizationId'], $loanId);

        $sets   = [];
        $params = [];

        foreach ([
            ['out_carrier', 'out_carrier', 64], ['out_tracking', 'out_tracking', 120],
            ['return_carrier', 'return_carrier', 64], ['return_tracking', 'return_tracking', 120],
        ] as [$key, $column, $max]) {
            if (array_key_exists($key, $body)) {
                $sets[]   = "{$column} = ?";
                $params[] = Util::boundedStr($body[$key], $key, $max);
            }
        }

        // Entering a tracking number is what "it has been sent" means, so the
        // timestamp is set from that rather than asked for separately.
        if (array_key_exists('out_tracking', $body) && !empty($body['out_tracking'])
            && empty($loan['out_shipped_at'])
        ) {
            $sets[] = 'out_shipped_at = NOW()';
        }
        if (array_key_exists('return_tracking', $body) && !empty($body['return_tracking'])
            && empty($loan['return_shipped_at'])
        ) {
            $sets[] = 'return_shipped_at = NOW()';
        }

        if ($sets === []) {
            throw Util::badRequest('No shipping details were supplied.');
        }

        $sets[]   = 'updated_at = NOW()';
        $params[] = $loanId;
        $params[] = (int) $auth['organizationId'];

        \Loaner\Db::execute(
            'UPDATE loans SET ' . implode(', ', $sets) . ' WHERE id = ? AND organization_id = ?',
            $params,
        );

        $after = Loans::get((int) $auth['organizationId'], $loanId);

        Audit::record(Audit::actor($request), [
            'action'      => Audit::LOAN_SHIPPED,
            'entityType'  => 'loan',
            'entityId'    => $loanId,
            'entityLabel' => $after['reference'],
            'summary'     => sprintf(
                'Shipping details recorded on %s%s',
                $after['reference'],
                !empty($after['out_tracking']) ? ' (' . $after['out_tracking'] . ')' : '',
            ),
        ]);

        Response::json(['loan' => $after]);
    }
}
