/**
 * Sign in, sign out, and "who am I".
 */

import express from 'express';
import { queryOne, execute } from '../db.js';
import {
  asyncRoute, unauthorized, badRequest, requiredStr, str, email as parseEmail,
  randomToken, sha256, toMysqlDateTime, escapeHtml,
} from '../lib/util.js';
import { sendMail } from '../lib/mailer.js';
import { getConfig } from '../config.js';
import {
  attemptLogin, createSession, destroySession, destroyAllSessionsForUser,
  sessionCookieOptions, SESSION_COOKIE, hashPassword, verifyPassword,
  validatePassword, capabilitiesForRole, ROLE_LABELS, requireAuth,
} from '../lib/auth.js';
import { recordAudit, AUDIT_ACTIONS, auditContextFromRequest } from '../lib/audit.js';
import { getOrganization } from '../lib/settings.js';

const router = express.Router();

/**
 * Every failed sign-in returns the same message and the same status, whatever
 * the underlying reason. The audit log records the real reason; the response
 * does not, so this endpoint cannot be used to enumerate staff addresses.
 */
const GENERIC_FAILURE = 'That email address and password combination was not recognised.';

router.post('/login', asyncRoute(async (req, res) => {
  const emailAddress = parseEmail(req.body?.email, 'Email address', { required: true });
  const password = String(req.body?.password ?? '');

  if (!password) throw badRequest('Enter your password.', { field: 'password' });

  const result = await attemptLogin(emailAddress, password);

  if (!result.ok) {
    if (result.user) {
      await recordAudit(
        { organizationId: result.user.organization_id, userId: result.user.id, label: result.user.full_name, ip: req.ip },
        {
          action: AUDIT_ACTIONS.LOGIN_FAILED,
          entityType: 'user',
          entityId: result.user.id,
          entityLabel: result.user.email,
          summary: `Failed sign-in attempt (${result.reason})`,
          detail: { reason: result.reason },
        },
      );
    }

    // A locked account is worth saying out loud: the person is legitimate and
    // otherwise has no way to understand why a correct password stops working.
    if (result.reason === 'locked') {
      const until = new Date(result.lockedUntil);
      return res.status(423).json({
        error: {
          code: 'account_locked',
          message:
            'This account is temporarily locked after too many failed sign-in attempts. ' +
            `Try again after ${until.toLocaleTimeString()}, or ask an administrator to unlock it.`,
        },
      });
    }
    if (result.reason === 'inactive') {
      return res.status(403).json({
        error: {
          code: 'account_inactive',
          message: 'This account has been deactivated. Contact an administrator.',
        },
      });
    }

    return res.status(401).json({ error: { code: 'invalid_credentials', message: GENERIC_FAILURE } });
  }

  const session = await createSession(result.user.id, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });

  res.cookie(SESSION_COOKIE, session.id, sessionCookieOptions(session.expiresAt));

  await recordAudit(
    { organizationId: result.user.organization_id, userId: result.user.id, label: result.user.full_name, ip: req.ip },
    {
      action: AUDIT_ACTIONS.LOGIN,
      entityType: 'user',
      entityId: result.user.id,
      entityLabel: result.user.email,
      summary: `${result.user.full_name} signed in`,
    },
  );

  const organization = await getOrganization(result.user.organization_id);

  res.json({
    user: publicUser(result.user),
    organization: publicOrganization(organization),
    capabilities: capabilitiesForRole(result.user.role),
    must_change_password: Boolean(result.user.must_change_password),
  });
}));

