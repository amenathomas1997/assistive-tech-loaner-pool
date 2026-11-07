<?php
/**
 * CSV / TSV parsing for spreadsheet ingest.
 *
 * Written by hand rather than using fgetcsv, because the input is "whatever
 * Excel produced" and the failure modes that matter are the ones a generic
 * parser hides: a UTF-8 BOM Excel always writes, CRLF endings, quoted fields
 * containing commas and newlines, and duplicate header names.
 *
 * Implements RFC 4180 plus the two extensions Excel actually emits:
 * semicolon or tab delimiters (locale-dependent exports), and a leading BOM.
 */

declare(strict_types=1);

namespace Loaner;

final class Csv
{
    private const BOM = "\xEF\xBB\xBF";

    /**
     * Guess the delimiter by counting candidates outside quoted regions in the
     * first few lines. Counting across the whole file gets this wrong the
     * moment a description field contains a comma.
     */
    public static function detectDelimiter(string $text): string
    {
        $sample    = substr($text, 0, 64 * 1024);
        $best      = ',';
        $bestScore = -1;

        foreach ([',', ';', "\t", '|'] as $delimiter) {
            $inQuotes = false;
            $count    = 0;
            $lines    = 0;
            $length   = strlen($sample);

            for ($i = 0; $i < $length && $lines < 5; $i++) {
                $char = $sample[$i];

                if ($char === '"') {
                    if ($inQuotes && ($sample[$i + 1] ?? '') === '"') {
                        $i++;
                    } else {
                        $inQuotes = !$inQuotes;
                    }
                } elseif (!$inQuotes && $char === $delimiter) {
                    $count++;
                } elseif (!$inQuotes && $char === "\n") {
                    $lines++;
                }
            }

            if ($count > $bestScore) {
                $bestScore = $count;
                $best      = $delimiter;
            }
        }

        return $bestScore > 0 ? $best : ',';
    }

    /**
     * Parse CSV text into rows of strings.
     *
     * Throws on an unterminated quote rather than silently swallowing the tail
     * of the file, which is the classic way a broken import loses half its
     * rows without anyone noticing.
     *
     * @return list<list<string>>
     */
    public static function parse(string $text, ?string $delimiter = null): array
    {
        if (str_starts_with($text, self::BOM)) {
            $text = substr($text, strlen(self::BOM));
        }

        if (trim($text) === '') {
            return [];
        }

        $sep = $delimiter ?? self::detectDelimiter($text);

        $rows           = [];
        $row            = [];
        $field          = '';
        $inQuotes       = false;
        $fieldWasQuoted = false;
        $line           = 1;
        $length         = strlen($text);

        $endField = static function () use (&$row, &$field, &$fieldWasQuoted): void {
            // Only trim unquoted fields: a quoted "  x  " asked for those spaces.
            $row[]          = $fieldWasQuoted ? $field : trim($field);
            $field          = '';
            $fieldWasQuoted = false;
        };

        $endRow = static function () use (&$rows, &$row, $endField): void {
            $endField();
            // Skip rows that are entirely empty (trailing newlines, separators).
            if (array_filter($row, static fn (string $c): bool => $c !== '') !== []) {
                $rows[] = $row;
            }
            $row = [];
        };

        for ($i = 0; $i < $length; $i++) {
            $char = $text[$i];

            if ($inQuotes) {
                if ($char === '"') {
                    if (($text[$i + 1] ?? '') === '"') {
                        $field .= '"';
                        $i++;
                    } else {
                        $inQuotes = false;
                    }
                } else {
                    if ($char === "\n") {
                        $line++;
                    }
                    $field .= $char;
                }
                continue;
            }

            if ($char === '"') {
                $inQuotes       = true;
                $fieldWasQuoted = true;
                continue;
            }
            if ($char === $sep) {
                $endField();
                continue;
            }
            if ($char === "\r") {
                // Handled by the \n that follows; a lone \r (old Mac) ends a row.
                if (($text[$i + 1] ?? '') !== "\n") {
                    $endRow();
                    $line++;
                }
                continue;
            }
            if ($char === "\n") {
                $endRow();
                $line++;
                continue;
            }

            $field .= $char;
        }

        if ($inQuotes) {
            throw Util::badRequest(
                "The file has an unclosed quotation mark starting somewhere before line {$line}. "
                . 'Re-export it from Excel as "CSV UTF-8" and try again.'
            );
        }

        // Flush the final line (files often lack a trailing newline).
        if ($field !== '' || $row !== []) {
            $endRow();
        }

        return $rows;
    }

