/**
 * Routes for the second wave of features: kits and accessories, reservations,
 * repairs, agreements, attachments, bulk actions and the job runner.
 *
 * Grouped in one module because they share the same shape and splitting them
 * across six files would multiply boilerplate without clarifying anything.
 * Each router is mounted separately in server.js.
 */

import express from 'express';
import fs from 'node:fs';
import {
  asyncRoute, pagination, paged, str, requiredStr, int, decimal, bool, oneOf,
  notFound, badRequest, forbidden, conflict, toCsv,
} from '../lib/util.js';
import { requireCapability, requireRole, isRestrictedToOwnRecords } from '../lib/auth.js';
import { auditContextFromRequest, recordAudit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { queryOne, query, execute } from '../db.js';
import { getOrCreateCronToken, verifyCronToken } from '../config.js';

import {
  listAccessories, setAccessories, listKits, getKit, createKit, updateKit,
  deleteKit, checkOutKit, checkInGroup, loansInGroup,
} from '../lib/kits.js';
import {
  createReservation, cancelReservation, listReservations, getReservation,
  waitlistForDevice, RESERVATION_STATUSES,
} from '../lib/reservations.js';
import {
  openRepair, updateRepair, getRepair, listRepairs, repairSummary,
  REPAIR_STATUSES, REPAIR_LABELS,
} from '../lib/repairs.js';
import {
  signAgreement, getAgreement, renderAgreementHtml, getAgreementSettings,
  loansMissingAgreements, renderAgreementText, DEFAULT_AGREEMENT_TEXT,
  SIGNATURE_METHODS, SIGNER_ROLES,
} from '../lib/agreements.js';
import {
  storeMany, getAttachment, resolveStoragePath, attachmentsForLoan,
  attachmentsForRepair, deleteAttachment, storageUsage, publicAttachment,
} from '../lib/attachments.js';
import { checkInDevice } from '../lib/loans.js';
import { runScheduledJobs, recentJobRuns, lastSuccessfulRun } from '../lib/jobs.js';

// ===========================================================================
// Kits and accessories
// ===========================================================================

export const kitsRouter = express.Router();

kitsRouter.get('/', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  res.json({ data: await listKits(req.auth.organizationId, { includeInactive: bool(req.query.include_inactive) }) });
}));

kitsRouter.post('/', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const kit = await createKit(auditContextFromRequest(req), req.auth.organizationId, {
    name: requiredStr(req.body?.name, 'Kit name', { max: 190 }),
    description: str(req.body?.description),
    deviceIds: (Array.isArray(req.body?.device_ids) ? req.body.device_ids : []).map(Number).filter(Boolean),
  });
  res.status(201).json({ kit });
}));

kitsRouter.get('/:id', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const kit = await getKit(req.auth.organizationId, Number(req.params.id));
  if (!kit) throw notFound('That kit does not exist.');
  res.json({ kit });
}));

kitsRouter.patch('/:id', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const kit = await updateKit(auditContextFromRequest(req), req.auth.organizationId, Number(req.params.id), {
    name: 'name' in (req.body ?? {}) ? requiredStr(req.body.name, 'Kit name', { max: 190 }) : undefined,
    description: 'description' in (req.body ?? {}) ? str(req.body.description) : undefined,
    active: 'active' in (req.body ?? {}) ? bool(req.body.active) : undefined,
    deviceIds: Array.isArray(req.body?.device_ids)
      ? req.body.device_ids.map(Number).filter(Boolean)
      : undefined,
  });
  res.json({ kit });
}));

kitsRouter.delete('/:id', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  res.json(await deleteKit(auditContextFromRequest(req), req.auth.organizationId, Number(req.params.id)));
}));

/** Check out every device in the kit under one group reference. */
kitsRouter.post('/:id/checkout', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  const result = await checkOutKit(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    kitId: Number(req.params.id),
    techId: int(req.body?.tech_id, 'tech_id'),
    clientId: int(req.body?.client_id, 'client_id'),
    programId: int(req.body?.program_id, 'program_id'),
    loanPeriodId: int(req.body?.loan_period_id, 'loan_period_id'),
    customDays: req.body?.custom_days === undefined
      ? null : int(req.body?.custom_days, 'custom_days', { min: 0, max: 3650 }),
    notes: str(req.body?.notes),
    conditionOut: str(req.body?.condition_out, { max: 190 }),
    method: bool(req.body?.scanned) ? 'scan' : 'manual',
    actorId: req.auth.userId,
    skipUnavailable: bool(req.body?.skip_unavailable, true),
  });
  res.status(201).json(result);
}));

