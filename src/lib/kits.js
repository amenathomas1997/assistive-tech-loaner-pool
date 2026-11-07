/**
 * Accessories and kits.
 *
 * Two different problems that look similar:
 *
 * **Accessories** are the charger, case and dongle that go out with a device
 * and are not worth their own barcode — but are exactly what goes missing.
 * They are a checklist on the device, ticked at check-out and again at
 * check-in, with the difference recorded on the loan.
 *
 * **Kits** are named bundles of separately tracked devices ("Assessment kit
 * B"). Checking out a kit creates one loan per device sharing a group
 * reference, so the invariant that a device has at most one active loan
 * survives, and each unit keeps its own history.
 */

import { transaction, connOne, connAll, query, queryOne, execute } from '../db.js';
import { notFound, conflict, badRequest, randomCode } from './util.js';
import { recordAudit } from './audit.js';
import { checkOutDevice, checkInDevice } from './loans.js';

// ---------------------------------------------------------------------------
// Accessories
// ---------------------------------------------------------------------------

export async function listAccessories(deviceId) {
  return query(
    'SELECT * FROM device_accessories WHERE device_id = ? ORDER BY sort_order ASC, name ASC',
    [deviceId],
  );
}

export async function setAccessories(ctx, organizationId, deviceId, accessories) {
  const device = await queryOne(
    'SELECT id, name FROM devices WHERE id = ? AND organization_id = ?',
    [deviceId, organizationId],
  );
  if (!device) throw notFound('That device does not exist.');

  await transaction(async (conn) => {
    await conn.execute('DELETE FROM device_accessories WHERE device_id = ?', [deviceId]);

    for (const [index, accessory] of accessories.entries()) {
      const name = String(accessory?.name ?? '').trim();
      if (!name) continue;
      await conn.execute(
        `INSERT INTO device_accessories (device_id, name, required, sort_order)
         VALUES (?, ?, ?, ?)`,
        [deviceId, name.slice(0, 120), accessory.required === false ? 0 : 1, index],
      );
    }
  });

  await recordAudit(ctx, {
    organizationId,
    action: 'device.updated',
    entityType: 'device',
    entityId: deviceId,
    entityLabel: device.name,
    summary: `Updated the accessory checklist for ${device.name} (${accessories.length} item(s))`,
    detail: { accessories: accessories.map((a) => a.name) },
  });

  return listAccessories(deviceId);
}

/**
 * Normalise a checklist submitted at check-out or check-in into
 * `{ name: boolean }`, keeping only accessories the device actually has.
 */
export function normaliseChecklist(accessories, submitted) {
  const known = new Map(accessories.map((a) => [a.name, a]));
  const result = {};

  for (const accessory of accessories) {
    const value = submitted?.[accessory.name];
    result[accessory.name] = value === true || value === 'true' || value === 1 || value === '1';
  }

  // Anything submitted that the device does not list is dropped rather than
  // stored, so a stale form cannot invent accessories.
  for (const key of Object.keys(submitted || {})) {
    if (!known.has(key)) delete result[key];
  }

  return result;
}

/** Which required accessories went out but did not come back. */
export function missingAccessories(outChecklist, inChecklist, accessories) {
  const required = new Set(accessories.filter((a) => a.required).map((a) => a.name));
  const missing = [];

  for (const [name, wentOut] of Object.entries(outChecklist || {})) {
    if (!wentOut) continue;
    const cameBack = Boolean((inChecklist || {})[name]);
    if (!cameBack) missing.push({ name, required: required.has(name) });
  }

  return missing;
}

