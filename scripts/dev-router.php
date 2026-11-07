<?php
/**
 * Router for PHP's built-in development server.
 *
 * Mirrors public/.htaccess: a real file on disk is served as-is, everything
 * else goes to the front controller. Without this, `php -S` either bypasses
 * routing entirely or swallows static assets, and neither matches how Apache
 * will behave in production.
 *
 * Usage: php -S 127.0.0.1:8080 -t public scripts/dev-router.php
 */

declare(strict_types=1);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$file = __DIR__ . '/../public' . $path;

if ($path !== '/' && is_file($file)) {
    if (str_ends_with($file, '.php')) {
        require $file;
        return true;
    }
    return false; // Let the built-in server serve the static file.
}

require __DIR__ . '/../public/index.php';
