<?php
/**
 * QR encoder: byte mode, error correction level M, versions 1-10.
 *
 * Scoped deliberately. This application encodes two kinds of string — a device
 * barcode ("LP-7K3F9Q2M", 11 bytes) and a scanner pairing URL (~60 bytes) —
 * and version 6 at level M holds 106 bytes. Supporting versions 7-40 would add
 * the version-information block and a far larger table of alignment positions
 * for capacity nothing here will ever use, so it is left out and anything too
 * long is rejected with a clear error rather than silently mis-encoded.
 * (Versions 7-10 were added later, for two-factor set-up links.)
 *
 * Level M (~15% recoverable) rather than L because these labels live on
 * equipment that gets handled, scuffed and stickered over; rather than H
 * because H inflates the module count, and a denser symbol on a one-inch label
 * is harder for a phone camera to resolve.
 *
 * Correctness is not assumed: scripts/verify-barcode.php renders every symbol
 * this produces and decodes it with a real QR decoder, asserting the round
 * trip. A QR encoder that is subtly wrong produces a label that looks perfect
 * and scans as something else, which is exactly the failure a loaner pool
 * cannot absorb.
 */

declare(strict_types=1);

namespace Loaner;

final class Qr
{
    /** Error correction level M. */
    private const ECC_INDICATOR = 0b00;

    /**
     * Per version: error-correction codewords per block, and the block groups
     * as [blockCount, dataCodewordsPerBlock].
     */
    private const BLOCKS = [
        1 => ['ecc' => 10, 'groups' => [[1, 16]]],
        2 => ['ecc' => 16, 'groups' => [[1, 28]]],
        3 => ['ecc' => 26, 'groups' => [[1, 44]]],
        4 => ['ecc' => 18, 'groups' => [[2, 32]]],
        5 => ['ecc' => 24, 'groups' => [[2, 43]]],
        6 => ['ecc' => 16, 'groups' => [[4, 27]]],
        // Versions 7 and up additionally carry a version-information block,
        // which is why they are a separate undertaking from 1-6 rather than
        // more rows in this table. Added because an otpauth:// enrolment URI
        // runs to about 190 bytes and would not otherwise fit in a QR at all.
        7  => ['ecc' => 18, 'groups' => [[4, 31]]],
        8  => ['ecc' => 22, 'groups' => [[2, 38], [2, 39]]],
        9  => ['ecc' => 22, 'groups' => [[3, 36], [2, 37]]],
        10 => ['ecc' => 26, 'groups' => [[4, 43], [1, 44]]],
    ];

    /** Centre coordinates of the alignment patterns, per version. */
    private const ALIGNMENT = [
        1 => [],
        2 => [6, 18],
        3 => [6, 22],
        4 => [6, 26],
        5 => [6, 30],
        6 => [6, 34],
        7  => [6, 22, 38],
        8  => [6, 24, 42],
        9  => [6, 26, 46],
        10 => [6, 28, 50],
    ];

    /**
     * Lowest version that carries a version-information block.
     *
     * Below this the decoder works the version out from the symbol's size;
     * at and above it, the version is written into the symbol twice, with BCH
     * error correction, because a large symbol is more likely to be read at an
     * angle where counting modules goes wrong.
     */
    private const VERSION_INFO_FROM = 7;

    private static ?array $expTable = null;
    private static ?array $logTable = null;

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Encode to a module matrix: a list of rows of booleans, true meaning a
     * dark module.
     *
     * @return list<list<bool>>
     */
    public static function matrix(string $text, ?int $forceMask = null): array
    {
        $bytes  = array_map('ord', str_split($text));
        $length = count($bytes);

        $version = self::chooseVersion($length);
        $size    = 17 + 4 * $version;

        $data      = self::buildDataCodewords($bytes, $version);
        $codewords = self::addErrorCorrection($data, $version);

        // Build the function patterns once; `reserved` marks every module that
        // data must not be written into.
        [$modules, $reserved] = self::functionPatterns($version, $size);

        self::placeData($modules, $reserved, $codewords, $size);

        // Try all eight masks and keep the least-penalised, as the
        // specification requires. A fixed mask produces valid-but-poor symbols
        // that some decoders struggle with under bad lighting.
        $best        = null;
        $bestPenalty = PHP_INT_MAX;

        // $forceMask pins the choice. Only the verification harness uses it,
        // to compare against a reference implementation mask-for-mask.
        $masks = $forceMask !== null ? [$forceMask] : range(0, 7);

        foreach ($masks as $mask) {
            $candidate = self::applyMask($modules, $reserved, $mask, $size);
            self::placeFormatInfo($candidate, $mask, $size);

            $penalty = self::penalty($candidate, $size);

            if ($penalty < $bestPenalty) {
                $bestPenalty = $penalty;
                $best        = $candidate;
            }
        }

        return $best;
    }

