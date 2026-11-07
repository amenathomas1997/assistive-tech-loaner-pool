<?php
/**
 * Structural verification of the 1D barcode encoders.
 *
 * The Code 128 and Code 39 tables are transcribed by hand, and a single
 * mistyped digit produces a barcode that renders perfectly and scans as the
 * wrong value — the kind of bug you only find once a device is already
 * mislabelled. The checks below are properties of the specifications, so they
 * catch transcription errors without needing a reference encoder.
 *
 * QR is verified separately, by decoding real symbols: see
 * scripts/verify-qr.sh. Structural checks alone are not sufficient there, and
 * assuming they were is what let a reversed Reed-Solomon polynomial through.
 *
 * Run: php scripts/verify-barcode.php
 */

declare(strict_types=1);

namespace Loaner;

require __DIR__ . '/../app/bootstrap.php';

$failures = 0;

function check(string $description, bool $condition, string $detail = ''): void
{
    global $failures;

    if ($condition) {
        echo "  ok   {$description}\n";
        return;
    }

    $failures++;
    echo "  FAIL {$description}" . ($detail !== '' ? " — {$detail}" : '') . "\n";
}

echo "\nCode 128 pattern table\n";

$patterns = Barcode::code128Patterns();

check('table has 107 entries (values 0-106)', count($patterns) === 107, 'got ' . count($patterns));

$wrongElements = [];
foreach (array_slice($patterns, 0, 106) as $i => $p) {
    if (strlen($p) !== 6) {
        $wrongElements[] = "{$i}:{$p}";
    }
}
check('values 0-105 each have 6 elements', $wrongElements === [], implode(', ', $wrongElements));

// Every character is exactly 11 modules wide. The single strongest check
// against a mistyped digit.
$wrongWidth = [];
foreach (array_slice($patterns, 0, 106) as $i => $p) {
    $sum = array_sum(array_map('intval', str_split($p)));
    if ($sum !== 11) {
        $wrongWidth[] = "{$i}:{$p}={$sum}";
    }
}
check('values 0-105 are each 11 modules wide', $wrongWidth === [], implode(', ', $wrongWidth));

$stop    = $patterns[106];
$stopSum = array_sum(array_map('intval', str_split($stop)));
check(
    'stop pattern is 7 elements / 13 modules',
    strlen($stop) === 7 && $stopSum === 13,
    "{$stop} = {$stopSum} modules in " . strlen($stop) . ' elements',
);

// Specification property: within any Code 128 character the bar widths
// (elements 1, 3, 5) sum to an even number. Independent of the width check.
$oddBars = [];
foreach (array_slice($patterns, 0, 106) as $i => $p) {
    $bars = (int) $p[0] + (int) $p[2] + (int) $p[4];
    if ($bars % 2 !== 0) {
        $oddBars[] = "{$i}:{$p} bars={$bars}";
    }
}
check('bar widths sum to an even number in every character', $oddBars === [], implode(', ', $oddBars));

check(
    'all 107 patterns are unique',
    count(array_unique($patterns)) === count($patterns),
    (count($patterns) - count(array_unique($patterns))) . ' duplicate(s)',
);

echo "\nCode 128 encoding\n";

// Worked example, checkable by hand:
//   Start B = 104, "A" = 65 - 32 = 33 at position 1
//   checksum = (104 + 33 * 1) % 103 = 137 % 103 = 34
$encodedA = Barcode::code128Encode('A');
check('check digit for "A" is 34', $encodedA['checkDigit'] === 34, 'got ' . $encodedA['checkDigit']);
check('"A" encodes to start + data + check + stop', count($encodedA['codes']) === 4);

$sample  = 'LP-7K3F9Q2M';
$encoded = Barcode::code128Encode($sample);

check(
    'sample encodes to the right number of codes',
    count($encoded['codes']) === strlen($sample) + 3,
    count($encoded['codes']) . ' codes for ' . strlen($sample) . ' characters',
);

// Total modules = 11 per code, plus 2 extra for the 13-module stop pattern.
$expectedModules = (count($encoded['codes']) - 1) * 11 + 13;
$actualModules   = (int) array_sum($encoded['widths']);
check(
    'sample module count matches specification',
    $actualModules === $expectedModules,
    "expected {$expectedModules}, got {$actualModules}",
);

$outOfRange = 0;
foreach (str_split(Util::UNAMBIGUOUS . '-') as $char) {
    $digit = Barcode::code128Encode('LP-' . str_repeat($char, 6))['checkDigit'];
    if ($digit < 0 || $digit > 102) {
        $outOfRange++;
    }
}
check('check digit stays within 0-102 across the generator alphabet', $outOfRange === 0);

$rejected = false;
try {
    Barcode::code128Encode("caf\u{00E9}");
} catch (\Throwable) {
    $rejected = true;
}
check('non-ASCII input is rejected', $rejected);

echo "\nCode 39\n";

$alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
$bad      = [];

foreach (str_split($alphabet) as $char) {
    // *X* = 3 characters at 9 elements each, plus 2 inter-character gaps = 29.
    $widths = Barcode::code39Encode($char)['widths'];
    if (count($widths) !== 29) {
        $bad[] = $char . ':' . count($widths);
    }
}
check('every Code 39 character yields 29 elements when framed', $bad === [], implode(', ', $bad));

// Specification: exactly 3 of the 9 elements in each character are wide.
$wideBad = [];
foreach (Barcode::code39Alphabet() as $char => $pattern) {
    $wide = substr_count($pattern, 'w');
    if ($wide !== 3) {
        $wideBad[] = "{$char}:{$wide}";
    }
}
check('each Code 39 character has exactly 3 wide elements', $wideBad === [], implode(', ', $wideBad));

