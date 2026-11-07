/**
 * Loan operations: check out, check in, extend, reduce, cancel, transfer.
 */

import express from 'express';
import {
  asyncRoute, pagination, paged, str, int, bool, notFound, badRequest, toCsv, dateTime,
} from '../lib/util.js';
import { requireCapability, isRestrictedToOwnRecords } from '../lib/auth.js';
import { auditContextFromRequest } from '../lib/audit.js';
import {
  checkOutDevice, checkInDevice, adjustLoanDueDate, cancelLoan, transferLoan,
  listLoans, getLoan, getLoanWithTimeline,
} from '../lib/loans.js';
import { getSettings, getLoanPeriods } from '../lib/settings.js';
import { notify } from '../lib/mailer.js';
import { getConfig } from '../config.js';

const router = express.Router();

const LOAN_STATUSES = ['active', 'returned', 'cancelled', 'overdue', 'due_soon'];

function baseUrl() {
  return getConfig()?.baseUrl || '';
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

router.get('/', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pagination(req.query);
  const settings = await getSettings(req.auth.organizationId);

  const filters = {
    status: str(req.query.status),
    deviceId: int(req.query.device_id, 'device_id'),
    techId: int(req.query.tech_id, 'tech_id'),
    clientId: int(req.query.client_id, 'client_id'),
    programId: int(req.query.program_id, 'program_id'),
    from: str(req.query.from),
    to: str(req.query.to),
    search: str(req.query.search) || str(req.query.q),
    dueSoonDays: settings['notify.due_soon_days'],
  };

  if (filters.status && !LOAN_STATUSES.includes(filters.status)) {
    throw badRequest(`"status" must be one of: ${LOAN_STATUSES.join(', ')}.`, { allowed: LOAN_STATUSES });
  }

  // A counselor sees loans belonging to their own clients, not the whole pool.
  if (isRestrictedToOwnRecords(req.auth) && !filters.clientId) {
    filters.counselorId = req.auth.userId;
  }

  const { rows, total } = await listLoans(req.auth.organizationId, filters, {
    limit: perPage, offset, sort: str(req.query.sort),
  });

  res.json(paged(rows, total, { page, perPage }));
}));

router.get('/periods', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  res.json({ data: await getLoanPeriods(req.auth.organizationId) });
}));

// NOTE: GET /:id is registered at the bottom of this file. Express matches in
// declaration order, so /export.csv declared after /:id would be captured by
// it and treated as a loan id.

// ---------------------------------------------------------------------------
// Check out
// ---------------------------------------------------------------------------

/**
 * Check a device out.
 *
 * `device` accepts a scanned barcode, an asset tag, or a numeric device id —
 * so the scanner path, the typed path and the pick-from-list path are one code
 * path with one set of rules.
 */
router.post('/checkout', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  const deviceIdentifier = req.body?.device ?? req.body?.barcode ?? req.body?.device_id;
  if (!deviceIdentifier) {
    throw badRequest('Scan a barcode or choose a device to check out.', { field: 'device' });
  }

  const loan = await checkOutDevice(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    deviceIdentifier,
    techId: int(req.body?.tech_id, 'tech_id'),
    clientId: int(req.body?.client_id, 'client_id'),
    programId: int(req.body?.program_id, 'program_id'),
    loanPeriodId: int(req.body?.loan_period_id, 'loan_period_id'),
    customDays: req.body?.custom_days === undefined ? null : int(req.body?.custom_days, 'custom_days', { min: 0, max: 3650 }),
    notes: str(req.body?.notes),
    conditionOut: str(req.body?.condition_out, { max: 190 }),
    method: bool(req.body?.scanned) ? 'scan' : (req.auth.actorType === 'api_key' ? 'api' : 'manual'),
    requestId: int(req.body?.request_id, 'request_id'),
    actorId: req.auth.userId,
    // { "Charger": true, "Case": false } — what physically left with the device.
    accessoriesOut: req.body?.accessories && typeof req.body.accessories === 'object'
      ? req.body.accessories
      : null,
  });

  // Notification failure must not fail the check-out; notify() never throws.
  const mail = await notify(auditContextFromRequest(req), req.auth.organizationId, 'checked_out', loan, {
    baseUrl: baseUrl(),
  });

  res.status(201).json({ loan, notification: mail });
}));

// ---------------------------------------------------------------------------
// Check in
// ---------------------------------------------------------------------------

/**
 * Check a device back in, by barcode or by loan id.
 *
 * Deliberately does not require knowing the loan: at a returns desk the only
 * thing in hand is the device itself.
 */