    /** Render as an SVG. */
    public static function svg(string $text, array $options = []): string
    {
        // What a screen reader says. Not the encoded text when a title is
        // given: for two-factor set-up that text is the secret, read aloud.
        $label  = (string) ($options['title'] ?? "QR code {$text}");
        $size   = (int) ($options['size'] ?? 160);
        $margin = (int) ($options['margin'] ?? 2); // quiet zone, in modules

        $matrix = self::matrix($text);
        $count  = count($matrix);
        $total  = $count + $margin * 2;

        // One path for every dark module is far smaller than one <rect> each,
        // which matters when a label sheet holds 500 symbols.
        $path = '';
        foreach ($matrix as $y => $row) {
            foreach ($row as $x => $dark) {
                if ($dark) {
                    $path .= 'M' . ($x + $margin) . ' ' . ($y + $margin) . 'h1v1h-1z';
                }
            }
        }

        return sprintf(
            '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" '
            . 'shape-rendering="crispEdges" role="img" aria-label="%s">'
            . '<rect width="%d" height="%d" fill="#fff"/><path d="%s" fill="#000"/></svg>',
            $size,
            $size,
            $total,
            $total,
            htmlspecialchars($label, ENT_QUOTES | ENT_XML1 | ENT_SUBSTITUTE, 'UTF-8'),
            $total,
            $total,
            $path,
        );
    }

    /** Largest string this encoder will accept, in bytes. */
    public static function maxLength(): int
    {
        return self::dataCapacity(max(array_keys(self::BLOCKS)));
    }

    // -----------------------------------------------------------------------
    // Data encoding
    // -----------------------------------------------------------------------

    /** Data codewords available at a version, less the 12-bit header. */
    private static function dataCapacity(int $version): int
    {
        $total = 0;
        foreach (self::BLOCKS[$version]['groups'] as [$count, $perBlock]) {
            $total += $count * $perBlock;
        }

        // 4 bits mode plus the character count, which is 8 bits up to version
        // 9 and 16 bits from version 10 — so the overhead is 12 or 20 bits.
        return $total - (int) ceil((4 + self::countBits($version)) / 8);
    }

    /**
     * Width of the byte-mode character count field.
     *
     * Eight bits for versions 1-9 and sixteen from version 10. Getting this
     * wrong does not produce an obviously broken symbol: it produces one that
     * passes every structural check, reads back to its own codewords, and
     * decodes on no reader at all — which is exactly what happened the first
     * time version 10 was added here, and what the round-trip harness caught.
     */
    private static function countBits(int $version): int
    {
        return $version < 10 ? 8 : 16;
    }

    private static function chooseVersion(int $length): int
    {
        foreach (array_keys(self::BLOCKS) as $version) {
            if ($length <= self::dataCapacity($version)) {
                return $version;
            }
        }

        throw Util::badRequest(sprintf(
            'That value is %d bytes, which is too long for this QR encoder (maximum %d). '
            . 'Shorten it, or use Code 128 for long values.',
            $length,
            self::maxLength(),
        ));
    }

