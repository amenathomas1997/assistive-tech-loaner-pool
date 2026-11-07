<?php
/**
 * Barcode value allocation and label rendering.
 *
 * Every device gets a `barcode` string at creation or import. That string is
 * what a scanner reads, regardless of symbology — so an organisation can
 * switch from QR to Code 128 and reprint labels without any device's identity
 * changing.
 *
 *   qr      — 2D. Scannable by phone cameras and 2D imagers. NOT readable by
 *             1D laser scanners, which is why the choice is per-organisation.
 *   code128 — 1D, dense, alphanumeric. Readable by essentially every scanner.
 *   code39  — 1D, less dense, but readable by very old hardware.
 *
 * All three encoders are implemented here rather than pulled in as a
 * dependency, because "upload the files" has to be the whole deployment story.
 * They are verified by scripts/verify-barcode.php: the 1D tables against
 * properties of their specifications, and QR by round-tripping every symbol
 * through a real decoder.
 */

declare(strict_types=1);

namespace Loaner;

final class Barcode
{
    public const SYMBOLOGIES = ['qr', 'code128', 'code39'];

    // -----------------------------------------------------------------------
    // Value allocation
    // -----------------------------------------------------------------------

    /**
     * Barcode values look like "LP-7K3F9Q2M".
     *
     * Deliberately not sequential: sequential asset codes leak inventory size,
     * and a mis-keyed digit in a sequential scheme silently resolves to a
     * real, wrong device. With a random alphabet drawn from an unambiguous
     * character set, a typo almost always resolves to nothing at all.
     */
    public static function generateValue(string $prefix = 'LP', int $length = 8): string
    {
        $clean = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $prefix) ?? '');
        $clean = substr($clean, 0, 8) ?: 'LP';

        return $clean . '-' . Util::randomCode($length);
    }

    /**
     * Allocate a value that is not already taken.
     *
     * $exists is a predicate so this works both inside a transaction and out.
     * Reaching the attempt limit means either a catastrophically bad RNG or a
     * barcode table so full that random allocation no longer terminates —
     * both need a human, not a retry.
     */
    public static function allocate(callable $exists, string $prefix = 'LP', int $maxAttempts = 12): string
    {
        for ($attempt = 0; $attempt < $maxAttempts; $attempt++) {
            $candidate = self::generateValue($prefix);
            if (!$exists($candidate)) {
                return $candidate;
            }
        }

        throw new \RuntimeException(
            "Could not allocate a unique barcode after {$maxAttempts} attempts. "
            . 'Check the devices table for duplicate or corrupted barcode values.'
        );
    }

    /**
     * Scanners and humans introduce predictable noise: keyboard-wedge scanners
     * append Enter or Tab, some prepend an AIM symbology identifier, and
     * people type lowercase. Normalise before lookup so a good scan is never
     * a miss.
     */
    public static function normaliseScan(mixed $raw): ?string
    {
        if ($raw === null || is_array($raw)) {
            return null;
        }

        $value = (string) $raw;
        $value = preg_replace('/[\r\n\t]+$/', '', $value) ?? $value;   // wedge terminators
        $value = preg_replace('/^\][A-Za-z]\d/', '', $value) ?? $value; // AIM identifier
        $value = trim($value);

        if ($value === '') {
            return null;
        }

        // Code 39 transmits its own start/stop asterisks on some readers.
        if (strlen($value) > 2 && str_starts_with($value, '*') && str_ends_with($value, '*')) {
            $value = substr($value, 1, -1);
        }

        return strtoupper($value);
    }

    // -----------------------------------------------------------------------
    // Code 128 (subset B)
    // -----------------------------------------------------------------------

    /**
     * Element widths for Code 128 values 0-106. Each string is
     * bar,space,bar,space,bar,space in modules. Values 0-105 are 11 modules
     * wide; 106 (stop) is 13 and has a trailing bar.
     */
    private const CODE128 = [
        '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
        '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
        '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
        '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
        '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
        '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
        '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
        '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
        '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
        '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
        '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
        '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
        '114311', '411113', '411311', '113141', '114131', '311141', '411131',
        '211412', // 103 Start A
        '211214', // 104 Start B
        '211232', // 105 Start C
        '2331112', // 106 Stop
    ];

    private const CODE128_START_B = 104;
    private const CODE128_STOP    = 106;

    /** Exported so the verification script can assert the table's integrity. */
    public static function code128Patterns(): array
    {
        return self::CODE128;
    }

    /**
     * Encode as Code 128 subset B. Subset B covers ASCII 32-126, which is
     * everything a generated barcode value can contain.
     *
     * @return array{codes: list<int>, checkDigit: int, widths: list<int>}
     */
    public static function code128Encode(string $text): array
    {
        $length = strlen($text);

        for ($i = 0; $i < $length; $i++) {
            $code = ord($text[$i]);
            if ($code < 32 || $code > 126) {
                throw Util::badRequest(
                    "Code 128 subset B cannot encode the character \"{$text[$i]}\". "
                    . 'Barcode values must use printable ASCII only.'
                );
            }
        }

        $codes = [self::CODE128_START_B];
        for ($i = 0; $i < $length; $i++) {
            $codes[] = ord($text[$i]) - 32;
        }

        // Checksum: start value + sum(position * value), modulo 103.
        $checksum = self::CODE128_START_B;
        for ($i = 1, $n = count($codes); $i < $n; $i++) {
            $checksum += $codes[$i] * $i;
        }
        $checkDigit = $checksum % 103;

        $codes[] = $checkDigit;
        $codes[] = self::CODE128_STOP;

        $widths = [];
        foreach ($codes as $code) {
            foreach (str_split(self::CODE128[$code]) as $digit) {
                $widths[] = (int) $digit;
            }
        }

        return ['codes' => $codes, 'checkDigit' => $checkDigit, 'widths' => $widths];
    }

    // -----------------------------------------------------------------------
    // Code 39
    // -----------------------------------------------------------------------

    /**
     * Each character is 9 elements (5 bars, 4 spaces), 3 of which are wide.
     * "n" = narrow, "w" = wide, alternating bar/space starting with a bar.
     */
    private const CODE39 = [
        '0' => 'nnnwwnwnn', '1' => 'wnnwnnnnw', '2' => 'nnwwnnnnw', '3' => 'wnwwnnnnn',
        '4' => 'nnnwwnnnw', '5' => 'wnnwwnnnn', '6' => 'nnwwwnnnn', '7' => 'nnnwnnwnw',
        '8' => 'wnnwnnwnn', '9' => 'nnwwnnwnn', 'A' => 'wnnnnwnnw', 'B' => 'nnwnnwnnw',
        'C' => 'wnwnnwnnn', 'D' => 'nnnnwwnnw', 'E' => 'wnnnwwnnn', 'F' => 'nnwnwwnnn',
        'G' => 'nnnnnwwnw', 'H' => 'wnnnnwwnn', 'I' => 'nnwnnwwnn', 'J' => 'nnnnwwwnn',
        'K' => 'wnnnnnnww', 'L' => 'nnwnnnnww', 'M' => 'wnwnnnnwn', 'N' => 'nnnnwnnww',
        'O' => 'wnnnwnnwn', 'P' => 'nnwnwnnwn', 'Q' => 'nnnnnnwww', 'R' => 'wnnnnnwwn',
        'S' => 'nnwnnnwwn', 'T' => 'nnnnwnwwn', 'U' => 'wwnnnnnnw', 'V' => 'nwwnnnnnw',
        'W' => 'wwwnnnnnn', 'X' => 'nwnnwnnnw', 'Y' => 'wwnnwnnnn', 'Z' => 'nwwnwnnnn',
        '-' => 'nwnnnnwnw', '.' => 'wwnnnnwnn', ' ' => 'nwwnnnwnn', '$' => 'nwnwnwnnn',
        '/' => 'nwnwnnnwn', '+' => 'nwnnnwnwn', '%' => 'nnnwnwnwn', '*' => 'nwnnwnwnn',
    ];

    public static function code39Alphabet(): array
    {
        return self::CODE39;
    }

    /** @return array{widths: list<float>} */
    public static function code39Encode(string $text, float $wideRatio = 2.5): array
    {
        $value = strtoupper($text);

        for ($i = 0, $n = strlen($value); $i < $n; $i++) {
            $char = $value[$i];
            if (!isset(self::CODE39[$char]) || $char === '*') {
                throw Util::badRequest(
                    "Code 39 cannot encode the character \"{$char}\". "
                    . 'Use A-Z, 0-9, space, or - . $ / + % only.'
                );
            }
        }

        $framed = '*' . $value . '*';
        $widths = [];

        for ($i = 0, $n = strlen($framed); $i < $n; $i++) {
            foreach (str_split(self::CODE39[$framed[$i]]) as $element) {
                $widths[] = $element === 'w' ? $wideRatio : 1.0;
            }
            if ($i < $n - 1) {
                $widths[] = 1.0; // Inter-character gap: one narrow space.
            }
        }

        return ['widths' => $widths];
    }

    // -----------------------------------------------------------------------
    // SVG rendering for the 1D symbologies
    // -----------------------------------------------------------------------

    /**
     * Render alternating bar/space widths as SVG. The first element is always
     * a bar, and elements alternate from there.
     */
    private static function widthsToSvg(array $widths, array $options): string
    {
        $height      = (float) ($options['height'] ?? 60);
        $moduleWidth = (float) ($options['moduleWidth'] ?? 2);
        $quietZone   = (float) ($options['quietZone'] ?? 10);
        $text        = $options['text'] ?? null;
        $fontSize    = (float) ($options['fontSize'] ?? 10);

        $totalModules = array_sum($widths);
        $barsWidth    = $totalModules * $moduleWidth;
        $width        = $barsWidth + $quietZone * 2;
        $textHeight   = $text !== null ? $fontSize + 4 : 0;
        $totalHeight  = $height + $textHeight;

        $x     = $quietZone;
        $rects = '';

        foreach ($widths as $index => $moduleCount) {
            $elementWidth = $moduleCount * $moduleWidth;

            if ($index % 2 === 0) { // Even indices are bars.
                $rects .= sprintf(
                    '<rect x="%s" y="0" width="%s" height="%s" fill="#000"/>',
                    self::round($x),
                    self::round($elementWidth),
                    self::round($height),
                );
            }

            $x += $elementWidth;
        }

        $label = '';
        if ($text !== null) {
            $label = sprintf(
                '<text x="%s" y="%s" text-anchor="middle" font-family="monospace" font-size="%s" fill="#000">%s</text>',
                self::round($width / 2),
                self::round($height + $fontSize),
                self::round($fontSize),
                self::escapeXml((string) $text),
            );
        }

        return sprintf(
            '<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s" '
            . 'role="img" aria-label="Barcode %s"><rect width="100%%" height="100%%" fill="#fff"/>%s%s</svg>',
            self::round($width),
            self::round($totalHeight),
            self::round($width),
            self::round($totalHeight),
            self::escapeXml((string) ($text ?? '')),
            $rects,
            $label,
        );
    }

    public static function code128Svg(string $value, array $options = []): string
    {
        $encoded = self::code128Encode($value);
        return self::widthsToSvg($encoded['widths'], $options + ['text' => $value]);
    }

    public static function code39Svg(string $value, array $options = []): string
    {
        $encoded = self::code39Encode($value);
        return self::widthsToSvg($encoded['widths'], $options + ['text' => $value]);
    }

    /** Render in whichever symbology the organisation has configured. */
    public static function render(string $value, string $symbology = 'qr', array $options = []): string
    {
        return match ($symbology) {
            'code128' => self::code128Svg($value, $options),
            'code39'  => self::code39Svg($value, $options),
            default   => Qr::svg($value, $options),
        };
    }

    private static function round(float $n): string
    {
        return rtrim(rtrim(number_format($n, 3, '.', ''), '0'), '.');
    }

    private static function escapeXml(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES | ENT_XML1 | ENT_SUBSTITUTE, 'UTF-8');
    }

    // -----------------------------------------------------------------------
    // Printable label sheets
    // -----------------------------------------------------------------------

    /**
     * A print-ready HTML page of device labels.
     *
     * Sizing is in millimetres with an explicit @page rule, because label
     * stock is sold by physical size and "looks right on screen" is not a
     * useful guarantee when the output goes onto a sheet of Avery labels.
     */
    public static function labelSheet(array $devices, array $options = []): string
    {
        $symbology    = $options['symbology'] ?? 'qr';
        $orgName      = (string) ($options['orgName'] ?? '');
        $columns      = (int) ($options['columns'] ?? 3);
        $labelWidth   = (float) ($options['labelWidthMm'] ?? 63.5);
        $labelHeight  = (float) ($options['labelHeightMm'] ?? 38.1);

        $labels = '';

        foreach ($devices as $device) {
            $svg = self::render((string) $device['barcode'], $symbology, [
                'size'        => 90,
                'height'      => 44,
                'moduleWidth' => 1.4,
                'fontSize'    => 8,
            ]);

            $labels .= '<div class="label">'
                . '<div class="code">' . $svg . '</div>'
                . '<div class="meta">'
                . '<div class="value">' . Util::escapeHtml($device['barcode']) . '</div>'
                . '<div class="name">' . Util::escapeHtml(self::truncate((string) $device['name'], 34)) . '</div>'
                . (!empty($device['asset_tag'])
                    ? '<div class="asset">Asset ' . Util::escapeHtml($device['asset_tag']) . '</div>' : '')
                . ($orgName !== ''
                    ? '<div class="org">' . Util::escapeHtml(self::truncate($orgName, 30)) . '</div>' : '')
                . '</div></div>';
        }

        $count  = count($devices);
        $plural = $count === 1 ? '' : 's';

        return <<<HTML
            <!doctype html>
            <html lang="en">
            <head>
            <meta charset="utf-8">
            <title>Device labels ({$count})</title>
            <style>
              @page { size: A4; margin: 8mm; }
              * { box-sizing: border-box; }
              body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #000; background: #fff; }
              .toolbar { padding: 12px; background: #f2f2f2; border-bottom: 1px solid #ccc; }
              .toolbar button { font: inherit; padding: 8px 16px; cursor: pointer; }
              .sheet { display: grid; grid-template-columns: repeat({$columns}, {$labelWidth}mm); gap: 0; }
              .label {
                width: {$labelWidth}mm; height: {$labelHeight}mm;
                display: flex; align-items: center; gap: 2mm;
                padding: 2mm; overflow: hidden;
                page-break-inside: avoid; break-inside: avoid;
              }
              .code { flex: 0 0 auto; display: flex; align-items: center; }
              .code svg { display: block; max-width: 24mm; max-height: 24mm; }
              .meta { flex: 1 1 auto; min-width: 0; line-height: 1.25; }
              .value { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 8pt; font-weight: 700; }
              .name { font-size: 7pt; overflow: hidden; }
              .asset, .org { font-size: 6pt; color: #333; }
              @media print { .toolbar { display: none; } }
            </style>
            </head>
            <body>
              <div class="toolbar">
                <button type="button" data-print hidden>Print {$count} label{$plural}</button>
                <noscript>Use your browser's own Print command to print this sheet.</noscript>
                <span> &nbsp; Symbology: {$symbology} &nbsp;|&nbsp; Label size: {$labelWidth} &times; {$labelHeight} mm</span>
              </div>
              <div class="sheet">{$labels}</div>
              <script src="/js/print-sheet.js"></script>
            </body>
            </html>
            HTML;
    }

    private static function truncate(string $value, int $max): string
    {
        return mb_strlen($value) > $max ? mb_substr($value, 0, $max - 1) . '…' : $value;
    }
}
