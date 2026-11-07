/**
 * Administration: organisation profile, loan periods, settings (including the
 * Microsoft Graph mail configuration) and API keys.
 */

import express from 'express';
import { query, queryOne, execute, transaction } from '../db.js';
import {
  asyncRoute, str, requiredStr, int, bool, oneOf, notFound, badRequest, conflict,
  email as parseEmail, randomToken,
} from '../lib/util.js';
import {
  requireCapability, requireRole, generateApiKey, API_SCOPES,
} from '../lib/auth.js';
import { auditContextFromRequest, recordAudit, AUDIT_ACTIONS, diffRecords } from '../lib/audit.js';
import {
  getSettingsForClient, updateSettings, getOrganization, getLoanPeriods,
  SETTING_DEFINITIONS, SETTING_GROUPS,
} from '../lib/settings.js';
import { getMailConfig, sendTestEmail, recentEmails } from '../lib/mailer.js';
import { SYMBOLOGIES } from '../lib/barcode.js';
import { publicOrganization } from './auth.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

router.get('/organization', requireCapability('settings.read'), asyncRoute(async (req, res) => {
  res.json({ organization: publicOrganization(await getOrganization(req.auth.organizationId)) });
}));

router.patch('/organization', requireCapability('settings.write'), asyncRoute(async (req, res) => {
  const before = await getOrganization(req.auth.organizationId);

  const data = {};
  if ('name' in (req.body ?? {})) data.name = requiredStr(req.body.name, 'Organisation name', { max: 190 });
  if ('timezone' in (req.body ?? {})) data.timezone = str(req.body.timezone, { max: 64 }) || 'UTC';
  if ('contact_email' in (req.body ?? {})) data.contact_email = parseEmail(req.body.contact_email, 'Contact email');
  if ('barcode_symbology' in (req.body ?? {})) {
    data.barcode_symbology = oneOf(req.body.barcode_symbology, SYMBOLOGIES, 'barcode_symbology', { required: true });
  }
  if ('barcode_prefix' in (req.body ?? {})) {
    const prefix = String(req.body.barcode_prefix ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!prefix) throw badRequest('The barcode prefix must contain at least one letter or number.', {
      field: 'barcode_prefix',
    });
    data.barcode_prefix = prefix;
  }

  if (!Object.keys(data).length) throw badRequest('No changes were supplied.');

  const fields = Object.keys(data);
  await execute(
    `UPDATE organizations SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
    [...fields.map((f) => data[f]), req.auth.organizationId],
  );

  const after = await getOrganization(req.auth.organizationId);

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.SETTINGS_UPDATED,
    entityType: 'organization',
    entityId: req.auth.organizationId,
    entityLabel: after.name,
    summary: `Updated organisation profile: ${fields.join(', ')}`,
    detail: { changes: diffRecords(before, after, fields) },
  });

  res.json({
    organization: publicOrganization(after),
    // Changing symbology does not change any barcode value, but every printed
    // label is now the wrong shape. Say so rather than letting it be discovered.
    notice: data.barcode_symbology && data.barcode_symbology !== before.barcode_symbology
      ? `Barcode values are unchanged, but existing printed labels are ${before.barcode_symbology.toUpperCase()} ` +
        `and new ones will be ${data.barcode_symbology.toUpperCase()}. Reprint labels for any device you want to ` +
        'scan with the new symbology.'
      : null,
  });
}));

// ---------------------------------------------------------------------------
// Loan periods
// ---------------------------------------------------------------------------

router.get('/loan-periods', requireCapability('settings.read'), asyncRoute(async (req, res) => {
  res.json({ data: await getLoanPeriods(req.auth.organizationId, { includeInactive: true }) });
}));

router.post('/loan-periods', requireCapability('settings.write'), asyncRoute(async (req, res) => {
  const data = readPeriodBody(req.body, true);

  const period = await transaction(async (conn) => {
    if (data.is_default) await clearDefault(conn, req.auth.organizationId);

    const [result] = await conn.execute(
      `INSERT INTO loan_periods
         (organization_id, name, days, is_default, max_extensions, extension_days, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.auth.organizationId, data.name, data.days, data.is_default ? 1 : 0,
        data.max_extensions, data.extension_days, data.sort_order,
      ],
    );

    const [rows] = await conn.execute('SELECT * FROM loan_periods WHERE id = ?', [result.insertId]);
    return rows[0];
  }).catch((err) => {
    if (err?.code === 'ER_DUP_ENTRY') {
      throw conflict('A loan period with that name already exists.', { field: 'name' });
    }
    throw err;
  });

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.PERIOD_CREATED,
    entityType: 'loan_period',
    entityId: period.id,
    entityLabel: period.name,
    summary: `Added loan period "${period.name}" (${period.days === 0 ? 'open ended' : `${period.days} days`})`,
  });

  res.status(201).json({ loan_period: period });
}));

