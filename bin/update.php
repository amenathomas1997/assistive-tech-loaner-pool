#!/usr/bin/env php
<?php
/**
 * Check for and apply updates.
 *
 *   php bin/update.php              is there an update?
 *   php bin/update.php --apply      pull it and run the migrations
 *   php bin/update.php --quiet      print nothing unless an update exists
 *
 * Applying is deliberately command-line only. A web route that pulls code and
 * runs migrations becomes a remote code execution path the day its credential
 * leaks, and this software is built for agencies who would not spot that.
 *
 * Exit status: 0 up to date or applied, 1 failed, 2 an update is available
 * (so `php bin/update.php --quiet || notify` works in a cron entry).
 */

declare(strict_types=1);

namespace Loaner;

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    echo "This script runs from the command line only.\n";
    exit(1);
}

require __DIR__ . '/../app/bootstrap.php';

$options = [];
foreach (array_slice($argv, 1) as $argument) {
    if (preg_match('/^--([a-z-]+)$/', $argument, $m)) {
        $options[$m[1]] = true;
    }
}

if (isset($options['help'])) {
    echo "Usage: php bin/update.php [--apply] [--quiet]\n\n";
    echo "  (no flags)  check whether an update is available\n";
    echo "  --apply     pull the update and run database migrations\n";
    echo "  --quiet     only print when there is something to say\n\n";
    echo "Source: https://github.com/" . Updates::REPOSITORY . "\n";
    exit(0);
}

$quiet = isset($options['quiet']);
$say   = static function (string $line = '') use ($quiet): void {
    if (!$quiet) {
        echo $line . "\n";
    }
};

// --- Apply ------------------------------------------------------------------

if (isset($options['apply'])) {
    echo "Updating " . APP_ROOT . "\n\n";

    try {
        $result = Updates::apply();
    } catch (\Throwable $e) {
        fwrite(STDERR, "Update failed: " . $e->getMessage() . "\n");
        exit(1);
    }

    foreach ($result['log'] as $line) {
        echo '  ' . $line . "\n";
    }

    echo "\n";
    echo $result['changed']
        ? "Updated {$result['from']} -> {$result['to']}.\n"
        : "Nothing to do; already on {$result['to']}.\n";

    exit(0);
}

// --- Check ------------------------------------------------------------------

$result = Updates::check(true);
$local  = $result['local'];

$say('This installation');
$say('  version        ' . $local['app_version'] . ' (schema ' . $local['schema_version'] . ')');
$say('  installed from ' . ($local['install_method'] === 'git' ? 'a git clone' : 'files'));

if ($local['commit_short'] !== null) {
    $say('  commit         ' . $local['commit_short']
        . ($local['branch'] !== null ? ' on ' . $local['branch'] : '')
        . ($local['has_local_changes'] === true ? '  (uncommitted local changes)' : ''));
}

$say();

if ($result['reachable'] === false) {
    // Not a failure of this installation, so not an error exit: a host that
    // blocks outbound HTTPS is a configuration choice, not a broken app.
    fwrite(STDERR, $result['summary'] . "\n");
    if (!empty($result['detail'])) {
        fwrite(STDERR, '  ' . $result['detail'] . "\n");
    }
    exit(1);
}

if ($result['up_to_date'] === true) {
    $say('Up to date.');
    exit(0);
}

// From here on there is something to report, so --quiet speaks too.
echo $result['summary'] . "\n";

if (!empty($result['latest']['url'])) {
    echo '  ' . $result['latest']['url'] . "\n";
}

$how = $result['how_to_apply'] ?? null;

if ($how !== null) {
    echo "\nTo update:\n";
    foreach ($how['steps'] as $index => $step) {
        echo '  ' . ($index + 1) . '. ' . $step . "\n";
    }
    if (!empty($how['command'])) {
        echo "\n  " . $how['command'] . "\n";
    }
    if (!empty($how['notice'])) {
        echo "\n  Note: " . $how['notice'] . "\n";
    }
}

exit(2);
