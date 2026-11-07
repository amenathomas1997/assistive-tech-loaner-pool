/**
 * Append-only audit trail.
 *
 * Every state change routes through recordAudit(). Two rules make the log
 * trustworthy:
 *
 *   1. Nothing in this codebase ever UPDATEs or DELETEs audit_log.
 *   2. A failure to write an audit row never fails the request it describes,
 *      but it is loudly logged to stderr. Losing an audit row is bad; losing a
 *      device check-in because the audit insert deadlocked is worse.
 */

import { execute, query, queryOne } from '../db.js';
import { toMysqlDateTime } from './util.js';

/** Canonical action verbs. Keeping these fixed makes the log filterable. */
export const AUDIT_ACTIONS = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  PASSWORD_CHANGED: 'auth.password_changed',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password_reset_completed',

  DEVICE_CREATED: 'device.created',
  DEVICE_UPDATED: 'device.updated',
  DEVICE_DELETED: 'device.deleted',
  DEVICE_IMPORTED: 'device.imported',
  DEVICE_STATUS_CHANGED: 'device.status_changed',
  DEVICE_BARCODE_ASSIGNED: 'device.barcode_assigned',

  LOAN_CHECKED_OUT: 'loan.checked_out',
  LOAN_CHECKED_IN: 'loan.checked_in',
  LOAN_EXTENDED: 'loan.extended',
  LOAN_REDUCED: 'loan.reduced',
  LOAN_CANCELLED: 'loan.cancelled',
  LOAN_TRANSFERRED: 'loan.transferred',

  REQUEST_SUBMITTED: 'request.submitted',
  REQUEST_APPROVED: 'request.approved',
  REQUEST_DENIED: 'request.denied',
  REQUEST_CANCELLED: 'request.cancelled',
  REQUEST_STATE_CHANGED: 'request.state_changed',
  REQUEST_FULFILLED: 'request.fulfilled',

  CLIENT_CREATED: 'client.created',
  CLIENT_UPDATED: 'client.updated',
  PROGRAM_CREATED: 'program.created',
  PROGRAM_UPDATED: 'program.updated',

  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DEACTIVATED: 'user.deactivated',

  SETTINGS_UPDATED: 'settings.updated',
  PERIOD_CREATED: 'period.created',
  PERIOD_UPDATED: 'period.updated',
  PERIOD_DELETED: 'period.deleted',

  APIKEY_CREATED: 'apikey.created',
  APIKEY_REVOKED: 'apikey.revoked',

  EMAIL_SENT: 'email.sent',
  EMAIL_FAILED: 'email.failed',

  INSTALL_COMPLETED: 'install.completed',
};

/**
 * Write one audit row.
 *
 * Pass either an Express request (from which actor, org and IP are read) or an
 * explicit context object — background jobs have no request.
 */
export async function recordAudit(ctx, entry) {
  try {
    const actor = ctx?.auth ?? ctx ?? {};
    const organizationId = entry.organizationId ?? actor.organizationId ?? null;
    if (!organizationId) return; // Nothing sensible to attach the row to.

    await execute(
      `INSERT INTO audit_log
         (organization_id, actor_id, actor_label, actor_type, action,
          entity_type, entity_id, entity_label, summary, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        organizationId,
        actor.userId ?? null,
        actor.label ?? actor.fullName ?? null,
        actor.actorType ?? 'user',
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.entityLabel ? String(entry.entityLabel).slice(0, 190) : null,
        entry.summary ? String(entry.summary).slice(0, 500) : null,
        entry.detail ? JSON.stringify(entry.detail) : null,
        actor.ip ?? null,
      ],
    );
  } catch (err) {
    // Deliberately swallowed — see the module comment.
    console.error('[audit] failed to record entry:', entry?.action, err?.message);
  }
}

/**
 * Build the audit context an Express request carries. Called by the auth
 * middleware once per request so routes can just pass `req`.
 */
export function auditContextFromRequest(req) {
  const auth = req.auth || {};
  return {
    organizationId: auth.organizationId ?? null,
    userId: auth.userId ?? null,
    label: auth.label ?? null,
    actorType: auth.actorType ?? 'user',
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
  };
}

/**
 * Query the audit log with filters. Column names come from a fixed map so no
 * user input reaches the SQL text.
 */
export async function searchAudit(organizationId, filters = {}, { limit = 50, offset = 0 } = {}) {
  const where = ['a.organization_id = ?'];
  const params = [organizationId];

  if (filters.action) {
    where.push('a.action = ?');
    params.push(filters.action);
  }
  if (filters.actionPrefix) {
    where.push('a.action LIKE ?');
    params.push(`${filters.actionPrefix}%`);
  }
  if (filters.actorId) {
    where.push('a.actor_id = ?');
    params.push(filters.actorId);
  }
  if (filters.entityType) {
    where.push('a.entity_type = ?');
    params.push(filters.entityType);
  }
  if (filters.entityId) {
    where.push('a.entity_id = ?');
    params.push(filters.entityId);
  }
  if (filters.from) {
    where.push('a.created_at >= ?');
    params.push(toMysqlDateTime(filters.from));
  }
  if (filters.to) {
    where.push('a.created_at <= ?');
    params.push(toMysqlDateTime(filters.to));
  }
  if (filters.search) {
    where.push('(a.summary LIKE ? OR a.entity_label LIKE ? OR a.actor_label LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }

  const whereSql = where.join(' AND ');

  const rows = await query(
    `SELECT a.*, u.full_name AS actor_name, u.email AS actor_email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  );

  const countRow = await queryOne(
    `SELECT COUNT(*) AS total FROM audit_log a WHERE ${whereSql}`,
    params,
  );

  return {
    rows: rows.map((row) => ({
      ...row,
      detail: parseDetail(row.detail),
    })),
    total: Number(countRow?.total ?? 0),
  };
}

function parseDetail(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/**
 * Diff two records and return only what changed, so an "updated" audit row
 * says what actually moved instead of dumping the whole entity.
 */
export function diffRecords(before, after, fields) {
  const changes = {};
  for (const field of fields) {
    const oldValue = normalise(before?.[field]);
    const newValue = normalise(after?.[field]);
    if (oldValue !== newValue) {
      changes[field] = { from: oldValue, to: newValue };
    }
  }
  return Object.keys(changes).length ? changes : null;
}

function normalise(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
