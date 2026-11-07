/**
 * VRC loan requests and their fulfilment.
 *
 * Flow:
 *   VRC submits            -> status=submitted,  fulfillment=pending
 *   Tech approves          -> status=approved,   fulfillment=pending
 *   Tech starts work       -> fulfillment=provisioning
 *   Tech takes it out      -> fulfillment=in_transit      (deliver_to_client)
 *   Tech stages it         -> fulfillment=ready_pickup    (vrc_pickup)
 *   Device handed over     -> status=fulfilled, fulfillment=delivered, loan created
 *
 * The two axes are kept separate on purpose: "approved but not yet provisioned"
 * and "approved and sitting on the shelf ready for the VRC" are different
 * things to the person asking where their equipment is.
 */

import { transaction, connOne, query, queryOne } from '../db.js';
import {
  notFound, badRequest, conflict, forbidden, makeReference, toMysqlDateTime,
} from './util.js';
import { recordAudit, AUDIT_ACTIONS } from './audit.js';
import { checkOutDevice } from './loans.js';

export const REQUEST_STATUSES = ['submitted', 'approved', 'denied', 'cancelled', 'fulfilled'];
export const FULFILLMENT_STATES = ['pending', 'provisioning', 'in_transit', 'ready_pickup', 'delivered'];

export const FULFILLMENT_LABELS = {
  pending: 'Not started',
  provisioning: 'Being provisioned',
  in_transit: 'On its way to the client',
  ready_pickup: 'Ready for pickup',
  delivered: 'Delivered',
};

/**
 * Which fulfilment states may follow which. Enforced so the tracker cannot be
 * driven into a state the VRC would read as progress when it is not.
 */
const FULFILLMENT_TRANSITIONS = {
  pending: ['provisioning', 'in_transit', 'ready_pickup'],
  provisioning: ['in_transit', 'ready_pickup', 'pending'],
  in_transit: ['delivered', 'ready_pickup', 'provisioning'],
  ready_pickup: ['delivered', 'in_transit', 'provisioning'],
  delivered: [],
};

const REQUEST_SELECT = `
  SELECT r.*,
         u.full_name AS requester_name, u.email AS requester_email,
         c.first_name AS client_first_name, c.last_name AS client_last_name,
         c.email AS client_email, c.phone AS client_phone,
         p.name AS program_name,
         d.name AS device_name, d.barcode AS device_barcode, d.status AS device_status,
         t.full_name AS assigned_tech_name, t.email AS assigned_tech_email,
         rv.full_name AS reviewer_name,
         lp.name AS period_name, lp.days AS period_days,
         l.reference AS loan_reference, l.due_at AS loan_due_at
    FROM loan_requests r
    JOIN users u ON u.id = r.requested_by
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN programs p ON p.id = r.program_id
    LEFT JOIN devices d ON d.id = r.device_id
    LEFT JOIN users t ON t.id = r.assigned_tech_id
    LEFT JOIN users rv ON rv.id = r.reviewed_by
    LEFT JOIN loan_periods lp ON lp.id = r.loan_period_id
    LEFT JOIN loans l ON l.id = r.loan_id`;

export async function getRequest(organizationId, requestId) {
  const row = await queryOne(
    `${REQUEST_SELECT} WHERE r.id = ? AND r.organization_id = ?`,
    [requestId, organizationId],
  );
  return row ? decorateRequest(row) : null;
}

export function decorateRequest(row) {
  return {
    ...row,
    client_name: row.client_first_name ? `${row.client_first_name} ${row.client_last_name}` : null,
    fulfillment_label: FULFILLMENT_LABELS[row.fulfillment_state] ?? row.fulfillment_state,
    // What the requester is actually waiting on, in one phrase.
    tracking_summary: describeTracking(row),
    can_be_cancelled: ['submitted', 'approved'].includes(row.status),
    next_states: FULFILLMENT_TRANSITIONS[row.fulfillment_state] ?? [],
  };
}

function describeTracking(row) {
  if (row.status === 'submitted') return 'Waiting for a technician to review it';
  if (row.status === 'denied') return 'Declined';
  if (row.status === 'cancelled') return 'Cancelled';
  if (row.status === 'fulfilled') return 'Delivered';

  switch (row.fulfillment_state) {
    case 'pending': return 'Approved — not yet started';
    case 'provisioning': return 'A technician is setting up the device';
    case 'in_transit': return 'On its way to the client';
    case 'ready_pickup': return 'Ready for you to collect';
    default: return FULFILLMENT_LABELS[row.fulfillment_state] ?? 'In progress';
  }
}