    /** @param list<int> $bytes @return list<int> data codewords */
    private static function buildDataCodewords(array $bytes, int $version): array
    {
        $bits = '';

        $countBits = self::countBits($version);

        $bits .= '0100';                                                       // byte mode
        $bits .= str_pad(decbin(count($bytes)), $countBits, '0', STR_PAD_LEFT); // character count

        foreach ($bytes as $byte) {
            $bits .= str_pad(decbin($byte), 8, '0', STR_PAD_LEFT);
        }

        $totalData = self::dataCapacity($version)
                   + (int) ceil((4 + $countBits) / 8); // codewords
        $capacity  = $totalData * 8;

        // Terminator: up to four zero bits.
        $bits .= str_repeat('0', min(4, $capacity - strlen($bits)));

        // Pad to a byte boundary.
        if (strlen($bits) % 8 !== 0) {
            $bits .= str_repeat('0', 8 - (strlen($bits) % 8));
        }

        $codewords = [];
        foreach (str_split($bits, 8) as $byte) {
            $codewords[] = bindec($byte);
        }

        // Pad with the alternating bytes the specification mandates.
        $padBytes = [0xEC, 0x11];
        $i = 0;
        while (count($codewords) < $totalData) {
            $codewords[] = $padBytes[$i % 2];
            $i++;
        }

        return $codewords;
    }

    // -----------------------------------------------------------------------
    // Reed-Solomon
    // -----------------------------------------------------------------------

    /** GF(256) tables, primitive polynomial 0x11D. */
    private static function initTables(): void
    {
        if (self::$expTable !== null) {
            return;
        }

        $exp = array_fill(0, 512, 0);
        $log = array_fill(0, 256, 0);

        $x = 1;
        for ($i = 0; $i < 255; $i++) {
            $exp[$i] = $x;
            $log[$x] = $i;

            $x <<= 1;
            if ($x & 0x100) {
                $x ^= 0x11D;
            }
        }

        for ($i = 255; $i < 512; $i++) {
            $exp[$i] = $exp[$i - 255];
        }

        self::$expTable = $exp;
        self::$logTable = $log;
    }

    private static function gfMultiply(int $a, int $b): int
    {
        if ($a === 0 || $b === 0) {
            return 0;
        }

        self::initTables();
        return self::$expTable[(self::$logTable[$a] + self::$logTable[$b]) % 255];
    }

    /**
     * Generator polynomial of the given degree: the product of (x + α^i) for
     * i in 0..degree-1.
     *
     * Coefficients run from the highest power down, so index 0 is the leading
     * term and must come out as 1 — the synthetic division below relies on
     * that to cancel each step.
     *
     * The two lines are easy to transpose, and transposing them reverses the
     * coefficients. That still produces plausible-looking error-correction
     * bytes and a symbol that renders perfectly, so nothing short of decoding
     * it catches the mistake.
     */
    private static function generatorPolynomial(int $degree): array
    {
        self::initTables();

        $poly = [1];

        for ($i = 0; $i < $degree; $i++) {
            $next = array_fill(0, count($poly) + 1, 0);

            foreach ($poly as $index => $coefficient) {
                $next[$index]     ^= $coefficient;                                      // × x
                $next[$index + 1] ^= self::gfMultiply($coefficient, self::$expTable[$i]); // × α^i
            }

            $poly = $next;
        }

        return $poly;
    }

    /** @param list<int> $data @return list<int> */
    private static function eccForBlock(array $data, int $eccCount): array
    {
        $generator = self::generatorPolynomial($eccCount);
        $remainder = array_merge($data, array_fill(0, $eccCount, 0));

        for ($i = 0, $n = count($data); $i < $n; $i++) {
            $factor = $remainder[$i];
            if ($factor === 0) {
                continue;
            }

            foreach ($generator as $offset => $coefficient) {
                $remainder[$i + $offset] ^= self::gfMultiply($coefficient, $factor);
            }
        }

        return array_slice($remainder, count($data));
    }