/** Accessory checklist for one device. */
kitsRouter.get('/accessories/:deviceId', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  res.json({ data: await listAccessories(Number(req.params.deviceId)) });
}));

kitsRouter.put('/accessories/:deviceId', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const accessories = Array.isArray(req.body?.accessories) ? req.body.accessories : [];
  res.json({
    data: await setAccessories(
      auditContextFromRequest(req), req.auth.organizationId, Number(req.params.deviceId), accessories,
    ),
  });
}));

// ===========================================================================
// Loan groups (kits that are out)
// ===========================================================================

export const groupsRouter = express.Router();

groupsRouter.get('/:groupRef', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const loans = await loansInGroup(req.auth.organizationId, req.params.groupRef);
  if (!loans.length) throw notFound('No loans exist under that group reference.');
  res.json({ group_ref: req.params.groupRef, loans });
}));

groupsRouter.post('/:groupRef/checkin', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  res.json(await checkInGroup(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    groupRef: req.params.groupRef,
    conditionIn: str(req.body?.condition_in, { max: 190 }),
    notes: str(req.body?.notes),
    actorId: req.auth.userId,
    method: bool(req.body?.scanned) ? 'scan' : 'manual',
  }));
}));

// ===========================================================================
// Reservations and waitlist
// ===========================================================================

export const reservationsRouter = express.Router();

reservationsRouter.get('/', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pagination(req.query);

  const filters = {
    status: oneOf(req.query.status, RESERVATION_STATUSES, 'status'),
    open: bool(req.query.open),
    deviceId: int(req.query.device_id, 'device_id'),
    category: str(req.query.category),
    clientId: int(req.query.client_id, 'client_id'),
  };

  // A counselor sees their own queue entries, not the whole waitlist.
  if (isRestrictedToOwnRecords(req.auth)) filters.requestedBy = req.auth.userId;

  const { rows, total } = await listReservations(req.auth.organizationId, filters, {
    limit: perPage, offset,
  });
  res.json(paged(rows, total, { page, perPage }));
}));

reservationsRouter.post('/', requireCapability('requests.write'), asyncRoute(async (req, res) => {
  const settings = await getSettings(req.auth.organizationId);
  if (!settings['reservations.enabled']) {
    throw forbidden('Reservations are switched off for this organisation.');
  }

  const result = await createReservation(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    requestedBy: req.auth.userId,
    deviceId: int(req.body?.device_id, 'device_id'),
    category: str(req.body?.category, { max: 96 }),
    clientId: int(req.body?.client_id, 'client_id'),
    programId: int(req.body?.program_id, 'program_id'),
    requestId: int(req.body?.request_id, 'request_id'),
    neededFrom: str(req.body?.needed_from),
    neededTo: str(req.body?.needed_to),
    priority: int(req.body?.priority, 'priority', { min: 0, max: 100 }) ?? 0,
    notes: str(req.body?.notes),
  });

  res.status(201).json(result);
}));

reservationsRouter.get('/:id', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const reservation = await getReservation(req.auth.organizationId, Number(req.params.id));
  if (!reservation) throw notFound('That reservation does not exist.');
  if (isRestrictedToOwnRecords(req.auth) && reservation.requested_by !== req.auth.userId) {
    throw forbidden('You can only view waitlist entries you created.');
  }
  res.json({ reservation });
}));

reservationsRouter.post('/:id/cancel', requireCapability('requests.write'), asyncRoute(async (req, res) => {
  res.json({
    reservation: await cancelReservation(auditContextFromRequest(req), {
      organizationId: req.auth.organizationId,
      reservationId: Number(req.params.id),
      reason: str(req.body?.reason),
      auth: req.auth,
    }),
  });
}));