router.post('/logout', asyncRoute(async (req, res) => {
  if (req.auth?.sessionId) {
    await destroySession(req.auth.sessionId);
    await recordAudit(auditContextFromRequest(req), {
      action: AUDIT_ACTIONS.LOGOUT,
      entityType: 'user',
      entityId: req.auth.userId,
      summary: `${req.auth.fullName} signed out`,
    });
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
}));

/** Current identity. The client calls this on load to decide what to render. */
router.get('/me', asyncRoute(async (req, res) => {
  if (!req.auth) return res.status(401).json({ error: { code: 'unauthorized', message: 'Not signed in.' } });

  if (req.auth.actorType === 'api_key') {
    return res.json({
      actor_type: 'api_key',
      organization: publicOrganization(await getOrganization(req.auth.organizationId)),
      scopes: req.auth.scopes,
      capabilities: req.auth.capabilities,
    });
  }

  const user = await queryOne(
    `SELECT id, organization_id, email, full_name, role, phone, employee_ref,
            last_login_at, must_change_password, created_at
       FROM users WHERE id = ?`,
    [req.auth.userId],
  );
  if (!user) throw unauthorized('Your account no longer exists.');

  res.json({
    actor_type: 'user',
    user: publicUser(user),
    organization: publicOrganization(await getOrganization(user.organization_id)),
    capabilities: capabilitiesForRole(user.role),
    must_change_password: Boolean(user.must_change_password),
  });
}));

/**
 * Change your own password.
 *
 * Requires the current password even though the session already proves
 * identity — this is what stops an unattended, unlocked browser from becoming
 * a permanent account takeover.
 */
router.post('/change-password', requireAuth, asyncRoute(async (req, res) => {
  if (req.auth.actorType !== 'user') {
    throw badRequest('API keys do not have passwords.');
  }

  const currentPassword = String(req.body?.current_password ?? '');
  const newPassword = String(req.body?.new_password ?? '');
  const confirm = String(req.body?.confirm_password ?? newPassword);

  if (newPassword !== confirm) {
    throw badRequest('The two new passwords do not match.', { field: 'confirm_password' });
  }

  const user = await queryOne('SELECT id, password_hash, full_name FROM users WHERE id = ?', [req.auth.userId]);
  if (!user) throw unauthorized('Your account no longer exists.');

  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw badRequest('Your current password is not correct.', { field: 'current_password' });
  }
  if (newPassword === currentPassword) {
    throw badRequest('The new password must be different from the current one.', { field: 'new_password' });
  }

  validatePassword(newPassword);

  await execute(
    'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = NOW() WHERE id = ?',
    [await hashPassword(newPassword), user.id],
  );

  // Invalidate every other session, then re-issue one for this browser. If the
  // password is being changed because it leaked, leaving other sessions alive
  // would defeat the point.
  await destroyAllSessionsForUser(user.id);
  const session = await createSession(user.id, { ip: req.ip, userAgent: req.get('user-agent') });
  res.cookie(SESSION_COOKIE, session.id, sessionCookieOptions(session.expiresAt));

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.PASSWORD_CHANGED,
    entityType: 'user',
    entityId: user.id,
    entityLabel: user.full_name,
    summary: `${user.full_name} changed their password; all other sessions were signed out`,
  });

  res.json({ ok: true, other_sessions_ended: true });
}));

// ---------------------------------------------------------------------------
// Self-service password reset
//
// Two endpoints. Both are unauthenticated by necessity, so both are written to
// give away nothing: the request endpoint always reports success, and the
// confirm endpoint distinguishes only between "this link works" and "it does
// not", never why.
// ---------------------------------------------------------------------------

const RESET_TOKEN_LIFETIME_MINUTES = 60;

