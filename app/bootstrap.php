<?php
/**
 * Application bootstrap: autoloading, error handling and shared constants.
 *
 * No Composer. Shared hosting is the target, and "upload the files" has to be
 * the whole deployment story — a vendor directory that must be installed by a
 * tool the host may not have is exactly the friction this avoids.
 *
 * Requires PHP 8.1+ with pdo_mysql, openssl, mbstring, json and curl.
 */

declare(strict_types=1);

namespace Loaner;

const APP_VERSION = '2.0.0';

/**
 * The version that schema.sql alone produces.
 *
 * Migrations take the database from here up to Migrations::TARGET_VERSION. The
 * two are deliberately separate: a fresh install runs schema.sql and then the
 * same migrations an existing install runs, so there is only ever one code path
 * that creates the later tables.
 */
const BASE_SCHEMA_VERSION = 1;

/** Project root — one level above this file. */
define('Loaner\\APP_ROOT', dirname(__DIR__));

// ---------------------------------------------------------------------------
// Autoloader
//
// Maps Loaner\Foo\Bar to app/Foo/Bar.php. Deliberately tiny: there is one
// namespace and one directory, and anything cleverer would be ceremony.
// ---------------------------------------------------------------------------

spl_autoload_register(static function (string $class): void {
    if (!str_starts_with($class, 'Loaner\\')) {
        return;
    }

    $relative = str_replace('\\', '/', substr($class, strlen('Loaner\\')));
    $path     = APP_ROOT . '/app/' . $relative . '.php';

    if (is_file($path)) {
        require_once $path;
    }
});

// ---------------------------------------------------------------------------
// Error handling
//
// Everything becomes an exception, so a stray warning in a query builder
// cannot quietly produce a half-built statement that still runs.
// ---------------------------------------------------------------------------

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    // Respect @-suppression and error_reporting, or legitimate silenced calls
    // (an is_file on an unreadable path, say) become fatal.
    if (!(error_reporting() & $severity)) {
        return false;
    }

    // Deprecations are logged, never thrown. They are a warning about a future
    // PHP release, not a fault in this request, and turning them into
    // exceptions means a new PHP version breaks working features the day the
    // host upgrades: PHP 8.5 deprecated curl_close(), which would otherwise
    // have made every outgoing email throw on a server that was fine the day
    // before. Logged rather than ignored, so they still get fixed.
    if ($severity === E_DEPRECATED || $severity === E_USER_DEPRECATED) {
        error_log("[deprecated] {$message} in {$file}:{$line}");
        return true;
    }

    throw new \ErrorException($message, 0, $severity, $file, $line);
});

/**
 * Minimum PHP version.
 *
 * 8.1, not 8.0: this codebase uses readonly properties (app/Request.php) and
 * the `never` return type (app/Response.php), both of which are 8.1 syntax.
 * On 8.0 they are a parse error, which PHP reports as a blank page — so the
 * check has to be stricter than "the features I remember using", or the gate
 * passes and the application dies anyway with nothing on screen to explain it.
 *
 * 8.0 reached end of life in November 2023 and no longer receives security
 * fixes, so this is not a floor worth lowering. Every cPanel host offers 8.1
 * or newer under "Select PHP Version".
 */
if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode([
        'error' => [
            'code'    => 'php_too_old',
            'message' => 'Loaner Pool needs PHP 8.1 or newer. This server is running '
                       . PHP_VERSION . '. Change the PHP version for this domain in your '
                       . 'hosting control panel (cPanel: MultiPHP Manager).',
        ],
    ], JSON_PRETTY_PRINT);
    exit;
}

/** Extensions without which nothing works. Checked once, reported clearly. */
$missing = array_values(array_filter(
    ['pdo_mysql', 'openssl', 'mbstring', 'json'],
    static fn (string $ext): bool => !extension_loaded($ext)
));

if ($missing !== []) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode([
        'error' => [
            'code'    => 'missing_extensions',
            'message' => 'This PHP installation is missing required extension(s): '
                       . implode(', ', $missing) . '. Enable them in your hosting control '
                       . 'panel (cPanel: Select PHP Version → Extensions).',
            'details' => ['missing' => $missing],
        ],
    ], JSON_PRETTY_PRINT);
    exit;
}

// ---------------------------------------------------------------------------
// Timezone
//
// Set explicitly so date arithmetic in the loan engine does not depend on
// php.ini differing between the developer's machine and the host.
// ---------------------------------------------------------------------------

$configuredTimezone = Config::organizationTimezone();
date_default_timezone_set($configuredTimezone ?: (ini_get('date.timezone') ?: 'UTC'));
