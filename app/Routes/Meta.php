<?php
/**
 * API description and version information.
 *
 * The OpenAPI document is generated from the live route table rather than kept
 * as a file alongside it. A separately maintained spec drifts from the code,
 * and a wrong spec is worse than no spec for anyone building against it.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Auth;
use Loaner\Request;
use Loaner\Response;
use Loaner\Router;
use Loaner\Settings;

final class Meta
{
    public static function register(Router $router): void
    {
        // The signpost stays public so hitting the API root is not a 404, but
        // it says nothing about the server it is running on.
        $router->get('/', [self::class, 'root']);

        // The description and the version both require a caller. The
        // permission map tells an attacker which endpoints are worth trying
        // with a low-privilege account, and an exact patch-level PHP version is
        // the first thing checked against known CVEs for that build. Neither is
        // any use to an integrator who has not been given a key yet.
        $router->get('/openapi.json', [self::class, 'openapi'], 'devices.read');
        $router->get('/version', [self::class, 'version'], 'devices.read');
    }

    /** A signposting response, so hitting the API root is not a 404. */
    public static function root(Request $request): never
    {
        Response::json([
            'name'        => 'Assistive Technology Loaner Pool API',
            'version'     => \Loaner\APP_VERSION,
            'description' => 'Device inventory, loans, requests and reporting for an assistive '
                           . 'technology loaner pool.',
            'openapi'     => $request->baseUrl() . '/api/v1/openapi.json',
            'authentication' => [
                'session' => 'POST /api/v1/auth/login, then the session cookie.',
                'api_key' => 'Authorization: Bearer lp_<prefix>_<secret>',
            ],
        ]);
    }

    public static function version(Request $request): never
    {
        Response::json([
            'app_version'    => \Loaner\APP_VERSION,
            'schema_version' => \Loaner\Migrations::TARGET_VERSION,
            // Only the major.minor line, and only to an authenticated caller.
            // An administrator needs to know they are on PHP 8.2 rather than
            // 8.0; nobody needs the patch level, which only serves to match the
            // build against a CVE list.
            'php_version'    => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
            'server_time'    => date('c'),
        ]);
    }

    /**
     * Generate the OpenAPI 3.1 description.
     *
     * Deliberately coarse on request and response bodies: this application's
     * payloads are documented in the README with real examples, and an
     * auto-generated schema that claims more precision than it has would send
     * integrators down the wrong path. What it does describe exactly is the
     * path, the method, and the permission each endpoint needs — which is the
     * part nobody can discover by trial and error.
     */
    public static function openapi(Request $request): never
    {
        $router = new Router();
        Api::register($router);

        $paths = [];

        foreach ($router->describe() as $route) {
            // {id} is already OpenAPI's parameter syntax, so patterns need no
            // translation; they were written that way for this reason.
            $path   = '/api/v1' . ($route['pattern'] === '/' ? '' : $route['pattern']);
            $method = strtolower($route['method']);

            preg_match_all('/\{([a-zA-Z]+)\}/', $route['pattern'], $matches);

            $parameters = array_map(static fn (string $name): array => [
                'name'     => $name,
                'in'       => 'path',
                'required' => true,
                'schema'   => ['type' => str_ends_with(strtolower($name), 'id') || $name === 'id'
                    ? 'integer' : 'string'],
            ], $matches[1]);

            $security = $route['capability'] === null
                ? []
                : [['sessionCookie' => []], ['apiKey' => []]];

            $description = $route['capability'] === null
                ? 'No standing permission: this endpoint carries its own credential '
                . '(a scanner pairing code, or the cron token).'
                : "Requires the \"{$route['capability']}\" permission.";

            $paths[$path][$method] = array_filter([
                'summary'     => self::summarise($route['method'], $route['pattern']),
                'description' => $description,
                'tags'        => [self::tag($route['pattern'])],
                'parameters'  => $parameters,
                'security'    => $security,
                'responses'   => [
                    '200' => ['description' => 'Success'],
                    '400' => ['description' => 'The request was not valid',
                              'content' => ['application/json' =>
                                  ['schema' => ['$ref' => '#/components/schemas/Error']]]],
                    '401' => ['description' => 'Not authenticated'],
                    '403' => ['description' => 'Authenticated but not permitted'],
                    '404' => ['description' => 'Not found'],
                    '409' => ['description' => 'Conflicts with the current state',
                              'content' => ['application/json' =>
                                  ['schema' => ['$ref' => '#/components/schemas/Error']]]],
                ],
            ], static fn ($v): bool => $v !== [] && $v !== null);
        }

        ksort($paths);

        $organization = $request->auth !== null
            ? Settings::organization((int) $request->auth['organizationId'])
            : null;

        Response::json([
            'openapi' => '3.1.0',
            'info' => [
                'title'       => 'Assistive Technology Loaner Pool API',
                'version'     => \Loaner\APP_VERSION,
                'description' =>
                    "Device inventory, barcode check-out and check-in, counselor requests, waitlists, "
                    . "repairs and reporting.\n\n"
                    . "Authenticate either with a session cookie (POST /api/v1/auth/login) or with an "
                    . "API key sent as `Authorization: Bearer lp_<prefix>_<secret>`. API keys are created "
                    . "under Settings and carry read, write or admin scope.\n\n"
                    . "Errors always have the shape "
                    . '`{"error":{"code":"...","message":"...","details":{...}}}`. The message is written '
                    . "to be shown to a person as-is.\n\n"
                    . "The unversioned prefix `/api` is accepted as an alias for `/api/v1`, but new "
                    . 'integrations should use the versioned path.',
                'license' => ['name' => 'MIT', 'identifier' => 'MIT'],
            ],
            'servers' => [[
                'url'         => $request->baseUrl(),
                'description' => $organization['name'] ?? 'This installation',
            ]],
            'components' => [
                'securitySchemes' => [
                    'sessionCookie' => ['type' => 'apiKey', 'in' => 'cookie', 'name' => 'loaner_session'],
                    'apiKey' => [
                        'type'   => 'http',
                        'scheme' => 'bearer',
                        'description' => 'An API key created under Settings → API keys. The full key is '
                                       . 'shown once at creation and only its hash is stored.',
                    ],
                ],
                'schemas' => [
                    'Error' => [
                        'type' => 'object',
                        'required' => ['error'],
                        'properties' => [
                            'error' => [
                                'type' => 'object',
                                'required' => ['code', 'message'],
                                'properties' => [
                                    'code'    => ['type' => 'string',
                                                  'example' => 'validation_error'],
                                    'message' => ['type' => 'string',
                                                  'description' => 'Written for a person to read.'],
                                    'details' => ['type' => 'object', 'additionalProperties' => true],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
            'security' => [['sessionCookie' => []], ['apiKey' => []]],
            'paths'    => $paths,
            'x-capabilities' => Auth::CAPABILITIES,
            'x-api-scopes'   => Auth::API_SCOPES,
        ], 200, ['Cache-Control' => 'private, max-age=300']);
    }

    private static function tag(string $pattern): string
    {
        $first = explode('/', trim($pattern, '/'))[0] ?? 'meta';

        return match ($first) {
            ''            => 'Meta',
            'openapi.json', 'version' => 'Meta',
            'auth'        => 'Authentication',
            'devices'     => 'Devices',
            'loans'       => 'Loans',
            'requests'    => 'Requests',
            'clients', 'programs', 'users' => 'Directory',
            'scan'        => 'Scanning',
            'kits', 'groups' => 'Kits',
            'reservations' => 'Reservations',
            'repairs'     => 'Repairs',
            'agreements'  => 'Agreements',
            'attachments' => 'Attachments',
            'bulk'        => 'Bulk actions',
            'jobs'        => 'Scheduled jobs',
            'audit'       => 'Audit log',
            'reports'     => 'Reports',
            'admin'       => 'Administration',
            default       => ucfirst($first),
        };
    }

    /** A readable one-liner per endpoint, derived from its shape. */
    private static function summarise(string $method, string $pattern): string
    {
        $segments = array_values(array_filter(
            explode('/', trim($pattern, '/')),
            static fn (string $s): bool => !str_starts_with($s, '{'),
        ));

        $noun = $segments === [] ? 'the API root' : str_replace(['-', '_', '.csv'], [' ', ' ', ' as CSV'], end($segments));
        $hasId = str_contains($pattern, '{');

        return match ($method) {
            'GET'    => $hasId ? "Fetch one {$noun}" : "List or fetch {$noun}",
            'POST'   => "Create or act on {$noun}",
            'PATCH'  => "Update {$noun}",
            'PUT'    => "Replace {$noun}",
            'DELETE' => "Remove {$noun}",
            default  => "{$method} {$noun}",
        };
    }
}
