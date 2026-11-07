<?php
/**
 * Routing.
 */

declare(strict_types=1);

namespace Loaner;

/**
 * Router.
 *
 * Routes are matched by *specificity*, not registration order: a pattern with
 * more literal segments beats one with more parameters. This is deliberate.
 *
 * Express matches in declaration order, which meant `/devices/export.csv`
 * registered after `/devices/{id}` was silently swallowed and treated as a
 * device whose id was "export.csv" — a bug that reached a running system in an
 * earlier version of this application. Scoring removes the entire class of
 * mistake rather than relying on everyone remembering the ordering rule.
 */
final class Router
{
    /**
     * @var list<array{method:string, segments:list<string>, handler:callable,
     *                 capability:?string, pattern:string}>
     */
    private array $routes = [];

    public function get(string $pattern, callable $handler, ?string $capability = null): void
    {
        $this->add('GET', $pattern, $handler, $capability);
    }

    public function post(string $pattern, callable $handler, ?string $capability = null): void
    {
        $this->add('POST', $pattern, $handler, $capability);
    }

    public function patch(string $pattern, callable $handler, ?string $capability = null): void
    {
        $this->add('PATCH', $pattern, $handler, $capability);
    }

    public function put(string $pattern, callable $handler, ?string $capability = null): void
    {
        $this->add('PUT', $pattern, $handler, $capability);
    }

    public function delete(string $pattern, callable $handler, ?string $capability = null): void
    {
        $this->add('DELETE', $pattern, $handler, $capability);
    }

    private function add(string $method, string $pattern, callable $handler, ?string $capability): void
    {
        $this->routes[] = [
            'method'     => $method,
            'segments'   => $this->segments($pattern),
            'handler'    => $handler,
            'capability' => $capability,
            'pattern'    => $pattern,
        ];
    }

    /** @return list<string> */
    private function segments(string $path): array
    {
        $trimmed = trim($path, '/');
        return $trimmed === '' ? [] : explode('/', $trimmed);
    }

    /**
     * Find the best match.
     *
     * Returns null when the path matches no route at all, and throws 405 when
     * the path matches but the method does not — a far more useful answer than
     * a bare 404.
     *
     * @param string|null $pathOverride Match against this instead of the raw
     *        request path. The API router uses it so `/api/v1/devices` and
     *        `/api/devices` both dispatch against `/devices`.
     */
    public function dispatch(Request $request, ?string $pathOverride = null): ?array
    {
        $requestSegments        = $this->segments($pathOverride ?? $request->path);
        $best                   = null;
        $bestScore              = -1;
        $pathMatchedOtherMethod = false;

        foreach ($this->routes as $route) {
            if (count($route['segments']) !== count($requestSegments)) {
                continue;
            }

            $params = [];
            $score  = 0;
            $ok     = true;

            foreach ($route['segments'] as $i => $segment) {
                if (str_starts_with($segment, '{') && str_ends_with($segment, '}')) {
                    $params[substr($segment, 1, -1)] = $requestSegments[$i];
                    continue; // A parameter scores nothing.
                }

                if ($segment !== $requestSegments[$i]) {
                    $ok = false;
                    break;
                }

                $score++; // A literal segment is worth more than a parameter.
            }

            if (!$ok) {
                continue;
            }

            if ($route['method'] !== $request->method) {
                $pathMatchedOtherMethod = true;
                continue;
            }

            if ($score > $bestScore) {
                $bestScore = $score;
                $best      = $route + ['params' => $params];
            }
        }

        if ($best === null && $pathMatchedOtherMethod) {
            throw new HttpError(
                405,
                'method_not_allowed',
                "{$request->method} is not supported on {$request->path}.",
            );
        }

        return $best;
    }
}
