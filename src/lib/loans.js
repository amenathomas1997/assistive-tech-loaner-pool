/**
 * Loan lifecycle: check-out, check-in, extend, reduce, cancel.
 *
 * A device may be held by any combination of a technician, a program and a
 * client — all three holder columns are independent and nullable. The one
 * invariant enforced everywhere is that a device has at most one active loan;
 * that is enforced with a row lock inside a transaction rather than by
 * checking `devices.status` first, because two techs scanning the same device
 * at the same desk is a real scenario, not a theoretical one.
 */

import { transaction, connOne, connAll, query, queryOne } from '../db.js';
import {
  HttpError, conflict, notFound, badRequest, unprocessable,
  makeReference, toMysqlDateTime, addDays, isOverdue,
} from './util.js';
import { recordAudit, AUDIT_ACTIONS } from './audit.js';
import { normaliseScan } from './barcode.js';
import { getSettings } from './settings.js';

/** Statuses a device can be in and still be lent out. */
const LENDABLE_STATUSES = new Set(['available', 'reserved']);

/**
 * Resolve a device by barcode, asset tag or id — a scan, a typed value and a
 * click from a list all land here so the rules stay identical.
 */
export async function resolveDevice(organizationId, identifier, { conn = null } = {}) {
  const runner = conn
    ? (sql, params) => connOne(conn, sql, params)
    : (sql, params) => queryOne(sql, params);

  if (identifier === null || identifier === undefined || identifier === '') return null;

  // Numeric ids come from the UI's own lists, never from a scanner.
  if (typeof identifier === 'number' || /^\d+$/.test(String(identifier))) {
    const byId = await runner(
      'SELECT * FROM devices WHERE id = ? AND organization_id = ?',
      [Number(identifier), organizationId],
    );
    if (byId) return byId;
  }

  const scanned = normaliseScan(identifier);
  if (!scanned) return null;

  // Barcode first: that is what a scanner produces, and it is globally unique.
  const byBarcode = await runner(
    'SELECT * FROM devices WHERE barcode = ? AND organization_id = ?',
    [scanned, organizationId],
  );
  if (byBarcode) return byBarcode;

  // Fall back to the org's own asset tag, for hand-typed lookups.
  return runner(
    'SELECT * FROM devices WHERE asset_tag = ? AND organization_id = ?',
    [scanned, organizationId],
  );
}

/** The active loan for a device, if any. */
export async function getActiveLoanForDevice(deviceId, { conn = null } = {}) {
  const sql = `SELECT * FROM loans WHERE device_id = ? AND status = 'active' LIMIT 1`;
  return conn ? connOne(conn, sql, [deviceId]) : queryOne(sql, [deviceId]);
}

/**
 * Compute a due date.
 *
 * days === 0 means an open-ended loan and yields null, which the schema stores
 * as "no due date" — distinct from "due today", which would be days === 0 in a
 * naive implementation.
 */
export function computeDueDate(days, from = new Date()) {
  if (days === null || days === undefined) return null;
  const numeric = Number(days);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const due = addDays(from, numeric);
  // Due at end of the working day, not at the minute of checkout. A device
  // taken out at 16:55 is not overdue at 16:56 fourteen days later.
  due.setHours(23, 59, 59, 0);
  return due;
}

/**
 * Insert a row whose `reference` column is unique, retrying on collision.
 * Six random characters collide rarely, but "rarely" over years of use is not
 * "never", and the failure mode without this is a 500 at the check-out desk.
 */
async function insertWithReference(conn, prefix, buildSql) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const reference = makeReference(prefix);
    try {
      const { sql, params } = buildSql(reference);
      const [result] = await conn.execute(sql, params);
      return { id: result.insertId, reference };
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY' && String(err.sqlMessage || '').includes('reference')) {
        continue;
      }
      throw err;
    }
  }
  throw new Error('Could not allocate a unique reference after 6 attempts.');
}

/**
 * Check a device out.
 *
 * Holders: any combination of techId, clientId and programId. At least one is
 * required when `loans.require_client_or_tech` is on (the default) — a loan
 * held by nobody is an inventory adjustment, not a loan.
 */