    /**
     * Turn raw rows into associative records keyed by header.
     * Duplicate headers get suffixed rather than silently overwriting.
     *
     * @return array{headers: list<string>, records: list<array<string,mixed>>, rawHeaders: list<string>}
     */
    public static function toRecords(string $text, ?string $delimiter = null): array
    {
        $rows = self::parse($text, $delimiter);

        if ($rows === []) {
            throw Util::badRequest('That file contains no rows.');
        }

        $rawHeaders = array_shift($rows);
        $seen       = [];
        $headers    = [];

        foreach ($rawHeaders as $header) {
            $base  = self::normaliseHeader($header) ?: 'column';
            $count = $seen[$base] ?? 0;
            $seen[$base] = $count + 1;
            $headers[]   = $count === 0 ? $base : $base . '_' . ($count + 1);
        }

        $records = [];
        foreach ($rows as $index => $values) {
            $record = [];
            foreach ($headers as $column => $name) {
                $record[$name] = $values[$column] ?? '';
            }
            // Line number in the original file, for errors a user can act on.
            $record['__line'] = $index + 2;
            $records[] = $record;
        }

        return ['headers' => $headers, 'records' => $records, 'rawHeaders' => $rawHeaders];
    }

    /** "Serial Number" / "serial_number" / "SERIAL-NUMBER" all become serial_number. */
    public static function normaliseHeader(string $header): string
    {
        $value = str_replace(self::BOM, '', $header);
        $value = strtolower(trim($value));
        $value = preg_replace('/[^a-z0-9]+/', '_', $value) ?? '';

        return trim($value, '_');
    }

    /**
     * Device fields that can be populated from a spreadsheet, with the header
     * spellings seen in the wild. Anything not listed is preserved verbatim in
     * the device's custom_fields rather than discarded — an inventory sheet's
     * odd columns are often the ones a given office cares most about.
     */
    public const DEVICE_ALIASES = [
        'barcode'          => ['barcode', 'bar_code', 'barcode_id', 'tag_barcode', 'scan_code'],
        'asset_tag'        => ['asset_tag', 'asset', 'asset_id', 'asset_number', 'tag', 'inventory_number', 'inventory_id'],
        'serial_number'    => ['serial_number', 'serial', 'serial_no', 'sn', 'service_tag'],
        'name'             => ['name', 'device', 'device_name', 'item', 'item_name', 'title'],
        'category'         => ['category', 'type', 'device_type', 'equipment_type', 'class'],
        'manufacturer'     => ['manufacturer', 'make', 'brand', 'vendor'],
        'model'            => ['model', 'model_number', 'model_no'],
        'description'      => ['description', 'details', 'long_description'],
        'status'           => ['status', 'state', 'availability'],
        'condition_note'   => ['condition', 'condition_note', 'device_condition'],
        'location'         => ['location', 'current_location', 'storage_location', 'shelf', 'room'],
        'home_location'    => ['home_location', 'default_location', 'assigned_location'],
        'purchase_date'    => ['purchase_date', 'purchased', 'date_purchased', 'acquired', 'acquisition_date'],
        'purchase_cost'    => ['purchase_cost', 'cost', 'price', 'value', 'purchase_price'],
        'warranty_expires' => ['warranty_expires', 'warranty', 'warranty_end', 'warranty_expiration'],
        'funding_source'   => ['funding_source', 'funding', 'grant', 'fund'],
        'notes'            => ['notes', 'note', 'comments', 'remarks'],
        'program'          => ['program', 'owner_program', 'activity', 'service', 'program_name'],
    ];

    /**
     * A starter spreadsheet.
     *
     * Includes two filled example rows rather than headers alone: the commonest
     * import failure is a date or cost written in a format nobody expected, and
     * an example of each is worth more than a paragraph of instructions.
     */
    public static function template(): string
    {
        $headers = [
            'barcode', 'asset_tag', 'serial_number', 'name', 'category', 'manufacturer', 'model',
            'description', 'status', 'condition', 'location', 'home_location', 'program',
            'purchase_date', 'purchase_cost', 'warranty_expires', 'funding_source', 'notes',
        ];

        $rows = [
            [
                '', 'AT-0001', 'SN12345678', 'Dragon Professional headset', 'Speech recognition',
                'Nuance', 'USB-4100', 'Noise-cancelling headset for dictation', 'available',
                'Good — foam replaced', 'Main store', 'Main store', 'LEAP',
                '2025-04-18', '129.99', '2028-04-18', 'Title I', 'Comes with carry case',
            ],
            [
                '', 'AT-0002', '', 'Portable video magnifier', 'Low vision',
                'HumanWare', 'Explore 8', '8-inch handheld magnifier', 'available',
                'New', 'Low vision cabinet', 'Low vision cabinet', 'Retreat',
                '2025-09-02', '1295.00', '2027-09-02', 'State match', '',
            ],
        ];

        // Leaving the barcode column empty is the normal case: the importer
        // allocates one per device and the labels are printed afterwards.
        return Util::toCsv($headers, $rows);
    }