/** Submit a request. Anyone with requests.write may do this. */
export async function createRequest(ctx, input) {
  const {
    organizationId,
    requestedBy,
    clientId = null,
    programId = null,
    deviceId = null,
    requestedCategory = null,
    requestedDetails = null,
    justification = null,
    neededBy = null,
    loanPeriodId = null,
    requestedDays = null,
    deliveryMode = 'vrc_pickup',
    autoApprove = false,
    actorId = null,
  } = input;

  if (!deviceId && !requestedCategory && !requestedDetails) {
    throw badRequest(
      'Say what is needed: pick a specific device, or choose a category, or describe the requirement.',
      { fields: ['device_id', 'requested_category', 'requested_details'] },
    );
  }

  const result = await transaction(async (conn) => {
    if (clientId) {
      const client = await connOne(
        conn, 'SELECT id FROM clients WHERE id = ? AND organization_id = ?', [clientId, organizationId],
      );
      if (!client) throw badRequest('That client does not exist.', { field: 'client_id' });
    }
    if (deviceId) {
      const device = await connOne(
        conn, 'SELECT id, name, status FROM devices WHERE id = ? AND organization_id = ?',
        [deviceId, organizationId],
      );
      if (!device) throw badRequest('That device does not exist.', { field: 'device_id' });
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const reference = makeReference('RQ');
      try {
        const [res] = await conn.execute(
          `INSERT INTO loan_requests
             (organization_id, reference, requested_by, client_id, program_id, device_id,
              requested_category, requested_details, justification, needed_by,
              loan_period_id, requested_days, delivery_mode, status, fulfillment_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [
            organizationId, reference, requestedBy, clientId, programId, deviceId,
            requestedCategory, requestedDetails, justification, neededBy,
            loanPeriodId, requestedDays, deliveryMode,
            autoApprove ? 'approved' : 'submitted',
          ],
        );
        return { id: res.insertId, reference };
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY' && String(err.sqlMessage || '').includes('reference')) continue;
        throw err;
      }
    }
    throw new Error('Could not allocate a unique request reference.');
  });

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.REQUEST_SUBMITTED,
    entityType: 'request',
    entityId: result.id,
    entityLabel: result.reference,
    summary: `Loan request ${result.reference} submitted`,
    detail: { client_id: clientId, device_id: deviceId, category: requestedCategory, delivery_mode: deliveryMode },
  });

  return getRequest(organizationId, result.id);
}

/**
 * Approve or deny a request.
 *
 * Approving may reserve a specific device so it cannot be lent out from under
 * the request between approval and provisioning.
 */
export async function reviewRequest(ctx, input) {
  const {
    organizationId, requestId, decision, notes = null,
    deviceId = null, assignedTechId = null, loanPeriodId = null, actorId = null,
  } = input;

  if (!['approved', 'denied'].includes(decision)) {
    throw badRequest('A review decision must be either "approved" or "denied".');
  }

  const result = await transaction(async (conn) => {
    const request = await connOne(
      conn, 'SELECT * FROM loan_requests WHERE id = ? AND organization_id = ? FOR UPDATE',
      [requestId, organizationId],
    );
    if (!request) throw notFound('That request does not exist.');
    if (request.status !== 'submitted') {
      throw conflict(
        `Request ${request.reference} has already been ${request.status} and cannot be reviewed again.`,
        { status: request.status },
      );
    }

    let reservedDevice = null;
    if (decision === 'approved' && deviceId) {
      const device = await connOne(conn, 'SELECT * FROM devices WHERE id = ? AND organization_id = ? FOR UPDATE',
        [deviceId, organizationId]);
      if (!device) throw badRequest('That device does not exist.', { field: 'device_id' });

      const activeLoan = await connOne(
        conn, `SELECT reference FROM loans WHERE device_id = ? AND status = 'active'`, [deviceId],
      );
      if (activeLoan) {
        throw conflict(
          `${device.name} is already on loan (${activeLoan.reference}) and cannot be reserved for this request.`,
          { device_id: deviceId, loan_reference: activeLoan.reference },
        );
      }
      if (!['available', 'reserved'].includes(device.status)) {
        throw conflict(`${device.name} is marked "${device.status}" and cannot be reserved.`, {
          device_id: deviceId, status: device.status,
        });
      }

      await conn.execute(`UPDATE devices SET status = 'reserved', updated_at = NOW() WHERE id = ?`, [deviceId]);
      reservedDevice = device;
    }

    await conn.execute(
      `UPDATE loan_requests
          SET status = ?, review_notes = ?, reviewed_by = ?, reviewed_at = NOW(),
              device_id = COALESCE(?, device_id),
              assigned_tech_id = COALESCE(?, assigned_tech_id),
              loan_period_id = COALESCE(?, loan_period_id),
              updated_at = NOW()
        WHERE id = ?`,
      [decision, notes, actorId, deviceId, assignedTechId, loanPeriodId, requestId],
    );

    return { request, reservedDevice };
  });

  await recordAudit(ctx, {
    organizationId,
    action: decision === 'approved' ? AUDIT_ACTIONS.REQUEST_APPROVED : AUDIT_ACTIONS.REQUEST_DENIED,
    entityType: 'request',
    entityId: requestId,
    entityLabel: result.request.reference,
    summary: `Request ${result.request.reference} ${decision}${notes ? `: ${notes}` : ''}`,
    detail: { decision, notes, device_id: deviceId, assigned_tech_id: assignedTechId },
  });

  return getRequest(organizationId, requestId);
}

/** Move an approved request along its fulfilment track. */
export async function updateFulfillment(ctx, input) {
  const {
    organizationId, requestId, state, notes = null, assignedTechId = null, deviceId = null, actorId = null,
  } = input;

  if (!FULFILLMENT_STATES.includes(state)) {
    throw badRequest(`"${state}" is not a fulfilment state.`, { allowed: FULFILLMENT_STATES });
  }

  const result = await transaction(async (conn) => {
    const request = await connOne(
      conn, 'SELECT * FROM loan_requests WHERE id = ? AND organization_id = ? FOR UPDATE',
      [requestId, organizationId],
    );
    if (!request) throw notFound('That request does not exist.');

    if (request.status !== 'approved') {
      throw conflict(
        `Request ${request.reference} is "${request.status}". Only an approved request can be moved through fulfilment.`,
        { status: request.status },
      );
    }

    const allowed = FULFILLMENT_TRANSITIONS[request.fulfillment_state] ?? [];
    if (state !== request.fulfillment_state && !allowed.includes(state)) {
      throw conflict(
        `A request cannot go from "${FULFILLMENT_LABELS[request.fulfillment_state]}" to ` +
        `"${FULFILLMENT_LABELS[state]}".`,
        { from: request.fulfillment_state, to: state, allowed },
      );
    }

    if (state === 'delivered') {
      throw badRequest(
        'Mark a request delivered by checking the device out to its holder, not by setting the state directly. ' +
        'Use the fulfil action so a loan record is created.',
      );
    }

    await conn.execute(
      `UPDATE loan_requests
          SET fulfillment_state = ?,
              assigned_tech_id = COALESCE(?, assigned_tech_id),
              device_id = COALESCE(?, device_id),
              updated_at = NOW()
        WHERE id = ?`,
      [state, assignedTechId, deviceId, requestId],
    );

    return { request, from: request.fulfillment_state };
  });

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.REQUEST_STATE_CHANGED,
    entityType: 'request',
    entityId: requestId,
    entityLabel: result.request.reference,
    summary:
      `Request ${result.request.reference}: ${FULFILLMENT_LABELS[result.from]} → ${FULFILLMENT_LABELS[state]}`,
    detail: { from: result.from, to: state, notes },
  });

  return getRequest(organizationId, requestId);
}

/**
 * Hand the device over: creates the actual loan and closes the request.
 * Delegates to checkOutDevice so a request-originated loan is identical in
 * every respect to one created at the check-out desk.
 */
export async function fulfillRequest(ctx, input) {
  const {
    organizationId, requestId, deviceIdentifier = null, techId = null,
    clientId = null, programId = null, loanPeriodId = null, customDays = null,
    notes = null, conditionOut = null, method = 'request', actorId = null,
  } = input;

  const request = await getRequest(organizationId, requestId);
  if (!request) throw notFound('That request does not exist.');
  if (request.status !== 'approved') {
    throw conflict(
      `Request ${request.reference} is "${request.status}". Approve it before fulfilling it.`,
      { status: request.status },
    );
  }

  const device = deviceIdentifier ?? request.device_id;
  if (!device) {
    throw badRequest('Scan or choose the device being handed over before fulfilling this request.');
  }

  // A reserved device is not lendable until we release the reservation; do it
  // here rather than making checkOutDevice aware of requests.
  await query(
    `UPDATE devices SET status = 'available'
      WHERE id = ? AND organization_id = ? AND status = 'reserved'`,
    [request.device_id ?? 0, organizationId],
  ).catch(() => {});

  const loan = await checkOutDevice(ctx, {
    organizationId,
    deviceIdentifier: device,
    techId: techId ?? request.assigned_tech_id ?? null,
    clientId: clientId ?? request.client_id ?? null,
    programId: programId ?? request.program_id ?? null,
    loanPeriodId: loanPeriodId ?? request.loan_period_id ?? null,
    customDays: customDays ?? request.requested_days ?? null,
    notes,
    conditionOut,
    method,
    requestId,
    actorId,
  });

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.REQUEST_FULFILLED,
    entityType: 'request',
    entityId: requestId,
    entityLabel: request.reference,
    summary: `Request ${request.reference} fulfilled as loan ${loan.reference}`,
    detail: { loan_id: loan.id, loan_reference: loan.reference, device_id: loan.device_id },
  });

  return { request: await getRequest(organizationId, requestId), loan };
}

/**
 * Cancel a request. A VRC may cancel their own; techs and admins may cancel
 * any. Releases a reserved device back to the pool.
 */
export async function cancelRequest(ctx, input) {
  const { organizationId, requestId, reason = null, actorId = null, auth = null } = input;

  const result = await transaction(async (conn) => {
    const request = await connOne(
      conn, 'SELECT * FROM loan_requests WHERE id = ? AND organization_id = ? FOR UPDATE',
      [requestId, organizationId],
    );
    if (!request) throw notFound('That request does not exist.');

    if (auth?.role === 'vrc' && request.requested_by !== auth.userId) {
      throw forbidden('You can only cancel requests you submitted.');
    }
    if (!['submitted', 'approved'].includes(request.status)) {
      throw conflict(`Request ${request.reference} is ${request.status} and cannot be cancelled.`, {
        status: request.status,
      });
    }

    if (request.device_id) {
      await conn.execute(
        `UPDATE devices SET status = 'available', updated_at = NOW()
          WHERE id = ? AND status = 'reserved'`,
        [request.device_id],
      );
    }

    await conn.execute(
      `UPDATE loan_requests SET status = 'cancelled', review_notes = COALESCE(?, review_notes), updated_at = NOW()
        WHERE id = ?`,
      [reason, requestId],
    );

    return { request };
  });

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.REQUEST_CANCELLED,
    entityType: 'request',
    entityId: requestId,
    entityLabel: result.request.reference,
    summary: `Request ${result.request.reference} cancelled${reason ? `: ${reason}` : ''}`,
    detail: { reason },
  });

  return getRequest(organizationId, requestId);
}

/** Filterable request list. VRCs are scoped to their own by the route. */
export async function listRequests(organizationId, filters = {}, { limit = 50, offset = 0, sort = null } = {}) {
  const where = ['r.organization_id = ?'];
  const params = [organizationId];

  if (filters.status) { where.push('r.status = ?'); params.push(filters.status); }
  if (filters.fulfillmentState) { where.push('r.fulfillment_state = ?'); params.push(filters.fulfillmentState); }
  if (filters.requestedBy) { where.push('r.requested_by = ?'); params.push(filters.requestedBy); }
  if (filters.assignedTechId) { where.push('r.assigned_tech_id = ?'); params.push(filters.assignedTechId); }
  if (filters.clientId) { where.push('r.client_id = ?'); params.push(filters.clientId); }
  if (filters.programId) { where.push('r.program_id = ?'); params.push(filters.programId); }
  if (filters.open) {
    where.push(`r.status IN ('submitted', 'approved')`);
  }
  if (filters.search) {
    where.push(
      "(r.reference LIKE ? OR r.requested_category LIKE ? OR r.requested_details LIKE ? " +
      "OR CONCAT(c.first_name, ' ', c.last_name) LIKE ? OR u.full_name LIKE ?)",
    );
    const like = `%${filters.search}%`;
    params.push(like, like, like, like, like);
  }

  const whereSql = where.join(' AND ');
  const sortColumns = {
    created_at: 'r.created_at', needed_by: 'r.needed_by',
    status: 'r.status', reference: 'r.reference',
  };
  const key = String(sort || '').replace(/^-/, '');
  const orderSql = sortColumns[key]
    ? `${sortColumns[key]} ${String(sort).startsWith('-') ? 'DESC' : 'ASC'}`
    : 'r.created_at DESC';

  const rows = await query(
    `${REQUEST_SELECT} WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  );

  const countRow = await queryOne(
    `SELECT COUNT(*) AS total FROM loan_requests r
       JOIN users u ON u.id = r.requested_by
       LEFT JOIN clients c ON c.id = r.client_id
      WHERE ${whereSql}`,
    params,
  );

  return { rows: rows.map(decorateRequest), total: Number(countRow?.total ?? 0) };
}
