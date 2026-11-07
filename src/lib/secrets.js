/**
 * Encryption for settings that must not sit in the database as plaintext —
 * principally the Microsoft Graph client secret an admin pastes into the UI.
 *
 * AES-256-GCM with a key derived from the install's appKey. This protects
 * against a database dump (a stolen SQL backup, a leaked phpMyAdmin session).
 * It does NOT protect against an attacker who already has the config file,
 * since the key is derived from it — that is the accepted limit of what a
 * self-hosted app with no external key store can offer.
 */

import crypto from 'node:crypto';
import { getConfig } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function keyFor() {
  const config = getConfig();
  if (!config?.appKey) {
    throw new Error('Cannot encrypt settings: application key is missing from config.');
  }
  // appKey is 32 random bytes hex-encoded; hash it so we get exactly 32 bytes
  // regardless of how it was generated or migrated.
  return crypto.createHash('sha256').update(config.appKey).digest();
}

/** Returns "enc:v1:<iv>:<tag>:<ciphertext>", all base64url. */
export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFor(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    PREFIX + iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypt a value produced by encryptSecret. Values without the prefix are
 * returned as-is so a hand-edited plaintext row still works.
 * Returns null if the ciphertext fails authentication (wrong key, tampering).
 */
export function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === '') return null;
  const value = String(stored);
  if (!value.startsWith(PREFIX)) return value;

  try {
    const body = value.slice(PREFIX.length);
    const [ivB64, tagB64, dataB64] = body.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;

    const decipher = crypto.createDecipheriv(ALGORITHM, keyFor(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    // Wrong key or corrupted value. Callers treat null as "not configured",
    // which surfaces in the UI as a prompt to re-enter the secret.
    return null;
  }
}

/**
 * Render a secret for display: never the value, just enough to confirm which
 * credential is stored.
 */
export function maskSecret(plaintext) {
  if (!plaintext) return null;
  const s = String(plaintext);
  if (s.length <= 4) return '••••';
  return `••••••••${s.slice(-4)}`;
}

/** Constant-time string comparison, for tokens and hashes. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