router.patch('/loan-periods/:id', requireCapability('settings.write'), asyncRoute(async (req, res) => {
  const periodId = Number(req.params.id);
  const before = await queryOne(
    'SELECT * FROM loan_periods WHERE id = ? AND organization_id = ?',
    [periodId, req.auth.organizationId],
  );
  if (!before) throw notFound('That loan period does not exist.');

  const data = readPeriodBody(req.body, false);
  const fields = Object.keys(data).filter((key) => key in (req.body ?? {}));
  if (!fields.length) throw badRequest('No changes were supplied.');

  // Deactivating the default would leave check-out with nothing to fall back on.
  if (data.active === 0 && before.is_default) {
    throw badRequest(
      'This is the default loan period. Make another period the default before deactivating this one.',
    );
  }

  const after = await transaction(async (conn) => {
    if (data.is_default) await clearDefault(conn, req.auth.organizationId);

    await conn.execute(
      `UPDATE loan_periods SET ${fields.map((f) => `${f} = ?`).join(', ')}
        WHERE id = ? AND organization_id = ?`,
      [...fields.map((f) => data[f]), periodId, req.auth.organizationId],
    );

    const [rows] = await conn.execute('SELECT * FROM loan_periods WHERE id = ?', [periodId]);
    return rows[0];
  });

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.PERIOD_UPDATED,
    entityType: 'loan_period',
    entityId: periodId,
    entityLabel: after.name,
    summary: `Updated loan period "${after.name}": ${fields.join(', ')}`,
    detail: { changes: diffRecords(before, after, fields) },
  });

  res.json({ loan_period: after });
}));

/**
 * Periods already used by a loan are deactivated rather than deleted, so
 * historic loans keep showing which policy they were issued under.
 */
router.delete('/loan-periods/:id', requireCapability('settings.write'), asyncRoute(async (req, res) => {
  const periodId = Number(req.params.id);
  const period = await queryOne(
    'SELECT * FROM loan_periods WHERE id = ? AND organization_id = ?',
    [periodId, req.auth.organizationId],
  );
  if (!period) throw notFound('That loan period does not exist.');

  if (period.is_default) {
    throw badRequest('This is the default loan period. Make another period the default first.');
  }

  const usage = await queryOne('SELECT COUNT(*) AS n FROM loans WHERE loan_period_id = ?', [periodId]);

  if (Number(usage.n) > 0) {
    await execute('UPDATE loan_periods SET active = 0 WHERE id = ?', [periodId]);
    await recordAudit(auditContextFromRequest(req), {
      action: AUDIT_ACTIONS.PERIOD_UPDATED,
      entityType: 'loan_period',
      entityId: periodId,
      entityLabel: period.name,
      summary: `Deactivated loan period "${period.name}" (kept because ${usage.n} loan(s) reference it)`,
    });
    return res.json({
      ok: true,
      deactivated: true,
      deleted: false,
      message:
        `"${period.name}" is used by ${usage.n} loan(s), so it was deactivated rather than deleted. ` +
        'It will no longer be offered at check-out, and existing loans keep their history.',
    });
  }

  await execute('DELETE FROM loan_periods WHERE id = ?', [periodId]);
  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.PERIOD_DELETED,
    entityType: 'loan_period',
    entityId: periodId,
    entityLabel: period.name,
    summary: `Deleted unused loan period "${period.name}"`,
  });

  res.json({ ok: true, deactivated: false, deleted: true });
}));

