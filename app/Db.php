<?php
/**
 * Database access.
 *
 * A single lazily-created PDO connection per request. It cannot be built at
 * bootstrap because before installation there are no credentials to build it
 * from; connection() throws a clear error rather than a cryptic PDO failure.
 */

declare(strict_types=1);

namespace Loaner;

use PDO;
use PDOException;
use PDOStatement;

final class Db
{
    private static ?PDO $pdo = null;
    private static int $transactionDepth = 0;

    public static function connection(): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }

        $config = Config::get();
        if ($config === null) {
            throw new \RuntimeException('Database is not configured. Run the installer first.');
        }

        self::$pdo = self::connect($config['db']);
        return self::$pdo;
    }

    /**
     * Build a connection from raw credentials.
     *
     * Exported so the installer can test details the user typed without
     * committing them to disk.
     */
    public static function connect(array $db): PDO
    {
        $host = (string) ($db['host'] ?? 'localhost');
        $port = (int) ($db['port'] ?? 3306);
        $name = (string) ($db['database'] ?? '');

        $dsn = "mysql:host={$host};port={$port};charset=utf8mb4";
        if ($name !== '') {
            $dsn .= ";dbname={$name}";
        }

        $options = [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            // Real prepared statements, not client-side interpolation. This is
            // what makes the parameterised queries throughout actually safe.
            PDO::ATTR_EMULATE_PREPARES   => false,
            PDO::ATTR_STRINGIFY_FETCHES  => false,
        ];

        if (!empty($db['ssl'])) {
            $options[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = false;
        }

        $pdo = new PDO($dsn, (string) ($db['user'] ?? ''), (string) ($db['password'] ?? ''), $options);

        // Match the application's timezone so NOW() and DATEDIFF() agree with
        // PHP's date arithmetic. Without this, a server in UTC and an app in
        // America/New_York disagree about when a loan became overdue.
        $offset = (new \DateTime('now'))->format('P');
        $pdo->exec("SET time_zone = '{$offset}'");

        return $pdo;
    }

    public static function reset(): void
    {
        self::$pdo = null;
        self::$transactionDepth = 0;
    }

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------

    public static function run(string $sql, array $params = []): PDOStatement
    {
        $statement = self::connection()->prepare($sql);
        $statement->execute(self::normalise($params));
        return $statement;
    }

    /** All rows. */
    public static function all(string $sql, array $params = []): array
    {
        return self::run($sql, $params)->fetchAll();
    }

    /** First row, or null. */
    public static function one(string $sql, array $params = []): ?array
    {
        $row = self::run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    /** First column of the first row, or null. */
    public static function value(string $sql, array $params = []): mixed
    {
        $value = self::run($sql, $params)->fetchColumn();
        return $value === false ? null : $value;
    }

    /** INSERT/UPDATE/DELETE; returns affected rows. */
    public static function execute(string $sql, array $params = []): int
    {
        return self::run($sql, $params)->rowCount();
    }

    public static function insert(string $sql, array $params = []): int
    {
        self::run($sql, $params);
        return (int) self::connection()->lastInsertId();
    }

    /**
     * Booleans must be sent as 0/1, not PHP's '' for false — MySQL stores the
     * empty string in a TINYINT column as 0 but warns, and in strict mode
     * rejects it outright.
     */
    private static function normalise(array $params): array
    {
        foreach ($params as $key => $value) {
            // JSON lets a client send a list anywhere. Nothing that reaches a
            // placeholder is meant to be one, and PDO would warn and store
            // the word "Array".
            if (is_array($value)) {
                throw Util::badRequest('A list was sent where a single value was expected.');
            }

            if (is_bool($value)) {
                $params[$key] = $value ? 1 : 0;
            } elseif ($value instanceof \DateTimeInterface) {
                $params[$key] = $value->format('Y-m-d H:i:s');
            }
        }
        return $params;
    }

    // -----------------------------------------------------------------------
    // Transactions
    //
    // Nesting is tracked with a counter rather than SAVEPOINTs: the places
    // that nest here only ever want "join the outer transaction", and real
    // savepoints would imply partial rollback semantics nothing relies on.
    // -----------------------------------------------------------------------

    public static function transaction(callable $fn): mixed
    {
        $pdo = self::connection();

        if (self::$transactionDepth > 0) {
            self::$transactionDepth++;
            try {
                $result = $fn($pdo);
                self::$transactionDepth--;
                return $result;
            } catch (\Throwable $e) {
                self::$transactionDepth--;
                throw $e;
            }
        }

        $pdo->beginTransaction();
        self::$transactionDepth = 1;

        try {
            $result = $fn($pdo);
            $pdo->commit();
            self::$transactionDepth = 0;
            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                try {
                    $pdo->rollBack();
                } catch (\Throwable) {
                    // Rollback failure is secondary to the original error.
                }
            }
            self::$transactionDepth = 0;
            throw $e;
        }
    }

    // -----------------------------------------------------------------------
    // Schema loading
    // -----------------------------------------------------------------------

    /**
     * Split schema.sql into individual statements.
     *
     * The file is authored so this naive split is safe: every statement ends
     * with ";" at end of line and no string literal contains a semicolon.
     * Comment lines are stripped first so a "--" line containing one cannot
     * split a statement.
     */
    public static function schemaStatements(): array
    {
        $path = APP_ROOT . '/schema.sql';
        $raw  = file_get_contents($path);

        if ($raw === false) {
            throw new \RuntimeException("Could not read the schema at {$path}.");
        }

        $withoutComments = implode("\n", array_filter(
            explode("\n", $raw),
            static fn (string $line): bool => !str_starts_with(trim($line), '--')
        ));

        return array_values(array_filter(
            array_map('trim', explode(';', $withoutComments)),
            static fn (string $s): bool => $s !== ''
        ));
    }

    /**
     * Map driver errors onto messages an administrator can act on. Raw PDO
     * text ("SQLSTATE[HY000] [1045]") sends people to the wrong place.
     */
    public static function describeError(\Throwable $e): string
    {
        $message = $e->getMessage();
        $code    = $e instanceof PDOException ? ($e->errorInfo[1] ?? null) : null;

        return match (true) {
            $code === 1045 || str_contains($message, 'Access denied for user')
                => 'The database rejected that username or password.',
            $code === 1044 || str_contains($message, 'Access denied for user') && str_contains($message, 'to database')
                => 'That user exists but has no rights on this database. Grant it ALL PRIVILEGES, then try again.',
            $code === 1049 || str_contains($message, 'Unknown database')
                => 'That database does not exist. Create it first, then enter its exact name. '
                 . 'Note that some control panels prefix the name you typed with your account name.',
            $code === 1142 || str_contains($message, 'command denied')
                => 'The user cannot create tables in this database. Grant it ALL PRIVILEGES and try again.',
            str_contains($message, 'Connection refused')
                => 'Could not reach the database server. Check the host and port, and that MySQL is running.',
            str_contains($message, 'getaddrinfo') || str_contains($message, 'Name or service not known')
                => 'The database host name could not be resolved. On cPanel this is usually "localhost".',
            str_contains($message, 'timed out')
                => 'Timed out connecting to the database. If the host is remote, its firewall may be blocking this server.',
            default => $message,
        };
    }

    /**
     * What to tell the client when a write was refused because of the value.
     *
     * Validation is the first line of defence and most fields have it, but the
     * schema is the last one, and when it is the schema that says no the
     * request is at fault rather than the server: a 400 naming the field, not
     * a 500 and a reference number. Returns null for anything else, which
     * really is a fault and goes to the log.
     *
     * @return array{status:int, code:string, message:string, details:?array}|null
     */
    public static function clientError(\Throwable $e): ?array
    {
        if (!$e instanceof PDOException) {
            return null;
        }

        $field = preg_match("/column [`']?(?:[^`']+[`']?\\.[`']?)*([a-z_]+)[`']?/i", $e->getMessage(), $m)
            ? $m[1] : null;
        $details = $field !== null ? ['field' => $field] : null;

        return match ($e->errorInfo[1] ?? null) {
            1048 => ['status' => 400, 'code' => 'bad_request', 'details' => $details,
                     'message' => ($field !== null ? "\"{$field}\"" : 'A required value') . ' cannot be empty.'],
            1452 => ['status' => 400, 'code' => 'bad_request', 'details' => null,
                     'message' => 'That refers to something that does not exist.'],
            1264, 1265, 1292, 1366, 1406 => ['status' => 400, 'code' => 'bad_request', 'details' => $details,
                     'message' => 'That value is not valid here'
                                  . ($field !== null ? " (\"{$field}\")" : '') . '.'],
            1205, 1213 => ['status' => 503, 'code' => 'busy', 'details' => null,
                     'message' => 'Someone else was changing the same record. Nothing was saved. Try again.'],
            default => null,
        };
    }

    /** True when a duplicate-key violation. */
    public static function isDuplicate(\Throwable $e): bool
    {
        return $e instanceof PDOException && ($e->errorInfo[1] ?? null) === 1062;
    }
}