check('every Code 39 character is 9 elements', array_sum(array_map(
    static fn (string $p): int => strlen($p) === 9 ? 0 : 1,
    Barcode::code39Alphabet(),
)) === 0);

echo "\nScan normalisation\n";

check('strips wedge carriage return', Barcode::normaliseScan("LP-ABC123\r\n") === 'LP-ABC123');
check('strips trailing tab', Barcode::normaliseScan("LP-ABC123\t") === 'LP-ABC123');
check('strips AIM symbology identifier', Barcode::normaliseScan(']C1LP-ABC123') === 'LP-ABC123');
check('strips Code 39 framing asterisks', Barcode::normaliseScan('*LP-ABC123*') === 'LP-ABC123');
check('uppercases', Barcode::normaliseScan('lp-abc123') === 'LP-ABC123');
check('empty input becomes null', Barcode::normaliseScan('   ') === null);
check('null input becomes null', Barcode::normaliseScan(null) === null);

echo "\nGenerated values\n";

$generated = [];
for ($i = 0; $i < 5000; $i++) {
    $generated[] = Barcode::generateValue('LP');
}

check('generated values match the expected shape', array_sum(array_map(
    static fn (string $v): int => preg_match('/^LP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/', $v) ? 0 : 1,
    $generated,
)) === 0);

check('generated values avoid ambiguous characters 0/O/1/I/L', array_sum(array_map(
    static fn (string $v): int => preg_match('/[01OIL]/', substr($v, 3)) ? 1 : 0,
    $generated,
)) === 0);

check(
    '5000 generated values contain no duplicates',
    count(array_unique($generated)) === count($generated),
    (count($generated) - count(array_unique($generated))) . ' collision(s)',
);

// Rejection sampling should leave no character meaningfully more likely than
// any other. A modulo-biased generator shows the first eight characters high.
$frequency = [];
foreach ($generated as $value) {
    foreach (str_split(substr($value, 3)) as $char) {
        $frequency[$char] = ($frequency[$char] ?? 0) + 1;
    }
}

$expected     = (5000 * 8) / strlen(Util::UNAMBIGUOUS);
$maxDeviation = 0.0;
foreach ($frequency as $count) {
    $maxDeviation = max($maxDeviation, abs($count - $expected) / $expected);
}

check(
    'character distribution is uniform within 15%',
    $maxDeviation < 0.15,
    'worst deviation ' . number_format($maxDeviation * 100, 1) . '%',
);
check(
    'all 31 alphabet characters appear',
    count($frequency) === strlen(Util::UNAMBIGUOUS),
    'saw ' . count($frequency),
);

check('every generated value is Code 128 encodable', array_sum(array_map(
    static function (string $v): int {
        try {
            Barcode::code128Encode($v);
            return 0;
        } catch (\Throwable) {
            return 1;
        }
    },
    array_slice($generated, 0, 200),
)) === 0);

echo "\nSVG rendering\n";

$svg128 = Barcode::code128Svg('LP-7K3F9Q2M');
check('Code 128 SVG is well-formed', str_starts_with($svg128, '<svg') && str_ends_with($svg128, '</svg>'));
check('Code 128 SVG carries an accessible label', str_contains($svg128, 'aria-label="Barcode LP-7K3F9Q2M"'));

$svg39 = Barcode::code39Svg('LP-7K3F9Q2M');
check('Code 39 SVG is well-formed', str_starts_with($svg39, '<svg') && str_ends_with($svg39, '</svg>'));

$svgQr = Qr::svg('LP-7K3F9Q2M');
check('QR SVG is well-formed', str_contains($svgQr, '<svg') && str_ends_with(trim($svgQr), '</svg>'));

echo "\nQR structure\n";

$matrix = Qr::matrix('LP-7K3F9Q2M');
check('version 1 symbol is 21x21', count($matrix) === 21 && count($matrix[0]) === 21);

// Finder patterns: the three corners each carry a 7x7 ring with a 3x3 centre.
$finderOk = true;
foreach ([[0, 0], [0, 14], [14, 0]] as [$row, $col]) {
    for ($r = 0; $r < 7; $r++) {
        for ($c = 0; $c < 7; $c++) {
            $inRing   = ($c === 0 || $c === 6 || $r === 0 || $r === 6);
            $inCentre = $r >= 2 && $r <= 4 && $c >= 2 && $c <= 4;
            if ($matrix[$row + $r][$col + $c] !== ($inRing || $inCentre)) {
                $finderOk = false;
            }
        }
    }
}
check('all three finder patterns are correct', $finderOk);

$timingOk = true;
for ($i = 8; $i < 13; $i++) {
    if ($matrix[6][$i] !== ($i % 2 === 0) || $matrix[$i][6] !== ($i % 2 === 0)) {
        $timingOk = false;
    }
}
check('both timing patterns alternate correctly', $timingOk);
check('the dark module is set', $matrix[13][8] === true);

check(
    'a value too long for the encoder is rejected rather than truncated',
    (static function (): bool {
        try {
            Qr::matrix(str_repeat('A', Qr::maxLength() + 1));
            return false;
        } catch (\Throwable) {
            return true;
        }
    })(),
);

echo $failures === 0
    ? "\nAll barcode checks passed.\n\nQR decoding is verified separately: scripts/verify-qr.sh\n"
    : "\n{$failures} check(s) FAILED.\n";

exit($failures === 0 ? 0 : 1);