export async function checkOutDevice(ctx, input) {
  const {
    organizationId,
    deviceIdentifier,
    techId = null,
    clientId = null,
    programId = null,
    loanPeriodId = null,
    customDays = null,
    notes = null,
    conditionOut = null,
    method = 'manual',
    requestId = null,
    actorId = null,
    accessoriesOut = null,
  } = input;

  const settings = await getSettings(organizationId);

  if (settings['loans.require_client_or_tech'] && !techId && !clientId && !programId) {
    throw badRequest(
      'A loan must be assigned to at least one of: a technician, a client, or a program.',
      { fields: ['tech_id', 'client_id', 'program_id'] },
    );
  }

  const result = await transaction(async (conn) => {
    // Lock the device row for the duration. Any concurrent check-out of the
    // same device blocks here and then correctly sees it as already out.
    const device = await resolveDevice(organizationId, deviceIdentifier, { conn });
    if (!device) {
      throw notFound(`No device matches "${deviceIdentifier}".`);
    }

    const locked = await connOne(
      conn,
      'SELECT * FROM devices WHERE id = ? FOR UPDATE',
      [device.id],
    );

    // Order matters. An active loan is checked first because its message names
    // the loan reference, which is what the person at the desk needs in order
    // to act. Reporting only "this device is marked checked out" is true but
    // leaves them with nowhere to go.
    const existing = await getActiveLoanForDevice(locked.id, { conn });
    if (existing) {
      throw conflict(
        `${locked.name} is already on loan (${existing.reference}). Check it in before lending it again.`,
        { device_id: locked.id, loan_id: existing.id, loan_reference: existing.reference },
      );
    }

    if (!LENDABLE_STATUSES.has(locked.status)) {
      throw conflict(
        `${locked.name} cannot be checked out because it is marked "${locked.status.replace('_', ' ')}".`,
        { device_id: locked.id, status: locked.status },
      );
    }

    // Validate holders belong to this organisation. Skipping this would let a
    // crafted API call attach another tenant's client to a loan.
    await assertBelongsToOrg(conn, 'users', techId, organizationId, 'technician');
    await assertBelongsToOrg(conn, 'clients', clientId, organizationId, 'client');
    await assertBelongsToOrg(conn, 'programs', programId, organizationId, 'program');

    // Per-client concurrent loan cap, when configured.
    const maxPerClient = Number(settings['loans.max_per_client']) || 0;
    if (clientId && maxPerClient > 0) {
      const countRow = await connOne(
        conn,
        `SELECT COUNT(*) AS n FROM loans WHERE client_id = ? AND status = 'active'`,
        [clientId],
      );
      if (Number(countRow.n) >= maxPerClient) {
        throw conflict(
          `This client already has ${countRow.n} device(s) on loan, which is the configured maximum of ${maxPerClient}.`,
          { client_id: clientId, active_loans: Number(countRow.n), max: maxPerClient },
        );
      }
    }

    // Block a new loan to a client who already has something overdue.
    if (clientId && !settings['loans.allow_overdue_checkout']) {
      const overdue = await connOne(
        conn,
        `SELECT reference, due_at FROM loans
          WHERE client_id = ? AND status = 'active' AND due_at IS NOT NULL AND due_at < NOW()
          LIMIT 1`,
        [clientId],
      );
      if (overdue) {
        throw conflict(
          `This client has an overdue loan (${overdue.reference}). Return or extend it first, ` +
          'or enable "allow check-out with overdue loans" in settings.',
          { client_id: clientId, overdue_reference: overdue.reference },
        );
      }
    }

    // Resolve the loan period.
    const { periodId, days, periodRow } = await resolvePeriod(conn, organizationId, loanPeriodId, customDays);
    const now = new Date();
    const dueAt = computeDueDate(days, now);

    const { id: loanId, reference } = await insertWithReference(conn, 'LN', (ref) => ({
      sql: `INSERT INTO loans
              (organization_id, reference, device_id, request_id, tech_id, client_id, program_id,
               loan_period_id, status, checked_out_at, checked_out_by, checkout_method,
               due_at, original_due_at, condition_out, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        organizationId, ref, locked.id, requestId, techId, clientId, programId,
        periodId, toMysqlDateTime(now), actorId, method,
        toMysqlDateTime(dueAt), toMysqlDateTime(dueAt), conditionOut, notes,
      ],
    }));

    await conn.execute(
      `UPDATE devices SET status = 'checked_out', updated_at = NOW() WHERE id = ?`,
      [locked.id],
    );

    await conn.execute(
      `INSERT INTO loan_events (loan_id, event_type, new_due_at, actor_id, notes)
       VALUES (?, 'checkout', ?, ?, ?)`,
      [loanId, toMysqlDateTime(dueAt), actorId, notes],
    );

    // Record which accessories physically left with the device, so check-in
    // can report what did not come back.
    if (accessoriesOut && Object.keys(accessoriesOut).length) {
      await conn.execute('UPDATE loans SET accessories_out = ? WHERE id = ?', [
        JSON.stringify(accessoriesOut), loanId,
      ]);
    }

    if (requestId) {
      await conn.execute(
        `UPDATE loan_requests
            SET status = 'fulfilled', fulfillment_state = 'delivered',
                loan_id = ?, updated_at = NOW()
          WHERE id = ? AND organization_id = ?`,
        [loanId, requestId, organizationId],
      );
    }

    return { loanId, reference, device: locked, dueAt, days, periodRow };
  });

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.LOAN_CHECKED_OUT,
    entityType: 'loan',
    entityId: result.loanId,
    entityLabel: result.reference,
    summary:
      `Checked out ${result.device.name} (${result.device.barcode}) — ` +
      `due ${result.dueAt ? result.dueAt.toDateString() : 'open ended'}`,
    detail: {
      device_id: result.device.id,
      barcode: result.device.barcode,
      tech_id: techId,
      client_id: clientId,
      program_id: programId,
      days: result.days,
      method,
      request_id: requestId,
    },
  });

  return getLoan(organizationId, result.loanId);
}

async function assertBelongsToOrg(conn, table, id, organizationId, label) {
  if (!id) return;
  const row = await connOne(
    conn,
    `SELECT id FROM ${table} WHERE id = ? AND organization_id = ?`,
    [id, organizationId],
  );
  if (!row) throw badRequest(`That ${label} does not exist.`, { field: `${label}_id`, value: id });
}

async function resolvePeriod(conn, organizationId, loanPeriodId, customDays) {
  // An explicit custom duration always wins — that is the point of it.
  if (customDays !== null && customDays !== undefined && customDays !== '') {
    const days = Number(customDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      throw badRequest('A custom loan length must be a whole number of days between 0 and 3650.', {
        field: 'custom_days',
      });
    }
    return { periodId: null, days, periodRow: null };
  }

  if (loanPeriodId) {
    const period = await connOne(
      conn,
      'SELECT * FROM loan_periods WHERE id = ? AND organization_id = ?',
      [loanPeriodId, organizationId],
    );
    if (!period) throw badRequest('That loan period does not exist.', { field: 'loan_period_id' });
    return { periodId: period.id, days: Number(period.days), periodRow: period };
  }

  const fallback = await connOne(
    conn,
    `SELECT * FROM loan_periods WHERE organization_id = ? AND active = 1
      ORDER BY is_default DESC, sort_order ASC LIMIT 1`,
    [organizationId],
  );
  if (!fallback) {
    throw unprocessable(
      'No loan periods are configured. An administrator must add at least one under Settings → Loan periods.',
    );
  }
  return { periodId: fallback.id, days: Number(fallback.days), periodRow: fallback };
}

/**
 * Check a device back in.
 *
 * Accepts a barcode (scanned or typed) or a loan id, so the scanner path and
 * the "pick it from a list" path converge on identical behaviour.
 */
export async function checkInDevice(ctx, input) {
  const {
    organizationId,
    deviceIdentifier = null,
    loanId = null,
    conditionIn = null,
    notes = null,
    method = 'manual',
    newDeviceStatus = 'available',
    actorId = null,
    accessoriesIn = null,
  } = input;

  if (!deviceIdentifier && !loanId) {
    throw badRequest('Provide either a device barcode or a loan to check in.');
  }

  const result = await transaction(async (conn) => {
    let loan;
    let device;

    if (loanId) {
      loan = await connOne(
        conn,
        'SELECT * FROM loans WHERE id = ? AND organization_id = ? FOR UPDATE',
        [loanId, organizationId],
      );
      if (!loan) throw notFound('That loan does not exist.');
      device = await connOne(conn, 'SELECT * FROM devices WHERE id = ? FOR UPDATE', [loan.device_id]);
    } else {
      device = await resolveDevice(organizationId, deviceIdentifier, { conn });
      if (!device) {
        throw notFound(
          `No device matches "${deviceIdentifier}". If this label was printed by another system, ` +
          'find the device by name and check it in manually.',
        );
      }
      device = await connOne(conn, 'SELECT * FROM devices WHERE id = ? FOR UPDATE', [device.id]);
      loan = await connOne(
        conn,
        `SELECT * FROM loans WHERE device_id = ? AND status = 'active' FOR UPDATE`,
        [device.id],
      );
    }

    if (!loan) {
      // Not an error worth failing on if the device is simply already in — but
      // it must be reported, or a tech assumes a scan registered when it did not.
      throw conflict(
        `${device.name} (${device.barcode}) is not currently on loan.`,
        { device_id: device.id, device_status: device.status, already_returned: true },
      );
    }

    if (loan.status !== 'active') {
      throw conflict(`Loan ${loan.reference} is already ${loan.status}.`, {
        loan_id: loan.id,
        status: loan.status,
      });
    }

    const now = new Date();
    const wasOverdue = isOverdue(loan, now);
    const daysLate = wasOverdue
      ? Math.ceil((now.getTime() - new Date(loan.due_at).getTime()) / 86400000)
      : 0;

    await conn.execute(
      `UPDATE loans
          SET status = 'returned', returned_at = ?, checked_in_by = ?, checkin_method = ?,
              condition_in = ?, notes = CASE WHEN ? IS NULL THEN notes
                                             ELSE CONCAT(COALESCE(notes, ''), ?) END,
              updated_at = NOW()
        WHERE id = ?`,
      [
        toMysqlDateTime(now), actorId, method, conditionIn,
        notes, notes ? `\n[check-in] ${notes}` : null,
        loan.id,
      ],
    );

    await conn.execute(
      `UPDATE devices SET status = ?, condition_note = COALESCE(?, condition_note), updated_at = NOW()
        WHERE id = ?`,
      [newDeviceStatus, conditionIn, device.id],
    );

    await conn.execute(
      `INSERT INTO loan_events (loan_id, event_type, old_due_at, actor_id, notes)
       VALUES (?, 'checkin', ?, ?, ?)`,
      [loan.id, toMysqlDateTime(loan.due_at), actorId, notes],
    );

    // Compare what went out against what came back, so a missing charger is
    // recorded at the moment it is noticed rather than discovered next time.
    let missing = [];
    if (accessoriesIn) {
      await conn.execute('UPDATE loans SET accessories_in = ? WHERE id = ?', [
        JSON.stringify(accessoriesIn), loan.id,
      ]);

      const wentOut = parseJsonSafe(loan.accessories_out) || {};
      missing = Object.entries(wentOut)
        .filter(([name, out]) => out && !accessoriesIn[name])
        .map(([name]) => name);

      if (missing.length) {
        await conn.execute(
          `INSERT INTO loan_events (loan_id, event_type, actor_id, notes)
           VALUES (?, 'note', ?, ?)`,
          [loan.id, actorId, `Accessories not returned: ${missing.join(', ')}`],
        );
      }
    }

    return { loan, device, wasOverdue, daysLate, returnedAt: now, missingAccessories: missing };
  });

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.LOAN_CHECKED_IN,
    entityType: 'loan',
    entityId: result.loan.id,
    entityLabel: result.loan.reference,
    summary:
      `Checked in ${result.device.name} (${result.device.barcode})` +
      (result.wasOverdue ? ` — ${result.daysLate} day(s) overdue` : ''),
    detail: {
      device_id: result.device.id,
      barcode: result.device.barcode,
      was_overdue: result.wasOverdue,
      days_late: result.daysLate,
      method,
      condition_in: conditionIn,
      new_device_status: newDeviceStatus,
    },
  });

  // The device is free again, so offer it to whoever is next on the waitlist.
  // Deliberately after the transaction and never fatal: a failure here must
  // not undo a completed return.
  let promoted = null;
  if (newDeviceStatus === 'available') {
    try {
      const { promoteNextForDevice } = await import('./reservations.js');
      promoted = await promoteNextForDevice(ctx, organizationId, result.device.id);
    } catch (err) {
      console.error('[loans] waitlist promotion failed:', err.message);
    }
  }

  const loan = await getLoan(organizationId, result.loan.id);

  return {
    loan,
    device: result.device,
    wasOverdue: result.wasOverdue,
    daysLate: result.daysLate,
    missingAccessories: result.missingAccessories ?? [],
    promoted_reservation: promoted,
  };
}

function parseJsonSafe(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Change a loan's due date.
 *
 * Extending and reducing share this path because they are the same operation
 * with a different sign; keeping them together means the extension cap, the
 * audit entry and the timeline event cannot drift apart.
 */
export async function adjustLoanDueDate(ctx, input) {
  const {
    organizationId,
    loanId,
    days = null,
    newDueAt = null,
    reason = null,
    actorId = null,
    ignoreExtensionLimit = false,
  } = input;

  if (days === null && newDueAt === null) {
    throw badRequest('Provide either a number of days to change by, or a new due date.');
  }

  const result = await transaction(async (conn) => {
    const loan = await connOne(
      conn,
      'SELECT * FROM loans WHERE id = ? AND organization_id = ? FOR UPDATE',
      [loanId, organizationId],
    );
    if (!loan) throw notFound('That loan does not exist.');
    if (loan.status !== 'active') {
      throw conflict(`Loan ${loan.reference} is ${loan.status} and cannot be changed.`, {
        status: loan.status,
      });
    }

    const oldDueAt = loan.due_at ? new Date(loan.due_at) : null;
    let targetDue;

    if (newDueAt !== null) {
      targetDue = new Date(newDueAt);
      if (Number.isNaN(targetDue.getTime())) throw badRequest('That is not a valid due date.');
      targetDue.setHours(23, 59, 59, 0);
    } else {
      const base = oldDueAt || new Date();
      targetDue = addDays(base, Number(days));
      targetDue.setHours(23, 59, 59, 0);
    }

    const isExtension = !oldDueAt || targetDue.getTime() > oldDueAt.getTime();

    if (targetDue.getTime() < new Date(loan.checked_out_at).getTime()) {
      throw badRequest('A due date cannot be earlier than the date the device went out.');
    }

    // Extension cap comes from the loan's period, when it has one.
    if (isExtension && !ignoreExtensionLimit && loan.loan_period_id) {
      const period = await connOne(
        conn, 'SELECT * FROM loan_periods WHERE id = ?', [loan.loan_period_id],
      );
      const max = Number(period?.max_extensions ?? 0);
      if (period && max > 0 && Number(loan.extension_count) >= max) {
        throw conflict(
          `Loan ${loan.reference} has already been extended ${loan.extension_count} time(s), ` +
          `which is the maximum for the "${period.name}" period. An administrator can override this.`,
          { loan_id: loan.id, extension_count: loan.extension_count, max_extensions: max },
        );
      }
    }

    await conn.execute(
      `UPDATE loans
          SET due_at = ?, extension_count = extension_count + ?, updated_at = NOW()
        WHERE id = ?`,
      [toMysqlDateTime(targetDue), isExtension ? 1 : 0, loan.id],
    );

    await conn.execute(
      `INSERT INTO loan_events (loan_id, event_type, old_due_at, new_due_at, actor_id, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        loan.id,
        isExtension ? 'extend' : 'reduce',
        toMysqlDateTime(oldDueAt),
        toMysqlDateTime(targetDue),
        actorId,
        reason,
      ],
    );

    return { loan, oldDueAt, targetDue, isExtension };
  });

  await recordAudit(ctx, {
    organizationId,
    action: result.isExtension ? AUDIT_ACTIONS.LOAN_EXTENDED : AUDIT_ACTIONS.LOAN_REDUCED,
    entityType: 'loan',
    entityId: result.loan.id,
    entityLabel: result.loan.reference,
    summary:
      `${result.isExtension ? 'Extended' : 'Reduced'} ${result.loan.reference}: ` +
      `${result.oldDueAt ? result.oldDueAt.toDateString() : 'open ended'} → ${result.targetDue.toDateString()}`,
    detail: {
      old_due_at: result.oldDueAt,
      new_due_at: result.targetDue,
      reason,
    },
  });

  return getLoan(organizationId, loanId);
}

/**
 * Cancel a loan.
 *
 * Distinct from check-in: cancelling means the loan should not have happened
 * (wrong device scanned, request withdrawn). The device returns to the pool
 * but the loan is not counted as a completed loan in utilisation reporting.
 */
export async function cancelLoan(ctx, input) {
  const {
    organizationId, loanId, reason = null, actorId = null, deviceStatus = 'available',
  } = input;

  const result = await transaction(async (conn) => {
    const loan = await connOne(
      conn,
      'SELECT * FROM loans WHERE id = ? AND organization_id = ? FOR UPDATE',
      [loanId, organizationId],
    );
    if (!loan) throw notFound('That loan does not exist.');
    if (loan.status !== 'active') {
      throw conflict(`Loan ${loan.reference} is already ${loan.status}.`, { status: loan.status });
    }

    const device = await connOne(conn, 'SELECT * FROM devices WHERE id = ? FOR UPDATE', [loan.device_id]);

    await conn.execute(
      `UPDATE loans SET status = 'cancelled', returned_at = NOW(), checked_in_by = ?, updated_at = NOW()
        WHERE id = ?`,
      [actorId, loan.id],
    );
    await conn.execute(
      `UPDATE devices SET status = ?, updated_at = NOW() WHERE id = ?`,
      [deviceStatus, device.id],
    );
    await conn.execute(
      `INSERT INTO loan_events (loan_id, event_type, old_due_at, actor_id, notes)
       VALUES (?, 'cancel', ?, ?, ?)`,
      [loan.id, toMysqlDateTime(loan.due_at), actorId, reason],
    );

    return { loan, device };
  });

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.LOAN_CANCELLED,
    entityType: 'loan',
    entityId: result.loan.id,
    entityLabel: result.loan.reference,
    summary: `Cancelled ${result.loan.reference} for ${result.device.name}${reason ? `: ${reason}` : ''}`,
    detail: { reason, device_id: result.device.id },
  });

  return getLoan(organizationId, loanId);
}

