#!/usr/bin/env php
<?php
/**
 * Check the TOTP implementation against the published test vectors.
 *
 * Hand-written cryptographic code that is only tested against itself is not
 * tested. RFC 6238 Appendix B gives the expected codes for known times and a
 * known key, and RFC 4648 gives base32 vectors; both are asserted here, so a
 * mistake shows up as a failing check rather than as an administrator locked
 * out of their own system.
 *
 * Usage: php scripts/verify-totp.php
 */

declare(strict_types=1);

namespace Loaner;

if (PHP_SAPI !== 'cli') { exit(1); }

require __DIR__ . '/../app/bootstrap.php';

$failures = 0;

function check(string $what, mixed $actual, mixed $expected): void
{
    global $failures;

    if ($actual === $expected) {
        printf("  ok   %s\n", $what);
        return;
    }

    $failures++;
    printf("  FAIL %s\n       expected %s\n       got      %s\n",
        $what, var_export($expected, true), var_export($actual, true));
}

echo "\nBase32 (RFC 4648 test vectors)\n";

foreach ([
    ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI'],
] as [$plain, $encoded]) {
    check("encode " . var_export($plain, true), Totp::base32Encode($plain), $encoded);
    check("decode {$encoded}", Totp::base32Decode($encoded), $plain);
}

check('decode tolerates spaces and lower case',
    Totp::base32Decode('mzxw 6ytb oi'), 'foobar');

echo "\nTOTP (RFC 6238 Appendix B, SHA-1)\n";

// The RFC's shared secret is the ASCII string "12345678901234567890".
$secret = Totp::base32Encode('12345678901234567890');

// The RFC publishes 8-digit codes; this implementation uses 6, which is what
// authenticator apps use, so the expected values are the last six digits.
foreach ([
    [59,          '287082'],
    [1111111109,  '081804'],
    [1111111111,  '050471'],
    [1234567890,  '005924'],
    [2000000000,  '279037'],
    [20000000000, '353130'],
] as [$time, $expected]) {
    check("code at t={$time}", Totp::codeAt($secret, $time), $expected);
}

echo "\nVerification window\n";

$now = 1111111109;
check('accepts the current code', Totp::verify($secret, '081804', $now), true);
check('accepts the previous code (clock drift)',
    Totp::verify($secret, Totp::codeAt($secret, $now - 30), $now), true);
check('accepts the next code (clock drift)',
    Totp::verify($secret, Totp::codeAt($secret, $now + 30), $now), true);
check('rejects a code two steps old',
    Totp::verify($secret, Totp::codeAt($secret, $now - 90), $now), false);
check('rejects a wrong code', Totp::verify($secret, '000000', $now), false);
check('rejects a short code', Totp::verify($secret, '0818', $now), false);
check('rejects letters', Totp::verify($secret, 'abcdef', $now), false);
check('rejects an empty secret', Totp::verify('', '081804', $now), false);

echo "\nSecrets and URIs\n";

$generated = Totp::generateSecret();
check('generated secret is base32', (bool) preg_match('/^[A-Z2-7]+$/', $generated), true);
check('generated secret is 32 characters', strlen($generated), 32);
check('two secrets differ', $generated === Totp::generateSecret(), false);

$uri = Totp::provisioningUri($generated, 'admin@example.org', 'Loaner Pool');
check('uri scheme', str_starts_with($uri, 'otpauth://totp/'), true);
check('uri carries the secret', str_contains($uri, 'secret=' . $generated), true);
check('uri carries the issuer', str_contains($uri, 'issuer=Loaner%20Pool'), true);
check('uri escapes the account', str_contains($uri, 'admin%40example.org'), true);

check('secret is grouped for reading aloud',
    Totp::formatSecret('ABCDEFGHIJKLMNOP'), 'ABCD EFGH IJKL MNOP');

echo "\n";

if ($failures > 0) {
    echo "{$failures} check(s) FAILED.\n";
    exit(1);
}

echo "All TOTP checks passed.\n";
exit(0);
