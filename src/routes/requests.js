/**
 * VRC loan requests: submit, review, track fulfilment, fulfil, cancel.
 */

import express from 'express';
import {
  asyncRoute, pagination, paged, str, int, bool, dateOnly, notFound, forbidden, badRequest, oneOf,
} from '../lib/util.js';
import { requireCapability, isRestrictedToOwnRecords } from '../lib/auth.js';
import { auditContextFromRequest } from '../lib/audit.js';
import {
  createRequest, reviewRequest, updateFulfillment, fulfillRequest, cancelRequest,
  listRequests, getRequest, REQUEST_STATUSES, FULFILLMENT_STATES, FULFILLMENT_LABELS,
} from '../lib/requests.js';
import { getSettings } from '../lib/settings.js';
import { notify } from '../lib/mailer.js';
import { getConfig } from '../config.js';

const router = express.Router();

const DELIVERY_MODES = ['vrc_pickup', 'deliver_to_client', 'client_pickup'];

function baseUrl() {
  return getConfig()?.baseUrl || '';
}

/**
 * A counselor may only see and act on their own requests. Enforced here rather
 * than in the UI, because the UI is not a security boundary.
 */
async function loadOwnRequest(req, requestId) {
  const request = await getRequest(req.auth.organizationId, requestId);
  if (!request) throw notFound('That request does not exist.');
  if (isRestrictedToOwnRecords(req.auth) && request.requested_by !== req.auth.userId) {
    throw forbidden('You can only view requests you submitted.');
  }
  return request;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

router.get('/', requireCapability('requests.read'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pagination(req.query);

  const filters = {
    status: oneOf(req.query.status, REQUEST_STATUSES, 'status'),
    fulfillmentState: oneOf(req.query.fulfillment_state, FULFILLMENT_STATES, 'fulfillment_state'),
    requestedBy: int(req.query.requested_by, 'requested_by'),
    assignedTechId: int(req.query.assigned_tech_id, 'assigned_tech_id'),
    clientId: int(req.query.client_id, 'client_id'),
    programId: int(req.query.program_id, 'program_id'),
    open: bool(req.query.open),
    search: str(req.query.search) || str(req.query.q),
  };

  if (isRestrictedToOwnRecords(req.auth)) filters.requestedBy = req.auth.userId;

  const { rows, total } = await listRequests(req.auth.organizationId, filters, {
    limit: perPage, offset, sort: str(req.query.sort),
  });

  res.json(paged(rows, total, { page, perPage }));
}));

/** Reference data the request form and tracker need. */
router.get('/meta', requireCapability('requests.read'), asyncRoute(async (req, res) => {
  res.json({
    statuses: REQUEST_STATUSES,
    fulfillment_states: FULFILLMENT_STATES.map((state) => ({
      value: state,
      label: FULFILLMENT_LABELS[state],
    })),
    delivery_modes: [
      { value: 'vrc_pickup', label: 'I will collect it' },
      { value: 'deliver_to_client', label: 'Deliver to the client' },
      { value: 'client_pickup', label: 'The client will collect it' },
    ],
  });
}));

router.get('/:id', requireCapability('requests.read'), asyncRoute(async (req, res) => {
  res.json({ request: await loadOwnRequest(req, Number(req.params.id)) });
}));

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

router.post('/', requireCapability('requests.write'), asyncRoute(async (req, res) => {
  const settings = await getSettings(req.auth.organizationId);

  // A tech may raise a request on a counselor's behalf; a counselor may not
  // raise one in someone else's name.
  let requestedBy = req.auth.userId;
  const onBehalfOf = int(req.body?.requested_by, 'requested_by');
  if (onBehalfOf && onBehalfOf !== req.auth.userId) {
    if (isRestrictedToOwnRecords(req.auth)) {
      throw forbidden('You can only submit requests in your own name.');
    }
    requestedBy = onBehalfOf;
  }

  const request = await createRequest(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    requestedBy,
    clientId: int(req.body?.client_id, 'client_id'),
    programId: int(req.body?.program_id, 'program_id'),
    deviceId: int(req.body?.device_id, 'device_id'),
    requestedCategory: str(req.body?.requested_category, { max: 96 }),
    requestedDetails: str(req.body?.requested_details),
    justification: str(req.body?.justification),
    neededBy: dateOnly(req.body?.needed_by, 'needed_by'),
    loanPeriodId: int(req.body?.loan_period_id, 'loan_period_id'),
    requestedDays: int(req.body?.requested_days, 'requested_days', { min: 0, max: 3650 }),
    deliveryMode: oneOf(req.body?.delivery_mode, DELIVERY_MODES, 'delivery_mode', { fallback: 'vrc_pickup' }),
    autoApprove: Boolean(settings['loans.auto_approve_vrc']),
    actorId: req.auth.userId,
  });

  const mail = await notify(auditContextFromRequest(req), req.auth.organizationId, 'request_submitted', request, {
    baseUrl: baseUrl(),
  });

  res.status(201).json({ request, notification: mail });
}));

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