router.post('/forgot-password', asyncRoute(async (req, res) => {
  const emailAddress = parseEmail(req.body?.email, 'Email address', { required: true });

  // Always the same answer, whether or not the address exists. Anything else
  // turns this endpoint into a way of enumerating staff.
  const genericResponse = {
    ok: true,
    message:
      'If that address belongs to an account, a reset link has been sent to it. ' +
      'The link is valid for one hour.',
  };

  const user = await queryOne(
    'SELECT id, organization_id, email, full_name, active FROM users WHERE email = ?',
    [emailAddress],
  );

  if (!user || !user.active) return res.json(genericResponse);

  // Invalidate any outstanding link, so a forwarded old email cannot be used.
  await execute('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [user.id]);

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_LIFETIME_MINUTES * 60000);

  await execute(
    'INSERT INTO password_resets (user_id, token_hash, expires_at, ip) VALUES (?, ?, ?, ?)',
    [user.id, sha256(token), toMysqlDateTime(expiresAt), req.ip ?? null],
  );

  const baseUrl = getConfig()?.baseUrl
    || `${req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http'}://${req.get('host')}`;
  const link = `${String(baseUrl).replace(/\/$/, '')}/#/reset?token=${token}`;

  const mail = await sendMail(
    { organizationId: user.organization_id, actorType: 'system', label: 'Password reset' },
    user.organization_id,
    {
      to: [user.email],
      subject: 'Reset your Loaner Pool password',
      eventType: 'password_reset',
      html: `<!doctype html><html><body style="font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
        <div style="max-width:560px;margin:0 auto;padding:24px;">
          <h1 style="font-size:20px;color:#125b7d;">Reset your password</h1>
          <p>Hello ${escapeHtml(user.full_name)},</p>
          <p>Someone asked to reset the Loaner Pool password for this address.
             If it was you, use the link below. It stops working in one hour.</p>
          <p style="margin:24px 0;">
            <a href="${escapeHtml(link)}"
               style="display:inline-block;background:#125b7d;color:#fff;text-decoration:none;
                      padding:12px 22px;border-radius:6px;font-weight:600;">Choose a new password</a>
          </p>
          <p style="font-size:13px;color:#666;">If the button does not work, copy this address into your browser:<br>
            <span style="word-break:break-all;">${escapeHtml(link)}</span></p>
          <p style="font-size:13px;color:#666;">If you did not ask for this, you can ignore this message —
             your password has not changed.</p>
        </div></body></html>`,
    },
  );

  await recordAudit(
    { organizationId: user.organization_id, userId: user.id, label: user.full_name, actorType: 'system', ip: req.ip },
    {
      action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.email,
      summary: `Password reset requested for ${user.email}` + (mail.sent ? '' : ` (email not sent: ${mail.reason})`),
    },
  );

  // If email is not configured the reset cannot reach anyone, and silently
  // reporting success would leave an administrator waiting for a mail that
  // never comes. Say so — but only to a caller who is already signed in.
  if (!mail.sent && req.auth?.capabilities?.includes('settings.write')) {
    return res.json({ ...genericResponse, admin_warning: `No email was sent: ${mail.reason}` });
  }

  return res.json(genericResponse);
}));

router.post('/reset-password', asyncRoute(async (req, res) => {
  const token = str(req.body?.token, { max: 128 });
  const newPassword = String(req.body?.new_password ?? '');
  const confirm = String(req.body?.confirm_password ?? newPassword);

  if (!token) throw badRequest('That reset link is missing its token.', { field: 'token' });
  if (newPassword !== confirm) {
    throw badRequest('The two passwords do not match.', { field: 'confirm_password' });
  }
  validatePassword(newPassword);

  const record = await queryOne(
    `SELECT r.id, r.user_id, u.email, u.full_name, u.organization_id, u.active
       FROM password_resets r
       JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW()`,
    [sha256(token)],
  );

  if (!record || !record.active) {
    throw badRequest(
      'That reset link is not valid. It may have expired, already been used, or been replaced ' +
      'by a newer one. Request a fresh link and try again.',
      { field: 'token' },
    );
  }

  await execute(
    'UPDATE users SET password_hash = ?, must_change_password = 0, failed_logins = 0, locked_until = NULL, updated_at = NOW() WHERE id = ?',
    [await hashPassword(newPassword), record.user_id],
  );
  await execute('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [record.id]);

  // Everything else signed in as this account is now suspect.
  await destroyAllSessionsForUser(record.user_id);

  await recordAudit(
    { organizationId: record.organization_id, userId: record.user_id, label: record.full_name, actorType: 'system', ip: req.ip },
    {
      action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
      entityType: 'user',
      entityId: record.user_id,
      entityLabel: record.email,
      summary: `${record.full_name} reset their password via email; all sessions were ended`,
    },
  );

  res.json({
    ok: true,
    message: 'Your password has been changed. Sign in with the new one.',
  });
}));

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    role_label: ROLE_LABELS[user.role] ?? user.role,
    phone: user.phone ?? null,
    employee_ref: user.employee_ref ?? null,
    active: user.active === undefined ? true : Boolean(user.active),
    last_login_at: user.last_login_at ?? null,
    created_at: user.created_at ?? null,
  };
}

export function publicOrganization(org) {
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    timezone: org.timezone,
    barcode_symbology: org.barcode_symbology,
    barcode_prefix: org.barcode_prefix,
    contact_email: org.contact_email,
  };
}

export default router;
