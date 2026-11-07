<?php
/**
 * Runtime configuration.
 *
 * The app has two states:
 *
 *   NOT INSTALLED — no config file on disk. Every request is routed to the web
 *                   installer, which collects database details, creates the
 *                   tables and the first admin, then writes the config file.
 *
 *   INSTALLED     — config file present and parseable. Normal operation.
 *
 * The file lives in data/, which sits *above* the document root. On the Node
 * version this relied on .htaccess to stay private; here it is unreachable by
 * construction, which is a better guarantee.
 */

declare(strict_types=1);

namespace Loaner;

final class Config
{
    private static ?array $cached = null;
    private static bool $loaded = false;

    /**
     * Absolute path of the config file.
     *
     * Override with the LOANER_CONFIG environment variable (SetEnv in
     * .htaccess, or the cPanel environment editor) to move it somewhere else
     * entirely — useful when data/ is on shared storage.
     */
    public static function path(): string
    {
        $override = getenv('LOANER_CONFIG');
        if (is_string($override) && $override !== '') {
            return $override;
        }

        return APP_ROOT . '/data/config.json';
    }

    public static function dataDir(): string
    {
        return dirname(self::path());
    }

    public static function uploadsDir(): string
    {
        return self::dataDir() . '/uploads';
    }

    /** Read config from disk, or null when the app has not been installed. */
    public static function get(): ?array
    {
        if (self::$loaded) {
            return self::$cached;
        }

        self::$loaded = true;
        self::$cached = null;

        $path = self::path();
        if (!is_file($path) || !is_readable($path)) {
            return null;
        }

        try {
            $raw = file_get_contents($path);
            if ($raw === false) {
                return null;
            }

            $parsed = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (\Throwable) {
            // A corrupt config reads as "not installed" rather than crashing,
            // which puts the installer back in front of an administrator who
            // can fix it, instead of a stack trace.
            return null;
        }

        if (!is_array($parsed) || ($parsed['db']['host'] ?? '') === '' || ($parsed['db']['database'] ?? '') === '') {
            return null;
        }

        self::$cached = $parsed;
        return self::$cached;
    }

    public static function isInstalled(): bool
    {
        return self::get() !== null;
    }

    public static function reload(): ?array
    {
        self::$loaded = false;
        self::$cached = null;
        return self::get();
    }

    /**
     * Persist config atomically (write temp, then rename) so a crash midway
     * cannot leave a half-written file that reads as "not installed" on the
     * next request.
     *
     * Mode 0600: the file holds database credentials.
     */
    public static function write(array $config): array
    {
        $path = self::path();
        $dir  = dirname($path);

        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new \RuntimeException(
                "Could not create the configuration directory at {$dir}. "
                . 'Check that the parent directory is writable by the web server user.'
            );
        }

        $json = json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $temp = $path . '.' . getmypid() . '.tmp';

        if (@file_put_contents($temp, $json, LOCK_EX) === false) {
            throw new \RuntimeException(
                "Could not write to {$temp}. The web server user needs write access to "
                . dirname($path) . '.'
            );
        }

        @chmod($temp, 0600);

        if (!@rename($temp, $path)) {
            @unlink($temp);
            throw new \RuntimeException("Could not move the configuration file into place at {$path}.");
        }

        @chmod($path, 0600);

        self::$loaded = false;
        self::$cached = null;

        return self::get() ?? throw new \RuntimeException(
            'The configuration file was written but could not be read back. Check file permissions.'
        );
    }

    /** Defaults applied to any config the installer writes. */
    public static function defaults(): array
    {
        return [
            'appVersion'    => APP_VERSION,
            'schemaVersion' => SCHEMA_VERSION,
            'installedAt'   => date('c'),
            'appKey'        => self::generateAppKey(),
            'baseUrl'       => '',
            'timezone'      => 'UTC',
            'db' => [
                'host'     => 'localhost',
                'port'     => 3306,
                'user'     => '',
                'password' => '',
                'database' => '',
                'ssl'      => false,
            ],
            'session' => [
                // Days a session cookie stays valid.
                'lifetimeDays'  => 14,
                // Only true when the site is served over HTTPS, otherwise the
                // cookie is never sent and nobody can sign in.
                'secureCookies' => false,
            ],
        ];
    }

    /**
     * 32 random bytes, hex encoded. Used to sign session cookies and to derive
     * the key encrypting stored secrets (the Graph client secret).
     *
     * Never rotated automatically: changing it invalidates every session and
     * makes any stored secret unreadable.
     */
    public static function generateAppKey(): string
    {
        return bin2hex(random_bytes(32));
    }

    public static function appKey(): string
    {
        $key = self::get()['appKey'] ?? '';
        if (!is_string($key) || $key === '') {
            throw new \RuntimeException('The application key is missing from the configuration file.');
        }
        return $key;
    }

    public static function baseUrl(): string
    {
        return (string) (self::get()['baseUrl'] ?? '');
    }

    /**
     * Timezone, read from the config file rather than the database.
     *
     * Called during bootstrap, before any connection exists — reading it from
     * the database here would mean connecting before the timezone is set,
     * which is the thing we are trying to avoid.
     */
    public static function organizationTimezone(): string
    {
        $tz = self::get()['timezone'] ?? '';
        return (is_string($tz) && $tz !== '' && in_array($tz, timezone_identifiers_list(), true)) ? $tz : '';
    }

    // -----------------------------------------------------------------------
    // Cron token
    // -----------------------------------------------------------------------

    /**
     * Token authenticating an external cron entry against the job runner.
     *
     * Lives in the config file rather than the database: it authenticates the
     * installation as a whole, and a cron entry has no session to scope it
     * with. Generated on first request so an existing install picks one up
     * without a migration.
     */
    public static function cronToken(): string
    {
        $config = self::get();
        if ($config === null) {
            throw new \RuntimeException('Not installed.');
        }

        if (!empty($config['cronToken']) && is_string($config['cronToken'])) {
            return $config['cronToken'];
        }

        $token = rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
        $config['cronToken'] = $token;
        self::write($config);

        return $token;
    }

    /** Constant-time comparison, so the token cannot be found by timing. */
    public static function verifyCronToken(?string $candidate): bool
    {
        $expected = self::get()['cronToken'] ?? '';

        if (!is_string($expected) || $expected === '' || $candidate === null || $candidate === '') {
            return false;
        }

        return hash_equals($expected, $candidate);
    }
}
