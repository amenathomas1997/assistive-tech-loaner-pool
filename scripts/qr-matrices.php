#!/usr/bin/env php
<?php
/**
 * Emit QR test cases as JSON for the decoder harness.
 *
 * Kept separate from the decoding step so the generating side needs no
 * browser, no server and no JavaScript: it prints `{text, matrix}` pairs on
 * stdout and scripts/qr-decode.mjs reads them.
 *
 *   php scripts/qr-matrices.php | node scripts/qr-decode.mjs
 */

declare(strict_types=1);

namespace Loaner;

if (PHP_SAPI !== 'cli') {
    exit(1);
}

require __DIR__ . '/../app/bootstrap.php';

$cases = [];

// Representative barcode values, every alphabet character, and the longest
// realistic payload (a scanner pairing URL).
$cases[] = 'AT-7K3F9Q2M';
$cases[] = 'LP-23456789';
$cases[] = 'ZZ-ZZZZZZZZ';

// One symbol per alphabet character: a table transcription error shows up as
// exactly one character failing, which is far easier to diagnose than a
// general "QR is broken".
foreach (str_split(Util::UNAMBIGUOUS) as $char) {
    $cases[] = 'AT-' . str_repeat($char, 8);
}

for ($i = 0; $i < 40; $i++) {
    $cases[] = Barcode::generateValue('AT');
}

$cases[] = 'https://loanerpool.example.com/scanner.html?code=7K3F9Q';
$cases[] = 'https://a-very-long-subdomain.example-organisation.org/scanner.html?code=ABCDEF';

// Boundary: exactly the maximum the encoder accepts.
$cases[] = str_repeat('A', Qr::maxLength());

$payload = [];
foreach ($cases as $text) {
    $payload[] = ['text' => $text, 'matrix' => Qr::matrix($text)];
}

echo json_encode($payload), "\n";
