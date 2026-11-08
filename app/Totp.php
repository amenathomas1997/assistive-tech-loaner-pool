<?php
/**
 * Time-based one-time passwords (RFC 6238).
 *
 * Implemented here rather than pulled in, because this application has no
 * Composer step: a dependency would mean telling an administrator on cPanel to
 * run something they cannot run. The algorithm is small, fixed, and testable
 * against the published vectors, which is done in scripts/verify-totp.php.
 *
 * An administrator account reaches every client record in the agency, so this
 * exists for them. It is optional per user and can be required for admins by
 * an organisation that wants it.
 */

declare(strict_types=1);

namespace Loaner;

final class Totp
{
    /** Seconds per code. Thirty is what every authenticator app assumes. */
    public const PERIOD = 30;

    /** Digits per code. Six, for the same reason. */
    public const DIGITS = 6;

    /**
     * How many periods either side of now are accepted.
     *
     * One step is ±30 seconds, which covers a phone whose clock has drifted
     * and the very common case of typing the code as it rolls over. Wider
     * would start to matter: each extra step is another window in which a
     * code read over somebody's shoulder still works.
     */
    private const DRIFT = 1;

    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** A fresh secret, base32 as the apps expect. */
    public static function generateSecret(int $bytes = 20): string
    {
        return self::base32Encode(random_bytes($bytes));
    }

    /**
     * The code for a given moment.
     *
     * @param string $secret base32, as stored and as shown to the user
     */
    public static function codeAt(string $secret, ?int $timestamp = null): string
    {
        $key     = self::base32Decode($secret);
        $counter = intdiv($timestamp ?? time(), self::PERIOD);

        return self::hotp($key, $counter);
    }

    /**
     * Is this the right code?
     *
     * Compared with hash_equals so the time taken does not reveal how much of
     * a guess was correct.
     */
    public static function verify(string $secret, string $code, ?int $timestamp = null): bool
    {
        $code = preg_replace('/[^0-9]/', '', $code) ?? '';

        if (strlen($code) !== self::DIGITS) {
            return false;
        }

        $key = self::base32Decode($secret);

        if ($key === '') {
            return false;
        }

        $counter = intdiv($timestamp ?? time(), self::PERIOD);

        for ($offset = -self::DRIFT; $offset <= self::DRIFT; $offset++) {
            if (hash_equals(self::hotp($key, $counter + $offset), $code)) {
                return true;
            }
        }

        return false;
    }

    /** HOTP (RFC 4226): HMAC-SHA1, dynamic truncation, modulo 10^digits. */
    private static function hotp(string $key, int $counter): string
    {
        // Eight-byte big-endian counter. pack('J') would do it on 64-bit PHP,
        // but building it by hand works the same on any build.
        $bytes = '';
        for ($i = 7; $i >= 0; $i--) {
            $bytes = chr($counter & 0xFF) . $bytes;
            $counter >>= 8;
        }

        $hash = hash_hmac('sha1', $bytes, $key, true);

        // Dynamic truncation: the low nibble of the last byte picks where to
        // read four bytes from, and the top bit is masked off so the result is
        // always a positive 31-bit integer.
        $offset = ord($hash[19]) & 0x0F;

        $value = ((ord($hash[$offset])     & 0x7F) << 24)
               | ((ord($hash[$offset + 1]) & 0xFF) << 16)
               | ((ord($hash[$offset + 2]) & 0xFF) << 8)
               |  (ord($hash[$offset + 3]) & 0xFF);

        return str_pad(
            (string) ($value % (10 ** self::DIGITS)),
            self::DIGITS,
            '0',
            STR_PAD_LEFT,
        );
    }