    /**
     * Split into blocks, compute ECC for each, then interleave — which is what
     * lets the symbol survive damage concentrated in one area.
     *
     * @param list<int> $data @return list<int>
     */
    private static function addErrorCorrection(array $data, int $version): array
    {
        $eccCount = self::BLOCKS[$version]['ecc'];

        $dataBlocks = [];
        $eccBlocks  = [];
        $offset     = 0;

        foreach (self::BLOCKS[$version]['groups'] as [$blockCount, $perBlock]) {
            for ($b = 0; $b < $blockCount; $b++) {
                $block        = array_slice($data, $offset, $perBlock);
                $offset      += $perBlock;
                $dataBlocks[] = $block;
                $eccBlocks[]  = self::eccForBlock($block, $eccCount);
            }
        }

        $result = [];

        $maxData = max(array_map('count', $dataBlocks));
        for ($i = 0; $i < $maxData; $i++) {
            foreach ($dataBlocks as $block) {
                if (isset($block[$i])) {
                    $result[] = $block[$i];
                }
            }
        }

        for ($i = 0; $i < $eccCount; $i++) {
            foreach ($eccBlocks as $block) {
                $result[] = $block[$i];
            }
        }

        return $result;
    }

    // -----------------------------------------------------------------------
    // Matrix construction
    // -----------------------------------------------------------------------

    /**
     * Build the function patterns.
     *
     * @return array{0: list<list<bool>>, 1: list<list<bool>>} modules, reserved
     */
    private static function functionPatterns(int $version, int $size): array
    {
        $modules  = array_fill(0, $size, array_fill(0, $size, false));
        $reserved = array_fill(0, $size, array_fill(0, $size, false));

        // Finder patterns and their separators, in the three corners.
        foreach ([[0, 0], [$size - 7, 0], [0, $size - 7]] as [$col, $row]) {
            for ($r = -1; $r <= 7; $r++) {
                for ($c = -1; $c <= 7; $c++) {
                    $y = $row + $r;
                    $x = $col + $c;

                    if ($y < 0 || $y >= $size || $x < 0 || $x >= $size) {
                        continue;
                    }

                    $inRing   = ($r >= 0 && $r <= 6 && ($c === 0 || $c === 6))
                             || ($c >= 0 && $c <= 6 && ($r === 0 || $r === 6));
                    $inCentre = $r >= 2 && $r <= 4 && $c >= 2 && $c <= 4;

                    $modules[$y][$x]  = $inRing || $inCentre;
                    $reserved[$y][$x] = true;
                }
            }
        }

        // Timing patterns.
        for ($i = 8; $i < $size - 8; $i++) {
            $dark = $i % 2 === 0;
            $modules[6][$i]  = $dark;
            $reserved[6][$i] = true;
            $modules[$i][6]  = $dark;
            $reserved[$i][6] = true;
        }

        // Alignment patterns, skipping any that would overlap a finder.
        $centres = self::ALIGNMENT[$version];
        foreach ($centres as $row) {
            foreach ($centres as $col) {
                $overlapsFinder = ($row <= 8 && $col <= 8)
                               || ($row <= 8 && $col >= $size - 9)
                               || ($row >= $size - 9 && $col <= 8);

                if ($overlapsFinder) {
                    continue;
                }

                for ($r = -2; $r <= 2; $r++) {
                    for ($c = -2; $c <= 2; $c++) {
                        $modules[$row + $r][$col + $c]  = max(abs($r), abs($c)) !== 1;
                        $reserved[$row + $r][$col + $c] = true;
                    }
                }
            }
        }

        // The dark module, always set, always at this position.
        $modules[$size - 8][8]  = true;
        $reserved[$size - 8][8] = true;

        // Version information, for version 7 and above.
        self::placeVersionInfo($modules, $reserved, $version, $size);

        // Reserve the format-information areas; the bits go in later, once a
        // mask has been chosen.
        for ($i = 0; $i < 9; $i++) {
            if (!$reserved[8][$i]) {
                $reserved[8][$i] = true;
            }
            if (!$reserved[$i][8]) {
                $reserved[$i][8] = true;
            }
        }
        for ($i = 0; $i < 8; $i++) {
            $reserved[8][$size - 1 - $i]  = true;
            $reserved[$size - 1 - $i][8]  = true;
        }

        return [$modules, $reserved];
    }

