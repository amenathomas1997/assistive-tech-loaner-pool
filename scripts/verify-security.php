<?php
/**
 * The security rules that are pure functions, held to a table of cases.
 *
 * Each of these was a real defect, found by reading the code and then
 * reproduced against a running server before being fixed:
 *
 *   - X-Forwarded-For was believed by default, so any visitor could write
 *     any address into the audit log.
 *   - The failed-login count never reset after a lockout expired, so one
 *     wrong password every fifteen minutes kept an account locked for good.
 *   - A TOTP code was accepted any number of times inside its window.
 *   - A CSV export carried spreadsheet formulas typed into a name field
 *     straight into the spreadsheet of whoever opened it.
 *   - The Origin check that stops a page on a sibling subdomain from posting
 *     here with the session cookie.
 *
 * The end-to-end suite proves each over HTTP where it can. This file holds
 * the decision tables, which an HTTP test cannot reach: it cannot make a
 * lockout expire, and it cannot make time pass for a TOTP step.
 *
 * Usage: php scripts/verify-security.php
 */

declare(strict_types=1);

namespace Loaner;

require __DIR__ . '/../app/bootstrap.php';

$failures = 0;

$check = static function (string $label, bool $ok, string $detail = '') use (&$failures): void {
    if ($ok) {
        echo "  ok   {$label}\n";
    } else {
        echo "  FAIL {$label}" . ($detail !== '' ? "\n       {$detail}" : '') . "\n";
        $failures++;
    }
};

echo "==> Security decision tables\n\n";

// --- Client address ---------------------------------------------------------
echo "Which address goes in the audit log\n";

$cases = [
    // remote, forwarded, env, expected, why
    ['198.51.100.9', '203.0.113.77', false, '198.51.100.9', 'unset: a forged header is ignored'],
    ['198.51.100.9', '203.0.113.77', '0',   '198.51.100.9', 'LOANER_TRUST_PROXY=0: ignored'],
    ['127.0.0.1',    '203.0.113.77', false, '127.0.0.1',    'loopback is not proof of a proxy'],
    ['127.0.0.1',    '203.0.113.77', '1',   '203.0.113.77', 'LOANER_TRUST_PROXY=1: the proxy is believed'],
    ['127.0.0.1',    '203.0.113.77, 10.0.0.2', '1', '203.0.113.77', 'leftmost of a chain'],
    ['127.0.0.1',    'not-an-address', '1', '127.0.0.1',    'garbage in the header falls back'],
    ['127.0.0.1',    '',             '1',   '127.0.0.1',    'no header falls back'],
];

foreach ($cases as [$remote, $forwarded, $env, $expected, $why]) {
    $got = Request::resolveClientIp($remote, $forwarded, $env);
    $check($why, $got === $expected, "got {$got}, expected {$expected}");
}

// --- Lockout window ---------------------------------------------------------
echo "\nFailed sign-ins\n";

$now = 1_800_000_000;
$past   = date('Y-m-d H:i:s', $now - 60);
$future = date('Y-m-d H:i:s', $now + 600);

$check('a first miss counts one', Auth::failedLoginsAfterMiss(0, null, $now) === 1);
$check('misses accumulate', Auth::failedLoginsAfterMiss(5, null, $now) === 6);
$check('a miss during an active lockout accumulates', Auth::failedLoginsAfterMiss(8, $future, $now) === 9);
$check(
    'a miss after the lockout has expired starts a fresh window',
    Auth::failedLoginsAfterMiss(8, $past, $now) === 1,
    'the count stayed at the threshold, so the next miss re-locked the account',
);

// --- TOTP replay ------------------------------------------------------------
echo "\nTwo-factor codes\n";

$secret = Totp::generateSecret();
$t      = 1_800_000_015; // fifteen seconds into a step
$step   = intdiv($t, Totp::PERIOD);

$code = Totp::codeAt($secret, $t);
$check('a current code names its own step', Totp::matchCounter($secret, $code, $t) === $step);
$check('the previous step is still accepted', Totp::matchCounter($secret, Totp::codeAt($secret, $t - 30), $t) === $step - 1);
$check('the next step is accepted too', Totp::matchCounter($secret, Totp::codeAt($secret, $t + 30), $t) === $step + 1);
$check('two steps away is not', Totp::matchCounter($secret, Totp::codeAt($secret, $t + 60), $t) === null);
$check('a wrong code names no step', Totp::matchCounter($secret, '000000', $t) === null || Totp::codeAt($secret, $t) === '000000');
$check('verify() agrees with matchCounter()', Totp::verify($secret, $code, $t) === true && Totp::verify($secret, '123', $t) === false);

// --- CSV formulas -----------------------------------------------------------
echo "\nSpreadsheet exports\n";

$cases = [
    ['=HYPERLINK("http://evil.example","x")', "\"'=HYPERLINK(\"\"http://evil.example\"\",\"\"x\"\")\"", 'a formula is prefixed and quoted'],
    ['+1 (555) 0100', "'+1 (555) 0100", 'a leading plus is prefixed'],
    ['-5.00', '-5.00', 'a negative number is left alone'],
    ['@mention', "'@mention", 'a leading at-sign is prefixed'],
    ["\tcmd", "'\tcmd", 'a leading tab is prefixed'],
    ['2026-11-08', '2026-11-08', 'a date is left alone'],
    ['Rivera, Jordan', '"Rivera, Jordan"', 'ordinary quoting still happens'],
    ['', '', 'empty stays empty'],
];

foreach ($cases as [$in, $expected, $why]) {
    $got = Util::csvCell($in);
    $check($why, $got === $expected, 'got ' . json_encode($got) . ', expected ' . json_encode($expected));
}

// --- Same-site writes -------------------------------------------------------
echo "\nWhere a write may come from\n";

$cases = [
    ['https://loanerpool.example.org', 'loanerpool.example.org', true,  'the application itself'],
    ['https://loanerpool.example.org', 'LOANERPOOL.EXAMPLE.ORG', true,  'case does not matter'],
    ['http://127.0.0.1:3000',          '127.0.0.1:3000',         true,  'a dev server with a port'],
    ['https://loanerpool.example.org', 'loanerpool.example.org:443', true, 'a proxy that names the port'],
    ['https://other.example.org',      'loanerpool.example.org', false, 'a sibling subdomain — SameSite=Lax lets this through'],
    ['https://evil.example',           'loanerpool.example.org', false, 'another site entirely'],
    ['https://loanerpool.example.org.evil.example', 'loanerpool.example.org', false, 'a lookalike prefix'],
    ['null',                           'loanerpool.example.org', false, 'an opaque origin'],
    ['garbage',                        'loanerpool.example.org', false, 'not a URL'],
];

foreach ($cases as [$origin, $host, $expected, $why]) {
    $got = Auth::sameHost($origin, $host);
    $check($why, $got === $expected, 'sameHost returned ' . var_export($got, true));
}

echo "\n";

if ($failures === 0) {
    echo "All security decision tables pass.\n";
    exit(0);
}

echo "{$failures} security check(s) FAILED.\n";
exit(1);