    /**
     * The otpauth:// URI an authenticator app scans.
     *
     * The label carries the organisation and the account so somebody with
     * several of these can tell them apart in the app.
     */
    public static function provisioningUri(string $secret, string $account, string $issuer): string
    {
        $label = rawurlencode($issuer) . ':' . rawurlencode($account);

        // Only secret and issuer. algorithm=SHA1, digits=6 and period=30 are
        // the defaults every authenticator assumes, and stating them costs
        // about forty characters — which, on a long agency name and a long
        // email address, is the difference between a QR that fits and one
        // that has to be typed in by hand.
        //
        // RFC3986 encoding, not the default: http_build_query writes a space
        // as "+", and several apps read that literally, so the account shows
        // up as "Loaner+Pool".
        return 'otpauth://totp/' . $label . '?' . http_build_query(
            ['secret' => $secret, 'issuer' => $issuer],
            '',
            '&',
            PHP_QUERY_RFC3986,
        );
    }

    /**
     * Group the secret for reading aloud or typing in.
     *
     * Some apps, and anyone whose phone camera will not focus, need the secret
     * entered by hand.
     */
    public static function formatSecret(string $secret): string
    {
        return trim(chunk_split($secret, 4, ' '));
    }

    // -----------------------------------------------------------------------
    // Base32 (RFC 4648), without padding, which is what authenticators use
    // -----------------------------------------------------------------------

    public static function base32Encode(string $bytes): string
    {
        if ($bytes === '') {
            return '';
        }

        $bits = '';
        foreach (str_split($bytes) as $byte) {
            $bits .= str_pad(decbin(ord($byte)), 8, '0', STR_PAD_LEFT);
        }

        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::ALPHABET[bindec(str_pad($chunk, 5, '0', STR_PAD_RIGHT))];
        }

        return $out;
    }

    public static function base32Decode(string $secret): string
    {
        // Tolerant of how the secret comes back: spaces from a typed entry,
        // lower case from a paste, padding from another implementation.
        $clean = strtoupper(preg_replace('/[^A-Za-z2-7]/', '', $secret) ?? '');

        if ($clean === '') {
            return '';
        }

        $bits = '';
        foreach (str_split($clean) as $char) {
            $index = strpos(self::ALPHABET, $char);
            if ($index === false) {
                return '';
            }
            $bits .= str_pad(decbin($index), 5, '0', STR_PAD_LEFT);
        }

        $out = '';
        foreach (str_split($bits, 8) as $chunk) {
            if (strlen($chunk) === 8) {
                $out .= chr(bindec($chunk));
            }
        }

        return $out;
    }

    // -----------------------------------------------------------------------
    // Recovery codes
    // -----------------------------------------------------------------------

    /**
     * Codes for getting back in without the phone.
     *
     * The commonest two-factor failure is not an attacker; it is a lost or
     * replaced handset. Without these, the only way back in is an
     * administrator — and if that person WAS the administrator, there is none.
     *
     * Stored hashed, so a database dump does not hand over a way past the
     * second factor.
     *
     * @return array<int, string> the plaintext codes, shown exactly once
     */
    public static function issueRecoveryCodes(int $userId, int $count = 10): array
    {
        Db::execute('DELETE FROM totp_recovery_codes WHERE user_id = ?', [$userId]);

        $codes = [];

        for ($i = 0; $i < $count; $i++) {
            // Grouped and from the unambiguous alphabet, because these get
            // written on paper and read back later.
            $code = Util::randomCode(5) . '-' . Util::randomCode(5);

            Db::execute(
                'INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES (?, ?)',
                [$userId, Util::sha256(self::normaliseRecovery($code))],
            );

            $codes[] = $code;
        }

        return $codes;
    }

    /** Spend a recovery code. Each works once. */
    public static function consumeRecoveryCode(int $userId, string $code): bool
    {
        $hash = Util::sha256(self::normaliseRecovery($code));

        // One statement, and the answer is how many rows it changed. A SELECT
        // followed by an UPDATE lets two simultaneous attempts with the same
        // code both see it unused, turning one single-use code into two
        // signed-in sessions.
        $claimed = Db::execute(
            'UPDATE totp_recovery_codes SET used_at = NOW()
              WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
            [$userId, $hash],
        );

        return $claimed === 1;
    }

    public static function remainingRecoveryCodes(int $userId): int
    {
        return (int) Db::value(
            'SELECT COUNT(*) FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL',
            [$userId],
        );
    }

    private static function normaliseRecovery(string $code): string
    {
        return strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $code) ?? '');
    }
}
