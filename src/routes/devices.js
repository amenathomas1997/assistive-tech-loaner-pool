/**
 * Device inventory: CRUD, spreadsheet import, barcode labels, lookup by scan.
 */

import express from 'express';
import { execute, queryOne, query } from '../db.js';
import {
  asyncRoute, pagination, paged, str, requiredStr, int, decimal, bool, oneOf,
  dateOnly, notFound, badRequest, conflict, toCsv,
} from '../lib/util.js';
import { requireCapability } from '../lib/auth.js';
import { auditContextFromRequest, recordAudit, AUDIT_ACTIONS, diffRecords } from '../lib/audit.js';
import {
  listDevices, getDevice, createDevice, decorateDevice, getDeviceFacets,
  importDevices, previewImport, reassignBarcode, backfillBarcodes,
} from '../lib/devices.js';
import { getOrganization } from '../lib/settings.js';
import { renderBarcodeSvg, renderLabelSheet, normaliseScan, SYMBOLOGIES } from '../lib/barcode.js';
import { resolveDevice, getActiveLoanForDevice, decorateLoan } from '../lib/loans.js';

const router = express.Router();

const DEVICE_STATUSES = ['available', 'checked_out', 'reserved', 'maintenance', 'retired', 'lost'];

// ---------------------------------------------------------------------------
// List and read
// ---------------------------------------------------------------------------

router.get('/', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pagination(req.query);

  const { rows, total } = await listDevices(
    req.auth.organizationId,
    {
      status: str(req.query.status),
      category: str(req.query.category),
      programId: int(req.query.program_id, 'program_id'),
      location: str(req.query.location),
      overdue: bool(req.query.overdue),
      search: str(req.query.search) || str(req.query.q),
    },
    { limit: perPage, offset, sort: str(req.query.sort) },
  );

  res.json(paged(rows, total, { page, perPage }));
}));

/** Filter dropdown contents. */
router.get('/facets', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  res.json(await getDeviceFacets(req.auth.organizationId));
}));

/**
 * Resolve a scanned or typed code to a device, with its current loan.
 *
 * This is the endpoint the scan station calls on every scan, so it answers
 * with everything needed to decide what to do next — no follow-up request
 * while a queue forms at the desk.
 */
router.get('/lookup/:code', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const code = normaliseScan(req.params.code);
  if (!code) throw badRequest('No barcode was provided.');

  const device = await resolveDevice(req.auth.organizationId, code);

  if (!device) {
    return res.status(404).json({
      error: {
        code: 'device_not_found',
        message:
          `No device matches "${code}". If this label came from another system, ` +
          'search for the device by name and check it in or out manually.',
        details: { scanned: code },
      },
    });
  }

  const full = await getDevice(req.auth.organizationId, device.id);
  const activeLoan = await getActiveLoanForDevice(device.id);

  res.json({
    device: full,
    active_loan: activeLoan ? decorateLoan(activeLoan) : null,
    // What the station should offer, so the UI does not re-derive the rules.
    suggested_action: activeLoan
      ? 'check_in'
      : ['available', 'reserved'].includes(device.status)
        ? 'check_out'
        : 'blocked',
    blocked_reason: !activeLoan && !['available', 'reserved'].includes(device.status)
      ? `This device is marked "${device.status.replace('_', ' ')}" and cannot be lent out until that changes.`
      : null,
  });
}));

// NOTE: GET /:id is deliberately registered at the bottom of this file.
// Express matches in declaration order, so a single-segment literal route such
// as /export.csv or /labels declared *after* /:id would never be reached — the
// parameterised route would capture it and try to look up a device called
// "export.csv". Express 5 dropped inline param patterns like /:id(\d+), so
// ordering is the only defence.

// ---------------------------------------------------------------------------
// Create and update
// ---------------------------------------------------------------------------

router.post('/', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const org = await getOrganization(req.auth.organizationId);
  const data = readDeviceBody(req.body, { requireName: true });

  try {
    const device = await createDevice(
      auditContextFromRequest(req),
      req.auth.organizationId,
      data,
      { barcodePrefix: org.barcode_prefix, actorId: req.auth.userId },
    );
    res.status(201).json({ device });
  } catch (err) {
    throw translateDuplicate(err);
  }
}));

