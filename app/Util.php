<?php
/**
 * Shared helpers: input coercion, pagination, references, dates, output.
 */

declare(strict_types=1);

namespace Loaner;

final class Util
{
    // -----------------------------------------------------------------------
    // Error constructors
    // -----------------------------------------------------------------------

    public static function badRequest(string $message, ?array $details = null): HttpError
    {
        return new HttpError(400, 'bad_request', $message, $details);
    }

    public static function unauthorized(string $message = 'Authentication required.'): HttpError
    {
        return new HttpError(401, 'unauthorized', $message);
    }

    public static function forbidden(string $message = 'You do not have permission to do that.'): HttpError
    {
        return new HttpError(403, 'forbidden', $message);
    }

    public static function notFound(string $message = 'Not found.'): HttpError
    {
        return new HttpError(404, 'not_found', $message);
    }

    public static function conflict(string $message, ?array $details = null): HttpError
    {
        return new HttpError(409, 'conflict', $message, $details);
    }

    public static function unprocessable(string $message, ?array $details = null): HttpError
    {
        return new HttpError(422, 'unprocessable', $message, $details);
    }

    // -----------------------------------------------------------------------
    // Input coercion
    //
    // Each of these treats "missing" and "empty string" as null rather than as
    // 0 / NaN / "undefined", because HTML form fields submit empty strings and
    // those must not become real values in the database.
    // -----------------------------------------------------------------------

    /**
     * A string that must fit, or a 400 saying so.
     *
     * `str()` truncates, which is right for free text where losing the tail of
     * a note is better than refusing the whole form. It is wrong for anything
     * matched or printed: an asset tag silently cut to 64 characters no longer
     * matches the label on the device, and the spreadsheet importer matches on
     * asset tags, so the next import creates a duplicate instead of updating
     * the device. Identifiers go through here.
     */
    public static function boundedStr(mixed $value, string $field, int $max): ?string
    {
        $s = self::str($value, PHP_INT_MAX);

        if ($s !== null && mb_strlen($s) > $max) {
            throw self::badRequest(
                sprintf(
                    '"%s" is %d characters, and the limit is %d. Shorten it rather than letting it be '
                    . 'cut off, so it still matches what is printed on the device.',
                    $field, mb_strlen($s), $max,
                ),
                ['field' => $field, 'max_length' => $max, 'length' => mb_strlen($s)],
            );
        }

        return $s;
    }

    public static function str(mixed $value, int $max = 65535, bool $trim = true): ?string
    {
        if ($value === null || is_array($value) || is_object($value)) {
            return null;
        }

        $s = is_bool($value) ? ($value ? '1' : '0') : (string) $value;
        if ($trim) {
            $s = trim($s);
        }
        if ($s === '') {
            return null;
        }

        return mb_substr($s, 0, $max);
    }

    public static function requiredStr(mixed $value, string $field, int $max = 65535): string
    {
        $s = self::str($value, $max);
        if ($s === null) {
            throw self::badRequest("\"{$field}\" is required.", ['field' => $field]);
        }
        return $s;
    }

    public static function int(mixed $value, string $field, ?int $min = null, ?int $max = null): ?int
    {
        if ($value === null || $value === '' || is_array($value)) {
            return null;
        }

        if (!is_numeric($value) || (float) $value !== floor((float) $value)) {
            throw self::badRequest("\"{$field}\" must be a whole number.", ['field' => $field]);
        }

        $n = (int) $value;

        if ($min !== null && $n < $min) {
            throw self::badRequest("\"{$field}\" must be at least {$min}.", ['field' => $field]);
        }
        if ($max !== null && $n > $max) {
            throw self::badRequest("\"{$field}\" must be at most {$max}.", ['field' => $field]);
        }

        return $n;
    }

    public static function decimal(mixed $value, string $field): ?float
    {
        if ($value === null || $value === '' || is_array($value)) {
            return null;
        }
        if (!is_numeric($value)) {
            throw self::badRequest("\"{$field}\" must be a number.", ['field' => $field]);
        }
        return (float) $value;
    }

    public static function bool(mixed $value, bool $fallback = false): bool
    {
        if ($value === null || $value === '') {
            return $fallback;
        }
        if (is_bool($value)) {
            return $value;
        }
        return in_array(strtolower((string) $value), ['1', 'true', 'yes', 'on'], true);
    }

    /**
     * @param list<string> $allowed
     */
    public static function oneOf(
        mixed $value,
        array $allowed,
        string $field,
        bool $required = false,
        ?string $fallback = null,
    ): ?string {
        $s = self::str($value);

        if ($s === null) {
            if ($required) {
                throw self::badRequest("\"{$field}\" is required.", ['field' => $field]);
            }
            return $fallback;
        }

        if (!in_array($s, $allowed, true)) {
            throw self::badRequest(
                "\"{$field}\" must be one of: " . implode(', ', $allowed) . '.',
                ['field' => $field, 'allowed' => $allowed],
            );
        }

        return $s;
    }

