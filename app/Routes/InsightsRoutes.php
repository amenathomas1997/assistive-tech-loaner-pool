<?php
/**
 * Audit log and reporting endpoints.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Audit;
use Loaner\Auth;
use Loaner\Reports;
use Loaner\Request;
use Loaner\Response;
use Loaner\Router;
use Loaner\Util;

final class InsightsRoutes
{
    public static function register(Router $router): void
    {
        $router->get('/audit', [self::class, 'audit'], 'audit.read');
        $router->get('/audit/actions', [self::class, 'auditActions'], 'audit.read');
        $router->get('/audit/export.csv', [self::class, 'auditCsv'], 'audit.read');

        $router->get('/reports', [self::class, 'overview'], 'reports.read');
        $router->get('/reports/summary', [self::class, 'summary'], 'reports.read');
        $router->get('/reports/devices', [self::class, 'devices'], 'reports.read');
        $router->get('/reports/devices.csv', [self::class, 'devicesCsv'], 'reports.read');
        $router->get('/reports/categories', [self::class, 'categories'], 'reports.read');
        $router->get('/reports/activity/{holder}', [self::class, 'activity'], 'reports.read');
        $router->get('/reports/trend', [self::class, 'trend'], 'reports.read');
        $router->get('/reports/scan-adoption', [self::class, 'scanAdoption'], 'reports.read');
        $router->get('/reports/idle', [self::class, 'idle'], 'reports.read');
        $router->get('/reports/funding', [self::class, 'funding'], 'reports.read');
        $router->get('/reports/funding.csv', [self::class, 'fundingCsv'], 'reports.read');
    }

    // -----------------------------------------------------------------------
    // Audit
    // -----------------------------------------------------------------------

    public static function audit(Request $request): never
    {
        $pagination = Util::pagination($request->query);

        $result = Audit::search(
            (int) $request->auth['organizationId'],
            self::auditFilters($request),
            $pagination['limit'],
            $pagination['offset'],
        );

        Response::json(Util::paged($result['rows'], $result['total'], $pagination));
    }

    private static function auditFilters(Request $request): array
    {
        return [
            'action'       => $request->queryParam('action'),
            'actionPrefix' => $request->queryParam('action_prefix'),
            'actorId'      => $request->queryParam('actor_id'),
            'entityType'   => $request->queryParam('entity_type'),
            'entityId'     => $request->queryParam('entity_id'),
            'from'         => $request->queryParam('from'),
            'to'           => $request->queryParam('to'),
            'search'       => $request->queryParam('search'),
        ];
    }

    /**
     * The action vocabulary, grouped.
     *
     * Read from the constants by reflection rather than kept as a second list,
     * so a new audited action appears in the filter automatically instead of
     * being silently unfilterable.
     */
    public static function auditActions(Request $request): never
    {
        $actions = Audit::actions();
        $grouped = [];

        foreach ($actions as $action) {
            $grouped[$action['group']][] = $action;
        }

        ksort($grouped);

        Response::json(Util::collection($actions) + ['grouped' => $grouped]);
    }

    public static function auditCsv(Request $request): never
    {
        $result = Audit::search(
            (int) $request->auth['organizationId'],
            self::auditFilters($request),
            10000,
            0,
        );

        $csv = Util::toCsv(
            ['timestamp', 'actor', 'actor_type', 'action', 'entity_type', 'entity', 'summary', 'ip'],
            array_map(static fn (array $row): array => [
                $row['created_at'],
                $row['actor_name'] ?? $row['actor_label'], $row['actor_type'], $row['action'],
                $row['entity_type'], $row['entity_label'], $row['summary'], $row['ip'],
            ], $result['rows']),
        );

        Response::csv($csv, 'audit-log-' . date('Y-m-d') . '.csv');
    }

    // -----------------------------------------------------------------------
    // Reports
    // -----------------------------------------------------------------------

    public static function summary(Request $request): never
    {
        Response::json(Reports::summary((int) $request->auth['organizationId']));
    }

    public static function overview(Request $request): never
    {
        Response::json(Reports::overview(
            (int) $request->auth['organizationId'],
            $request->queryParam('from'),
            $request->queryParam('to'),
        ));
    }

    public static function devices(Request $request): never
    {
        Response::json(Reports::deviceUtilisation(
            (int) $request->auth['organizationId'],
            $request->queryParam('from'),
            $request->queryParam('to'),
            (int) ($request->queryParam('limit') ?? 200),
        ));
    }

    public static function devicesCsv(Request $request): never
    {
        Response::csv(
            Reports::deviceUtilisationCsv(
                (int) $request->auth['organizationId'],
                $request->queryParam('from'),
                $request->queryParam('to'),
            ),
            'device-usage-' . date('Y-m-d') . '.csv',
        );
    }

    public static function categories(Request $request): never
    {
        Response::json(Reports::categoryDemand(
            (int) $request->auth['organizationId'],
            $request->queryParam('from'),
            $request->queryParam('to'),
        ));
    }

    /**
     * Who is borrowing what.
     *
     * This report names people, so a counselor gets their own caseload and
     * nothing else. The technician and program breakdowns cannot be narrowed
     * to one counselor in any way that would still be true, so they are
     * refused rather than silently filtered — a report that looks complete
     * and is not is worse than one that says it is not for you.
     */
    public static function activity(Request $request): never
    {
        $auth   = $request->auth;
        $holder = (string) $request->param('holder');

        $restrictedTo = Auth::ownRecordsOnly($auth);

        if ($restrictedTo !== null && $holder !== 'client') {
            Auth::requireFullRecordAccess($request, 'The ' . $holder . ' activity report');
        }

        Response::json(Reports::holderActivity(
            (int) $auth['organizationId'],
            $holder,
            $request->queryParam('from'),
            $request->queryParam('to'),
            $holder === 'client' ? $restrictedTo : null,
        ));
    }

    public static function trend(Request $request): never
    {
        Response::json(Reports::trend(
            (int) $request->auth['organizationId'],
            (int) ($request->queryParam('months') ?? 12),
        ));
    }

    public static function scanAdoption(Request $request): never
    {
        Response::json(Reports::scanAdoption(
            (int) $request->auth['organizationId'],
            $request->queryParam('from'),
            $request->queryParam('to'),
        ));
    }

    public static function idle(Request $request): never
    {
        Response::json(Reports::idleDevices(
            (int) $request->auth['organizationId'],
            (int) ($request->queryParam('days') ?? 90),
        ));
    }

    public static function funding(Request $request): never
    {
        Auth::requireFullRecordAccess($request, 'The funding report');

        Response::json(Reports::funding(
            (int) $request->auth['organizationId'],
            $request->queryParam('from'),
            $request->queryParam('to'),
        ));
    }

    public static function fundingCsv(Request $request): never
    {
        Auth::requireFullRecordAccess($request, 'The funding report');

        Response::csv(
            Reports::fundingCsv(
                (int) $request->auth['organizationId'],
                $request->queryParam('from'),
                $request->queryParam('to'),
            ),
            'funding-report-' . date('Y-m-d') . '.csv',
        );
    }
}