router.patch('/:id', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const deviceId = Number(req.params.id);
  const before = await getDevice(req.auth.organizationId, deviceId);
  if (!before) throw notFound('That device does not exist.');

  const data = readDeviceBody(req.body, { requireName: false });
  const fields = Object.keys(data).filter((key) => data[key] !== undefined);

  if (!fields.length) throw badRequest('No changes were supplied.');

  // Changing status out from under an active loan silently desynchronises the
  // device from its loan record, so it is refused rather than allowed.
  if (data.status && data.status !== before.status && before.active_loan_id) {
    if (data.status !== 'checked_out') {
      throw conflict(
        `${before.name} is on loan (${before.active_loan_reference}). ` +
        'Check it in or cancel the loan before changing its status.',
        { loan_id: before.active_loan_id, loan_reference: before.active_loan_reference },
      );
    }
  }

  const setSql = fields.map((f) => `${f} = ?`).join(', ');
  const params = fields.map((f) => data[f]);
  params.push(deviceId, req.auth.organizationId);

  try {
    await execute(
      `UPDATE devices SET ${setSql}, updated_at = NOW() WHERE id = ? AND organization_id = ?`,
      params,
    );
  } catch (err) {
    throw translateDuplicate(err);
  }

  const after = await getDevice(req.auth.organizationId, deviceId);
  const changes = diffRecords(before, after, fields);

  await recordAudit(auditContextFromRequest(req), {
    action: data.status && data.status !== before.status
      ? AUDIT_ACTIONS.DEVICE_STATUS_CHANGED
      : AUDIT_ACTIONS.DEVICE_UPDATED,
    entityType: 'device',
    entityId: deviceId,
    entityLabel: after.name,
    summary: `Updated ${after.name} (${after.barcode}): ${fields.join(', ')}`,
    detail: { changes },
  });

  res.json({ device: after, changes });
}));

/**
 * Deleting a device with loan history would orphan that history, so it is only
 * allowed for devices that have never been lent. Everything else is retired,
 * which keeps the audit trail intact.
 */
router.delete('/:id', requireCapability('devices.delete'), asyncRoute(async (req, res) => {
  const deviceId = Number(req.params.id);
  const device = await getDevice(req.auth.organizationId, deviceId);
  if (!device) throw notFound('That device does not exist.');

  const loanCount = await queryOne('SELECT COUNT(*) AS n FROM loans WHERE device_id = ?', [deviceId]);

  if (Number(loanCount.n) > 0) {
    throw conflict(
      `${device.name} has ${loanCount.n} loan record(s) and cannot be deleted without destroying that history. ` +
      'Set its status to "retired" instead — it will stop appearing in the lendable pool.',
      { loan_count: Number(loanCount.n), suggested_action: 'retire' },
    );
  }

  await execute('DELETE FROM devices WHERE id = ? AND organization_id = ?', [deviceId, req.auth.organizationId]);

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.DEVICE_DELETED,
    entityType: 'device',
    entityId: deviceId,
    entityLabel: device.name,
    summary: `Deleted device ${device.name} (${device.barcode}) — it had no loan history`,
    detail: { barcode: device.barcode, asset_tag: device.asset_tag },
  });

  res.json({ ok: true, deleted: { id: deviceId, name: device.name, barcode: device.barcode } });
}));

// ---------------------------------------------------------------------------
// Spreadsheet import
// ---------------------------------------------------------------------------

/**
 * Import takes the file as raw text in the JSON body rather than multipart:
 * the browser reads the file with the File API, which keeps the server free of
 * upload middleware and temporary files on shared hosting.
 */
router.post('/import/preview', requireCapability('devices.import'), asyncRoute(async (req, res) => {
  const text = requiredStr(req.body?.content, 'File contents', { max: 20 * 1024 * 1024, trim: false });
  res.json(previewImport(text, { delimiter: str(req.body?.delimiter) }));
}));

router.post('/import', requireCapability('devices.import'), asyncRoute(async (req, res) => {
  const org = await getOrganization(req.auth.organizationId);
  const text = requiredStr(req.body?.content, 'File contents', { max: 20 * 1024 * 1024, trim: false });

  const result = await importDevices(auditContextFromRequest(req), {
    organizationId: req.auth.organizationId,
    text,
    filename: str(req.body?.filename, { max: 255 }),
    mapping: req.body?.mapping && typeof req.body.mapping === 'object' ? req.body.mapping : null,
    ignoreHeaders: Array.isArray(req.body?.ignore_headers) ? req.body.ignore_headers : [],
    delimiter: str(req.body?.delimiter),
    // Defaults to a dry run: committing has to be asked for explicitly.
    dryRun: bool(req.body?.dry_run, true),
    updateExisting: bool(req.body?.update_existing, true),
    defaultStatus: oneOf(req.body?.default_status, DEVICE_STATUSES, 'default_status', { fallback: 'available' }),
    barcodePrefix: org.barcode_prefix,
    actorId: req.auth.userId,
  });

  res.json(result);
}));