    /** Accepts YYYY-MM-DD. Returns it unchanged, or null; rejects impossible dates. */
    public static function dateOnly(mixed $value, string $field): ?string
    {
        $s = self::str($value);
        if ($s === null) {
            return null;
        }

        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $s)) {
            throw self::badRequest("\"{$field}\" must be a date in YYYY-MM-DD format.", ['field' => $field]);
        }

        [$y, $m, $d] = array_map('intval', explode('-', $s));
        if (!checkdate($m, $d, $y)) {
            throw self::badRequest("\"{$field}\" is not a real date.", ['field' => $field]);
        }

        return $s;
    }

    public static function dateTime(mixed $value, string $field): ?\DateTimeImmutable
    {
        $s = self::str($value);
        if ($s === null) {
            return null;
        }

        try {
            return new \DateTimeImmutable($s);
        } catch (\Throwable) {
            throw self::badRequest("\"{$field}\" is not a valid date and time.", ['field' => $field]);
        }
    }

    public static function email(mixed $value, string $field, bool $required = false): ?string
    {
        $s = self::str($value, 190);

        if ($s === null) {
            if ($required) {
                throw self::badRequest("\"{$field}\" is required.", ['field' => $field]);
            }
            return null;
        }

        if (!filter_var($s, FILTER_VALIDATE_EMAIL)) {
            throw self::badRequest("\"{$field}\" is not a valid email address.", ['field' => $field]);
        }

        return strtolower($s);
    }

    // -----------------------------------------------------------------------
    // Pagination
    // -----------------------------------------------------------------------

    public const MAX_PAGE_SIZE     = 200;
    public const DEFAULT_PAGE_SIZE = 50;

    public static function pagination(array $query): array
    {
        $page     = max(1, (int) ($query['page'] ?? 1));
        $requested = (int) ($query['per_page'] ?? self::DEFAULT_PAGE_SIZE);
        $perPage  = min(self::MAX_PAGE_SIZE, max(1, $requested ?: self::DEFAULT_PAGE_SIZE));

        // "limit" is the same number under the name the query builders use, so
        // a route can pass this array straight through without restating it.
        return [
            'page'    => $page,
            'perPage' => $perPage,
            'limit'   => $perPage,
            'offset'  => ($page - 1) * $perPage,
        ];
    }

    /**
     * A list that is not paginated, in the same envelope as one that is.
     *
     * Every collection this API returns looks the same from the outside:
     * `{data: [...], meta: {...}}`. A client should not have to remember which
     * endpoints happen to paginate, and adding pagination to one later must not
     * be a breaking change.
     */
    public static function collection(array $items, array $extraMeta = []): array
    {
        return [
            'data' => $items,
            'meta' => ['total' => count($items)] + $extraMeta,
        ];
    }

    public static function paged(array $items, int $total, array $pagination): array
    {
        return [
            'data' => $items,
            'meta' => [
                'page'        => $pagination['page'],
                'per_page'    => $pagination['perPage'],
                'total'       => $total,
                'total_pages' => max(1, (int) ceil($total / $pagination['perPage'])),
            ],
        ];
    }

    /**
     * Build "ORDER BY" from user input without letting user text into SQL.
     * Only column names present in $allowed can ever reach the query.
     */
    public static function orderBy(?string $sort, array $allowed, string $fallback): string
    {
        $raw = self::str($sort);
        if ($raw === null) {
            return $fallback;
        }

        $desc = str_starts_with($raw, '-');
        $key  = $desc ? substr($raw, 1) : $raw;

        if (!isset($allowed[$key])) {
            return $fallback;
        }

        return $allowed[$key] . ($desc ? ' DESC' : ' ASC');
    }

    // -----------------------------------------------------------------------
    // Identifiers
    // -----------------------------------------------------------------------

    /**
     * Alphabet for barcode values and pairing codes.
     *
     * Excludes 0/O and 1/I/L — the pairs people transpose when reading a code
     * off a label aloud or typing one in because the scanner failed.
     */
    public const UNAMBIGUOUS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

    /**
     * Random string from the unambiguous alphabet.
     *
     * Rejection sampling rather than modulo: 256 is not a multiple of 31, so
     * the modulo approach would make the first eight characters ~3% more
     * likely than the rest. Harmless for a pairing code, but these are also
     * device barcodes, where uniformity is what keeps the collision maths
     * honest.
     */
    public static function randomCode(int $length = 6): string
    {
        $size  = strlen(self::UNAMBIGUOUS);
        $limit = intdiv(256, $size) * $size; // 248 for a 31-character alphabet
        $out   = '';

        while (strlen($out) < $length) {
            foreach (str_split(random_bytes($length * 2)) as $char) {
                $byte = ord($char);
                if ($byte >= $limit) {
                    continue; // Discard the biased tail.
                }
                $out .= self::UNAMBIGUOUS[$byte % $size];
                if (strlen($out) === $length) {
                    break;
                }
            }
        }

        return $out;
    }

    public static function randomToken(int $bytes = 32): string
    {
        return bin2hex(random_bytes($bytes));
    }

    public static function sha256(string $value): string
    {
        return hash('sha256', $value);
    }

    /**
     * Human-facing reference like "LN-2026-4F7K2Q". Uniqueness is guaranteed
     * by a UNIQUE index plus retry at the call site, not by hoping six random
     * characters never collide.
     */
    public static function makeReference(string $prefix): string
    {
        return $prefix . '-' . date('Y') . '-' . self::randomCode(6);
    }

    // -----------------------------------------------------------------------
    // Dates
    // -----------------------------------------------------------------------

    public static function mysqlDateTime(\DateTimeInterface|string|null $date): ?string
    {
        if ($date === null) {
            return null;
        }
        if (is_string($date)) {
            if (trim($date) === '') {
                return null;
            }
            try {
                $date = new \DateTimeImmutable($date);
            } catch (\Throwable) {
                return null;
            }
        }
        return $date->format('Y-m-d H:i:s');
    }

    public static function addDays(\DateTimeInterface $date, int $days): \DateTimeImmutable
    {
        $immutable = \DateTimeImmutable::createFromInterface($date);
        return $days >= 0
            ? $immutable->add(new \DateInterval('P' . $days . 'D'))
            : $immutable->sub(new \DateInterval('P' . abs($days) . 'D'));
    }

    public static function daysBetween(string|\DateTimeInterface $a, string|\DateTimeInterface $b): int
    {
        $from = $a instanceof \DateTimeInterface ? $a : new \DateTimeImmutable($a);
        $to   = $b instanceof \DateTimeInterface ? $b : new \DateTimeImmutable($b);
        return (int) round(($to->getTimestamp() - $from->getTimestamp()) / 86400);
    }

    /**
     * A loan is overdue when it is still active and its due date has passed.
     * Derived rather than stored, so a row can never sit at "active" while
     * being months overdue because a nightly job failed to run.
     */
    public static function isOverdue(array $loan, ?\DateTimeInterface $now = null): bool
    {
        if (($loan['status'] ?? '') !== 'active' || empty($loan['due_at'])) {
            return false;
        }

        $now = $now ?? new \DateTimeImmutable();
        return strtotime((string) $loan['due_at']) < $now->getTimestamp();
    }

    // -----------------------------------------------------------------------
    // Output
    // -----------------------------------------------------------------------

    public static function escapeHtml(mixed $value): string
    {
        if ($value === null) {
            return '';
        }
        return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    /**
     * Escape a value for a CSV cell, per RFC 4180 — and defuse it for Excel.
     *
     * A cell that begins with =, +, -, @ or a tab is a formula to a
     * spreadsheet, not text. The exports here contain names and notes typed
     * by anyone who can edit a client or a device, and a client whose last
     * name was entered as =HYPERLINK("http://…") would run in the spreadsheet
     * of whoever opened the export. Prefixing an apostrophe is the standard
     * remedy: Excel, Sheets and LibreOffice all treat it as "this is text" and
     * do not display it.
     *
     * Numbers are left alone. A purchase cost of -5.00 or a date are not
     * formulas, and quoting them would make the file worse for the importer
     * that reads these exports back.
     */
    public static function csvCell(mixed $value): string
    {
        if ($value === null) {
            return '';
        }

        $s = is_bool($value) ? ($value ? '1' : '0') : (string) $value;

        if ($s !== '' && !is_numeric($s) && preg_match('/^[=+\-@\t\r]/', $s)) {
            $s = "'" . $s;
        }

        if (preg_match('/["\r\n,]/', $s)) {
            return '"' . str_replace('"', '""', $s) . '"';
        }

        return $s;
    }

    public static function toCsv(array $headers, array $rows): string
    {
        $lines = [implode(',', array_map([self::class, 'csvCell'], $headers))];

        foreach ($rows as $row) {
            $lines[] = implode(',', array_map([self::class, 'csvCell'], $row));
        }

        return implode("\r\n", $lines) . "\r\n";
    }
}
