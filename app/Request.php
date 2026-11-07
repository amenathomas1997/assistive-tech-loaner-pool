<?php
/**
 * The incoming HTTP request, parsed once.
 */

declare(strict_types=1);

namespace Loaner;

/** The incoming request, parsed once. */
final class Request
{
    public readonly string $method;
    public readonly string $path;
    public readonly array $query;
    public readonly string $ip;
    public readonly bool $secure;

    private ?array $body = null;

    /** Populated by Auth::attach(). Null when nobody is signed in. */
    public ?array $auth = null;

    /** Route parameters from the matched pattern, e.g. ['id' => '42']. */
    public array $params = [];

    public function __construct()
    {
        $this->method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

        $uri  = $_SERVER['REQUEST_URI'] ?? '/';
        $path = parse_url($uri, PHP_URL_PATH) ?: '/';
        $this->path = '/' . trim(rawurldecode($path), '/');

        parse_str((string) parse_url($uri, PHP_URL_QUERY), $query);
        $this->query = $query;

        $this->ip     = self::clientIp();
        $this->secure = self::isSecure();
    }

    /**
     * The JSON body, decoded once.
     *
     * Form encoding is accepted too, because the installer and a couple of
     * simple forms post that way, and a client that sends the wrong content
     * type should get a useful error rather than a silently empty body.
     */
    public function body(): array
    {
        if ($this->body !== null) {
            return $this->body;
        }

        $type = strtolower($_SERVER['CONTENT_TYPE'] ?? '');

        if (str_contains($type, 'application/x-www-form-urlencoded') || str_contains($type, 'multipart/form-data')) {
            return $this->body = $_POST;
        }

        $raw = file_get_contents('php://input');
        if ($raw === false || trim($raw) === '') {
            return $this->body = [];
        }

        try {
            $decoded = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new HttpError(400, 'malformed_json', 'The request body was not valid JSON.');
        }

        return $this->body = is_array($decoded) ? $decoded : [];
    }

    public function input(string $key, mixed $default = null): mixed
    {
        return $this->body()[$key] ?? $default;
    }

    public function has(string $key): bool
    {
        return array_key_exists($key, $this->body());
    }

    public function queryParam(string $key, mixed $default = null): mixed
    {
        return $this->query[$key] ?? $default;
    }

    public function param(string $key): ?string
    {
        return $this->params[$key] ?? null;
    }

    public function header(string $name): ?string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));

        if (isset($_SERVER[$key])) {
            return $_SERVER[$key];
        }

        // Apache with CGI/FastCGI hides Authorization unless explicitly passed
        // through; .htaccess sets HTTP_AUTHORIZATION for exactly this reason.
        if (strtolower($name) === 'authorization') {
            return $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
                ?? $_SERVER['HTTP_AUTHORIZATION']
                ?? (function_exists('apache_request_headers')
                    ? (apache_request_headers()['Authorization'] ?? null)
                    : null);
        }

        return null;
    }

    public function cookie(string $name): ?string
    {
        return $_COOKIE[$name] ?? null;
    }

    public function wantsJson(): bool
    {
        if (str_starts_with($this->path, '/api/')) {
            return true;
        }
        return str_contains(strtolower($_SERVER['HTTP_ACCEPT'] ?? ''), 'application/json');
    }

    public function baseUrl(): string
    {
        $configured = Config::baseUrl();
        if ($configured !== '') {
            return rtrim($configured, '/');
        }

        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        return ($this->secure ? 'https' : 'http') . '://' . $host;
    }

    /**
     * The client's address.
     *
     * X-Forwarded-For is trusted only because this is designed to run behind
     * the host's own Apache. If you expose PHP-FPM directly to the internet,
     * set LOANER_TRUST_PROXY=0 — otherwise a client can forge its own audit
     * log entries' IP.
     */
    private static function clientIp(): string
    {
        $trustProxy = getenv('LOANER_TRUST_PROXY') !== '0';

        if ($trustProxy && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $first = trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
            if (filter_var($first, FILTER_VALIDATE_IP)) {
                return $first;
            }
        }

        return $_SERVER['REMOTE_ADDR'] ?? '';
    }

    private static function isSecure(): bool
    {
        if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
            return true;
        }
        if (($_SERVER['SERVER_PORT'] ?? '') === '443') {
            return true;
        }
        if (strtolower($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') {
            return true;
        }
        return false;
    }
}
