/**
 * Reservations and waitlist.
 *
 * Two kinds of reservation:
 *   - **Specific device** — "hold this exact unit for Jordan".
 *   - **Category** — "the next available magnifier", which is what a waitlist
 *     actually is.
 *
 * When a device is checked in, the queue is consulted and the first matching
 * waiting entry is promoted to `ready`, the device is held, and the requester
 * is notified. The hold expires after a configurable window so one person
 * who never collects cannot block everyone behind them indefinitely.
 *
 * Position in the queue is (priority DESC, created_at ASC) — computed, never
 * stored, because a stored position has to be renumbered on every insertion
 * and cancellation and is wrong the moment that fails halfway.
 */

import { transaction, connOne, connAll, query, queryOne, execute } from '../db.js';
import {
  notFound, conflict, badRequest, forbidden, makeReference, toMysqlDateTime,
} from './util.js';
import { recordAudit } from './audit.js';
import { getSettings } from './settings.js';

export const RESERVATION_STATUSES = ['waiting', 'ready', 'fulfilled', 'cancelled', 'expired'];

const RESERVATION_SELECT = `
  SELECT r.*,
         d.name AS device_name, d.barcode AS device_barcode, d.status AS device_status,
         rd.name AS ready_device_name, rd.barcode AS ready_device_barcode,
         c.first_name AS client_first_name, c.last_name AS client_last_name, c.email AS client_email,
         p.name AS program_name,
         u.full_name AS requester_name, u.email AS requester_email,
         l.reference AS loan_reference
    FROM reservations r
    LEFT JOIN devices d ON d.id = r.device_id
    LEFT JOIN devices rd ON rd.id = r.ready_device_id
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN programs p ON p.id = r.program_id
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN loans l ON l.id = r.fulfilled_loan_id`;

/**
 * Join the queue.
 *
 * If the requested thing is free right now, that is reported back rather than
 * silently queued — telling someone they are "position 1 in the queue" for a
 * device sitting on the shelf is a good way to lose trust in the queue.
 */
