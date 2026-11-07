<?php
/**
 * Encryption for settings that must not sit in the database as plaintext —
 * principally the Microsoft Graph client secret an admin pastes into the UI.
 *
 * AES-256-GCM with a key derived from the install's appKey. This protects
 * against a database dump: a stolen SQL backup or a leaked phpMyAdmin session.
 * It does NOT protect against someone who already has the config file, since
 * the key is derived from it — that is the accepted limit of what a
 * self-hosted app with no external key store can offer.
 */

declare(strict_types=1);

namespace Loaner;

final class Secrets
{
    private const CIPHER = 'aes-256-gcm';
    private const PREFIX = 'enc:v1:';
    private const TAG_LENGTH = 16;

    /**
     * appKey is 32 random bytes hex-encoded; hash it so we get exactly 32
     * bytes regardless of how it was generated or migrated.
     */
    private static function key(): string
    {
        return hash('sha256', Config::appKey(), true);
    }

    /** Returns "enc:v1:<iv>:<tag>:<ciphertext>", each part base64url. */
    public static function encrypt(?string $plaintext): ?string
    {
        if ($plaintext === null || $plaintext === '') {
            return null;
        }

        $iv  = random_bytes(12);
        $tag = '';

        $ciphertext = openssl_encrypt(
            $plaintext,
            self::CIPHER,
            self::key(),
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
            '',
            self::TAG_LENGTH,
        );

        if ($ciphertext === false) {
            throw new \RuntimeException('Could not encrypt the value.');
        }

        return self::PREFIX . self::b64($iv) . ':' . self::b64($tag) . ':' . self::b64($ciphertext);
    }

    /**
     * Decrypt a value produced by encrypt(). Values without the prefix are
     * returned as-is, so a hand-edited plaintext row still works.
     *
     * Returns null when authentication fails (wrong key, tampering). Callers
     * treat null as "not configured", which surfaces in the UI as a prompt to
     * re-enter the secret rather than an unexplained failure.
     */
    public static function decrypt(?string $stored): ?string
    {
        if ($stored === null || $stored === '') {
            return null;
        }

        if (!str_starts_with($stored, self::PREFIX)) {
            return $stored;
        }

        $parts = explode(':', substr($stored, strlen(self::PREFIX)));
        if (count($parts) !== 3) {
            return null;
        }

        [$iv, $tag, $data] = array_map([self::class, 'unb64'], $parts);

        if ($iv === false || $tag === false || $data === false) {
            return null;
        }

        $plaintext = openssl_decrypt(
            $data,
            self::CIPHER,
            self::key(),
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
        );

        return $plaintext === false ? null : $plaintext;
    }

    /**
     * Render a secret for display: never the value, just enough to confirm
     * which credential is stored.
     */
    public static function mask(?string $plaintext): ?string
    {
        if ($plaintext === null || $plaintext === '') {
            return null;
        }

        if (strlen($plaintext) <= 4) {
            return '••••';
        }

        return '••••••••' . substr($plaintext, -4);
    }

    private static function b64(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }

    private static function unb64(string $encoded): string|false
    {
        return base64_decode(strtr($encoded, '-_', '+/'), true);
    }
}