reservationsRouter.get('/device/:deviceId', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  res.json({ data: await waitlistForDevice(req.auth.organizationId, Number(req.params.deviceId)) });
}));

// ===========================================================================
// Repairs
// ===========================================================================

export const repairsRouter = express.Router();

repairsRouter.get('/', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pagination(req.query);
  const { rows, total } = await listRepairs(
    req.auth.organizationId,
    {
      status: oneOf(req.query.status, REPAIR_STATUSES, 'status'),
      open: bool(req.query.open),
      deviceId: int(req.query.device_id, 'device_id'),
      assignedTo: int(req.query.assigned_to, 'assigned_to'),
      vendor: str(req.query.vendor),
      search: str(req.query.search) || str(req.query.q),
    },
    { limit: perPage, offset },
  );
  res.json(paged(rows, total, { page, perPage }));
}));

repairsRouter.get('/meta', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  res.json({
    statuses: REPAIR_STATUSES.map((value) => ({ value, label: REPAIR_LABELS[value] })),
  });
}));

repairsRouter.get('/summary', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  res.json(await repairSummary(req.auth.organizationId, {
    from: str(req.query.from), to: str(req.query.to),
  }));
}));

repairsRouter.post('/', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const deviceId = int(req.body?.device_id, 'device_id');
  if (!deviceId) throw badRequest('Choose the device that needs repair.', { field: 'device_id' });

  const repair = await openRepair(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    deviceId,
    fault: requiredStr(req.body?.fault, 'Fault description'),
    loanId: int(req.body?.loan_id, 'loan_id'),
    vendor: str(req.body?.vendor, { max: 190 }),
    assignedTo: int(req.body?.assigned_to, 'assigned_to'),
    underWarranty: 'under_warranty' in (req.body ?? {}) ? bool(req.body.under_warranty) : null,
    reportedBy: req.auth.userId,
  });
  res.status(201).json({ repair });
}));

repairsRouter.get('/:id', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const repair = await getRepair(req.auth.organizationId, Number(req.params.id));
  if (!repair) throw notFound('That repair does not exist.');
  repair.attachments = await attachmentsForRepair(req.auth.organizationId, repair.id);
  res.json({ repair });
}));

repairsRouter.patch('/:id', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  const repair = await updateRepair(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    repairId: Number(req.params.id),
    status: str(body.status),
    diagnosis: 'diagnosis' in body ? str(body.diagnosis) : undefined,
    resolution: 'resolution' in body ? str(body.resolution) : undefined,
    vendor: 'vendor' in body ? str(body.vendor, { max: 190 }) : undefined,
    vendorRef: 'vendor_ref' in body ? str(body.vendor_ref, { max: 120 }) : undefined,
    cost: 'cost' in body ? decimal(body.cost, 'cost') : undefined,
    assignedTo: 'assigned_to' in body ? int(body.assigned_to, 'assigned_to') : undefined,
    notes: str(body.notes),
    actorId: req.auth.userId,
    deviceStatusOnClose: str(body.device_status_on_close) || 'available',
  });
  res.json({ repair });
}));

// ===========================================================================
// Loan agreements
// ===========================================================================

export const agreementsRouter = express.Router();

/** The wording and settings the check-out form needs. */
agreementsRouter.get('/settings', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const settings = await getAgreementSettings(req.auth.organizationId);
  res.json({
    ...settings,
    default_text: DEFAULT_AGREEMENT_TEXT,
    signature_methods: SIGNATURE_METHODS,
    signer_roles: SIGNER_ROLES,
  });
}));

/** Preview the wording for a loan, with placeholders filled in. */
agreementsRouter.get('/preview/:loanId', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const settings = await getAgreementSettings(req.auth.organizationId);
  const loan = await queryOne(
    `SELECT l.*, d.name AS device_name, d.barcode AS device_barcode,
            CONCAT(COALESCE(c.first_name,''),' ',COALESCE(c.last_name,'')) AS client_name
       FROM loans l JOIN devices d ON d.id = l.device_id
       LEFT JOIN clients c ON c.id = l.client_id
      WHERE l.id = ? AND l.organization_id = ?`,
    [Number(req.params.loanId), req.auth.organizationId],
  );
  if (!loan) throw notFound('That loan does not exist.');

  const accessories = await listAccessories(loan.device_id);

  res.json({
    text: renderAgreementText(settings.text, {
      organisation: settings.organisation, loan, accessories,
    }),
    accessories,
  });
}));