router.post('/checkin', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  const deviceIdentifier = req.body?.device ?? req.body?.barcode ?? null;
  const loanId = int(req.body?.loan_id, 'loan_id');

  if (!deviceIdentifier && !loanId) {
    throw badRequest('Scan the device, or choose the loan to check in.', { field: 'device' });
  }

  const result = await checkInDevice(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    deviceIdentifier,
    loanId,
    conditionIn: str(req.body?.condition_in, { max: 190 }),
    notes: str(req.body?.notes),
    method: bool(req.body?.scanned) ? 'scan' : (req.auth.actorType === 'api_key' ? 'api' : 'manual'),
    // A device that comes back broken goes to maintenance, not back on the shelf.
    newDeviceStatus: str(req.body?.device_status) === 'maintenance' ? 'maintenance' : 'available',
    actorId: req.auth.userId,
    accessoriesIn: req.body?.accessories && typeof req.body.accessories === 'object'
      ? req.body.accessories
      : null,
  });

  // Missing accessories are reported rather than blocking the return: the
  // device is back, and the charger being absent is a fact to record, not a
  // reason to refuse the transaction.
  if (result.missingAccessories?.length) {
    result.warning =
      `Not returned: ${result.missingAccessories.join(', ')}. This has been noted on the loan.`;
  }

  const mail = await notify(auditContextFromRequest(req), req.auth.organizationId, 'checked_in', result.loan, {
    baseUrl: baseUrl(),
  });

  res.json({ ...result, notification: mail });
}));

// ---------------------------------------------------------------------------
// Adjust
// ---------------------------------------------------------------------------

router.post('/:id/extend', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  const days = int(req.body?.days, 'days', { min: 1, max: 3650 });
  const newDueAt = req.body?.due_at ? dateTime(req.body.due_at, 'due_at') : null;

  if (!days && !newDueAt) {
    throw badRequest('Say how many days to extend by, or give a new due date.', { field: 'days' });
  }

  const loan = await adjustLoanDueDate(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    loanId: Number(req.params.id),
    days,
    newDueAt,
    reason: str(req.body?.reason),
    actorId: req.auth.userId,
    // Only an administrator may push past the configured extension limit.
    ignoreExtensionLimit: bool(req.body?.override_limit) && req.auth.role === 'admin',
  });

  res.json({ loan });
}));

router.post('/:id/reduce', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  const days = int(req.body?.days, 'days', { min: 1, max: 3650 });
  const newDueAt = req.body?.due_at ? dateTime(req.body.due_at, 'due_at') : null;

  if (!days && !newDueAt) {
    throw badRequest('Say how many days to bring the return forward by, or give a new due date.', { field: 'days' });
  }

  const loan = await adjustLoanDueDate(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    loanId: Number(req.params.id),
    days: days ? -days : null,
    newDueAt,
    reason: str(req.body?.reason),
    actorId: req.auth.userId,
  });

  res.json({ loan });
}));

router.post('/:id/cancel', requireCapability('loans.cancel'), asyncRoute(async (req, res) => {
  const loan = await cancelLoan(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    loanId: Number(req.params.id),
    reason: str(req.body?.reason),
    actorId: req.auth.userId,
    deviceStatus: str(req.body?.device_status) === 'maintenance' ? 'maintenance' : 'available',
  });
  res.json({ loan });
}));

router.post('/:id/transfer', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  const loan = await transferLoan(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    loanId: Number(req.params.id),
    techId: int(req.body?.tech_id, 'tech_id'),
    clientId: int(req.body?.client_id, 'client_id'),
    programId: int(req.body?.program_id, 'program_id'),
    reason: str(req.body?.reason),
    actorId: req.auth.userId,
  });
  res.json({ loan });
}));

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

router.get('/export.csv', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const settings = await getSettings(req.auth.organizationId);
  const { rows } = await listLoans(
    req.auth.organizationId,
    {
      status: str(req.query.status),
      from: str(req.query.from),
      to: str(req.query.to),
      dueSoonDays: settings['notify.due_soon_days'],
    },
    { limit: 100000, offset: 0, sort: '-checked_out_at' },
  );

  const csv = toCsv(
    ['reference', 'device', 'barcode', 'asset_tag', 'status', 'client', 'technician', 'program',
     'checked_out_at', 'due_at', 'returned_at', 'days_overdue', 'extensions', 'period',
     'checkout_method', 'checkin_method', 'notes'],
    rows.map((l) => [
      l.reference, l.device_name, l.device_barcode, l.device_asset_tag,
      l.is_overdue ? 'overdue' : l.status, l.client_name, l.tech_name, l.program_name,
      l.checked_out_at, l.due_at, l.returned_at, l.days_overdue, l.extension_count,
      l.period_name, l.checkout_method, l.checkin_method, l.notes,
    ]),
  );

  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="loans-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// ---------------------------------------------------------------------------
// Single loan — registered last so literal paths above always win.
// ---------------------------------------------------------------------------

router.get('/:id', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const loanId = Number(req.params.id);
  if (!Number.isInteger(loanId)) throw notFound('That loan does not exist.');

  const loan = await getLoanWithTimeline(req.auth.organizationId, loanId);
  if (!loan) throw notFound('That loan does not exist.');
  res.json({ loan });
}));

export default router;