router.post('/:id/approve', requireCapability('requests.approve'), asyncRoute(async (req, res) => {
  const request = await reviewRequest(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    requestId: Number(req.params.id),
    decision: 'approved',
    notes: str(req.body?.notes),
    deviceId: int(req.body?.device_id, 'device_id'),
    assignedTechId: int(req.body?.assigned_tech_id, 'assigned_tech_id') ?? req.auth.userId,
    loanPeriodId: int(req.body?.loan_period_id, 'loan_period_id'),
    actorId: req.auth.userId,
  });

  const mail = await notify(auditContextFromRequest(req), req.auth.organizationId, 'request_approved', request, {
    baseUrl: baseUrl(),
  });

  res.json({ request, notification: mail });
}));

router.post('/:id/deny', requireCapability('requests.approve'), asyncRoute(async (req, res) => {
  const notes = str(req.body?.notes);
  if (!notes) {
    // A bare rejection leaves the counselor with no way forward, so a reason
    // is required rather than optional.
    throw badRequest('Give a reason so the counselor knows what to do next.', { field: 'notes' });
  }

  const request = await reviewRequest(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    requestId: Number(req.params.id),
    decision: 'denied',
    notes,
    actorId: req.auth.userId,
  });

  const mail = await notify(auditContextFromRequest(req), req.auth.organizationId, 'request_denied', request, {
    baseUrl: baseUrl(),
  });

  res.json({ request, notification: mail });
}));

// ---------------------------------------------------------------------------
// Fulfilment tracking
// ---------------------------------------------------------------------------

/**
 * Move a request along: provisioning → in transit / ready for pickup.
 * Reaching "delivered" happens through /fulfil, which creates the loan.
 */
router.post('/:id/fulfillment', requireCapability('requests.fulfill'), asyncRoute(async (req, res) => {
  const state = oneOf(req.body?.state, FULFILLMENT_STATES, 'state', { required: true });

  const request = await updateFulfillment(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    requestId: Number(req.params.id),
    state,
    notes: str(req.body?.notes),
    assignedTechId: int(req.body?.assigned_tech_id, 'assigned_tech_id'),
    deviceId: int(req.body?.device_id, 'device_id'),
    actorId: req.auth.userId,
  });

  // "Ready for pickup" is the one state the counselor is actively waiting on.
  const mail = state === 'ready_pickup'
    ? await notify(auditContextFromRequest(req), req.auth.organizationId, 'ready_for_pickup', request, { baseUrl: baseUrl() })
    : { sent: false, reason: 'No notification is sent for this state.' };

  res.json({ request, notification: mail });
}));

/**
 * Hand the device over: creates the loan and closes the request.
 * Registered under both spellings — this path gets typed by hand often enough
 * that a 404 on the American spelling is a support call waiting to happen.
 */
router.post(['/:id/fulfil', '/:id/fulfill'], requireCapability('requests.fulfill'), asyncRoute(async (req, res) => {
  const result = await fulfillRequest(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    requestId: Number(req.params.id),
    deviceIdentifier: req.body?.device ?? req.body?.barcode ?? int(req.body?.device_id, 'device_id'),
    techId: int(req.body?.tech_id, 'tech_id'),
    clientId: int(req.body?.client_id, 'client_id'),
    programId: int(req.body?.program_id, 'program_id'),
    loanPeriodId: int(req.body?.loan_period_id, 'loan_period_id'),
    customDays: req.body?.custom_days === undefined
      ? null
      : int(req.body?.custom_days, 'custom_days', { min: 0, max: 3650 }),
    notes: str(req.body?.notes),
    conditionOut: str(req.body?.condition_out, { max: 190 }),
    method: bool(req.body?.scanned) ? 'scan' : 'request',
    actorId: req.auth.userId,
  });

  const mail = await notify(auditContextFromRequest(req), req.auth.organizationId, 'checked_out', result.loan, {
    baseUrl: baseUrl(),
  });

  res.json({ ...result, notification: mail });
}));

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

router.post('/:id/cancel', requireCapability('requests.write'), asyncRoute(async (req, res) => {
  const request = await cancelRequest(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    requestId: Number(req.params.id),
    reason: str(req.body?.reason),
    actorId: req.auth.userId,
    auth: req.auth,
  });
  res.json({ request });
}));

export default router;
