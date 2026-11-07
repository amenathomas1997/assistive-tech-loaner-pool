/**
 * Authentication, sessions, roles and API keys.
 *
 * Two ways in:
 *   Browser  — signed session cookie backed by the `sessions` table.
 *   API      — `Authorization: Bearer lp_<prefix>_<secret>` against `api_keys`.
 *
 * Both populate req.auth with the same shape, so route handlers never care
 * which was used; only the permission checks differ (an API key has scopes, a
 * user has a role).
 */

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { query, queryOne, execute } from '../db.js';
import { getConfig } from '../config.js';
import { HttpError, unauthorized, forbidden, badRequest, randomToken, sha256, toMysqlDateTime, addDays } from './util.js';
import { safeEqual } from './secrets.js';

export const SESSION_COOKIE = 'loaner_session';
const BCRYPT_ROUNDS = 12;

// Failed-login throttling. Deliberately modest: this is an internal tool, and
// locking a tech out of the check-in desk during a clinic is its own problem.
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLES = ['admin', 'tech', 'vrc', 'viewer'];

export const ROLE_LABELS = {
  admin: 'Administrator',
  tech: 'Technician',
  vrc: 'Vocational Rehabilitation Counselor',
  viewer: 'Read-only',
};

/**
 * Capability map. Routes ask for a capability, not a role, so adding a role
 * later means editing this table rather than hunting for role checks.
 */
const CAPABILITIES = {
  admin: [
    'devices.read', 'devices.write', 'devices.import', 'devices.delete',
    'loans.read', 'loans.write', 'loans.cancel',
    'requests.read', 'requests.write', 'requests.approve', 'requests.fulfill',
    'clients.read', 'clients.write',
    'programs.read', 'programs.write',
    'users.read', 'users.write',
    'settings.read', 'settings.write',
    'audit.read', 'reports.read',
    'apikeys.read', 'apikeys.write',
    'scan.use',
  ],
  tech: [
    'devices.read', 'devices.write', 'devices.import',
    'loans.read', 'loans.write', 'loans.cancel',
    'requests.read', 'requests.write', 'requests.approve', 'requests.fulfill',
    'clients.read', 'clients.write',
    'programs.read',
    'users.read',
    'settings.read',
    'audit.read', 'reports.read',
    'scan.use',
  ],
  vrc: [
    'devices.read',
    'loans.read',
    'requests.read', 'requests.write',
    'clients.read', 'clients.write',
    'programs.read',
    'reports.read',
  ],
  viewer: [
    'devices.read', 'loans.read', 'requests.read',
    'clients.read', 'programs.read', 'reports.read', 'audit.read',
  ],
};

export function roleHasCapability(role, capability) {
  return (CAPABILITIES[role] || []).includes(capability);
}

export function capabilitiesForRole(role) {
  return CAPABILITIES[role] ? [...CAPABILITIES[role]] : [];
}

// ---------------------------------------------------------------------------
// API key scopes
//
// Coarse on purpose. Fine-grained scopes are a maintenance burden nobody
// audits; three levels that map cleanly onto capabilities are enough.
// ---------------------------------------------------------------------------

export const API_SCOPES = ['read', 'write', 'admin'];

const SCOPE_CAPABILITIES = {
  read: CAPABILITIES.viewer,
  write: CAPABILITIES.tech,
  admin: CAPABILITIES.admin,
};