export function parseChecklist(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Kits
// ---------------------------------------------------------------------------

export async function listKits(organizationId, { includeInactive = false } = {}) {
  const kits = await query(
    `SELECT k.*,
            (SELECT COUNT(*) FROM kit_items i WHERE i.kit_id = k.id) AS item_count
       FROM kits k
      WHERE k.organization_id = ? ${includeInactive ? '' : 'AND k.active = 1'}
      ORDER BY k.name ASC`,
    [organizationId],
  );

  for (const kit of kits) {
    kit.items = await query(
      `SELECT i.id, i.device_id, i.required, i.sort_order,
              d.name, d.barcode, d.status, d.category,
              l.id AS active_loan_id, l.reference AS active_loan_reference
         FROM kit_items i
         JOIN devices d ON d.id = i.device_id
         LEFT JOIN loans l ON l.device_id = d.id AND l.status = 'active'
        WHERE i.kit_id = ?
        ORDER BY i.sort_order ASC, d.name ASC`,
      [kit.id],
    );

    kit.item_count = Number(kit.item_count);
    kit.available_count = kit.items.filter(
      (item) => item.status === 'available' && !item.active_loan_id,
    ).length;
    // A kit is only lendable when every *required* member is free.
    kit.can_check_out = kit.items
      .filter((item) => item.required)
      .every((item) => item.status === 'available' && !item.active_loan_id);
  }

  return kits;
}

export async function getKit(organizationId, kitId) {
  const kits = await listKits(organizationId, { includeInactive: true });
  return kits.find((k) => k.id === Number(kitId)) || null;
}

export async function createKit(ctx, organizationId, { name, description = null, deviceIds = [] }) {
  const kit = await transaction(async (conn) => {
    const [result] = await conn.execute(
      'INSERT INTO kits (organization_id, name, description) VALUES (?, ?, ?)',
      [organizationId, name, description ?? null],
    );

    for (const [index, deviceId] of deviceIds.entries()) {
      const device = await connOne(
        conn, 'SELECT id FROM devices WHERE id = ? AND organization_id = ?',
        [deviceId, organizationId],
      );
      if (!device) throw badRequest(`Device ${deviceId} does not exist.`);

      await conn.execute(
        'INSERT INTO kit_items (kit_id, device_id, sort_order) VALUES (?, ?, ?)',
        [result.insertId, deviceId, index],
      );
    }

    return { id: result.insertId };
  }).catch((err) => {
    if (err?.code === 'ER_DUP_ENTRY') {
      throw conflict('A kit with that name already exists.', { field: 'name' });
    }
    throw err;
  });

  await recordAudit(ctx, {
    organizationId,
    action: 'kit.created',
    entityType: 'kit',
    entityId: kit.id,
    entityLabel: name,
    summary: `Created kit "${name}" with ${deviceIds.length} device(s)`,
  });

  return getKit(organizationId, kit.id);
}

export async function updateKit(ctx, organizationId, kitId, { name, description, active, deviceIds }) {
  const existing = await getKit(organizationId, kitId);
  if (!existing) throw notFound('That kit does not exist.');

  await transaction(async (conn) => {
    const sets = [];
    const params = [];
    if (name !== undefined) { sets.push('name = ?'); params.push(name); }
    if (description !== undefined) { sets.push('description = ?'); params.push(description); }
    if (active !== undefined) { sets.push('active = ?'); params.push(active ? 1 : 0); }

    if (sets.length) {
      params.push(kitId, organizationId);
      await conn.execute(
        `UPDATE kits SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`,
        params,
      );
    }

    if (Array.isArray(deviceIds)) {
      await conn.execute('DELETE FROM kit_items WHERE kit_id = ?', [kitId]);
      for (const [index, deviceId] of deviceIds.entries()) {
        await conn.execute(
          'INSERT INTO kit_items (kit_id, device_id, sort_order) VALUES (?, ?, ?)',
          [kitId, deviceId, index],
        );
      }
    }
  });

  await recordAudit(ctx, {
    organizationId,
    action: 'kit.updated',
    entityType: 'kit',
    entityId: kitId,
    entityLabel: name ?? existing.name,
    summary: `Updated kit "${name ?? existing.name}"`,
  });

  return getKit(organizationId, kitId);
}

export async function deleteKit(ctx, organizationId, kitId) {
  const kit = await getKit(organizationId, kitId);
  if (!kit) throw notFound('That kit does not exist.');

  // Deleting a kit never touches the devices in it — they exist independently
  // and may be on loan right now.
  await execute('DELETE FROM kits WHERE id = ? AND organization_id = ?', [kitId, organizationId]);

  await recordAudit(ctx, {
    organizationId,
    action: 'kit.deleted',
    entityType: 'kit',
    entityId: kitId,
    entityLabel: kit.name,
    summary: `Deleted kit "${kit.name}" (its ${kit.item_count} device(s) are unaffected)`,
  });

  return { deleted: true };
}

/**
 * Check out every device in a kit under one group reference.
 *
 * Not a single transaction across all devices on purpose: each device goes
 * through the same locked `checkOutDevice` path as a normal loan, and a member
 * that turns out to be unavailable is reported rather than rolling back the
 * ones that succeeded. A partly-issued kit that says so is more useful at the
 * desk than an all-or-nothing failure with no explanation.
 */
export async function checkOutKit(ctx, input) {
  const {
    organizationId, kitId, techId = null, clientId = null, programId = null,
    loanPeriodId = null, customDays = null, notes = null, conditionOut = null,
    method = 'manual', actorId = null, skipUnavailable = true,
  } = input;

  const kit = await getKit(organizationId, kitId);
  if (!kit) throw notFound('That kit does not exist.');
  if (!kit.items.length) throw badRequest('That kit has no devices in it.');

  const blockedRequired = kit.items.filter(
    (item) => item.required && (item.status !== 'available' || item.active_loan_id),
  );

  if (blockedRequired.length && !skipUnavailable) {
    throw conflict(
      `${blockedRequired.length} required item(s) in "${kit.name}" are not available: ` +
      blockedRequired.map((i) => i.name).join(', '),
      { blocked: blockedRequired.map((i) => ({ device_id: i.device_id, name: i.name, status: i.status })) },
    );
  }

  const groupRef = `KIT-${randomCode(6)}`;
  const issued = [];
  const skipped = [];

  for (const item of kit.items) {
    try {
      const loan = await checkOutDevice(ctx, {
        organizationId,
        deviceIdentifier: item.device_id,
        techId, clientId, programId, loanPeriodId, customDays,
        notes: notes ? `${notes} (kit: ${kit.name})` : `Part of kit: ${kit.name}`,
        conditionOut,
        method,
        actorId,
      });

      await execute('UPDATE loans SET group_ref = ?, kit_id = ? WHERE id = ?', [groupRef, kitId, loan.id]);
      issued.push({ ...loan, group_ref: groupRef });
    } catch (err) {
      skipped.push({
        device_id: item.device_id,
        name: item.name,
        required: Boolean(item.required),
        reason: err.message,
      });
    }
  }

  await recordAudit(ctx, {
    organizationId,
    action: 'kit.checked_out',
    entityType: 'kit',
    entityId: kitId,
    entityLabel: kit.name,
    summary:
      `Checked out kit "${kit.name}" as ${groupRef}: ${issued.length} issued` +
      (skipped.length ? `, ${skipped.length} unavailable` : ''),
    detail: { group_ref: groupRef, issued: issued.length, skipped },
  });

  return {
    kit: { id: kit.id, name: kit.name },
    group_ref: groupRef,
    loans: issued,
    skipped,
    complete: skipped.length === 0,
  };
}

/** Check every device in a group back in at once. */
export async function checkInGroup(ctx, { organizationId, groupRef, conditionIn = null, notes = null, actorId = null, method = 'manual' }) {
  const loans = await query(
    `SELECT id, device_id FROM loans
      WHERE group_ref = ? AND organization_id = ? AND status = 'active'`,
    [groupRef, organizationId],
  );

  if (!loans.length) {
    throw notFound(`Nothing is currently on loan under the group reference "${groupRef}".`);
  }

  const returned = [];
  const failed = [];

  for (const loan of loans) {
    try {
      const result = await checkInDevice(ctx, {
        organizationId, loanId: loan.id, conditionIn, notes, method, actorId,
      });
      returned.push(result);
    } catch (err) {
      failed.push({ loan_id: loan.id, device_id: loan.device_id, reason: err.message });
    }
  }

  await recordAudit(ctx, {
    organizationId,
    action: 'kit.checked_in',
    entityType: 'loan_group',
    entityLabel: groupRef,
    summary: `Checked in ${returned.length} device(s) from ${groupRef}`,
    detail: { group_ref: groupRef, returned: returned.length, failed },
  });

  return { group_ref: groupRef, returned, failed, complete: failed.length === 0 };
}

/** Every loan sharing a group reference, for the loan screen. */
export async function loansInGroup(organizationId, groupRef) {
  return query(
    `SELECT l.id, l.reference, l.status, l.due_at, l.returned_at,
            d.name AS device_name, d.barcode AS device_barcode
       FROM loans l JOIN devices d ON d.id = l.device_id
      WHERE l.group_ref = ? AND l.organization_id = ?
      ORDER BY d.name ASC`,
    [groupRef, organizationId],
  );
}