export async function createReservation(ctx, input) {
  const {
    organizationId, requestedBy, deviceId = null, category = null,
    clientId = null, programId = null, requestId = null,
    neededFrom = null, neededTo = null, priority = 0, notes = null,
  } = input;

  if (!deviceId && !category) {
    throw badRequest('Choose a specific device or a category to wait for.', {
      fields: ['device_id', 'category'],
    });
  }

  const available = await findAvailableMatch(organizationId, { deviceId, category });

  const result = await transaction(async (conn) => {
    if (deviceId) {
      const device = await connOne(
        conn, 'SELECT id, name FROM devices WHERE id = ? AND organization_id = ?',
        [deviceId, organizationId],
      );
      if (!device) throw badRequest('That device does not exist.', { field: 'device_id' });

      const duplicate = await connOne(
        conn,
        `SELECT reference FROM reservations
          WHERE device_id = ? AND requested_by = ? AND status IN ('waiting','ready')`,
        [deviceId, requestedBy],
      );
      if (duplicate) {
        throw conflict(
          `You are already on the waitlist for this device (${duplicate.reference}).`,
          { reference: duplicate.reference },
        );
      }
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const reference = makeReference('RS');
      try {
        const [res] = await conn.execute(
          `INSERT INTO reservations
             (organization_id, reference, device_id, category, client_id, program_id,
              request_id, requested_by, priority, needed_from, needed_to, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            organizationId, reference, deviceId, category, clientId, programId,
            requestId, requestedBy, priority, neededFrom, neededTo, notes,
          ],
        );
        return { id: res.insertId, reference };
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY' && String(err.sqlMessage || '').includes('reference')) continue;
        throw err;
      }
    }
    throw new Error('Could not allocate a unique reservation reference.');
  });

  await recordAudit(ctx, {
    organizationId,
    action: 'reservation.created',
    entityType: 'reservation',
    entityId: result.id,
    entityLabel: result.reference,
    summary: `Waitlist entry ${result.reference} for ${category || `device ${deviceId}`}`,
    detail: { device_id: deviceId, category, client_id: clientId, available_now: Boolean(available) },
  });

  const reservation = await getReservation(organizationId, result.id);

  return {
    reservation,
    // Surfaced so the UI can say "this is actually free now" instead of
    // pretending a queue is needed.
    available_now: available
      ? { id: available.id, name: available.name, barcode: available.barcode }
      : null,
  };
}

/** A free device matching the reservation criteria, if there is one. */
async function findAvailableMatch(organizationId, { deviceId, category }, conn = null) {
  const runner = conn
    ? (sql, params) => connOne(conn, sql, params)
    : (sql, params) => queryOne(sql, params);

  if (deviceId) {
    return runner(
      `SELECT d.id, d.name, d.barcode FROM devices d
        WHERE d.id = ? AND d.organization_id = ? AND d.status = 'available'
          AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.device_id = d.id AND l.status = 'active')
        ${conn ? 'FOR UPDATE' : ''}`,
      [deviceId, organizationId],
    );
  }

  return runner(
    `SELECT d.id, d.name, d.barcode FROM devices d
      WHERE d.organization_id = ? AND d.category = ? AND d.status = 'available'
        AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.device_id = d.id AND l.status = 'active')
        AND NOT EXISTS (
          SELECT 1 FROM reservations r
           WHERE r.ready_device_id = d.id AND r.status = 'ready'
        )
      ORDER BY d.id ASC LIMIT 1 ${conn ? 'FOR UPDATE' : ''}`,
    [organizationId, category],
  );
}

/**
 * Called after a device is checked in or otherwise becomes free.
 *
 * Promotes at most one waiting entry, because only one device became free.
 * Returns null when nobody is waiting, which is the common case and must be
 * cheap.
 */
export async function promoteNextForDevice(ctx, organizationId, deviceId) {
  const settings = await getSettings(organizationId);
  const holdHours = Number(settings['reservations.hold_hours']) || 48;

  const promoted = await transaction(async (conn) => {
    const device = await connOne(
      conn,
      `SELECT id, name, barcode, category, status FROM devices
        WHERE id = ? AND organization_id = ? FOR UPDATE`,
      [deviceId, organizationId],
    );
    if (!device || device.status !== 'available') return null;

    // Anyone waiting for this exact device outranks the category queue: they
    // asked for this unit specifically.
    const candidates = await connAll(
      conn,
      `SELECT * FROM reservations
        WHERE organization_id = ? AND status = 'waiting'
          AND (device_id = ? OR (device_id IS NULL AND category = ?))
        ORDER BY (device_id IS NULL) ASC, priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE`,
      [organizationId, deviceId, device.category],
    );

    if (!candidates.length) return null;
    const reservation = candidates[0];

    const expiresAt = new Date(Date.now() + holdHours * 3600_000);

    await conn.execute(
      `UPDATE reservations
          SET status = 'ready', ready_device_id = ?, notified_at = NOW(),
              claim_expires_at = ?, updated_at = NOW()
        WHERE id = ?`,
      [device.id, toMysqlDateTime(expiresAt), reservation.id],
    );

    // Hold the device so a walk-in check-out cannot take it from underneath
    // the person who has just been told it is ready.
    await conn.execute(
      `UPDATE devices SET status = 'reserved', updated_at = NOW() WHERE id = ?`,
      [device.id],
    );

    return { reservation, device, expiresAt };
  });

  if (!promoted) return null;

  await recordAudit(ctx, {
    organizationId,
    action: 'reservation.ready',
    entityType: 'reservation',
    entityId: promoted.reservation.id,
    entityLabel: promoted.reservation.reference,
    summary:
      `${promoted.device.name} held for ${promoted.reservation.reference} ` +
      `until ${promoted.expiresAt.toDateString()}`,
    detail: { device_id: promoted.device.id, hold_hours: holdHours },
  });

  return getReservation(organizationId, promoted.reservation.id);
}

/**
 * Release holds nobody collected, and pass the device to the next in line.
 * Called by the scheduled job.
 */
export async function expireStaleClaims(organizationId) {
  const stale = await query(
    `SELECT id, reference, ready_device_id FROM reservations
      WHERE organization_id = ? AND status = 'ready'
        AND claim_expires_at IS NOT NULL AND claim_expires_at < NOW()`,
    [organizationId],
  );

  let expired = 0;

  for (const row of stale) {
    await transaction(async (conn) => {
      await conn.execute(
        `UPDATE reservations SET status = 'expired', closed_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [row.id],
      );
      if (row.ready_device_id) {
        await conn.execute(
          `UPDATE devices SET status = 'available', updated_at = NOW()
            WHERE id = ? AND status = 'reserved'`,
          [row.ready_device_id],
        );
      }
    });

    expired += 1;

    // The device is free again — offer it to whoever is next.
    if (row.ready_device_id) {
      await promoteNextForDevice(
        { organizationId, actorType: 'system', label: 'Scheduled job' },
        organizationId,
        row.ready_device_id,
      ).catch(() => {});
    }
  }

  return expired;
}

export async function cancelReservation(ctx, { organizationId, reservationId, reason = null, auth = null }) {
  const result = await transaction(async (conn) => {
    const reservation = await connOne(
      conn, 'SELECT * FROM reservations WHERE id = ? AND organization_id = ? FOR UPDATE',
      [reservationId, organizationId],
    );
    if (!reservation) throw notFound('That reservation does not exist.');

    if (auth?.role === 'vrc' && reservation.requested_by !== auth.userId) {
      throw forbidden('You can only cancel waitlist entries you created.');
    }
    if (!['waiting', 'ready'].includes(reservation.status)) {
      throw conflict(`That reservation is already ${reservation.status}.`, { status: reservation.status });
    }

    await conn.execute(
      `UPDATE reservations SET status = 'cancelled', closed_at = NOW(), updated_at = NOW(),
              notes = CASE WHEN ? IS NULL THEN notes ELSE CONCAT(COALESCE(notes,''), ?) END
        WHERE id = ?`,
      [reason, reason ? `\n[cancelled] ${reason}` : null, reservationId],
    );

    if (reservation.ready_device_id) {
      await conn.execute(
        `UPDATE devices SET status = 'available', updated_at = NOW()
          WHERE id = ? AND status = 'reserved'`,
        [reservation.ready_device_id],
      );
    }

    return reservation;
  });

  await recordAudit(ctx, {
    organizationId,
    action: 'reservation.cancelled',
    entityType: 'reservation',
    entityId: reservationId,
    entityLabel: result.reference,
    summary: `Waitlist entry ${result.reference} cancelled${reason ? `: ${reason}` : ''}`,
  });

  // Their held device goes to the next person straight away.
  if (result.ready_device_id) {
    await promoteNextForDevice(ctx, organizationId, result.ready_device_id).catch(() => {});
  }

  return getReservation(organizationId, reservationId);
}