agreementsRouter.get('/:loanId', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const agreement = await getAgreement(req.auth.organizationId, Number(req.params.loanId));
  if (!agreement) throw notFound('No agreement has been signed for that loan.');
  res.json({ agreement });
}));

agreementsRouter.post('/:loanId', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  const agreement = await signAgreement(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    loanId: Number(req.params.loanId),
    signedByName: requiredStr(req.body?.signed_by_name, 'Name of the person signing', { max: 190 }),
    signedByRole: oneOf(req.body?.signed_by_role, SIGNER_ROLES, 'signed_by_role', { fallback: 'client' }),
    signatureMethod: oneOf(req.body?.signature_method, SIGNATURE_METHODS, 'signature_method', { fallback: 'typed' }),
    signatureImage: str(req.body?.signature_image, { max: 8 * 1024 * 1024, trim: false }),
    typedSignature: str(req.body?.typed_signature, { max: 190 }),
    waivedReason: str(req.body?.waived_reason, { max: 255 }),
    witnessedBy: req.auth.userId,
    ip: req.ip,
    actorId: req.auth.userId,
  });
  res.status(201).json({ agreement });
}));

/** Printable copy. */
agreementsRouter.get('/:loanId/print', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const html = await renderAgreementHtml(req.auth.organizationId, Number(req.params.loanId));
  res.type('text/html; charset=utf-8').send(html);
}));

agreementsRouter.get('/audit/missing', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  res.json({ data: await loansMissingAgreements(req.auth.organizationId) });
}));

// ===========================================================================
// Attachments (condition photos and signatures)
// ===========================================================================

export const attachmentsRouter = express.Router();

/**
 * Stream a stored file.
 *
 * Authenticated and organisation-scoped, with a Content-Disposition of
 * `inline` and a nosniff header — these are photographs of client equipment,
 * not public assets, and they are never placed in the public directory.
 */
attachmentsRouter.get('/:id', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  const attachment = await getAttachment(req.auth.organizationId, Number(req.params.id));
  if (!attachment) throw notFound('That file does not exist.');

  const absolutePath = resolveStoragePath(attachment);

  res.type(attachment.mime_type);
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('Content-Disposition', `inline; filename="${attachment.filename}"`);
  res.set('X-Content-Type-Options', 'nosniff');

  fs.createReadStream(absolutePath).pipe(res);
}));

/** Attach photos to a loan, at check-out or check-in. */
attachmentsRouter.post('/loan/:loanId', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  const settings = await getSettings(req.auth.organizationId);
  if (!settings['photos.enabled']) {
    throw forbidden('Condition photos are switched off for this organisation.');
  }

  const loanId = Number(req.params.loanId);
  const loan = await queryOne(
    'SELECT id, device_id FROM loans WHERE id = ? AND organization_id = ?',
    [loanId, req.auth.organizationId],
  );
  if (!loan) throw notFound('That loan does not exist.');

  const phase = oneOf(req.body?.phase, ['out', 'in'], 'phase', { required: true });
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  const max = Number(settings['photos.max_per_phase']) || 4;

  if (images.length > max) {
    throw badRequest(`At most ${max} photo(s) can be attached per check-out or check-in.`);
  }

  const result = await storeMany(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    kind: 'condition_photo',
    loanId,
    deviceId: loan.device_id,
    phase,
    uploadedBy: req.auth.userId,
  }, images);

  if (result.stored.length) {
    await recordAudit(auditContextFromRequest(req), {
      action: 'attachment.added',
      entityType: 'loan',
      entityId: loanId,
      summary: `Attached ${result.stored.length} condition photo(s) at check-${phase}`,
      detail: { phase, stored: result.stored.length, failed: result.failed },
    });
  }

  // Partial success is reported rather than thrown: photos are optional and
  // one unreadable image must not fail the whole attempt.
  res.status(result.stored.length ? 201 : 400).json(result);
}));