async function clearDefault(conn, organizationId) {
  await conn.execute('UPDATE loan_periods SET is_default = 0 WHERE organization_id = ?', [organizationId]);
}

function readPeriodBody(body, isCreate) {
  const data = {
    name: isCreate
      ? requiredStr(body?.name, 'Period name', { max: 120 })
      : str(body?.name, { max: 120 }),
    days: isCreate
      ? (int(body?.days, 'days', { min: 0, max: 3650 }) ?? 30)
      : int(body?.days, 'days', { min: 0, max: 3650 }),
    is_default: bool(body?.is_default, false) ? 1 : 0,
    max_extensions: int(body?.max_extensions, 'max_extensions', { min: 0, max: 50 }) ?? (isCreate ? 2 : undefined),
    extension_days: int(body?.extension_days, 'extension_days', { min: 0, max: 365 }) ?? (isCreate ? 14 : undefined),
    sort_order: int(body?.sort_order, 'sort_order', { min: 0, max: 1000 }) ?? 0,
  };
  if (!isCreate) data.active = body?.active === undefined ? undefined : (bool(body.active) ? 1 : 0);
  return data;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.get('/settings', requireCapability('settings.read'), asyncRoute(async (req, res) => {
  const settings = await getSettingsForClient(req.auth.organizationId);
  const mail = await getMailConfig(req.auth.organizationId);

  res.json({
    settings,
    // Schema so the UI can render controls without hard-coding every key.
    definitions: Object.fromEntries(
      Object.entries(SETTING_DEFINITIONS).map(([key, def]) => [
        key,
        { type: def.type, group: def.group, secret: Boolean(def.secret), default: def.default },
      ]),
    ),
    groups: SETTING_GROUPS,
    mail_status: {
      enabled: mail.enabled,
      usable: mail.usable,
      missing: mail.missing,
      reason: mail.reason,
      sender: mail.sender || null,
    },
  });
}));

router.patch('/settings', requireCapability('settings.write'), asyncRoute(async (req, res) => {
  const updates = req.body?.settings ?? req.body;
  if (!updates || typeof updates !== 'object') {
    throw badRequest('Send an object of settings to update.');
  }

  const { changed, unknown } = await updateSettings(req.auth.organizationId, updates);

  if (changed.length) {
    await recordAudit(auditContextFromRequest(req), {
      action: AUDIT_ACTIONS.SETTINGS_UPDATED,
      entityType: 'settings',
      entityId: req.auth.organizationId,
      summary: `Updated settings: ${changed.join(', ')}`,
      // Values are deliberately not recorded — one of them is a client secret.
      detail: { changed_keys: changed },
    });
  }

  res.json({
    ok: true,
    changed,
    ignored: unknown,
    settings: await getSettingsForClient(req.auth.organizationId),
    mail_status: await getMailConfig(req.auth.organizationId),
  });
}));

/**
 * Send a test email. Bypasses the "notifications enabled" toggle so an admin
 * can verify Graph works before switching notifications on for real.
 */
router.post('/settings/test-email', requireCapability('settings.write'), asyncRoute(async (req, res) => {
  const recipient = parseEmail(req.body?.recipient, 'Recipient', { required: true });
  const result = await sendTestEmail(auditContextFromRequest(req), req.auth.organizationId, recipient);
  res.json(result);
}));

router.get('/settings/email-log', requireCapability('settings.read'), asyncRoute(async (req, res) => {
  res.json({ data: await recentEmails(req.auth.organizationId, int(req.query.limit, 'limit', { min: 1, max: 200 }) ?? 25) });
}));

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

router.get('/api-keys', requireCapability('apikeys.read'), asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT k.id, k.name, k.key_prefix, k.scopes, k.created_at, k.last_used_at,
            k.expires_at, k.revoked_at, u.full_name AS created_by_name
       FROM api_keys k
       LEFT JOIN users u ON u.id = k.created_by
      WHERE k.organization_id = ?
      ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
    [req.auth.organizationId],
  );

  res.json({
    data: rows.map((row) => ({
      ...row,
      scopes: String(row.scopes).split(/[,\s]+/).filter(Boolean),
      // The key itself is unrecoverable; this is only enough to identify it.
      masked_key: `lp_${row.key_prefix}_${'•'.repeat(12)}`,
      status: row.revoked_at ? 'revoked'
        : (row.expires_at && new Date(row.expires_at) < new Date()) ? 'expired'
        : 'active',
    })),
  });
}));