    /**
     * Propose a header -> device field mapping. Returned to the browser so the
     * user can correct it before committing; never applied blind.
     */
    public static function suggestMapping(array $headers): array
    {
        $mapping = [];
        $used    = [];

        foreach (self::DEVICE_ALIASES as $field => $aliases) {
            foreach ($headers as $header) {
                if (in_array($header, $aliases, true) && !in_array($header, $used, true)) {
                    $mapping[$header] = $field;
                    $used[]           = $header;
                    break;
                }
            }
        }

        $unmapped = array_values(array_filter(
            $headers,
            static fn (string $h): bool => !in_array($h, $used, true) && $h !== '__line',
        ));

        return ['mapping' => $mapping, 'unmapped' => $unmapped];
    }

    /** Normalise the many ways a spreadsheet writes a status into our enum. */
    public static function normaliseStatus(mixed $value): ?string
    {
        $s = strtolower(trim((string) $value));
        if ($s === '') {
            return null;
        }

        $table = [
            'available' => 'available', 'in' => 'available', 'in stock' => 'available',
            'instock' => 'available', 'in_stock' => 'available', 'ready' => 'available',
            'free' => 'available', 'unassigned' => 'available',
            'checked_out' => 'checked_out', 'checked out' => 'checked_out', 'out' => 'checked_out',
            'loaned' => 'checked_out', 'on_loan' => 'checked_out', 'on loan' => 'checked_out',
            'assigned' => 'checked_out',
            'reserved' => 'reserved', 'hold' => 'reserved', 'on_hold' => 'reserved',
            'maintenance' => 'maintenance', 'repair' => 'maintenance', 'in repair' => 'maintenance',
            'broken' => 'maintenance', 'service' => 'maintenance', 'servicing' => 'maintenance',
            'retired' => 'retired', 'disposed' => 'retired', 'decommissioned' => 'retired',
            'surplus' => 'retired',
            'lost' => 'lost', 'missing' => 'lost', 'stolen' => 'lost',
        ];

        return $table[$s] ?? null;
    }

    /**
     * Parse the date formats spreadsheets emit into YYYY-MM-DD.
     *
     * Ambiguous DD/MM vs MM/DD is resolved as MM/DD (US) unless the first
     * number exceeds 12. That is a genuine limitation, surfaced in the import
     * UI rather than hidden: an ISO-formatted column is always unambiguous.
     */
    public static function parseDate(mixed $value): ?string
    {
        $s = trim((string) $value);
        if ($s === '') {
            return null;
        }

        if (preg_match('/^(\d{4})-(\d{1,2})-(\d{1,2})/', $s, $m)) {
            return self::formatDate((int) $m[1], (int) $m[2], (int) $m[3]);
        }

        // Excel serial number (days since 1899-12-30).
        if (preg_match('/^\d{5}$/', $s)) {
            $serial = (int) $s;
            if ($serial > 20000 && $serial < 60000) {
                $date = (new \DateTimeImmutable('1899-12-30'))->add(new \DateInterval("P{$serial}D"));
                return $date->format('Y-m-d');
            }
        }

        if (preg_match('#^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$#', $s, $m)) {
            $a    = (int) $m[1];
            $b    = (int) $m[2];
            $year = (int) $m[3];

            if ($year < 100) {
                $year += $year < 70 ? 2000 : 1900;
            }

            // If the first component cannot be a month, it must be the day.
            $month = $a > 12 ? $b : $a;
            $day   = $a > 12 ? $a : $b;

            if ($month >= 1 && $month <= 12 && $day >= 1 && $day <= 31) {
                return self::formatDate($year, $month, $day);
            }
        }

        // Fall back for things like "12 March 2024".
        try {
            return (new \DateTimeImmutable($s))->format('Y-m-d');
        } catch (\Throwable) {
            return null;
        }
    }

    private static function formatDate(int $year, int $month, int $day): ?string
    {
        // Reject dates that would roll over, e.g. 2024-02-31.
        if (!checkdate($month, $day, $year)) {
            return null;
        }

        return sprintf('%04d-%02d-%02d', $year, $month, $day);
    }

    /** Strip currency symbols and thousands separators. */
    public static function parseMoney(mixed $value): ?float
    {
        $s = preg_replace('/[^0-9.\-]/', '', (string) $value) ?? '';

        if ($s === '' || $s === '-') {
            return null;
        }

        return is_numeric($s) ? (float) $s : null;
    }
}