attachmentsRouter.get('/loan/:loanId/list', requireCapability('loans.read'), asyncRoute(async (req, res) => {
  res.json({ data: await attachmentsForLoan(req.auth.organizationId, Number(req.params.loanId)) });
}));

attachmentsRouter.post('/repair/:repairId', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const repairId = Number(req.params.repairId);
  const repair = await getRepair(req.auth.organizationId, repairId);
  if (!repair) throw notFound('That repair does not exist.');

  const result = await storeMany(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    kind: 'condition_photo',
    repairId,
    deviceId: repair.device_id,
    phase: 'repair',
    uploadedBy: req.auth.userId,
  }, Array.isArray(req.body?.images) ? req.body.images : []);

  res.status(result.stored.length ? 201 : 400).json(result);
}));

attachmentsRouter.delete('/:id', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  res.json(await deleteAttachment(req.auth.organizationId, Number(req.params.id)));
}));

attachmentsRouter.get('/usage/summary', requireCapability('settings.read'), asyncRoute(async (req, res) => {
  res.json(await storageUsage(req.auth.organizationId));
}));

// ===========================================================================
// Bulk actions
// ===========================================================================

export const bulkRouter = express.Router();

const MAX_BULK = 500;

/**
 * Bulk check-in.
 *
 * Deliberately per-item rather than one transaction: at the end of a program
 * twenty devices come back and one of them turns out not to be on loan.
 * Failing all twenty because of that one is unusable, so each is attempted
 * independently and the result reports both sides.
 */
bulkRouter.post('/checkin', requireCapability('loans.write'), asyncRoute(async (req, res) => {
  const identifiers = Array.isArray(req.body?.devices) ? req.body.devices : [];
  const loanIds = Array.isArray(req.body?.loan_ids) ? req.body.loan_ids.map(Number) : [];

  const items = [...identifiers, ...loanIds];
  if (!items.length) throw badRequest('Provide devices or loan ids to check in.');
  if (items.length > MAX_BULK) {
    throw badRequest(`At most ${MAX_BULK} items can be checked in at once.`);
  }

  const succeeded = [];
  const failed = [];

  for (const identifier of identifiers) {
    try {
      const result = await checkInDevice(auditContextFromRequest(req), {
        organizationId: req.auth.organizationId,
        deviceIdentifier: identifier,
        conditionIn: str(req.body?.condition_in, { max: 190 }),
        notes: str(req.body?.notes),
        method: bool(req.body?.scanned) ? 'scan' : 'manual',
        newDeviceStatus: str(req.body?.device_status) === 'maintenance' ? 'maintenance' : 'available',
        actorId: req.auth.userId,
      });
      succeeded.push({
        identifier,
        device: result.device.name,
        loan_reference: result.loan.reference,
        was_overdue: result.wasOverdue,
      });
    } catch (err) {
      failed.push({ identifier, reason: err.message });
    }
  }

  for (const loanId of loanIds) {
    try {
      const result = await checkInDevice(auditContextFromRequest(req), {
        organizationId: req.auth.organizationId,
        loanId,
        conditionIn: str(req.body?.condition_in, { max: 190 }),
        notes: str(req.body?.notes),
        method: 'manual',
        actorId: req.auth.userId,
      });
      succeeded.push({ identifier: loanId, device: result.device.name, loan_reference: result.loan.reference });
    } catch (err) {
      failed.push({ identifier: loanId, reason: err.message });
    }
  }

  await recordAudit(auditContextFromRequest(req), {
    action: 'loan.checked_in',
    entityType: 'bulk',
    summary: `Bulk check-in: ${succeeded.length} returned, ${failed.length} failed`,
    detail: { succeeded: succeeded.length, failed },
  });

  res.json({
    checked_in: succeeded.length,
    failed_count: failed.length,
    succeeded,
    failed,
  });
}));