    /**
     * Place the codeword bits in the zigzag order the specification defines:
     * two columns at a time, right to left, alternating upward and downward,
     * skipping the vertical timing column.
     *
     * @param list<int> $codewords
     */
    private static function placeData(array &$modules, array $reserved, array $codewords, int $size): void
    {
        $bits = '';
        foreach ($codewords as $codeword) {
            $bits .= str_pad(decbin($codeword), 8, '0', STR_PAD_LEFT);
        }

        $bitIndex = 0;
        $upward   = true;

        for ($right = $size - 1; $right > 0; $right -= 2) {
            if ($right === 6) {
                $right = 5; // Skip the vertical timing pattern column.
            }

            for ($step = 0; $step < $size; $step++) {
                $y = $upward ? $size - 1 - $step : $step;

                foreach ([$right, $right - 1] as $x) {
                    if ($reserved[$y][$x]) {
                        continue;
                    }

                    // Remaining modules past the end of the data are left
                    // light, which is what the specification requires.
                    $modules[$y][$x] = $bitIndex < strlen($bits) && $bits[$bitIndex] === '1';
                    $bitIndex++;
                }
            }

            $upward = !$upward;
        }
    }

    private static function maskCondition(int $mask, int $row, int $col): bool
    {
        return match ($mask) {
            0 => ($row + $col) % 2 === 0,
            1 => $row % 2 === 0,
            2 => $col % 3 === 0,
            3 => ($row + $col) % 3 === 0,
            4 => (intdiv($row, 2) + intdiv($col, 3)) % 2 === 0,
            5 => (($row * $col) % 2) + (($row * $col) % 3) === 0,
            6 => ((($row * $col) % 2) + (($row * $col) % 3)) % 2 === 0,
            7 => ((($row + $col) % 2) + (($row * $col) % 3)) % 2 === 0,
            default => false,
        };
    }

    /** @return list<list<bool>> */
    private static function applyMask(array $modules, array $reserved, int $mask, int $size): array
    {
        for ($y = 0; $y < $size; $y++) {
            for ($x = 0; $x < $size; $x++) {
                if (!$reserved[$y][$x] && self::maskCondition($mask, $y, $x)) {
                    $modules[$y][$x] = !$modules[$y][$x];
                }
            }
        }

        return $modules;
    }

    /**
     * 15-bit format information: 2 bits error-correction level, 3 bits mask,
     * 10 bits BCH, the whole thing XORed with 0x5412.
     */
    private static function formatBits(int $mask): int
    {
        $data  = (self::ECC_INDICATOR << 3) | $mask;
        $value = $data << 10;

        for ($i = 14; $i >= 10; $i--) {
            if ($value & (1 << $i)) {
                $value ^= 0x537 << ($i - 10);
            }
        }

        return (($data << 10) | $value) ^ 0x5412;
    }

    /**
     * Write the 15 format bits into both of their copies.
     *
     * The two copies run in *opposite* directions, and both step over the
     * timing patterns at row 6 and column 6 — which is what the awkward
     * special cases below are for. Getting the two copies consistent with each
     * other but wrong relative to the specification produces a symbol that
     * looks entirely plausible and decodes in nothing, so this mapping is
     * taken straight from the specification rather than inferred.
     *
     * Bit 0 is the least significant.
     */
    /**
     * The 18-bit version information word.
     *
     * Six bits of version followed by a BCH(18,6) remainder under the
     * generator 0x1F25. Computed rather than copied from the published table:
     * a transcribed table is one typo away from a symbol that looks perfect
     * and reads as the wrong version, which is precisely the class of bug the
     * round-trip harness exists to catch.
     */
    private static function versionInfoBits(int $version): int
    {
        $value = $version << 12;

        // Polynomial long division in GF(2).
        $remainder = $value;
        for ($i = 17; $i >= 12; $i--) {
            if ((($remainder >> $i) & 1) === 1) {
                $remainder ^= 0x1F25 << ($i - 12);
            }
        }

        return $value | $remainder;
    }

    /**
     * Write the version into the two reserved blocks.
     *
     * Bottom-left and top-right, the same eighteen bits each time, so a tear
     * or a thumb over one corner does not cost the reader the version.
     */
    private static function placeVersionInfo(array &$modules, array &$reserved, int $version, int $size): void
    {
        if ($version < self::VERSION_INFO_FROM) {
            return;
        }

        $bits = self::versionInfoBits($version);

        for ($i = 0; $i < 18; $i++) {
            $bit = (($bits >> $i) & 1) === 1;

            $row = intdiv($i, 3);
            $col = $i % 3;

            // Bottom-left block: 6 rows by 3 columns, just above the finder.
            $modules[$size - 11 + $col][$row]  = $bit;
            $reserved[$size - 11 + $col][$row] = true;

            // Top-right block: the transpose of the same arrangement.
            $modules[$row][$size - 11 + $col]  = $bit;
            $reserved[$row][$size - 11 + $col] = true;
        }
    }

