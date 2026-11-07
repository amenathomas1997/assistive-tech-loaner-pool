/**
 * Per-organisation settings.
 *
 * Stored as key/value rows rather than columns so an admin-configurable
 * setting can be added without a migration. Values marked secret are
 * encrypted at rest and never leave the server in readable form.
 */

import { query, execute, queryOne } from '../db.js';
import { encryptSecret, decryptSecret, maskSecret } from './secrets.js';

/**
 * Setting definitions. Anything not declared here is rejected, so a typo in a
 * settings POST cannot quietly create a phantom key that nothing reads.
 */
export const SETTING_DEFINITIONS = {
  // --- Microsoft Graph mail -------------------------------------------------
  'graph.enabled':        { type: 'boolean', default: false, group: 'email' },
  'graph.tenant_id':      { type: 'string',  default: '',    group: 'email' },
  'graph.client_id':      { type: 'string',  default: '',    group: 'email' },
  'graph.client_secret':  { type: 'string',  default: '',    group: 'email', secret: true },
  'graph.sender':         { type: 'string',  default: '',    group: 'email' },
  'graph.reply_to':       { type: 'string',  default: '',    group: 'email' },

  // --- Notification toggles -------------------------------------------------
  'notify.request_submitted': { type: 'boolean', default: true,  group: 'notifications' },
  'notify.request_approved':  { type: 'boolean', default: true,  group: 'notifications' },
  'notify.request_denied':    { type: 'boolean', default: true,  group: 'notifications' },
  'notify.ready_for_pickup':  { type: 'boolean', default: true,  group: 'notifications' },
  'notify.checked_out':       { type: 'boolean', default: true,  group: 'notifications' },
  'notify.due_soon':          { type: 'boolean', default: true,  group: 'notifications' },
  'notify.overdue':           { type: 'boolean', default: true,  group: 'notifications' },
  'notify.checked_in':        { type: 'boolean', default: false, group: 'notifications' },
  'notify.due_soon_days':     { type: 'integer', default: 3,     group: 'notifications' },
  'notify.admin_recipients':  { type: 'string',  default: '',    group: 'notifications' },

  // --- Loan policy ----------------------------------------------------------
  'loans.allow_overdue_checkout': { type: 'boolean', default: false, group: 'loans' },
  'loans.require_client_or_tech': { type: 'boolean', default: true,  group: 'loans' },
  'loans.max_per_client':         { type: 'integer', default: 0,     group: 'loans' },
  'loans.auto_approve_vrc':       { type: 'boolean', default: false, group: 'loans' },

  // --- Scanning -------------------------------------------------------------
  'scan.remote_enabled':      { type: 'boolean', default: true, group: 'scanning' },
  'scan.channel_ttl_minutes': { type: 'integer', default: 240,  group: 'scanning' },
  'scan.offline_enabled':     { type: 'boolean', default: true, group: 'scanning' },

  // --- Loan agreements ------------------------------------------------------
  'agreements.enabled':     { type: 'boolean', default: false, group: 'agreements' },
  'agreements.required':    { type: 'boolean', default: false, group: 'agreements' },
  'agreements.allow_waive': { type: 'boolean', default: true,  group: 'agreements' },
  'agreements.text':        { type: 'string',  default: '',    group: 'agreements' },

  // --- Condition photos -----------------------------------------------------
  // Off by default. Photographing a client's equipment is a data-protection
  // decision an organisation should make deliberately, not inherit.
  'photos.enabled':            { type: 'boolean', default: false, group: 'photos' },
  'photos.prompt_on_checkout': { type: 'boolean', default: true,  group: 'photos' },
  'photos.prompt_on_checkin':  { type: 'boolean', default: true,  group: 'photos' },
  'photos.max_per_phase':      { type: 'integer', default: 4,     group: 'photos' },
  'photos.retention_days':     { type: 'integer', default: 0,     group: 'photos' },

  // --- Reservations ---------------------------------------------------------
  'reservations.enabled':    { type: 'boolean', default: true, group: 'reservations' },
  'reservations.hold_hours': { type: 'integer', default: 48,   group: 'reservations' },
  'notify.reservation_ready': { type: 'boolean', default: true, group: 'notifications' },
};

export const SETTING_GROUPS = [
  'email', 'notifications', 'loans', 'scanning', 'agreements', 'photos', 'reservations',
];

function coerce(definition, rawValue) {
  if (rawValue === null || rawValue === undefined) return definition.default;
  switch (definition.type) {
    case 'boolean':
      return rawValue === '1' || rawValue === 'true' || rawValue === true;
    case 'integer': {
      const n = Number(rawValue);
      return Number.isFinite(n) ? Math.trunc(n) : definition.default;
    }
    default:
      return String(rawValue);
  }
}

