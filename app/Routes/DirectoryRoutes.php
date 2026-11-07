<?php
/**
 * Clients, programs and staff accounts.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Audit;
use Loaner\Auth;
use Loaner\Directory;
use Loaner\Request;
use Loaner\Response;
use Loaner\Router;
use Loaner\Util;

final class DirectoryRoutes
{
    public static function register(Router $router): void
    {
        $router->get('/clients', [self::class, 'clients'], 'clients.read');
        $router->post('/clients', [self::class, 'createClient'], 'clients.write');
        $router->get('/clients/{id}', [self::class, 'client'], 'clients.read');
        $router->patch('/clients/{id}', [self::class, 'updateClient'], 'clients.write');

        $router->get('/programs', [self::class, 'programs'], 'programs.read');
        $router->post('/programs', [self::class, 'createProgram'], 'programs.write');
        $router->get('/programs/{id}', [self::class, 'program'], 'programs.read');
        $router->patch('/programs/{id}', [self::class, 'updateProgram'], 'programs.write');

        $router->get('/users', [self::class, 'users'], 'users.read');
        $router->post('/users', [self::class, 'createUser'], 'users.write');
        $router->get('/users/{id}', [self::class, 'user'], 'users.read');
        $router->patch('/users/{id}', [self::class, 'updateUser'], 'users.write');
        $router->post('/users/{id}/reset-password', [self::class, 'resetPassword'], 'users.write');
    }

    // -----------------------------------------------------------------------
    // Clients
    // -----------------------------------------------------------------------

    public static function clients(Request $request): never
    {
        $auth       = $request->auth;
        $pagination = Util::pagination($request->query);

        $filters = [
            'search'          => $request->queryParam('search'),
            'programId'       => $request->queryParam('program_id'),
            'counselorId'     => $request->queryParam('counselor_id'),
            'includeInactive' => Util::bool($request->queryParam('include_inactive') ?? false),
        ];

        // A counselor sees their own caseload. Equipment records name real
        // people, and a directory everyone can browse is not necessary for
        // anyone to do their job.
        if (Auth::isRestrictedToOwnRecords($auth)) {
            $filters['counselorId'] = $auth['userId'];
        }

        $result = Directory::clients((int) $auth['organizationId'], $filters, [
            'limit'  => $pagination['limit'],
            'offset' => $pagination['offset'],
            'sort'   => $request->queryParam('sort'),
        ]);

        Response::json(Util::paged($result['rows'], $result['total'], $pagination));
    }

    public static function client(Request $request): never
    {
        $auth   = $request->auth;
        $client = Directory::client((int) $auth['organizationId'], (int) $request->param('id'));

        if ($client === null) {
            throw Util::notFound('That client does not exist.');
        }

        if (Auth::isRestrictedToOwnRecords($auth)
            && (int) ($client['counselor_id'] ?? 0) !== (int) $auth['userId']
        ) {
            throw Util::notFound('That client does not exist.');
        }

        Response::json(['client' => $client]);
    }

    public static function createClient(Request $request): never
    {
        $auth = $request->auth;
        $body = $request->body();

        // A counselor adding a client gets themselves as the counselor unless
        // they say otherwise; it is almost always the right answer.
        if (Auth::isRestrictedToOwnRecords($auth) && empty($body['counselor_id'] ?? $body['counselorId'] ?? null)) {
            $body['counselor_id'] = $auth['userId'];
        }

        $client = Directory::createClient(Audit::actor($request), (int) $auth['organizationId'], $body);

        Response::json(['client' => $client], 201);
    }

    public static function updateClient(Request $request): never
    {
        $auth     = $request->auth;
        $clientId = (int) $request->param('id');

        if (Auth::isRestrictedToOwnRecords($auth)) {
            $existing = Directory::client((int) $auth['organizationId'], $clientId);
            if ($existing === null || (int) ($existing['counselor_id'] ?? 0) !== (int) $auth['userId']) {
                throw Util::notFound('That client does not exist.');
            }
        }

        $client = Directory::updateClient(
            Audit::actor($request),
            (int) $auth['organizationId'],
            $clientId,
            $request->body(),
        );

        Response::json(['client' => $client]);
    }

    // -----------------------------------------------------------------------
    // Programs
    // -----------------------------------------------------------------------

    public static function programs(Request $request): never
    {
        Response::json(Util::collection(Directory::programs(
            (int) $request->auth['organizationId'],
            Util::bool($request->queryParam('include_inactive') ?? false),
        )));
    }

    public static function program(Request $request): never
    {
        $program = Directory::program((int) $request->auth['organizationId'], (int) $request->param('id'));

        if ($program === null) {
            throw Util::notFound('That program does not exist.');
        }

        Response::json(['program' => $program]);
    }

    public static function createProgram(Request $request): never
    {
        $program = Directory::createProgram(
            Audit::actor($request),
            (int) $request->auth['organizationId'],
            $request->body(),
        );

        Response::json(['program' => $program], 201);
    }

    public static function updateProgram(Request $request): never
    {
        $program = Directory::updateProgram(
            Audit::actor($request),
            (int) $request->auth['organizationId'],
            (int) $request->param('id'),
            $request->body(),
        );

        Response::json(['program' => $program]);
    }

    // -----------------------------------------------------------------------
    // Users
    // -----------------------------------------------------------------------

    public static function users(Request $request): never
    {
        Response::json(Util::collection(Directory::users((int) $request->auth['organizationId'], [
            'role'            => $request->queryParam('role'),
            'search'          => $request->queryParam('search'),
            'includeInactive' => Util::bool($request->queryParam('include_inactive') ?? false),
        ])));
    }

    public static function user(Request $request): never
    {
        $user = Directory::user((int) $request->auth['organizationId'], (int) $request->param('id'));

        if ($user === null) {
            throw Util::notFound('That account does not exist.');
        }

        Response::json(['user' => $user]);
    }

    /**
     * Creating and editing accounts is restricted to administrators even
     * though technicians hold "users.read": a technician who can create
     * administrators is an administrator.
     */
    public static function createUser(Request $request): never
    {
        Auth::requireRole($request, 'admin');

        $user = Directory::createUser(
            Audit::actor($request),
            (int) $request->auth['organizationId'],
            $request->body(),
        );

        Response::json(['user' => $user], 201);
    }

    public static function updateUser(Request $request): never
    {
        Auth::requireRole($request, 'admin');

        $user = Directory::updateUser(Audit::actor($request), [
            'organizationId' => (int) $request->auth['organizationId'],
            'userId'         => (int) $request->param('id'),
            'data'           => $request->body(),
            'auth'           => $request->auth,
        ]);

        Response::json(['user' => $user]);
    }

    public static function resetPassword(Request $request): never
    {
        Auth::requireRole($request, 'admin');

        $result = Directory::resetUserPassword(Audit::actor($request), [
            'organizationId' => (int) $request->auth['organizationId'],
            'userId'         => (int) $request->param('id'),
            'password'       => $request->input('password'),
        ]);

        Response::json($result);
    }
}