    private static function placeFormatInfo(array &$modules, int $mask, int $size): void
    {
        $bits = self::formatBits($mask);

        for ($i = 0; $i < 15; $i++) {
            $bit = (bool) (($bits >> $i) & 1);

            // Copy one: down column 8, skipping the horizontal timing row.
            if ($i < 6) {
                $modules[$i][8] = $bit;
            } elseif ($i < 8) {
                $modules[$i + 1][8] = $bit;
            } else {
                $modules[$size - 15 + $i][8] = $bit;
            }

            // Copy two: along row 8, skipping the vertical timing column.
            if ($i < 8) {
                $modules[8][$size - 1 - $i] = $bit;
            } elseif ($i === 8) {
                $modules[8][7] = $bit;
            } else {
                $modules[8][14 - $i] = $bit;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Mask penalty scoring
    // -----------------------------------------------------------------------

    private static function penalty(array $modules, int $size): int
    {
        return self::penaltyRuns($modules, $size)
             + self::penaltyBlocks($modules, $size)
             + self::penaltyFinderLike($modules, $size)
             + self::penaltyBalance($modules, $size);
    }

    /** Rule 1: runs of five or more same-coloured modules. */
    private static function penaltyRuns(array $modules, int $size): int
    {
        $score = 0;

        for ($i = 0; $i < $size; $i++) {
            foreach ([true, false] as $isRow) {
                $runColour = null;
                $runLength = 0;

                for ($j = 0; $j < $size; $j++) {
                    $value = $isRow ? $modules[$i][$j] : $modules[$j][$i];

                    if ($value === $runColour) {
                        $runLength++;
                    } else {
                        if ($runLength >= 5) {
                            $score += 3 + ($runLength - 5);
                        }
                        $runColour = $value;
                        $runLength = 1;
                    }
                }

                if ($runLength >= 5) {
                    $score += 3 + ($runLength - 5);
                }
            }
        }

        return $score;
    }

    /** Rule 2: 2x2 blocks of one colour. */
    private static function penaltyBlocks(array $modules, int $size): int
    {
        $score = 0;

        for ($y = 0; $y < $size - 1; $y++) {
            for ($x = 0; $x < $size - 1; $x++) {
                $v = $modules[$y][$x];
                if ($v === $modules[$y][$x + 1] && $v === $modules[$y + 1][$x] && $v === $modules[$y + 1][$x + 1]) {
                    $score += 3;
                }
            }
        }

        return $score;
    }

    /** Rule 3: finder-like 1:1:3:1:1 patterns, which confuse decoders. */
    private static function penaltyFinderLike(array $modules, int $size): int
    {
        $score    = 0;
        $patternA = [true, false, true, true, true, false, true, false, false, false, false];
        $patternB = [false, false, false, false, true, false, true, true, true, false, true];

        for ($i = 0; $i < $size; $i++) {
            for ($j = 0; $j <= $size - 11; $j++) {
                $row = array_slice($modules[$i], $j, 11);

                if ($row === $patternA || $row === $patternB) {
                    $score += 40;
                }

                $column = [];
                for ($k = 0; $k < 11; $k++) {
                    $column[] = $modules[$j + $k][$i];
                }

                if ($column === $patternA || $column === $patternB) {
                    $score += 40;
                }
            }
        }

        return $score;
    }

    /** Rule 4: how far the dark proportion strays from 50%. */
    private static function penaltyBalance(array $modules, int $size): int
    {
        $dark = 0;
        foreach ($modules as $row) {
            foreach ($row as $value) {
                if ($value) {
                    $dark++;
                }
            }
        }

        $percent = ($dark * 100) / ($size * $size);

        return (int) (floor(abs($percent - 50) / 5) * 10);
    }
}