function serialise(definition, value) {
  switch (definition.type) {
    case 'boolean':
      return value ? '1' : '0';
    case 'integer':
      return String(Math.trunc(Number(value) || 0));
    default:
      return value === null || value === undefined ? '' : String(value);
  }
}

/**
 * All settings for an organisation, with defaults filled in.
 * Secrets are decrypted — this is the server-side view.
 */
export async function getSettings(organizationId) {
  const rows = await query(
    'SELECT setting_key, setting_value, is_secret FROM org_settings WHERE organization_id = ?',
    [organizationId],
  );

  const stored = new Map(rows.map((r) => [r.setting_key, r]));
  const result = {};

  for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
    const row = stored.get(key);
    if (!row) {
      result[key] = definition.default;
      continue;
    }
    const raw = definition.secret ? decryptSecret(row.setting_value) : row.setting_value;
    result[key] = coerce(definition, raw);
  }

  return result;
}

/** A single setting, with its default applied. */
export async function getSetting(organizationId, key) {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) throw new Error(`Unknown setting: ${key}`);

  const row = await queryOne(
    'SELECT setting_value FROM org_settings WHERE organization_id = ? AND setting_key = ?',
    [organizationId, key],
  );
  if (!row) return definition.default;

  const raw = definition.secret ? decryptSecret(row.setting_value) : row.setting_value;
  return coerce(definition, raw);
}

/**
 * The client-safe view: secrets are replaced with a boolean "is it set" flag
 * and a masked hint, never the value itself.
 */
export async function getSettingsForClient(organizationId) {
  const settings = await getSettings(organizationId);
  const safe = {};

  for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
    if (definition.secret) {
      const value = settings[key];
      safe[key] = null;
      safe[`${key}__is_set`] = Boolean(value);
      safe[`${key}__hint`] = value ? maskSecret(value) : null;
    } else {
      safe[key] = settings[key];
    }
  }

  return safe;
}

/**
 * Write settings. Returns the list of keys that actually changed, so the
 * caller can write a meaningful audit entry.
 *
 * A secret submitted as an empty string is treated as "leave unchanged" —
 * otherwise every save from a form that masks the field would wipe it. To
 * clear a secret, send the literal string "__CLEAR__".
 */
export async function updateSettings(organizationId, updates) {
  const changed = [];
  const unknown = [];

  for (const [key, value] of Object.entries(updates)) {
    const definition = SETTING_DEFINITIONS[key];
    if (!definition) {
      unknown.push(key);
      continue;
    }

    if (definition.secret) {
      if (value === '' || value === null || value === undefined) continue; // unchanged
      const toStore = value === '__CLEAR__' ? null : encryptSecret(String(value));
      await execute(
        `INSERT INTO org_settings (organization_id, setting_key, setting_value, is_secret)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), is_secret = 1`,
        [organizationId, key, toStore],
      );
      changed.push(key);
      continue;
    }

    const serialised = serialise(definition, value);
    const existing = await queryOne(
      'SELECT setting_value FROM org_settings WHERE organization_id = ? AND setting_key = ?',
      [organizationId, key],
    );
    if (existing && existing.setting_value === serialised) continue;

    await execute(
      `INSERT INTO org_settings (organization_id, setting_key, setting_value, is_secret)
       VALUES (?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), is_secret = 0`,
      [organizationId, key, serialised],
    );
    changed.push(key);
  }

  return { changed, unknown };
}

/** Parse a comma/semicolon/newline separated recipient list into addresses. */
export function parseRecipients(value) {
  return String(value || '')
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

/** The organisation row, which holds settings that belong in columns. */
export async function getOrganization(organizationId) {
  return queryOne('SELECT * FROM organizations WHERE id = ?', [organizationId]);
}

/** Loan periods, default first. */
export async function getLoanPeriods(organizationId, { includeInactive = false } = {}) {
  return query(
    `SELECT * FROM loan_periods
      WHERE organization_id = ? ${includeInactive ? '' : 'AND active = 1'}
      ORDER BY is_default DESC, sort_order ASC, days ASC`,
    [organizationId],
  );
}

export async function getDefaultLoanPeriod(organizationId) {
  return queryOne(
    `SELECT * FROM loan_periods
      WHERE organization_id = ? AND active = 1
      ORDER BY is_default DESC, sort_order ASC LIMIT 1`,
    [organizationId],
  );
}
