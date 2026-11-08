<?php
/**
 * Which API routes does the test suite never reach?
 *
 * This exists because of a specific failure. GET /reports returned a shape
 * nothing on the Reports screen could read — every card on it showed an error
 * — and that shipped, because no test of any kind touched the route. The
 * end-to-end suites passed. The API/UI contract checker passed, because it
 * only inspects responses it is given, and nothing gave it that one.
 *
 * Both of those suites answer "does what we test work?". Neither answers
 * "what are we not testing?", and the second question is the one that lets a
 * whole screen ship broken.
 *
 * How it works: Router::dispatch() appends the matched *pattern* to a file
 * when LOANER_ROUTE_LOG is set in the environment. The suite runs with it
 * set, and this script compares what was reached against the live route
 * table — read from the router itself, not from a list maintained by hand,
 * which would drift the day somebody adds a route and forgets.
 *
 * Usage: php scripts/verify-route-coverage.php <log-file> [--max-uncovered=N]
 */

declare(strict_types=1);

namespace Loaner;

require __DIR__ . '/../app/bootstrap.php';

$logPath = $argv[1] ?? '';

if ($logPath === '' || !is_file($logPath)) {
    fwrite(STDERR, "Usage: php scripts/verify-route-coverage.php <log-file>\n\n"
        . "The log is written by the test run. Start the server with\n"
        . "LOANER_ROUTE_LOG=/path/to/log in its environment.\n");
    exit(2);
}

// Routes that a test suite cannot or should not drive. Each one needs a
// reason, because "exempt" is how a list like this becomes meaningless.
const EXEMPT = [
    // Streams the whole database as a download, gated on a password re-entry.
    // A suite that ran this on every build would be writing a copy of every
    // password hash to a temporary file.
    'POST /admin/backup' => 'streams a full database dump',

    // Replaces the application's own files from GitHub, mid-run. A test that
    // ran it would be measuring whether the suite survives being overwritten
    // while it executes.
    'POST /admin/updates/apply' => 'replaces the running code',

    // Asks GitHub whether a newer release exists. A build that goes red
    // because GitHub was slow is a build nobody trusts, and the handler's own
    // logic — comparing two version strings — is worth testing directly if it
    // is worth testing at all.
    'POST /admin/updates/check' => 'calls out to GitHub',
];

// Both routers. The installer has its own table, registered separately and
// reachable only before setup — but the suite does run the installer, so
// leaving it out would report its routes as unknown rather than as covered.
$router = new Router();
Routes\Api::register($router);
Routes\Install::register($router);

$all = [];
foreach ($router->describe() as $route) {
    $all["{$route['method']} {$route['pattern']}"] = $route['capability'];
}

$seen = [];
foreach (file($logPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
    $seen[trim($line)] = ($seen[trim($line)] ?? 0) + 1;
}

$uncovered = [];
foreach ($all as $route => $capability) {
    if (isset($seen[$route]) || isset(EXEMPT[$route])) {
        continue;
    }
    $uncovered[] = $route;
}

// A route in the log that is not in the table means the table changed and
// this log is from an older run — comparing them would be meaningless.
$unknown = array_diff(array_keys($seen), array_keys($all));

$total   = count($all);
$exempt  = count(array_intersect_key(EXEMPT, $all));
$covered = $total - count($uncovered) - $exempt;

printf(
    "==> API route coverage\n\n  %d of %d routes reached by the suite (%d%%), %d exempt\n\n",
    $covered,
    $total - $exempt,
    $total - $exempt > 0 ? (int) round($covered / ($total - $exempt) * 100) : 100,
    $exempt,
);

if ($unknown !== []) {
    fwrite(STDERR, "The log mentions routes that are not in the table. It is from an\n"
        . "older run; delete it and run the suite again.\n\n");
    foreach ($unknown as $route) {
        fwrite(STDERR, "  {$route}\n");
    }
    exit(1);
}

if ($uncovered === []) {
    echo "Every route is exercised at least once.\n";
    exit(0);
}

fwrite(STDERR, "These routes are never reached by any test:\n\n");

foreach ($uncovered as $route) {
    $capability = $all[$route];
    fwrite(STDERR, sprintf("  %-46s %s\n", $route, $capability ?? '(no capability)'));
}

fwrite(STDERR, "\nA route with no test is a route that can return the wrong shape\n"
    . "indefinitely. That is how the Reports screen shipped broken: it was\n"
    . "not that its test was weak, it was that it had none.\n\n"
    . "Add a check to one of the scripts/e2e-*.sh suites, or — if the route\n"
    . "genuinely cannot be driven by a test — add it to EXEMPT at the top of\n"
    . "this file with the reason why.\n");

exit(1);