router.get('/import/history', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT i.*, u.full_name AS imported_by_name
       FROM device_imports i
       LEFT JOIN users u ON u.id = i.imported_by
      WHERE i.organization_id = ?
      ORDER BY i.created_at DESC LIMIT 50`,
    [req.auth.organizationId],
  );

  res.json({
    data: rows.map((row) => ({
      ...row,
      column_mapping: safeParse(row.column_mapping),
      errors: safeParse(row.errors),
    })),
  });
}));

/** A ready-made template so nobody has to guess the column names. */
router.get('/import/template.csv', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const csv = toCsv(
    ['asset_tag', 'serial_number', 'name', 'category', 'manufacturer', 'model',
     'status', 'condition', 'location', 'purchase_date', 'purchase_cost', 'funding_source', 'notes'],
    [
      ['AT-1001', 'SN12345678', 'Dell Latitude 5440', 'Laptop', 'Dell', 'Latitude 5440',
       'available', 'Good', 'Main office store', '2024-03-15', '899.00', 'State grant', 'Includes charger'],
      ['AT-1002', 'SN87654321', 'JAWS screen reader licence', 'Software', 'Freedom Scientific', 'JAWS 2024',
       'available', 'New', 'Main office store', '2024-05-02', '1095.00', 'State grant', 'Annual licence'],
      ['AT-1003', '', 'Optelec ClearView C', 'Magnifier', 'Optelec', 'ClearView C',
       'maintenance', 'Screen flickers', 'Repair bench', '2021-09-30', '2450.00', '', 'Awaiting parts'],
    ],
  );

  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="loaner-pool-device-template.csv"');
  res.send(csv);
}));

/** Export the current inventory, so this app is never a one-way door. */
router.get('/export.csv', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const { rows } = await listDevices(
    req.auth.organizationId,
    {
      status: str(req.query.status),
      category: str(req.query.category),
      search: str(req.query.search),
    },
    { limit: 100000, offset: 0, sort: 'name' },
  );

  const csv = toCsv(
    ['barcode', 'asset_tag', 'serial_number', 'name', 'category', 'manufacturer', 'model',
     'status', 'condition', 'location', 'program', 'purchase_date', 'purchase_cost',
     'funding_source', 'current_holder', 'due_at', 'notes'],
    rows.map((d) => [
      d.barcode, d.asset_tag, d.serial_number, d.name, d.category, d.manufacturer, d.model,
      d.status, d.condition_note, d.location, d.program_name, d.purchase_date, d.purchase_cost,
      d.funding_source, d.current_holder, d.active_loan_due_at, d.notes,
    ]),
  );

  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="devices-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// ---------------------------------------------------------------------------
// Barcodes and labels
// ---------------------------------------------------------------------------

/** A single barcode image, for on-screen display. */
router.get('/:id/barcode.svg', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const device = await getDevice(req.auth.organizationId, Number(req.params.id));
  if (!device) throw notFound('That device does not exist.');

  const org = await getOrganization(req.auth.organizationId);
  const symbology = oneOf(req.query.symbology, SYMBOLOGIES, 'symbology', { fallback: org.barcode_symbology });

  const svg = await renderBarcodeSvg(device.barcode, symbology, {
    size: int(req.query.size, 'size', { min: 40, max: 600 }) ?? 180,
  });

  res.type('image/svg+xml');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(svg);
}));

/** Printable label sheet for a selection of devices, or a whole filter. */
router.get('/labels', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const org = await getOrganization(req.auth.organizationId);
  const symbology = oneOf(req.query.symbology, SYMBOLOGIES, 'symbology', { fallback: org.barcode_symbology });

  let devices;
  const ids = str(req.query.ids);

  if (ids) {
    const idList = ids.split(',').map((n) => Number(n)).filter(Number.isInteger).slice(0, 500);
    if (!idList.length) throw badRequest('No valid device ids were supplied.');
    devices = await query(
      `SELECT id, name, barcode, asset_tag FROM devices
        WHERE organization_id = ? AND id IN (${idList.map(() => '?').join(',')})
        ORDER BY name`,
      [req.auth.organizationId, ...idList],
    );
  } else {
    const result = await listDevices(
      req.auth.organizationId,
      { status: str(req.query.status), category: str(req.query.category), search: str(req.query.search) },
      { limit: 500, offset: 0, sort: 'name' },
    );
    devices = result.rows;
  }

  if (!devices.length) throw notFound('No devices matched, so there is nothing to print.');

  const html = await renderLabelSheet(devices, {
    symbology,
    orgName: org.name,
    columns: int(req.query.columns, 'columns', { min: 1, max: 6 }) ?? 3,
    labelWidthMm: decimal(req.query.label_width_mm, 'label_width_mm') ?? 63.5,
    labelHeightMm: decimal(req.query.label_height_mm, 'label_height_mm') ?? 38.1,
  });

  res.type('text/html; charset=utf-8').send(html);
}));

/** Issue a fresh barcode, e.g. after a duplicate label is discovered. */
router.post('/:id/reassign-barcode', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const org = await getOrganization(req.auth.organizationId);
  const device = await reassignBarcode(
    auditContextFromRequest(req),
    req.auth.organizationId,
    Number(req.params.id),
    { barcodePrefix: org.barcode_prefix, actorId: req.auth.userId },
  );
  res.json({ device });
}));

/** Assign barcodes to any devices missing one. Safe to re-run. */
router.post('/backfill-barcodes', requireCapability('devices.write'), asyncRoute(async (req, res) => {
  const org = await getOrganization(req.auth.organizationId);
  const result = await backfillBarcodes(auditContextFromRequest(req), req.auth.organizationId, org.barcode_prefix);
  res.json(result);
}));

// ---------------------------------------------------------------------------
// Single device — registered last so literal paths above always win.
// ---------------------------------------------------------------------------

router.get('/:id', requireCapability('devices.read'), asyncRoute(async (req, res) => {
  const deviceId = Number(req.params.id);
  if (!Number.isInteger(deviceId)) throw notFound('That device does not exist.');

  const device = await getDevice(req.auth.organizationId, deviceId);
  if (!device) throw notFound('That device does not exist.');

  const loans = await query(
    `SELECT l.id, l.reference, l.status, l.checked_out_at, l.due_at, l.returned_at,
            u.full_name AS tech_name, p.name AS program_name,
            c.first_name AS client_first_name, c.last_name AS client_last_name
       FROM loans l
       LEFT JOIN users u ON u.id = l.tech_id
       LEFT JOIN programs p ON p.id = l.program_id
       LEFT JOIN clients c ON c.id = l.client_id
      WHERE l.device_id = ?
      ORDER BY l.checked_out_at DESC LIMIT 50`,
    [device.id],
  );

  res.json({ device, loan_history: loans });
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readDeviceBody(body, { requireName }) {
  const data = {
    name: requireName
      ? requiredStr(body?.name, 'Device name', { max: 190 })
      : str(body?.name, { max: 190 }),
    asset_tag: str(body?.asset_tag, { max: 64 }),
    serial_number: str(body?.serial_number, { max: 128 }),
    category: str(body?.category, { max: 96 }),
    manufacturer: str(body?.manufacturer, { max: 120 }),
    model: str(body?.model, { max: 120 }),
    description: str(body?.description),
    status: oneOf(body?.status, DEVICE_STATUSES, 'status', { fallback: requireName ? 'available' : undefined }),
    condition_note: str(body?.condition_note, { max: 190 }),
    location: str(body?.location, { max: 190 }),
    home_location: str(body?.home_location, { max: 190 }),
    owner_program_id: int(body?.owner_program_id, 'owner_program_id'),
    purchase_date: dateOnly(body?.purchase_date, 'purchase_date'),
    purchase_cost: decimal(body?.purchase_cost, 'purchase_cost'),
    warranty_expires: dateOnly(body?.warranty_expires, 'warranty_expires'),
    funding_source: str(body?.funding_source, { max: 120 }),
    notes: str(body?.notes),
    barcode: str(body?.barcode, { max: 64 }),
  };

  // On create, keep everything. On update, only keep keys the caller sent, so
  // a PATCH of one field does not blank the other twenty.
  if (!requireName) {
    for (const key of Object.keys(data)) {
      if (!(key in (body ?? {}))) delete data[key];
    }
    delete data.barcode; // Barcodes change through reassign-barcode only.
  }

  return data;
}

/** Turn a driver duplicate-key error into a message naming the actual field. */
function translateDuplicate(err) {
  if (err?.code !== 'ER_DUP_ENTRY') return err;
  const message = String(err.sqlMessage || '');

  if (message.includes('uq_device_barcode')) {
    return conflict('Another device already uses that barcode.', { field: 'barcode' });
  }
  if (message.includes('uq_device_asset')) {
    return conflict('Another device already uses that asset tag.', { field: 'asset_tag' });
  }
  if (message.includes('uq_device_serial')) {
    return conflict('Another device already uses that serial number.', { field: 'serial_number' });
  }
  return conflict('That value is already in use by another device.');
}

function safeParse(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export default router;
