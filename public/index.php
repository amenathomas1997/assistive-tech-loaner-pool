<?php
/**
 * Front controller.
 *
 * Everything that is not a real file on disk arrives here (see .htaccess).
 *
 * Two modes, decided per request by whether a config file exists:
 *   uninstalled — only the installer and its API are reachable.
 *   installed   — the full application.
 *
 * The mode is re-checked per request rather than cached at boot, so finishing
 * the installer does not require restarting anything — which on shared hosting
 * the administrator often cannot do.
 */

declare(strict_types=1);

namespace Loaner;

require __DIR__ . '/../app/bootstrap.php';

$request = new Request();

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');
header_remove('X-Powered-By');

// No inline event handlers or remote assets anywhere in this app, so the
// policy can be strict. 'unsafe-inline' is allowed for styles only, which the
// label sheet and the printable agreement use for print-specific rules.
header(
    "Content-Security-Policy: default-src 'self'; "
    . "script-src 'self'; "
    . "style-src 'self' 'unsafe-inline'; "
    . "img-src 'self' data: blob:; "
    . "media-src 'self' blob:; "
    . "connect-src 'self'; "
    . "frame-ancestors 'none'; "
    . "base-uri 'self'; "
    . "form-action 'self'"
);

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

try {
    $installed = Config::isInstalled();

    // --- Health check ------------------------------------------------------
    // Deliberately available in both modes: it is how you tell "PHP is running
    // but not set up" apart from "the server is broken".
    if ($request->path === '/health') {
        // Unauthenticated by necessity — it is how a monitor tells "PHP is
        // running but not set up" from "the server is broken". So it reports
        // only the major.minor PHP line: an uptime check does not need the
        // patch level, and handing it to anyone who asks only helps someone
        // matching the build against a list of known vulnerabilities.
        $status = [
            'ok'           => true,
            'app_version'  => APP_VERSION,
            'installed'    => $installed,
            'php_version'  => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
            'server_time'  => date('c'),
        ];

        if ($installed) {
            try {
                Db::value('SELECT 1');
                $status['database'] = 'connected';
            } catch (\Throwable $e) {
                $status['ok']             = false;
                $status['database']       = 'unreachable';
                $status['database_error'] = Db::describeError($e);
                Response::json($status, 503);
            }
        }

        Response::json($status);
    }

    // --- Installer mode ----------------------------------------------------
    if (!$installed) {
        if (str_starts_with($request->path, '/api/install')) {
            $router = new Router();
            Routes\Install::register($router);

            $match = $router->dispatch($request);
            if ($match === null) {
                throw Util::notFound("No route matches {$request->method} {$request->path}.");
            }

            $request->params = $match['params'];
            ($match['handler'])($request);
            exit;
        }

        if (str_starts_with($request->path, '/api/')) {
            Response::error(
                503,
                'not_installed',
                'This Loaner Pool has not been set up yet. Open /install.html in a browser to configure it.',
                ['installer_url' => '/install.html', 'config_path' => Config::path()],
            );
        }

        // Anything else goes to the wizard.
        Response::redirect('/install.html');
    }

    // --- Installed -----------------------------------------------------------

    // --- Maintenance window --------------------------------------------------
    // Held only while an update is physically replacing files. PHP loads
    // classes one file at a time, so a request arriving mid-swap could execute
    // a new class against an old one. A few seconds of honest 503 beats that.
    //
    // The lock expires on its own (see Updates::LOCK_SECONDS), so an update
    // that crashes halfway cannot leave the site unreachable with no way back
    // in through the interface. /health stays up throughout, above.
    if (Updates::isLocked()) {
        $details = Updates::lockDetails();

        header('Retry-After: 30');

        if (str_starts_with($request->path, '/api/')) {
            Response::error(
                503,
                'updating',
                'The software is being updated right now. This takes under a minute — try again shortly.',
                ['started_at' => $details['started_at'] ?? null, 'by' => $details['by'] ?? null],
            );
        }

        http_response_code(503);
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        echo '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            . '<meta name="viewport" content="width=device-width, initial-scale=1">'
            . '<meta http-equiv="refresh" content="15">'
            . '<title>Updating — Loaner Pool</title><style>'
            . 'body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a2230;'
            . 'background:#f4f6f9;margin:0;display:grid;place-items:center;min-height:100vh;padding:24px}'
            . 'main{max-width:34rem;background:#fff;border:1px solid #d8dee8;border-radius:12px;padding:32px}'
            . 'h1{font-size:1.4rem;margin:0 0 12px}p{margin:0 0 12px}'
            . '@media (prefers-color-scheme:dark){body{background:#11151c;color:#e8edf5}'
            . 'main{background:#1a212b;border-color:#2c3542}}'
            . '</style></head><body><main role="status">'
            . '<h1>The loaner pool is being updated</h1>'
            . '<p>This usually takes well under a minute. Nothing has been lost — devices, loans and '
            . 'photos are untouched.</p>'
            . '<p>This page checks again every 15 seconds.</p>'
            . '</main></body></html>';
        exit;
    }

    // The installer closes itself permanently once setup succeeds. Leaving it
    // reachable is a standing offer to repoint a live system at someone else's
    // database.
    if (str_starts_with($request->path, '/api/install')) {
        Response::error(
            410,
            'already_installed',
            'This Loaner Pool is already installed. To reinstall, remove the configuration file on the server first.',
            ['config_path' => Config::path()],
        );
    }

    Auth::attach($request);

    if (str_starts_with($request->path, '/api/')) {
        // Both /api/v1/... and the unversioned alias reach the same table. The
        // versioned path is the contract third parties should build against.
        $apiPath = preg_replace('#^/api(/v1)?#', '', $request->path) ?: '/';

        $router = new Router();
        Routes\Api::register($router);

        $match = $router->dispatch($request, $apiPath === '' ? '/' : $apiPath);

        if ($match === null) {
            throw Util::notFound("No route matches {$request->method} {$request->path}.");
        }

        $request->params = $match['params'];

        if ($match['capability'] !== null) {
            Auth::requireCapability($request, $match['capability']);
        }

        ($match['handler'])($request);
        exit;
    }

    // --- Application shell ---------------------------------------------------
    // Client-side routing: any non-API, non-file path returns the shell and the
    // browser takes it from there.
    $shell = __DIR__ . '/app.html';

    if (!is_file($shell)) {
        Response::error(500, 'shell_missing', 'The application shell (public/app.html) is missing from this deployment.');
    }

    header('Cache-Control: no-cache');
    Response::html((string) file_get_contents($shell));
} catch (HttpError $e) {
    Response::error($e->status, $e->errorCode, $e->getMessage(), $e->details);
} catch (\Throwable $e) {
    // Anything unexpected becomes a generic 500 with a reference, so a stack
    // trace or SQL fragment never reaches a client. The real detail goes to
    // the server log where an administrator can find it by that reference.
    $reference = substr(bin2hex(random_bytes(8)), 0, 8);

    error_log(sprintf(
        '[error %s] %s %s — %s in %s:%d',
        $reference,
        $request->method,
        $request->path,
        $e->getMessage(),
        $e->getFile(),
        $e->getLine(),
    ));

    Response::error(
        500,
        'internal_error',
        'Something went wrong on the server. If this keeps happening, give your administrator this '
        . "reference so they can find it in the server log: {$reference}",
        ['reference' => $reference],
    );
}
