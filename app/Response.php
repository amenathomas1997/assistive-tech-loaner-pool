<?php
/**
 * Response helpers. Each one ends the request.
 */

declare(strict_types=1);

namespace Loaner;

/** Response helpers. Each one ends the request. */
final class Response
{
    public static function json(mixed $data, int $status = 200, array $headers = []): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');

        foreach ($headers as $name => $value) {
            header("{$name}: {$value}");
        }

        echo json_encode(
            $data,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR,
        );
        exit;
    }

    public static function error(int $status, string $code, string $message, ?array $details = null): never
    {
        $payload = ['error' => ['code' => $code, 'message' => $message]];

        if ($details !== null) {
            $payload['error']['details'] = $details;
        }

        self::json($payload, $status);
    }

    public static function html(string $html, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: text/html; charset=utf-8');
        echo $html;
        exit;
    }

    public static function csv(string $csv, string $filename): never
    {
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        echo $csv;
        exit;
    }

    public static function svg(string $svg, bool $cache = true): never
    {
        header('Content-Type: image/svg+xml');
        if ($cache) {
            header('Cache-Control: private, max-age=3600');
        }
        echo $svg;
        exit;
    }

    public static function redirect(string $to, int $status = 302): never
    {
        http_response_code($status);
        header('Location: ' . $to);
        exit;
    }

    public static function noContent(): never
    {
        http_response_code(204);
        exit;
    }

    /** Stream a stored file. Used for condition photos and signatures. */
    public static function file(string $path, string $mimeType, string $filename): never
    {
        if (!is_file($path)) {
            self::error(404, 'not_found', 'That file is no longer on disk.');
        }

        header('Content-Type: ' . $mimeType);
        header('Content-Length: ' . (string) filesize($path));
        header('Content-Disposition: inline; filename="' . $filename . '"');
        header('X-Content-Type-Options: nosniff');
        // Condition photos and signatures, on what is often a shared computer.
        // Not left in the disk cache for the next person at the desk.
        header('Cache-Control: no-store');

        readfile($path);
        exit;
    }
}
