<?php
/**
 * Web installer.
 *
 * Reachable only while the app is uninstalled; the front controller returns
 * 410 for everything here once a config file exists. An installer that stays
 * reachable is a standing offer to repoint a live system at someone else's
 * database.
 *
 * The installer never needs shell access and never needs CREATE DATABASE
 * rights: the expected flow on shared hosting is that the administrator
 * creates an empty database in their control panel and hands the details over
 * here. Creating the database is not attempted, because most managed MySQL
 * users cannot.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Auth;
use Loaner\Barcode;
use Loaner\Config;
use Loaner\Db;
use Loaner\HttpError;
use Loaner\Migrations;
use Loaner\Request;
use Loaner\Response;
use Loaner\Router;
use Loaner\Util;

final class Install
{
    public static function register(Router $router): void
    {
        $router->get('/api/install/state', [self::class, 'state']);
        $router->post('/api/install/test-database', [self::class, 'testDatabase']);
        $router->post('/api/install/run', [self::class, 'run']);
    }

    /** What the installer needs to know about its own environment. */
    public static function state(Request $request): never
    {
        Response::json([
            'installed'         => false,
            'app_version'       => \Loaner\APP_VERSION,
            'schema_version'    => \Loaner\SCHEMA_VERSION,
            'config_path'       => Config::path(),
            'node_version'      => 'PHP ' . PHP_VERSION,
            'php_version'       => PHP_VERSION,
            // Whether the request arrived over TLS decides the secure-cookie
            // default. Getting this wrong locks everyone out, so it is
            // detected rather than guessed.
            'is_https'          => $request->secure,
            'detected_base_url' => $request->baseUrl(),
            'symbologies'       => Barcode::SYMBOLOGIES,
            'writable'          => self::configDirWritable(),
            'timezones'         => ['detected' => date_default_timezone_get()],
        ]);
    }

    /**
     * Test credentials.
     *
     * Reports precisely what worked — reachable, authenticated, database
     * present, can create tables. "Connection failed" alone sends people to
     * the wrong place half the time.
     */
    public static function testDatabase(Request $request): never
    {
        $db = self::readDbConfig($request);

        $checks = [
            'reachable'       => false,
            'authenticated'   => false,
            'database_exists' => false,
            'can_create_tables' => false,
            'existing_tables' => [],
            'server_version'  => null,
        ];

        // Connect without selecting a database first, so "wrong password" and
        // "database missing" are distinguishable.
        try {
            $probe = Db::connect(['host' => $db['host'], 'port' => $db['port'],
                                  'user' => $db['user'], 'password' => $db['password'],
                                  'database' => '', 'ssl' => $db['ssl']]);

            $checks['reachable']      = true;
            $checks['authenticated']  = true;
            $checks['server_version'] = (string) $probe->query('SELECT VERSION()')->fetchColumn();

            $statement = $probe->prepare(
                'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?'
            );
            $statement->execute([$db['database']]);
            $checks['database_exists'] = $statement->fetch() !== false;
        } catch (\Throwable $e) {
            Response::json([
                'ok'     => false,
                'checks' => $checks,
                'error'  => Db::describeError($e),
            ], 400);
        }

        if (!$checks['database_exists']) {
            Response::json([
                'ok'     => false,
                'checks' => $checks,
                'error'  => "Connected to MySQL successfully, but the database \"{$db['database']}\" does not exist. "
                          . 'Create it in your hosting control panel and make sure this user has ALL PRIVILEGES on it. '
                          . 'Some control panels prefix the name you type with your account name — enter the full, '
                          . 'final name here.',
            ]);
        }

        // Now connect to the database itself and check we can actually write.
        try {
            $pdo = Db::connect($db);

            $tables = $pdo->prepare('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?');
            $tables->execute([$db['database']]);
            $checks['existing_tables'] = array_column($tables->fetchAll(), 'TABLE_NAME');

            // Create and drop a scratch table — the only honest test of
            // CREATE rights.
            $pdo->exec('CREATE TABLE IF NOT EXISTS _loaner_install_check (id INT PRIMARY KEY)');
            $pdo->exec('DROP TABLE IF EXISTS _loaner_install_check');
            $checks['can_create_tables'] = true;
        } catch (\Throwable $e) {
            Response::json(['ok' => false, 'checks' => $checks, 'error' => Db::describeError($e)], 400);
        }

        $conflicting = array_values(array_intersect(
            $checks['existing_tables'],
            ['devices', 'loans', 'users', 'organizations'],
        ));

        Response::json([
            'ok'      => true,
            'checks'  => $checks,
            'warning' => $conflicting !== []
                ? 'This database already contains Loaner Pool tables (' . implode(', ', $conflicting) . '). '
                  . 'Installing will reuse them and will not delete existing rows, but if this database '
                  . 'belongs to another installation, stop and use a different one.'
                : null,
        ]);
    }

    /**
     * Run the installation.
     *
     * Order matters: schema and seed data first, config file last. If anything
     * fails, no config file exists, so the app stays in installer mode and the
     * administrator can correct and retry — rather than booting into a
     * half-configured state that needs shell access to unpick.
     */
    public static function run(Request $request): never
    {
        $db       = self::readDbConfig($request);
        $org      = self::readOrgConfig($request);
        $admin    = self::readAdminConfig($request);
        $periods  = self::readPeriods($request);

        $baseUrl = Util::str($request->input('base_url'), 255) ?? $request->baseUrl();
        $secureCookies = Util::bool($request->input('secure_cookies'), str_starts_with($baseUrl, 'https://'));

        if (!self::configDirWritable()) {
            throw new HttpError(
                500,
                'config_not_writable',
                'The configuration directory is not writable: ' . Config::dataDir() . '. '
                . 'Create it and give the web server user write access, then try again.',
                ['config_path' => Config::path()],
            );
        }

        $log = [];

        try {
            $pdo = Db::connect($db);
        } catch (\Throwable $e) {
            throw new HttpError(400, 'db_unreachable', Db::describeError($e));
        }

        try {
            // --- Schema -------------------------------------------------------
            foreach (Db::schemaStatements() as $statement) {
                $pdo->exec($statement);
            }
            $log[] = 'Created or verified ' . count(Db::schemaStatements()) . ' schema objects.';

            // Everything from here is one transaction: a failure must not leave
            // an organisation with no administrator.
            $pdo->beginTransaction();

            // --- Organisation --------------------------------------------------
            $existing = $pdo->prepare('SELECT id FROM organizations WHERE slug = ?');
            $existing->execute([$org['slug']]);
            $found = $existing->fetch();

            if ($found !== false) {
                $organizationId = (int) $found['id'];
                $update = $pdo->prepare(
                    'UPDATE organizations SET name = ?, timezone = ?, barcode_symbology = ?,
                            barcode_prefix = ?, contact_email = ?, updated_at = NOW() WHERE id = ?'
                );
                $update->execute([$org['name'], $org['timezone'], $org['symbology'],
                                  $org['barcodePrefix'], $org['contactEmail'], $organizationId]);
                $log[] = "Reused existing organisation \"{$org['name']}\".";
            } else {
                $insert = $pdo->prepare(
                    'INSERT INTO organizations (name, slug, timezone, barcode_symbology, barcode_prefix, contact_email)
                     VALUES (?, ?, ?, ?, ?, ?)'
                );
                $insert->execute([$org['name'], $org['slug'], $org['timezone'], $org['symbology'],
                                  $org['barcodePrefix'], $org['contactEmail']]);
                $organizationId = (int) $pdo->lastInsertId();
                $log[] = "Created organisation \"{$org['name']}\".";
            }

            // --- Loan periods --------------------------------------------------
            $periodCount = 0;
            foreach ($periods as $index => $period) {
                $check = $pdo->prepare('SELECT id FROM loan_periods WHERE organization_id = ? AND name = ?');
                $check->execute([$organizationId, $period['name']]);

                if ($check->fetch() !== false) {
                    continue;
                }

                $insert = $pdo->prepare(
                    'INSERT INTO loan_periods
                       (organization_id, name, days, is_default, max_extensions, extension_days, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?, ?)'
                );
                $insert->execute([
                    $organizationId, $period['name'], $period['days'], $period['isDefault'] ? 1 : 0,
                    $period['maxExtensions'], $period['extensionDays'], $index,
                ]);
                $periodCount++;
            }
            $log[] = "Configured {$periodCount} loan period(s).";

            // --- Administrator --------------------------------------------------
            $dupe = $pdo->prepare('SELECT id FROM users WHERE organization_id = ? AND email = ?');
            $dupe->execute([$organizationId, $admin['email']]);

            if ($dupe->fetch() !== false) {
                $pdo->rollBack();
                throw new HttpError(
                    409,
                    'admin_exists',
                    "A user with the address {$admin['email']} already exists in this database. "
                    . 'Either use a different address, or use an empty database.',
                );
            }

            $createUser = $pdo->prepare(
                'INSERT INTO users (organization_id, email, password_hash, full_name, role, active)
                 VALUES (?, ?, ?, ?, "admin", 1)'
            );
            $createUser->execute([$organizationId, $admin['email'], $admin['passwordHash'], $admin['fullName']]);
            $adminId = (int) $pdo->lastInsertId();
            $log[] = "Created administrator {$admin['email']}.";

            // --- Schema version marker --------------------------------------
            $pdo->prepare(
                'INSERT INTO schema_meta (id, schema_version, app_version) VALUES (1, ?, ?)
                 ON DUPLICATE KEY UPDATE schema_version = VALUES(schema_version), app_version = VALUES(app_version)'
            )->execute([\Loaner\SCHEMA_VERSION, \Loaner\APP_VERSION]);

            $pdo->prepare(
                'INSERT INTO audit_log (organization_id, actor_id, actor_label, actor_type, action,
                                        entity_type, entity_id, summary, ip)
                 VALUES (?, ?, ?, "user", "install.completed", "organization", ?, ?, ?)'
            )->execute([
                $organizationId, $adminId, $admin['fullName'], $organizationId,
                'Loaner Pool ' . \Loaner\APP_VERSION . ' installed', $request->ip ?: null,
            ]);

            $pdo->commit();
        } catch (HttpError $e) {
            throw $e;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                try {
                    $pdo->rollBack();
                } catch (\Throwable) {
                }
            }

            throw new HttpError(
                500,
                'install_failed',
                'Installation failed: ' . Db::describeError($e),
                ['log' => $log],
            );
        }

        // --- Config file (last) ---------------------------------------------
        $config = array_replace_recursive(Config::defaults(), [
            'baseUrl'  => $baseUrl,
            'timezone' => $org['timezone'],
            'db'       => $db,
            'session'  => ['lifetimeDays' => 14, 'secureCookies' => $secureCookies],
        ]);

        try {
            Config::write($config);
        } catch (\Throwable $e) {
            throw new HttpError(
                500,
                'config_write_failed',
                'The database was set up successfully, but the configuration file could not be written to '
                . Config::path() . ': ' . $e->getMessage() . '. Make sure the "data" directory exists and is '
                . 'writable by the account PHP runs as, then run the installer again.',
                ['log' => $log, 'config_path' => Config::path()],
            );
        }

        Config::reload();
        Db::reset();

        // Migrations run only now, because they use the shared connection,
        // which needs the config file to exist before it can be built.
        try {
            $migration = Migrations::run();
            if ($migration['applied'] !== []) {
                $log[] = 'Applied schema upgrades: v' . implode(', v', $migration['applied']) . '.';
                $log   = array_merge($log, $migration['log']);
            }
        } catch (\Throwable $e) {
            // The core install succeeded, so do not fail the request — but say
            // so plainly, because newer features will not work until it is fixed.
            $log[] = 'WARNING: optional schema upgrades did not apply: ' . $e->getMessage();
        }

        // The uploads directory is created now rather than lazily, so a
        // permissions problem surfaces during setup and not weeks later when
        // somebody first attaches a photo.
        @mkdir(Config::uploadsDir(), 0700, true);

        Response::json([
            'ok'             => true,
            'log'            => $log,
            'config_path'    => Config::path(),
            'login_url'      => '/',
            'admin_email'    => $admin['email'],
            'secure_cookies' => $secureCookies,
            'warning'        => $secureCookies
                ? null
                : 'Secure cookies are switched off because this installation is not being served over HTTPS. '
                  . 'Enable HTTPS and turn them on before using this system with real client data.',
        ]);
    }

    // -----------------------------------------------------------------------
    // Input parsing
    // -----------------------------------------------------------------------

    private static function configDirWritable(): bool
    {
        $dir = Config::dataDir();

        if (is_dir($dir)) {
            return is_writable($dir);
        }

        // Not there yet — can we create it?
        $parent = dirname($dir);
        return is_dir($parent) && is_writable($parent);
    }

    private static function readDbConfig(Request $request): array
    {
        return [
            'host'     => Util::requiredStr($request->input('db_host'), 'Database host', 190),
            'port'     => Util::int($request->input('db_port'), 'Database port', 1, 65535) ?? 3306,
            'user'     => Util::requiredStr($request->input('db_user'), 'Database user', 128),
            // A password may legitimately be empty on a local development MySQL.
            'password' => (string) ($request->input('db_password') ?? ''),
            'database' => Util::requiredStr($request->input('db_name'), 'Database name', 128),
            'ssl'      => Util::bool($request->input('db_ssl'), false),
        ];
    }

    private static function readOrgConfig(Request $request): array
    {
        $name = Util::requiredStr($request->input('org_name'), 'Organisation name', 190);

        $slug = Util::str($request->input('org_slug'), 64) ?? $name;
        $slug = preg_replace('/[^a-z0-9]+/', '-', strtolower($slug)) ?? '';
        $slug = trim($slug, '-');
        $slug = substr($slug, 0, 64) ?: 'organisation';

        $symbology = Util::oneOf(
            $request->input('barcode_symbology'),
            Barcode::SYMBOLOGIES,
            'barcode_symbology',
            fallback: 'qr',
        );

        $prefix = strtoupper((string) (Util::str($request->input('barcode_prefix'), 8) ?? 'LP'));
        $prefix = preg_replace('/[^A-Z0-9]/', '', $prefix) ?: 'LP';

        $timezone = Util::str($request->input('org_timezone'), 64) ?? 'UTC';
        if (!in_array($timezone, timezone_identifiers_list(), true)) {
            $timezone = 'UTC';
        }

        return [
            'name'          => $name,
            'slug'          => $slug,
            'timezone'      => $timezone,
            'symbology'     => $symbology,
            'barcodePrefix' => substr($prefix, 0, 8),
            'contactEmail'  => Util::email($request->input('org_contact_email'), 'Contact email'),
        ];
    }

    private static function readAdminConfig(Request $request): array
    {
        $email    = Util::email($request->input('admin_email'), 'Administrator email', true);
        $fullName = Util::requiredStr($request->input('admin_name'), 'Administrator name', 190);
        $password = (string) ($request->input('admin_password') ?? '');
        $confirm  = (string) ($request->input('admin_password_confirm') ?? $password);

        if ($password !== $confirm) {
            throw Util::badRequest('The two passwords do not match.', ['field' => 'admin_password_confirm']);
        }

        Auth::validatePassword($password);

        return ['email' => $email, 'fullName' => $fullName, 'passwordHash' => Auth::hashPassword($password)];
    }

    /**
     * Loan periods. Defaults cover the common cases; the wizard lets the
     * administrator edit, remove or add to them, and they stay fully editable
     * afterwards.
     */
    private static function readPeriods(Request $request): array
    {
        $provided = $request->input('loan_periods');

        $source = (is_array($provided) && $provided !== []) ? $provided : [
            ['name' => 'Short term (7 days)',       'days' => 7,   'is_default' => false, 'max_extensions' => 2, 'extension_days' => 7],
            ['name' => 'Standard (30 days)',        'days' => 30,  'is_default' => true,  'max_extensions' => 2, 'extension_days' => 14],
            ['name' => 'Extended (90 days)',        'days' => 90,  'is_default' => false, 'max_extensions' => 1, 'extension_days' => 30],
            ['name' => 'Academic term (120 days)',  'days' => 120, 'is_default' => false, 'max_extensions' => 1, 'extension_days' => 30],
            ['name' => 'Open ended (no due date)',  'days' => 0,   'is_default' => false, 'max_extensions' => 0, 'extension_days' => 0],
        ];

        $periods = [];
        foreach (array_values($source) as $index => $period) {
            $n = $index + 1;
            $periods[] = [
                'name'          => Util::requiredStr($period['name'] ?? null, "Loan period {$n} name", 120),
                'days'          => Util::int($period['days'] ?? null, "Loan period {$n} length", 0, 3650) ?? 30,
                'isDefault'     => Util::bool($period['is_default'] ?? false),
                'maxExtensions' => Util::int($period['max_extensions'] ?? null, "Loan period {$n} extension limit", 0, 50) ?? 2,
                'extensionDays' => Util::int($period['extension_days'] ?? null, "Loan period {$n} extension length", 0, 365) ?? 14,
            ];
        }

        // Exactly one default, or check-out has to ask every time.
        $defaults = array_keys(array_filter($periods, static fn (array $p): bool => $p['isDefault']));

        if ($defaults === []) {
            $firstWithDays = null;
            foreach ($periods as $i => $p) {
                if ($p['days'] > 0) {
                    $firstWithDays = $i;
                    break;
                }
            }
            $periods[$firstWithDays ?? 0]['isDefault'] = true;
        } elseif (count($defaults) > 1) {
            foreach (array_slice($defaults, 1) as $i) {
                $periods[$i]['isDefault'] = false;
            }
        }

        return $periods;
    }
}
