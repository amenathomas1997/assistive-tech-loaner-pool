<?php
/**
 * API route table.
 *
 * Paths are relative to /api/v1 (and the unversioned /api alias). The third
 * argument to each registration is the capability required; null means the
 * route does its own checking, which is only used where the rule is more
 * subtle than a single capability — the paired-phone endpoints, which are
 * authenticated by a pairing code, and the job runner, which accepts a cron
 * token.
 *
 * Routes are matched by specificity rather than registration order — see
 * Router — so a literal path can never be swallowed by a parameterised one.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Router;

final class Api
{
    public static function register(Router $router): void
    {
        Authentication::register($router);
        Meta::register($router);

        DeviceRoutes::register($router);
        LoanRoutes::register($router);
        RequestRoutes::register($router);
        DirectoryRoutes::register($router);
        ScanRoutes::register($router);
        WorkshopRoutes::register($router);
        InsightsRoutes::register($router);
        AdminRoutes::register($router);

        OutcomeRoutes::register($router);
        SecurityRoutes::register($router);
    }
}
