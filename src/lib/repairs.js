/**
 * Repair tracking.
 *
 * A device can already be marked "maintenance", but that says nothing about
 * what is wrong, who is fixing it, what it cost or when it is coming back.
 * A repair ticket carries that, and owns the device's status while it is open:
 * opening one moves the device to maintenance, closing one returns it to the
 * pool (or retires it), so the two can never disagree.
 */

import { transaction, connOne, query, queryOne, execute } from '../db.js';
import { notFound, conflict, badRequest, makeReference, toMysqlDateTime } from './util.js';
import { recordAudit } from './audit.js';

export const REPAIR_STATUSES = [
  'reported', 'diagnosing', 'awaiting_parts', 'with_vendor', 'repaired', 'unrepairable', 'cancelled',
];

export const REPAIR_LABELS = {
  reported: 'Reported',
  diagnosing: 'Being diagnosed',
  awaiting_parts: 'Waiting for parts',
  with_vendor: 'With the vendor',
  repaired: 'Repaired',
  unrepairable: 'Beyond repair',
  cancelled: 'Cancelled',
};

/** Statuses that mean the ticket is finished and the device is free again. */
const CLOSED = new Set(['repaired', 'unrepairable', 'cancelled']);

const REPAIR_SELECT = `
  SELECT r.*,
         d.name AS device_name, d.barcode AS device_barcode, d.serial_number, d.category,
         d.warranty_expires,
         rep.full_name AS reported_by_name,
         asg.full_name AS assigned_to_name,
         l.reference AS loan_reference
    FROM repairs r
    JOIN devices d ON d.id = r.device_id
    LEFT JOIN users rep ON rep.id = r.reported_by
    LEFT JOIN users asg ON asg.id = r.assigned_to
    LEFT JOIN loans l ON l.id = r.loan_id`;

/**
 * Open a repair ticket.
 *
 * Refused while the device is on loan: a device cannot simultaneously be with
 * a client and on the repair bench, and quietly allowing it produces an
 * inventory nobody trusts.
 */