/** Bulk status change, e.g. retiring a batch of end-of-life equipment. */
bulkRouter.post('/device-status', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const ids = (Array.isArray(req.body?.device_ids) ? req.body.device_ids : []).map(Number).filter(Boolean);
  const status = oneOf(
    req.body?.status,
    ['available', 'maintenance', 'retired', 'lost', 'reserved'],
    'status',
    { required: true },
  );

  if (!ids.length) throw badRequest('Select at least one device.');
  if (ids.length > MAX_BULK) throw badRequest(`At most ${MAX_BULK} devices can be changed at once.`);

  const succeeded = [];
  const failed = [];

  for (const id of ids) {
    try {
      const device = await queryOne(
        'SELECT id, name, status FROM devices WHERE id = ? AND organization_id = ?',
        [id, req.auth.organizationId],
      );
      if (!device) throw notFound('No such device.');

      const activeLoan = await queryOne(
        `SELECT reference FROM loans WHERE device_id = ? AND status = 'active'`, [id],
      );
      if (activeLoan) {
        throw conflict(`On loan (${activeLoan.reference}) — check it in first.`);
      }

      await query(
        'UPDATE devices SET status = ?, updated_at = NOW() WHERE id = ? AND organization_id = ?',
        [status, id, req.auth.organizationId],
      );
      succeeded.push({ id, name: device.name, from: device.status, to: status });
    } catch (err) {
      failed.push({ id, reason: err.message });
    }
  }

  await recordAudit(auditContextFromRequest(req), {
    action: 'device.status_changed',
    entityType: 'bulk',
    summary: `Bulk status change to "${status}": ${succeeded.length} changed, ${failed.length} skipped`,
    detail: { status, succeeded: succeeded.length, failed },
  });

  res.json({ changed: succeeded.length, failed_count: failed.length, succeeded, failed });
}));

// ===========================================================================
// Scheduled jobs
// ===========================================================================

export const jobsRouter = express.Router();

jobsRouter.get('/', requireCapability('settings.read'), asyncRoute(async (req, res) => {
  const runs = await recentJobRuns(20);
  const lastSuccess = await lastSuccessfulRun();

  res.json({
    runs,
    last_success: lastSuccess,
    in_process_scheduler: process.env.LOANER_DISABLE_SCHEDULER !== '1',
    // Surfaced so an administrator can tell at a glance whether reminders are
    // actually going out, rather than assuming they are.
    healthy: Boolean(lastSuccess && Date.now() - new Date(lastSuccess.started_at).getTime() < 36 * 3600_000),
  });
}));

/** The cron command an administrator can paste into their control panel. */
jobsRouter.get('/cron-command', requireCapability('settings.write'), requireRole('admin'),
  asyncRoute(async (req, res) => {
    const token = getOrCreateCronToken();
    const base = `${req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http'}://${req.get('host')}`;

    res.json({
      token,
      url: `${base}/api/v1/jobs/run`,
      curl: `curl -fsS -X POST "${base}/api/v1/jobs/run" -H "X-Cron-Token: ${token}"`,
      crontab: `0 9 * * * curl -fsS -X POST "${base}/api/v1/jobs/run" -H "X-Cron-Token: ${token}" >/dev/null`,
      note:
        'Only needed if you turn the built-in scheduler off, or your host idles the application out ' +
        'between requests. Treat the token like a password.',
    });
  }));

/**
 * Run the scheduled work now.
 *
 * Two callers: an administrator pressing "run now", and an external cron.
 * Cron authenticates with a token from settings rather than a session, because
 * a cron entry cannot hold a cookie.
 */
jobsRouter.post('/run', asyncRoute(async (req, res) => {
  const token = str(req.get('x-cron-token')) || str(req.query.token);
  let trigger = 'manual';

  if (token) {
    // The token lives in the configuration file rather than the database: it
    // authenticates the whole installation, not one organisation, and a cron
    // entry has no session to scope it with.
    if (!verifyCronToken(token)) throw forbidden('That cron token is not valid.');
    trigger = 'cron';
  } else {
    if (!req.auth) throw forbidden('Sign in, or supply a cron token.');
    if (!req.auth.capabilities?.includes('settings.write')) {
      throw forbidden('Only an administrator can run scheduled jobs by hand.');
    }
  }

  const result = await runScheduledJobs({ trigger, force: bool(req.query.force) || trigger === 'manual' });
  res.json(result);
}));

export default {
  kitsRouter, groupsRouter, reservationsRouter, repairsRouter,
  agreementsRouter, attachmentsRouter, bulkRouter, jobsRouter,
};