/** Mark a reservation as satisfied by a loan. */
export async function fulfilReservation(ctx, { organizationId, reservationId, loanId }) {
  await execute(
    `UPDATE reservations
        SET status = 'fulfilled', fulfilled_loan_id = ?, closed_at = NOW(), updated_at = NOW()
      WHERE id = ? AND organization_id = ?`,
    [loanId, reservationId, organizationId],
  );

  await recordAudit(ctx, {
    organizationId,
    action: 'reservation.fulfilled',
    entityType: 'reservation',
    entityId: reservationId,
    summary: `Waitlist entry satisfied by loan ${loanId}`,
    detail: { loan_id: loanId },
  });

  return getReservation(organizationId, reservationId);
}

export async function getReservation(organizationId, reservationId) {
  const row = await queryOne(
    `${RESERVATION_SELECT} WHERE r.id = ? AND r.organization_id = ?`,
    [reservationId, organizationId],
  );
  return row ? await decorate(row) : null;
}

async function decorate(row) {
  return {
    ...row,
    client_name: row.client_first_name ? `${row.client_first_name} ${row.client_last_name}` : null,
    wants: row.device_name || row.category || 'Unspecified',
    queue_position: row.status === 'waiting' ? await positionOf(row) : null,
    claim_expires_in_hours: row.claim_expires_at
      ? Math.max(0, Math.round((new Date(row.claim_expires_at).getTime() - Date.now()) / 3600_000))
      : null,
  };
}

/** Position is computed from the ordering, never stored. */
async function positionOf(row) {
  const result = await queryOne(
    `SELECT COUNT(*) + 1 AS position FROM reservations
      WHERE organization_id = ? AND status = 'waiting'
        AND ${row.device_id ? 'device_id = ?' : 'category <=> ?'}
        AND (priority > ? OR (priority = ? AND created_at < ?))`,
    [
      row.organization_id,
      row.device_id ?? row.category,
      row.priority, row.priority, toMysqlDateTime(row.created_at),
    ],
  );
  return Number(result?.position ?? 1);
}

export async function listReservations(organizationId, filters = {}, { limit = 50, offset = 0 } = {}) {
  const where = ['r.organization_id = ?'];
  const params = [organizationId];

  if (filters.status) { where.push('r.status = ?'); params.push(filters.status); }
  if (filters.open) { where.push(`r.status IN ('waiting','ready')`); }
  if (filters.deviceId) { where.push('r.device_id = ?'); params.push(filters.deviceId); }
  if (filters.category) { where.push('r.category = ?'); params.push(filters.category); }
  if (filters.clientId) { where.push('r.client_id = ?'); params.push(filters.clientId); }
  if (filters.requestedBy) { where.push('r.requested_by = ?'); params.push(filters.requestedBy); }

  const whereSql = where.join(' AND ');

  const rows = await query(
    `${RESERVATION_SELECT} WHERE ${whereSql}
      ORDER BY FIELD(r.status, 'ready', 'waiting', 'fulfilled', 'expired', 'cancelled'),
               r.priority DESC, r.created_at ASC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  );

  const countRow = await queryOne(
    `SELECT COUNT(*) AS total FROM reservations r WHERE ${whereSql}`,
    params,
  );

  const decorated = [];
  for (const row of rows) decorated.push(await decorate(row));

  return { rows: decorated, total: Number(countRow?.total ?? 0) };
}

/** Anyone waiting on a given device or its category, for the device screen. */
export async function waitlistForDevice(organizationId, deviceId) {
  const device = await queryOne(
    'SELECT category FROM devices WHERE id = ? AND organization_id = ?',
    [deviceId, organizationId],
  );
  if (!device) return [];

  const rows = await query(
    `${RESERVATION_SELECT}
      WHERE r.organization_id = ? AND r.status IN ('waiting','ready')
        AND (r.device_id = ? OR (r.device_id IS NULL AND r.category <=> ?))
      ORDER BY (r.device_id IS NULL) ASC, r.priority DESC, r.created_at ASC`,
    [organizationId, deviceId, device.category],
  );

  const decorated = [];
  for (const row of rows) decorated.push(await decorate(row));
  return decorated;
}