export async function openRepair(ctx, input) {
  const {
    organizationId, deviceId, fault, loanId = null, vendor = null,
    assignedTo = null, underWarranty = null, reportedBy = null,
  } = input;

  if (!fault || !String(fault).trim()) {
    throw badRequest('Describe what is wrong with the device.', { field: 'fault' });
  }

  const result = await transaction(async (conn) => {
    const device = await connOne(
      conn, 'SELECT * FROM devices WHERE id = ? AND organization_id = ? FOR UPDATE',
      [deviceId, organizationId],
    );
    if (!device) throw notFound('That device does not exist.');

    const activeLoan = await connOne(
      conn, `SELECT reference FROM loans WHERE device_id = ? AND status = 'active'`, [deviceId],
    );
    if (activeLoan) {
      throw conflict(
        `${device.name} is currently on loan (${activeLoan.reference}). ` +
        'Check it in — marking it as needing maintenance as you do — before opening a repair.',
        { loan_reference: activeLoan.reference },
      );
    }

    const open = await connOne(
      conn,
      `SELECT reference FROM repairs
        WHERE device_id = ? AND status NOT IN ('repaired','unrepairable','cancelled')`,
      [deviceId],
    );
    if (open) {
      throw conflict(
        `${device.name} already has an open repair (${open.reference}).`,
        { reference: open.reference },
      );
    }

    // Default the warranty flag from the device's own warranty date rather
    // than making someone look it up.
    const inWarranty = underWarranty !== null
      ? underWarranty
      : Boolean(device.warranty_expires && new Date(device.warranty_expires) > new Date());

    let created = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const reference = makeReference('RP');
      try {
        const [res] = await conn.execute(
          `INSERT INTO repairs
             (organization_id, reference, device_id, loan_id, fault, vendor,
              assigned_to, under_warranty, reported_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [organizationId, reference, deviceId, loanId, String(fault).trim(),
           vendor, assignedTo, inWarranty ? 1 : 0, reportedBy],
        );
        created = { id: res.insertId, reference };
        break;
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY' && String(err.sqlMessage || '').includes('reference')) continue;
        throw err;
      }
    }
    if (!created) throw new Error('Could not allocate a unique repair reference.');

    await conn.execute(
      `UPDATE devices SET status = 'maintenance', active_repair_id = ?, updated_at = NOW() WHERE id = ?`,
      [created.id, deviceId],
    );

    await conn.execute(
      `INSERT INTO repair_events (repair_id, event_type, to_status, actor_id, notes)
       VALUES (?, 'opened', 'reported', ?, ?)`,
      [created.id, reportedBy, String(fault).trim()],
    );

    return { ...created, device, inWarranty };
  });

  await recordAudit(ctx, {
    organizationId,
    action: 'repair.opened',
    entityType: 'repair',
    entityId: result.id,
    entityLabel: result.reference,
    summary: `Opened repair ${result.reference} for ${result.device.name}: ${String(fault).slice(0, 120)}`,
    detail: { device_id: deviceId, vendor, under_warranty: result.inWarranty },
  });

  return getRepair(organizationId, result.id);
}

/** Move a ticket along, and release the device when it closes. */
export async function updateRepair(ctx, input) {
  const {
    organizationId, repairId, status = null, diagnosis, resolution,
    vendor, vendorRef, cost, assignedTo, notes = null, actorId = null,
    deviceStatusOnClose = 'available',
  } = input;

  if (status && !REPAIR_STATUSES.includes(status)) {
    throw badRequest(`"${status}" is not a repair status.`, { allowed: REPAIR_STATUSES });
  }

  const result = await transaction(async (conn) => {
    const repair = await connOne(
      conn, 'SELECT * FROM repairs WHERE id = ? AND organization_id = ? FOR UPDATE',
      [repairId, organizationId],
    );
    if (!repair) throw notFound('That repair does not exist.');

    if (CLOSED.has(repair.status) && status && status !== repair.status) {
      throw conflict(
        `Repair ${repair.reference} is already ${REPAIR_LABELS[repair.status].toLowerCase()} and cannot be reopened. ` +
        'Open a new repair instead, so each fault keeps its own history.',
        { status: repair.status },
      );
    }

    const sets = [];
    const params = [];
    const push = (column, value) => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      params.push(value);
    };

    push('diagnosis', diagnosis);
    push('resolution', resolution);
    push('vendor', vendor);
    push('vendor_ref', vendorRef);
    push('cost', cost);
    push('assigned_to', assignedTo);

    if (status && status !== repair.status) {
      sets.push('status = ?');
      params.push(status);

      if (status === 'with_vendor' && !repair.sent_at) {
        sets.push('sent_at = NOW()');
      }
      if (CLOSED.has(status)) {
        sets.push('closed_at = NOW()');
        if (!repair.returned_at) sets.push('returned_at = NOW()');
      }
    }

    if (!sets.length && !notes) throw badRequest('No changes were supplied.');

    if (sets.length) {
      params.push(repairId);
      await conn.execute(
        `UPDATE repairs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`,
        params,
      );
    }

    await conn.execute(
      `INSERT INTO repair_events (repair_id, event_type, from_status, to_status, actor_id, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        repairId,
        status && status !== repair.status ? 'status_changed' : 'note',
        repair.status,
        status ?? repair.status,
        actorId,
        notes,
      ],
    );

    // Closing the ticket hands the device back. "Beyond repair" retires it
    // rather than putting broken equipment back into the lendable pool.
    if (status && CLOSED.has(status)) {
      const newDeviceStatus = status === 'unrepairable'
        ? 'retired'
        : (deviceStatusOnClose === 'retired' ? 'retired' : 'available');

      await conn.execute(
        `UPDATE devices SET status = ?, active_repair_id = NULL, updated_at = NOW() WHERE id = ?`,
        [newDeviceStatus, repair.device_id],
      );

      return { repair, closed: true, newDeviceStatus, status };
    }

    return { repair, closed: false, status };
  });

  await recordAudit(ctx, {
    organizationId,
    action: result.closed ? 'repair.closed' : 'repair.updated',
    entityType: 'repair',
    entityId: repairId,
    entityLabel: result.repair.reference,
    summary: result.closed
      ? `Closed repair ${result.repair.reference} as ${REPAIR_LABELS[result.status].toLowerCase()}; ` +
        `device set to ${result.newDeviceStatus}`
      : `Updated repair ${result.repair.reference}${status ? ` → ${REPAIR_LABELS[status]}` : ''}`,
    detail: { status, cost, vendor, notes },
  });

  return getRepair(organizationId, repairId);
}

export async function getRepair(organizationId, repairId) {
  const row = await queryOne(
    `${REPAIR_SELECT} WHERE r.id = ? AND r.organization_id = ?`,
    [repairId, organizationId],
  );
  if (!row) return null;

  const events = await query(
    `SELECT e.*, u.full_name AS actor_name
       FROM repair_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.repair_id = ?
      ORDER BY e.created_at ASC, e.id ASC`,
    [repairId],
  );

  return { ...decorate(row), timeline: events };
}

function decorate(row) {
  const opened = new Date(row.created_at).getTime();
  const closed = row.closed_at ? new Date(row.closed_at).getTime() : Date.now();

  return {
    ...row,
    status_label: REPAIR_LABELS[row.status] ?? row.status,
    is_open: !CLOSED.has(row.status),
    days_open: Math.max(0, Math.round((closed - opened) / 86400000)),
    cost: row.cost === null ? null : Number(row.cost),
  };
}

export async function listRepairs(organizationId, filters = {}, { limit = 50, offset = 0 } = {}) {
  const where = ['r.organization_id = ?'];
  const params = [organizationId];

  if (filters.status) { where.push('r.status = ?'); params.push(filters.status); }
  if (filters.open) { where.push(`r.status NOT IN ('repaired','unrepairable','cancelled')`); }
  if (filters.deviceId) { where.push('r.device_id = ?'); params.push(filters.deviceId); }
  if (filters.assignedTo) { where.push('r.assigned_to = ?'); params.push(filters.assignedTo); }
  if (filters.vendor) { where.push('r.vendor = ?'); params.push(filters.vendor); }
  if (filters.search) {
    where.push('(r.reference LIKE ? OR r.fault LIKE ? OR d.name LIKE ? OR d.barcode LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like, like);
  }

  const whereSql = where.join(' AND ');

  const rows = await query(
    `${REPAIR_SELECT} WHERE ${whereSql}
      ORDER BY r.status IN ('repaired','unrepairable','cancelled') ASC, r.created_at DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  );

  const countRow = await queryOne(
    `SELECT COUNT(*) AS total FROM repairs r JOIN devices d ON d.id = r.device_id WHERE ${whereSql}`,
    params,
  );

  return { rows: rows.map(decorate), total: Number(countRow?.total ?? 0) };
}

/** Repair cost and downtime summary, for the reports screen. */
export async function repairSummary(organizationId, filters = {}) {
  const clauses = ['r.organization_id = ?'];
  const params = [organizationId];

  if (filters.from) { clauses.push('r.created_at >= ?'); params.push(toMysqlDateTime(filters.from)); }
  if (filters.to) { clauses.push('r.created_at <= ?'); params.push(toMysqlDateTime(filters.to)); }

  const where = clauses.join(' AND ');

  const totals = await queryOne(
    `SELECT COUNT(*) AS total,
            SUM(r.status NOT IN ('repaired','unrepairable','cancelled')) AS open_count,
            SUM(r.status = 'repaired') AS repaired,
            SUM(r.status = 'unrepairable') AS unrepairable,
            COALESCE(SUM(r.cost), 0) AS total_cost,
            COALESCE(SUM(CASE WHEN r.under_warranty = 0 THEN r.cost END), 0) AS out_of_warranty_cost,
            COALESCE(AVG(CASE WHEN r.closed_at IS NOT NULL
                              THEN DATEDIFF(r.closed_at, r.created_at) END), 0) AS avg_days_to_close
       FROM repairs r WHERE ${where}`,
    params,
  );

  const byVendor = await query(
    `SELECT COALESCE(r.vendor, '(in house)') AS vendor,
            COUNT(*) AS tickets,
            COALESCE(SUM(r.cost), 0) AS cost,
            COALESCE(AVG(CASE WHEN r.closed_at IS NOT NULL
                              THEN DATEDIFF(r.closed_at, r.created_at) END), 0) AS avg_days
       FROM repairs r WHERE ${where}
      GROUP BY COALESCE(r.vendor, '(in house)')
      ORDER BY cost DESC`,
    params,
  );

  const worstDevices = await query(
    `SELECT d.id, d.name, d.barcode, COUNT(*) AS repair_count,
            COALESCE(SUM(r.cost), 0) AS total_cost
       FROM repairs r JOIN devices d ON d.id = r.device_id
      WHERE ${where}
      GROUP BY d.id
     HAVING repair_count > 1
      ORDER BY repair_count DESC, total_cost DESC
      LIMIT 20`,
    params,
  );

  return {
    total: Number(totals?.total ?? 0),
    open: Number(totals?.open_count ?? 0),
    repaired: Number(totals?.repaired ?? 0),
    unrepairable: Number(totals?.unrepairable ?? 0),
    total_cost: Number(totals?.total_cost ?? 0),
    out_of_warranty_cost: Number(totals?.out_of_warranty_cost ?? 0),
    avg_days_to_close: Math.round(Number(totals?.avg_days_to_close ?? 0) * 10) / 10,
    by_vendor: byVendor.map((v) => ({
      ...v, tickets: Number(v.tickets), cost: Number(v.cost),
      avg_days: Math.round(Number(v.avg_days) * 10) / 10,
    })),
    repeat_offenders: worstDevices.map((d) => ({
      ...d, repair_count: Number(d.repair_count), total_cost: Number(d.total_cost),
    })),
  };
}