/** Move an active loan to a different holder without a return trip. */
export async function transferLoan(ctx, input) {
  const {
    organizationId, loanId, techId, clientId, programId, reason = null, actorId = null,
  } = input;

  const result = await transaction(async (conn) => {
    const loan = await connOne(
      conn, 'SELECT * FROM loans WHERE id = ? AND organization_id = ? FOR UPDATE', [loanId, organizationId],
    );
    if (!loan) throw notFound('That loan does not exist.');
    if (loan.status !== 'active') {
      throw conflict(`Loan ${loan.reference} is ${loan.status} and cannot be transferred.`);
    }

    await assertBelongsToOrg(conn, 'users', techId, organizationId, 'technician');
    await assertBelongsToOrg(conn, 'clients', clientId, organizationId, 'client');
    await assertBelongsToOrg(conn, 'programs', programId, organizationId, 'program');

    if (!techId && !clientId && !programId) {
      throw badRequest('A transfer must name at least one new holder.');
    }

    await conn.execute(
      `UPDATE loans SET tech_id = ?, client_id = ?, program_id = ?, updated_at = NOW() WHERE id = ?`,
      [techId ?? null, clientId ?? null, programId ?? null, loan.id],
    );
    await conn.execute(
      `INSERT INTO loan_events (loan_id, event_type, actor_id, notes) VALUES (?, 'transfer', ?, ?)`,
      [loan.id, actorId, reason],
    );

    return { loan, before: { tech_id: loan.tech_id, client_id: loan.client_id, program_id: loan.program_id } };
  });

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.LOAN_TRANSFERRED,
    entityType: 'loan',
    entityId: loanId,
    entityLabel: result.loan.reference,
    summary: `Transferred ${result.loan.reference} to a new holder`,
    detail: { from: result.before, to: { tech_id: techId, client_id: clientId, program_id: programId }, reason },
  });

  return getLoan(organizationId, loanId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const LOAN_SELECT = `
  SELECT l.*,
         d.name AS device_name, d.barcode AS device_barcode, d.asset_tag AS device_asset_tag,
         d.category AS device_category, d.manufacturer AS device_manufacturer, d.model AS device_model,
         t.full_name AS tech_name, t.email AS tech_email,
         c.first_name AS client_first_name, c.last_name AS client_last_name, c.email AS client_email,
         p.name AS program_name,
         lp.name AS period_name, lp.days AS period_days, lp.max_extensions AS period_max_extensions,
         ob.full_name AS checked_out_by_name,
         ib.full_name AS checked_in_by_name,
         r.reference AS request_reference
    FROM loans l
    JOIN devices d ON d.id = l.device_id
    LEFT JOIN users t ON t.id = l.tech_id
    LEFT JOIN clients c ON c.id = l.client_id
    LEFT JOIN programs p ON p.id = l.program_id
    LEFT JOIN loan_periods lp ON lp.id = l.loan_period_id
    LEFT JOIN users ob ON ob.id = l.checked_out_by
    LEFT JOIN users ib ON ib.id = l.checked_in_by
    LEFT JOIN loan_requests r ON r.id = l.request_id`;

export async function getLoan(organizationId, loanId) {
  const loan = await queryOne(
    `${LOAN_SELECT} WHERE l.id = ? AND l.organization_id = ?`,
    [loanId, organizationId],
  );
  if (!loan) return null;
  return decorateLoan(loan);
}

export async function getLoanWithTimeline(organizationId, loanId) {
  const loan = await getLoan(organizationId, loanId);
  if (!loan) return null;

  const events = await query(
    `SELECT e.*, u.full_name AS actor_name
       FROM loan_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.loan_id = ?
      ORDER BY e.created_at ASC, e.id ASC`,
    [loanId],
  );

  return { ...loan, timeline: events };
}

/**
 * Add derived fields the UI and API both need, so "overdue" is computed in
 * exactly one place.
 */
export function decorateLoan(loan) {
  const now = new Date();
  const overdue = isOverdue(loan, now);
  const dueAt = loan.due_at ? new Date(loan.due_at) : null;

  return {
    ...loan,
    is_overdue: overdue,
    days_until_due: dueAt && loan.status === 'active'
      ? Math.ceil((dueAt.getTime() - now.getTime()) / 86400000)
      : null,
    days_overdue: overdue ? Math.ceil((now.getTime() - dueAt.getTime()) / 86400000) : 0,
    client_name: loan.client_first_name
      ? `${loan.client_first_name} ${loan.client_last_name}`
      : null,
    holder_summary: describeHolders(loan),
  };
}

/** One-line description of who holds a device, for lists and notifications. */
export function describeHolders(loan) {
  const parts = [];
  if (loan.client_first_name) parts.push(`${loan.client_first_name} ${loan.client_last_name}`);
  if (loan.tech_name) parts.push(loan.tech_name);
  if (loan.program_name) parts.push(loan.program_name);
  return parts.length ? parts.join(' / ') : 'Unassigned';
}

/** Filterable loan list. Column names come from fixed maps, never user input. */
export async function listLoans(organizationId, filters = {}, { limit = 50, offset = 0, sort = null } = {}) {
  const where = ['l.organization_id = ?'];
  const params = [organizationId];

  if (filters.status === 'overdue') {
    where.push(`l.status = 'active' AND l.due_at IS NOT NULL AND l.due_at < NOW()`);
  } else if (filters.status === 'due_soon') {
    const days = Number(filters.dueSoonDays) || 3;
    where.push(
      `l.status = 'active' AND l.due_at IS NOT NULL AND l.due_at >= NOW() ` +
      `AND l.due_at <= DATE_ADD(NOW(), INTERVAL ${Number(days)} DAY)`,
    );
  } else if (filters.status) {
    where.push('l.status = ?');
    params.push(filters.status);
  }

  if (filters.deviceId) { where.push('l.device_id = ?'); params.push(filters.deviceId); }
  if (filters.techId) { where.push('l.tech_id = ?'); params.push(filters.techId); }
  if (filters.clientId) { where.push('l.client_id = ?'); params.push(filters.clientId); }
  if (filters.programId) { where.push('l.program_id = ?'); params.push(filters.programId); }

  // Scopes a counselor to loans held by their own caseload. Applied by the
  // route for the vrc role, not something a client can ask for.
  if (filters.counselorId) { where.push('c.counselor_id = ?'); params.push(filters.counselorId); }
  if (filters.from) { where.push('l.checked_out_at >= ?'); params.push(toMysqlDateTime(filters.from)); }
  if (filters.to) { where.push('l.checked_out_at <= ?'); params.push(toMysqlDateTime(filters.to)); }

  if (filters.search) {
    where.push(
      '(l.reference LIKE ? OR d.name LIKE ? OR d.barcode LIKE ? OR d.asset_tag LIKE ? ' +
      "OR CONCAT(c.first_name, ' ', c.last_name) LIKE ? OR t.full_name LIKE ?)",
    );
    const like = `%${filters.search}%`;
    params.push(like, like, like, like, like, like);
  }

  const whereSql = where.join(' AND ');
  const sortColumns = {
    checked_out_at: 'l.checked_out_at',
    due_at: 'l.due_at',
    reference: 'l.reference',
    device: 'd.name',
    status: 'l.status',
  };
  const orderSql = sortColumns[String(sort || '').replace(/^-/, '')]
    ? `${sortColumns[String(sort).replace(/^-/, '')]} ${String(sort).startsWith('-') ? 'DESC' : 'ASC'}`
    : 'l.checked_out_at DESC';

  const rows = await query(
    `${LOAN_SELECT} WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  );

  const countRow = await queryOne(
    `SELECT COUNT(*) AS total FROM loans l
       JOIN devices d ON d.id = l.device_id
       LEFT JOIN clients c ON c.id = l.client_id
       LEFT JOIN users t ON t.id = l.tech_id
      WHERE ${whereSql}`,
    params,
  );

  return { rows: rows.map(decorateLoan), total: Number(countRow?.total ?? 0) };
}

/** Loans approaching their due date, for the notification job. */
export async function findLoansDueSoon(organizationId, withinDays = 3) {
  const rows = await query(
    `${LOAN_SELECT}
      WHERE l.organization_id = ? AND l.status = 'active'
        AND l.due_at IS NOT NULL
        AND l.due_at >= NOW()
        AND l.due_at <= DATE_ADD(NOW(), INTERVAL ? DAY)
        AND NOT EXISTS (
          SELECT 1 FROM loan_events e
           WHERE e.loan_id = l.id AND e.event_type = 'due_soon_notice'
             AND e.created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)
        )
      ORDER BY l.due_at ASC`,
    [organizationId, Number(withinDays)],
  );
  return rows.map(decorateLoan);
}

/** Overdue loans that have not been chased in the last day. */
export async function findOverdueLoans(organizationId) {
  const rows = await query(
    `${LOAN_SELECT}
      WHERE l.organization_id = ? AND l.status = 'active'
        AND l.due_at IS NOT NULL AND l.due_at < NOW()
        AND NOT EXISTS (
          SELECT 1 FROM loan_events e
           WHERE e.loan_id = l.id AND e.event_type = 'overdue_notice'
             AND e.created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)
        )
      ORDER BY l.due_at ASC`,
    [organizationId],
  );
  return rows.map(decorateLoan);
}
