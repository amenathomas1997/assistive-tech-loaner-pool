<?php
/**
 * Scanning endpoints.
 *
 * The /scan/join routes are the only authenticated-by-code endpoints in the
 * application. A paired phone holds nothing but a six-character code, so those
 * two routes can do exactly one thing — report a barcode — and are registered
 * with a null capability because the pairing code is the credential.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Audit;
use Loaner\Auth;
use Loaner\Request;
use Loaner\Response;
use Loaner\Router;
use Loaner\Scan;
use Loaner\Util;

final class ScanRoutes
{
    public static function register(Router $router): void
    {
        $router->post('/scan/lookup', [self::class, 'lookup'], 'scan.use');

        $router->post('/scan/channels', [self::class, 'createChannel'], 'scan.use');
        $router->get('/scan/channels/{id}', [self::class, 'channel'], 'scan.use');
        $router->get('/scan/channels/{id}/events', [self::class, 'events'], 'scan.use');
        $router->delete('/scan/channels/{id}', [self::class, 'closeChannel'], 'scan.use');

        // No capability: the pairing code is the credential. See the note above.
        $router->get('/scan/join/{code}', [self::class, 'join']);
        $router->post('/scan/join/{code}', [self::class, 'push']);
    }

    public static function lookup(Request $request): never
    {
        Response::json(Scan::lookup(
            (int) $request->auth['organizationId'],
            $request->input('barcode') ?? $request->input('code'),
        ));
    }

    public static function createChannel(Request $request): never
    {
        $auth = $request->auth;

        if (($auth['actorType'] ?? '') !== 'user') {
            throw Util::forbidden(
                'Pairing a phone needs a signed-in person, because the channel belongs to their desk.',
            );
        }

        $result = Scan::createChannel(Audit::actor($request), [
            'organizationId' => (int) $auth['organizationId'],
            'ownerId'        => (int) $auth['userId'],
            'label'          => Util::str($request->input('label'), 120),
            'baseUrl'        => $request->baseUrl(),
            // A phone will not open its camera on a plain-HTTP page, so warn
            // before the operator reads a code out and nothing happens.
            'insecure'       => !$request->secure,
        ]);

        Response::json($result, 201);
    }

    public static function channel(Request $request): never
    {
        $auth = $request->auth;

        // Pass the id as-is, including 0 for an API key. `?: null` here would
        // turn "no user" into "skip the ownership check", which is the opposite
        // of what is wanted: a pairing channel is a private line between one
        // person's desk and their phone, and its pair_code is the credential
        // that phone uses.
        $channel = Scan::channel(
            (int) $auth['organizationId'],
            (int) $request->param('id'),
            (int) ($auth['userId'] ?? 0),
        );

        if ($channel === null) {
            throw Util::notFound('That pairing channel does not exist.');
        }

        Response::json(['channel' => $channel]);
    }

    /**
     * Short poll for scans from the paired phone.
     *
     * Polled rather than streamed: PHP holds an Apache worker for the whole
     * life of a request, so one long-lived connection per scan station would
     * exhaust the worker pool on exactly the kind of shared host this is
     * expected to run on.
     */
    public static function events(Request $request): never
    {
        $auth = $request->auth;

        $result = Scan::events(
            (int) $auth['organizationId'],
            (int) $request->param('id'),
            (int) ($auth['userId'] ?? 0),
            (int) ($request->queryParam('after') ?? 0),
        );

        // Never cached: a cached poll response would freeze the scan station.
        Response::json($result, 200, ['Cache-Control' => 'no-store']);
    }

    public static function closeChannel(Request $request): never
    {
        $auth = $request->auth;

        Scan::closeChannel(
            (int) $auth['organizationId'],
            (int) $request->param('id'),
            (int) ($auth['userId'] ?? 0),
        );

        Response::noContent();
    }

    public static function join(Request $request): never
    {
        Response::json(Scan::join((string) $request->param('code')), 200, ['Cache-Control' => 'no-store']);
    }

    public static function push(Request $request): never
    {
        Response::json(
            Scan::push((string) $request->param('code'), $request->body()),
            201,
            ['Cache-Control' => 'no-store'],
        );
    }
}