function scopesToCapabilities(scopeList) {
  const caps = new Set();
  for (const scope of scopeList) {
    for (const cap of SCOPE_CAPABILITIES[scope] || []) caps.add(cap);
  }
  return [...caps];
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Password rules. Length does the heavy lifting; character-class rules mostly
 * produce "Password1!" so we require one non-letter rather than four classes.
 */
export function validatePassword(password) {
  const problems = [];
  const value = String(password ?? '');

  if (value.length < 12) problems.push('be at least 12 characters long');
  if (value.length > 200) problems.push('be no longer than 200 characters');
  if (!/[a-zA-Z]/.test(value)) problems.push('contain at least one letter');
  if (!/[^a-zA-Z]/.test(value)) problems.push('contain at least one number or symbol');

  const lowered = value.toLowerCase();
  const banned = ['password', 'loanerpool', 'letmein', '12345678', 'qwerty', 'changeme'];
  if (banned.some((bad) => lowered.includes(bad))) {
    problems.push('not contain a common word like "password" or "changeme"');
  }

  if (problems.length) {
    throw badRequest(`Password must ${problems.join(', ')}.`, { field: 'password', problems });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(userId, { ip, userAgent } = {}) {
  const config = getConfig();
  const id = crypto.randomBytes(32).toString('hex');
  const lifetimeDays = Number(config?.session?.lifetimeDays) || 14;
  const expiresAt = addDays(new Date(), lifetimeDays);

  await execute(
    `INSERT INTO sessions (id, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)`,
    [id, userId, ip ?? null, (userAgent ?? '').slice(0, 255) || null, toMysqlDateTime(expiresAt)],
  );

  return { id, expiresAt };
}

export async function loadSession(sessionId) {
  if (!sessionId || !/^[a-f0-9]{64}$/.test(sessionId)) return null;

  const row = await queryOne(
    `SELECT s.id, s.user_id, s.expires_at,
            u.organization_id, u.email, u.full_name, u.role, u.active, u.must_change_password
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > NOW()`,
    [sessionId],
  );

  if (!row || !row.active) return null;
  return row;
}

export async function destroySession(sessionId) {
  if (!sessionId) return;
  await execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
}

export async function destroyAllSessionsForUser(userId) {
  await execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

/** Housekeeping — called on an interval from server.js. */
export async function pruneExpiredSessions() {
  const result = await execute('DELETE FROM sessions WHERE expires_at < NOW()');
  return result.affectedRows;
}

export function sessionCookieOptions(expiresAt) {
  const config = getConfig();
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(config?.session?.secureCookies),
    expires: expiresAt,
    path: '/',
  };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Verify credentials.
 *
 * Returns { ok: false, reason } rather than throwing for bad credentials, so
 * the caller can audit the failure before deciding what to tell the client
 * (which is always the same generic message, regardless of reason).
 */
export async function attemptLogin(emailAddress, password) {
  const user = await queryOne(
    `SELECT id, organization_id, email, password_hash, full_name, role, active,
            failed_logins, locked_until, must_change_password
       FROM users WHERE email = ? LIMIT 1`,
    [String(emailAddress || '').toLowerCase()],
  );

  if (!user) {
    // Spend roughly the same time as a real bcrypt compare so response timing
    // does not reveal whether an address is registered.
    await bcrypt.hash('timing-equalisation-placeholder', BCRYPT_ROUNDS);
    return { ok: false, reason: 'no_such_user' };
  }

  if (!user.active) return { ok: false, reason: 'inactive', user };

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { ok: false, reason: 'locked', user, lockedUntil: user.locked_until };
  }

  const valid = await verifyPassword(password, user.password_hash);

  if (!valid) {
    const failed = Number(user.failed_logins) + 1;
    const shouldLock = failed >= MAX_FAILED_LOGINS;
    await execute(
      `UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?`,
      [
        failed,
        shouldLock ? toMysqlDateTime(new Date(Date.now() + LOCKOUT_MINUTES * 60000)) : null,
        user.id,
      ],
    );
    return { ok: false, reason: 'bad_password', user, attemptsRemaining: Math.max(0, MAX_FAILED_LOGINS - failed) };
  }

  await execute(
    `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?`,
    [user.id],
  );

  return { ok: true, user };
}

// ---------------------------------------------------------------------------
// API keys
//
// Format: lp_<8-char prefix>_<48-char secret>
// The prefix is stored plainly so a key can be identified in the UI and in
// logs; only sha256(full key) is stored for verification.
// ---------------------------------------------------------------------------

export function generateApiKey() {
  const prefix = crypto.randomBytes(4).toString('hex'); // 8 chars
  const secret = randomToken(24); // 48 chars
  const plaintext = `lp_${prefix}_${secret}`;
  return { plaintext, prefix, hash: sha256(plaintext) };
}

export async function verifyApiKey(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext.startsWith('lp_')) return null;

  const row = await queryOne(
    `SELECT k.*, o.name AS organization_name
       FROM api_keys k
       JOIN organizations o ON o.id = k.organization_id
      WHERE k.key_hash = ?
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > NOW())
      LIMIT 1`,
    [sha256(plaintext)],
  );

  if (!row) return null;

  // Defence in depth: the lookup was by hash, but compare again in constant
  // time so a hash-collision or a future index change cannot become a bypass.
  if (!safeEqual(row.key_hash, sha256(plaintext))) return null;

  // Fire-and-forget; last_used_at is telemetry, not correctness.
  execute('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [row.id]).catch(() => {});

  return row;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Populate req.auth if a valid session cookie or API key is present.
 * Never rejects — that is the job of requireAuth / requireCapability, so that
 * public routes and the installer can share the same pipeline.
 */
export async function attachAuth(req, res, next) {
  try {
    const header = req.get('authorization') || '';

    if (header.toLowerCase().startsWith('bearer ')) {
      const token = header.slice(7).trim();
      const key = await verifyApiKey(token);
      if (key) {
        const scopes = String(key.scopes || 'read').split(/[,\s]+/).filter(Boolean);
        req.auth = {
          actorType: 'api_key',
          apiKeyId: key.id,
          organizationId: key.organization_id,
          userId: null,
          label: `API key: ${key.name}`,
          role: null,
          scopes,
          capabilities: scopesToCapabilities(scopes),
          ip: req.ip,
        };
      }
      return next();
    }

    const sessionId = req.cookies?.[SESSION_COOKIE];
    if (sessionId) {
      const session = await loadSession(sessionId);
      if (session) {
        req.auth = {
          actorType: 'user',
          sessionId: session.id,
          userId: session.user_id,
          organizationId: session.organization_id,
          email: session.email,
          fullName: session.full_name,
          label: session.full_name,
          role: session.role,
          mustChangePassword: Boolean(session.must_change_password),
          capabilities: capabilitiesForRole(session.role),
          ip: req.ip,
        };
      } else {
        // Stale or revoked cookie — clear it so the browser stops sending it.
        res.clearCookie(SESSION_COOKIE, { path: '/' });
      }
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.auth) return next(unauthorized());
  return next();
}

/**
 * Gate a route on a capability. Works identically for sessions and API keys.
 */
export function requireCapability(capability) {
  return (req, res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!req.auth.capabilities?.includes(capability)) {
      return next(
        new HttpError(403, 'forbidden', `This action requires the "${capability}" permission.`, {
          required: capability,
          role: req.auth.role,
          scopes: req.auth.scopes,
        }),
      );
    }
    return next();
  };
}

/** Restrict to specific roles. Prefer requireCapability where possible. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return next(unauthorized());
    if (req.auth.actorType === 'api_key') {
      // API keys have scopes, not roles. Treat "admin" scope as admin role.
      if (roles.includes('admin') && req.auth.scopes?.includes('admin')) return next();
      return next(forbidden('This endpoint is not available to API keys with these scopes.'));
    }
    if (!roles.includes(req.auth.role)) {
      return next(forbidden(`This action is restricted to: ${roles.map((r) => ROLE_LABELS[r] || r).join(', ')}.`));
    }
    return next();
  };
}

/**
 * A VRC may only see their own requests and their own clients. Routes call
 * this to decide whether to add an ownership filter to their query.
 */
export function isRestrictedToOwnRecords(auth) {
  return auth?.actorType === 'user' && auth.role === 'vrc';
}
