#!/usr/bin/env php
<?php
/**
 * Run the scheduled jobs from the command line.
 *
 * The command-line route is preferred over the HTTP one where cron runs on the
 * same host: it needs no network, no token in the crontab, and it still works
 * if the site is temporarily unreachable from outside.
 *
 *   php bin/run-jobs.php            run everything for every organisation
 *   php bin/run-jobs.php --org=1    one organisation
 *   php bin/run-jobs.php --job=overdue
 *   php bin/run-jobs.php --quiet    print nothing unless something failed
 *
 * Exit status is 0 when every job succeeded and 1 when any failed, so cron's
 * own MAILTO reports a problem rather than silence.
 */

declare(strict_types=1);

namespace Loaner;

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    echo "This script runs from the command line only.\n";
    exit(1);
}

require __DIR__ . '/../app/bootstrap.php';

// --- Arguments --------------------------------------------------------------

$options = [];
foreach (array_slice($argv, 1) as $argument) {
    if (preg_match('/^--([a-z-]+)(?:=(.*))?$/', $argument, $matches)) {
        $options[$matches[1]] = $matches[2] ?? true;
    }
}

$quiet = isset($options['quiet']);
$help  = isset($options['help']) || isset($options['h']);

if ($help) {
    echo "Usage: php bin/run-jobs.php [--org=ID] [--job=NAME] [--quiet]\n\n";
    echo "Jobs: " . implode(', ', Jobs::NAMES) . "\n";
    exit(0);
}

/** Write a line unless --quiet, which keeps a successful cron run silent. */
$say = static function (string $line) use ($quiet): void {
    if (!$quiet) {
        echo $line . "\n";
    }
};

// --- Preconditions ----------------------------------------------------------

if (!Config::isInstalled()) {
    fwrite(STDERR, "This Loaner Pool is not installed yet — there is no configuration at "
        . Config::path() . ".\n");
    exit(1);
}

try {
    Db::value('SELECT 1');
} catch (\Throwable $e) {
    fwrite(STDERR, "Could not reach the database: " . Db::describeError($e) . "\n");
    exit(1);
}

// --- Which organisations ----------------------------------------------------

if (isset($options['org'])) {
    $organizationIds = [(int) $options['org']];
} else {
    $organizationIds = array_map(
        'intval',
        array_column(Db::all('SELECT id FROM organizations WHERE active = 1 ORDER BY id'), 'id'),
    );
}

if ($organizationIds === []) {
    fwrite(STDERR, "There are no active organisations to run jobs for.\n");
    exit(1);
}

// --- Run --------------------------------------------------------------------

$failed = 0;

foreach ($organizationIds as $organizationId) {
    $organization = Settings::organization($organizationId);

    if ($organization === null) {
        fwrite(STDERR, "Organisation {$organizationId} does not exist.\n");
        $failed++;
        continue;
    }

    $say("— {$organization['name']} (#{$organizationId})");

    $names = isset($options['job']) ? [(string) $options['job']] : Jobs::NAMES;

    foreach ($names as $name) {
        try {
            $result = Jobs::run(null, $organizationId, $name, 'cron');
        } catch (\Throwable $e) {
            fwrite(STDERR, "  {$name}: {$e->getMessage()}\n");
            $failed++;
            continue;
        }

        if ($result['status'] === 'ok') {
            $say(sprintf('  %-20s %s', $name, $result['summary']));
        } else {
            // Always reported, even under --quiet: a silent failure is how a
            // reminder system stops working for months without anyone noticing.
            fwrite(STDERR, sprintf("  %-20s FAILED: %s\n", $name, $result['summary']));
            $failed++;
        }
    }
}

if ($failed > 0) {
    fwrite(STDERR, "\n{$failed} job(s) failed.\n");
    exit(1);
}

$say("\nAll jobs completed.");
exit(0);