/**
 * Create an API key. The plaintext is returned exactly once, here — only its
 * hash is stored, so it genuinely cannot be shown again.
 */
router.post('/api-keys', requireCapability('apikeys.write'), requireRole('admin'), asyncRoute(async (req, res) => {
  const name = requiredStr(req.body?.name, 'Key name', { max: 190 });

  const requestedScopes = Array.isArray(req.body?.scopes)
    ? req.body.scopes
    : String(req.body?.scopes ?? 'read').split(/[,\s]+/);

  const scopes = [...new Set(requestedScopes.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  const invalid = scopes.filter((s) => !API_SCOPES.includes(s));
  if (invalid.length) {
    throw badRequest(`Unknown scope(s): ${invalid.join(', ')}. Valid scopes are: ${API_SCOPES.join(', ')}.`, {
      field: 'scopes', allowed: API_SCOPES,
    });
  }
  if (!scopes.length) scopes.push('read');

  const expiresInDays = int(req.body?.expires_in_days, 'expires_in_days', { min: 1, max: 3650 });
  const { plaintext, prefix, hash } = generateApiKey();

  const result = await execute(
    `INSERT INTO api_keys (organization_id, name, key_prefix, key_hash, scopes, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ${expiresInDays ? 'DATE_ADD(NOW(), INTERVAL ? DAY)' : 'NULL'})`,
    expiresInDays
      ? [req.auth.organizationId, name, prefix, hash, scopes.join(','), req.auth.userId, expiresInDays]
      : [req.auth.organizationId, name, prefix, hash, scopes.join(','), req.auth.userId],
  );

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.APIKEY_CREATED,
    entityType: 'api_key',
    entityId: result.insertId,
    entityLabel: name,
    summary: `Created API key "${name}" with scope(s): ${scopes.join(', ')}`,
    detail: { scopes, key_prefix: prefix, expires_in_days: expiresInDays },
  });

  res.status(201).json({
    api_key: {
      id: result.insertId,
      name,
      key_prefix: prefix,
      scopes,
      expires_in_days: expiresInDays,
    },
    key: plaintext,
    warning:
      'Copy this key now. It is stored only as a hash and cannot be shown again — ' +
      'if it is lost, revoke it and create another.',
  });
}));

router.delete('/api-keys/:id', requireCapability('apikeys.write'), requireRole('admin'), asyncRoute(async (req, res) => {
  const keyId = Number(req.params.id);
  const key = await queryOne(
    'SELECT * FROM api_keys WHERE id = ? AND organization_id = ?',
    [keyId, req.auth.organizationId],
  );
  if (!key) throw notFound('That API key does not exist.');
  if (key.revoked_at) return res.json({ ok: true, already_revoked: true });

  await execute('UPDATE api_keys SET revoked_at = NOW() WHERE id = ?', [keyId]);

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.APIKEY_REVOKED,
    entityType: 'api_key',
    entityId: keyId,
    entityLabel: key.name,
    summary: `Revoked API key "${key.name}"`,
  });

  res.json({ ok: true, revoked: true });
}));

export default router;
