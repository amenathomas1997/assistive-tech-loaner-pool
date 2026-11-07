/**
 * Device inventory: spreadsheet ingest and barcode assignment.
 *
 * Import is deliberately two-phase. A dry run parses, maps and validates
 * everything and reports exactly what would happen, without writing a row.
 * Only a second call with dry_run=false commits. Inventory imports are the
 * operation most likely to be run against the wrong file, and "undo" for a
 * 900-row import is not something this application can offer.
 */

import { transaction, connOne, query, queryOne, execute } from '../db.js';
import { badRequest, notFound, str, toMysqlDateTime } from './util.js';
import { recordAudit, AUDIT_ACTIONS } from './audit.js';
import { allocateBarcode, normaliseScan } from './barcode.js';
import {
  parseCsvToObjects, suggestMapping, normaliseStatus,
  parseSpreadsheetDate, parseMoney, DEVICE_FIELD_ALIASES,
} from './csv.js';

/** Columns an import may write. Anything else lands in custom_fields. */
const IMPORTABLE_FIELDS = Object.keys(DEVICE_FIELD_ALIASES);

const MAX_IMPORT_ROWS = 20000;

/**
 * Parse a spreadsheet and propose a mapping, without touching the database.
 * The browser shows this for confirmation before any import runs.
 */
export function previewImport(text, { delimiter } = {}) {
  const { headers, records, rawHeaders } = parseCsvToObjects(text, { delimiter });

  if (records.length > MAX_IMPORT_ROWS) {
    throw badRequest(
      `That file has ${records.length} rows, which is over the ${MAX_IMPORT_ROWS} row limit. ` +
      'Split it into smaller files and import them one at a time.',
    );
  }

  const { mapping, unmapped } = suggestMapping(headers);

  return {
    row_count: records.length,
    headers,
    raw_headers: rawHeaders,
    suggested_mapping: mapping,
    unmapped_headers: unmapped,
    importable_fields: IMPORTABLE_FIELDS,
    sample_rows: records.slice(0, 5).map((r) => {
      const { __line, ...rest } = r;
      return rest;
    }),
  };
}

/**
 * Import devices.
 *
 * `mapping` maps spreadsheet header -> device field. Headers not in the
 * mapping are stored in custom_fields unless listed in `ignoreHeaders`.
 *
 * Matching for updates, in priority order: barcode, then serial number, then
 * asset tag. A row that matches nothing creates a new device and is allocated
 * a fresh barcode.
 */
export async function importDevices(ctx, input) {
  const {
    organizationId,
    text,
    filename = null,
    mapping: providedMapping = null,
    ignoreHeaders = [],
    delimiter = null,
    dryRun = true,
    updateExisting = true,
    defaultStatus = 'available',
    barcodePrefix = 'LP',
    actorId = null,
  } = input;

  const { headers, records } = parseCsvToObjects(text, { delimiter });

  if (!records.length) throw badRequest('That file has a header row but no data rows.');
  if (records.length > MAX_IMPORT_ROWS) {
    throw badRequest(`That file has ${records.length} rows, which is over the ${MAX_IMPORT_ROWS} row limit.`);
  }

  const mapping = providedMapping || suggestMapping(headers).mapping;
  const ignored = new Set(ignoreHeaders);

  // A device needs something to be called. Refusing up front beats importing
  // 800 rows named "Unnamed device".
  const mappedFields = new Set(Object.values(mapping));
  if (!mappedFields.has('name') && !mappedFields.has('model') && !mappedFields.has('asset_tag')) {
    throw badRequest(
      'The import needs at least one column mapped to "name", "model" or "asset_tag" so each device can be identified.',
      { mapped_fields: [...mappedFields] },
    );
  }

  const errors = [];
  const plan = [];
  const seenBarcodes = new Set();
  const seenSerials = new Set();
  const seenAssetTags = new Set();

  // Program names in the sheet are resolved to ids once, not per row.
  const programsByName = new Map();
  for (const program of await query(
    'SELECT id, name, code FROM programs WHERE organization_id = ?', [organizationId],
  )) {
    programsByName.set(program.name.toLowerCase(), program.id);
    if (program.code) programsByName.set(program.code.toLowerCase(), program.id);
  }

  for (const record of records) {
    const line = record.__line;
    const rowErrors = [];
    const device = {};
    const custom = {};

    for (const header of headers) {
      if (header === '__line') continue;
      const rawValue = record[header];
      const field = mapping[header];

      if (!field || field === '__ignore') {
        if (!ignored.has(header) && str(rawValue) !== null) custom[header] = rawValue;
        continue;
      }

      const value = str(rawValue);
      if (value === null) continue;

      switch (field) {
        case 'purchase_date':
        case 'warranty_expires': {
          const parsed = parseSpreadsheetDate(value);
          if (!parsed) {
            rowErrors.push(`"${header}" value "${value}" is not a date this importer recognises`);
          } else {
            device[field] = parsed;
          }
          break;
        }
        case 'purchase_cost': {
          const parsed = parseMoney(value);
          if (parsed === null) {
            rowErrors.push(`"${header}" value "${value}" is not a number`);
          } else {
            device[field] = parsed;
          }
          break;
        }
        case 'status': {
          const parsed = normaliseStatus(value);
          if (!parsed) {
            rowErrors.push(`"${header}" value "${value}" is not a status this importer recognises`);
          } else {
            device[field] = parsed;
          }
          break;
        }
        case 'program': {
          const programId = programsByName.get(value.toLowerCase());
          if (!programId) {
            rowErrors.push(`program "${value}" does not exist — create it first, or leave the column unmapped`);
          } else {
            device.owner_program_id = programId;
          }
          break;
        }
        case 'barcode': {
          const parsed = normaliseScan(value);
          if (!parsed) rowErrors.push(`"${header}" is empty after cleanup`);
          else device.barcode = parsed;
          break;
        }
        default:
          device[field] = value;
      }
    }

    // Derive a name when the sheet has no explicit name column.
    if (!device.name) {
      device.name = [device.manufacturer, device.model].filter(Boolean).join(' ')
        || device.asset_tag
        || device.serial_number
        || null;
    }
    if (!device.name) {
      rowErrors.push('could not determine a device name from this row');
    }

    // Duplicates within the file itself, which the database would only catch
    // one at a time, halfway through the import.
    if (device.barcode) {
      if (seenBarcodes.has(device.barcode)) {
        rowErrors.push(`barcode "${device.barcode}" appears more than once in this file`);
      }
      seenBarcodes.add(device.barcode);
    }
    if (device.serial_number) {
      const key = device.serial_number.toUpperCase();
      if (seenSerials.has(key)) {
        rowErrors.push(`serial number "${device.serial_number}" appears more than once in this file`);
      }
      seenSerials.add(key);
    }
    if (device.asset_tag) {
      const key = device.asset_tag.toUpperCase();
      if (seenAssetTags.has(key)) {
        rowErrors.push(`asset tag "${device.asset_tag}" appears more than once in this file`);
      }
      seenAssetTags.add(key);
    }

    if (rowErrors.length) {
      errors.push({ line, errors: rowErrors, row: summariseRow(device) });
      continue;
    }

    if (Object.keys(custom).length) device.custom_fields = JSON.stringify(custom);
    if (!device.status) device.status = defaultStatus;

    // Decide create vs update.
    const existing = await findExistingDevice(organizationId, device);
    plan.push({
      line,
      action: existing ? (updateExisting ? 'update' : 'skip') : 'create',
      existing_id: existing?.id ?? null,
      existing_barcode: existing?.barcode ?? null,
      device,
    });
  }

  const summary = {
    row_count: records.length,
    to_create: plan.filter((p) => p.action === 'create').length,
    to_update: plan.filter((p) => p.action === 'update').length,
    to_skip: plan.filter((p) => p.action === 'skip').length,
    error_count: errors.length,
    errors: errors.slice(0, 200),
    errors_truncated: errors.length > 200,
    mapping,
    dry_run: dryRun,
  };

  if (dryRun) {
    // Record the dry run so an admin can see that a file was evaluated.
    await execute(
      `INSERT INTO device_imports
         (organization_id, filename, row_count, created_count, updated_count, skipped_count,
          error_count, column_mapping, errors, dry_run, imported_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        organizationId, filename, records.length, summary.to_create, summary.to_update,
        summary.to_skip, errors.length, JSON.stringify(mapping),
        JSON.stringify(errors.slice(0, 200)), actorId,
      ],
    );
    return { ...summary, preview: plan.slice(0, 25).map(previewEntry) };
  }

  // --- Commit ---------------------------------------------------------------
  const result = await transaction(async (conn) => {
    const [importResult] = await conn.execute(
      `INSERT INTO device_imports
         (organization_id, filename, row_count, column_mapping, errors, dry_run, imported_by)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [organizationId, filename, records.length, JSON.stringify(mapping),
       JSON.stringify(errors.slice(0, 200)), actorId],
    );
    const importId = importResult.insertId;

    let created = 0;
    let updated = 0;
    let skipped = 0;

    const barcodeExists = async (candidate) => {
      const row = await connOne(conn, 'SELECT id FROM devices WHERE barcode = ?', [candidate]);
      return Boolean(row);
    };

    for (const entry of plan) {
      if (entry.action === 'skip') { skipped += 1; continue; }

      if (entry.action === 'create') {
        const barcode = entry.device.barcode || await allocateBarcode(barcodeExists, barcodePrefix);
        await conn.execute(
          `INSERT INTO devices
             (organization_id, barcode, asset_tag, serial_number, name, category, manufacturer,
              model, description, status, condition_note, location, home_location,
              owner_program_id, purchase_date, purchase_cost, warranty_expires, funding_source,
              notes, custom_fields, import_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            organizationId, barcode, entry.device.asset_tag ?? null, entry.device.serial_number ?? null,
            entry.device.name, entry.device.category ?? null, entry.device.manufacturer ?? null,
            entry.device.model ?? null, entry.device.description ?? null, entry.device.status,
            entry.device.condition_note ?? null, entry.device.location ?? null,
            entry.device.home_location ?? null, entry.device.owner_program_id ?? null,
            entry.device.purchase_date ?? null, entry.device.purchase_cost ?? null,
            entry.device.warranty_expires ?? null, entry.device.funding_source ?? null,
            entry.device.notes ?? null, entry.device.custom_fields ?? null, importId,
          ],
        );
        created += 1;
        continue;
      }

      // Update: only overwrite columns the sheet actually supplied, so a
      // partial spreadsheet cannot blank out data it does not know about.
      const updatable = IMPORTABLE_FIELDS
        .filter((f) => f !== 'program' && f !== 'barcode')
        .concat(['owner_program_id', 'custom_fields'])
        .filter((f) => entry.device[f] !== undefined);

      if (!updatable.length) { skipped += 1; continue; }

      const setSql = updatable.map((f) => `${f} = ?`).join(', ');
      const params = updatable.map((f) => entry.device[f]);
      params.push(importId, entry.existing_id, organizationId);

      await conn.execute(
        `UPDATE devices SET ${setSql}, import_id = ?, updated_at = NOW()
          WHERE id = ? AND organization_id = ?`,
        params,
      );
      updated += 1;
    }

    await conn.execute(
      `UPDATE device_imports
          SET created_count = ?, updated_count = ?, skipped_count = ?, error_count = ?
        WHERE id = ?`,
      [created, updated, skipped, errors.length, importId],
    );

    return { importId, created, updated, skipped };
  });

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.DEVICE_IMPORTED,
    entityType: 'device_import',
    entityId: result.importId,
    entityLabel: filename,
    summary:
      `Imported ${filename || 'spreadsheet'}: ${result.created} created, ` +
      `${result.updated} updated, ${result.skipped} skipped, ${errors.length} rejected`,
    detail: { ...result, error_count: errors.length, mapping },
  });

  return {
    ...summary,
    dry_run: false,
    import_id: result.importId,
    created_count: result.created,
    updated_count: result.updated,
    skipped_count: result.skipped,
  };
}

function summariseRow(device) {
  return {
    name: device.name ?? null,
    asset_tag: device.asset_tag ?? null,
    serial_number: device.serial_number ?? null,
    barcode: device.barcode ?? null,
  };
}

function previewEntry(entry) {
  return {
    line: entry.line,
    action: entry.action,
    existing_id: entry.existing_id,
    existing_barcode: entry.existing_barcode,
    name: entry.device.name,
    asset_tag: entry.device.asset_tag ?? null,
    serial_number: entry.device.serial_number ?? null,
    barcode: entry.device.barcode ?? '(will be assigned)',
  };
}

/**
 * Match an incoming row to an existing device.
 * Barcode is authoritative, then serial number, then asset tag — in that order
 * because that is the order of how uniquely each identifies real hardware.
 */
async function findExistingDevice(organizationId, device) {
  if (device.barcode) {
    const row = await queryOne(
      'SELECT id, barcode FROM devices WHERE barcode = ? AND organization_id = ?',
      [device.barcode, organizationId],
    );
    if (row) return row;
  }
  if (device.serial_number) {
    const row = await queryOne(
      'SELECT id, barcode FROM devices WHERE serial_number = ? AND organization_id = ?',
      [device.serial_number, organizationId],
    );
    if (row) return row;
  }
  if (device.asset_tag) {
    const row = await queryOne(
      'SELECT id, barcode FROM devices WHERE asset_tag = ? AND organization_id = ?',
      [device.asset_tag, organizationId],
    );
    if (row) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createDevice(ctx, organizationId, data, { barcodePrefix = 'LP', actorId = null } = {}) {
  const barcode = data.barcode
    ? normaliseScan(data.barcode)
    : await allocateBarcode(
        async (candidate) => Boolean(await queryOne('SELECT id FROM devices WHERE barcode = ?', [candidate])),
        barcodePrefix,
      );

  const result = await execute(
    `INSERT INTO devices
       (organization_id, barcode, asset_tag, serial_number, name, category, manufacturer, model,
        description, status, condition_note, location, home_location, owner_program_id,
        purchase_date, purchase_cost, warranty_expires, funding_source, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId, barcode, data.asset_tag ?? null, data.serial_number ?? null, data.name,
      data.category ?? null, data.manufacturer ?? null, data.model ?? null, data.description ?? null,
      data.status ?? 'available', data.condition_note ?? null, data.location ?? null,
      data.home_location ?? null, data.owner_program_id ?? null, data.purchase_date ?? null,
      data.purchase_cost ?? null, data.warranty_expires ?? null, data.funding_source ?? null,
      data.notes ?? null,
    ],
  );

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.DEVICE_CREATED,
    entityType: 'device',
    entityId: result.insertId,
    entityLabel: data.name,
    summary: `Added device ${data.name} (${barcode})`,
    detail: { barcode, asset_tag: data.asset_tag, serial_number: data.serial_number },
  });

  return getDevice(organizationId, result.insertId);
}

const DEVICE_SELECT = `
  SELECT d.*,
         p.name AS program_name,
         l.id AS active_loan_id, l.reference AS active_loan_reference, l.due_at AS active_loan_due_at,
         l.checked_out_at AS active_loan_checked_out_at,
         t.full_name AS active_loan_tech_name,
         c.first_name AS active_loan_client_first_name, c.last_name AS active_loan_client_last_name,
         lp.name AS active_loan_program_name
    FROM devices d
    LEFT JOIN programs p ON p.id = d.owner_program_id
    LEFT JOIN loans l ON l.device_id = d.id AND l.status = 'active'
    LEFT JOIN users t ON t.id = l.tech_id
    LEFT JOIN clients c ON c.id = l.client_id
    LEFT JOIN programs lp ON lp.id = l.program_id`;

export async function getDevice(organizationId, deviceId) {
  const row = await queryOne(
    `${DEVICE_SELECT} WHERE d.id = ? AND d.organization_id = ?`,
    [deviceId, organizationId],
  );
  return row ? decorateDevice(row) : null;
}

export function decorateDevice(row) {
  const holder = [];
  if (row.active_loan_client_first_name) {
    holder.push(`${row.active_loan_client_first_name} ${row.active_loan_client_last_name}`);
  }
  if (row.active_loan_tech_name) holder.push(row.active_loan_tech_name);
  if (row.active_loan_program_name) holder.push(row.active_loan_program_name);

  return {
    ...row,
    custom_fields: parseJson(row.custom_fields),
    is_available: row.status === 'available' && !row.active_loan_id,
    current_holder: holder.length ? holder.join(' / ') : null,
    is_overdue: Boolean(
      row.active_loan_id && row.active_loan_due_at && new Date(row.active_loan_due_at) < new Date(),
    ),
  };
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function listDevices(organizationId, filters = {}, { limit = 50, offset = 0, sort = null } = {}) {
  const where = ['d.organization_id = ?'];
  const params = [organizationId];

  if (filters.status === 'available') {
    where.push(`d.status = 'available' AND l.id IS NULL`);
  } else if (filters.status) {
    where.push('d.status = ?');
    params.push(filters.status);
  }
  if (filters.category) { where.push('d.category = ?'); params.push(filters.category); }
  if (filters.programId) { where.push('d.owner_program_id = ?'); params.push(filters.programId); }
  if (filters.location) { where.push('d.location = ?'); params.push(filters.location); }
  if (filters.overdue) {
    where.push(`l.id IS NOT NULL AND l.due_at IS NOT NULL AND l.due_at < NOW()`);
  }
  if (filters.search) {
    where.push(
      '(d.name LIKE ? OR d.barcode LIKE ? OR d.asset_tag LIKE ? OR d.serial_number LIKE ? ' +
      'OR d.manufacturer LIKE ? OR d.model LIKE ? OR d.category LIKE ?)',
    );
    const like = `%${filters.search}%`;
    params.push(like, like, like, like, like, like, like);
  }

  const whereSql = where.join(' AND ');
  const sortColumns = {
    name: 'd.name', barcode: 'd.barcode', status: 'd.status',
    category: 'd.category', created_at: 'd.created_at', asset_tag: 'd.asset_tag',
    due_at: 'l.due_at',
  };
  const key = String(sort || '').replace(/^-/, '');
  const orderSql = sortColumns[key]
    ? `${sortColumns[key]} ${String(sort).startsWith('-') ? 'DESC' : 'ASC'}`
    : 'd.name ASC';

  const rows = await query(
    `${DEVICE_SELECT} WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  );

  const countRow = await queryOne(
    `SELECT COUNT(DISTINCT d.id) AS total FROM devices d
       LEFT JOIN loans l ON l.device_id = d.id AND l.status = 'active'
      WHERE ${whereSql}`,
    params,
  );

  return { rows: rows.map(decorateDevice), total: Number(countRow?.total ?? 0) };
}

/** Distinct categories and locations, for filter dropdowns. */
export async function getDeviceFacets(organizationId) {
  const [categories, locations, statuses] = await Promise.all([
    query(
      `SELECT category AS value, COUNT(*) AS count FROM devices
        WHERE organization_id = ? AND category IS NOT NULL AND category <> ''
        GROUP BY category ORDER BY category`,
      [organizationId],
    ),
    query(
      `SELECT location AS value, COUNT(*) AS count FROM devices
        WHERE organization_id = ? AND location IS NOT NULL AND location <> ''
        GROUP BY location ORDER BY location`,
      [organizationId],
    ),
    query(
      `SELECT status AS value, COUNT(*) AS count FROM devices
        WHERE organization_id = ? GROUP BY status`,
      [organizationId],
    ),
  ]);
  return { categories, locations, statuses };
}

/** Re-issue a device's barcode, e.g. after a label is damaged or duplicated. */
export async function reassignBarcode(ctx, organizationId, deviceId, { barcodePrefix = 'LP', actorId = null } = {}) {
  const device = await queryOne(
    'SELECT * FROM devices WHERE id = ? AND organization_id = ?', [deviceId, organizationId],
  );
  if (!device) throw notFound('That device does not exist.');

  const newBarcode = await allocateBarcode(
    async (candidate) => Boolean(await queryOne('SELECT id FROM devices WHERE barcode = ?', [candidate])),
    barcodePrefix,
  );

  await execute('UPDATE devices SET barcode = ?, updated_at = NOW() WHERE id = ?', [newBarcode, deviceId]);

  await recordAudit(ctx, {
    organizationId,
    action: AUDIT_ACTIONS.DEVICE_BARCODE_ASSIGNED,
    entityType: 'device',
    entityId: deviceId,
    entityLabel: device.name,
    summary: `Reassigned barcode for ${device.name}: ${device.barcode} → ${newBarcode}`,
    detail: { old_barcode: device.barcode, new_barcode: newBarcode },
  });

  return getDevice(organizationId, deviceId);
}

/**
 * Give barcodes to devices that somehow lack one — legacy rows, or an import
 * that was interrupted. Safe to run repeatedly.
 */
export async function backfillBarcodes(ctx, organizationId, barcodePrefix = 'LP') {
  const missing = await query(
    `SELECT id, name FROM devices WHERE organization_id = ? AND (barcode IS NULL OR barcode = '')`,
    [organizationId],
  );

  let assigned = 0;
  for (const device of missing) {
    const barcode = await allocateBarcode(
      async (candidate) => Boolean(await queryOne('SELECT id FROM devices WHERE barcode = ?', [candidate])),
      barcodePrefix,
    );
    await execute('UPDATE devices SET barcode = ?, updated_at = NOW() WHERE id = ?', [barcode, device.id]);
    assigned += 1;
  }

  if (assigned) {
    await recordAudit(ctx, {
      organizationId,
      action: AUDIT_ACTIONS.DEVICE_BARCODE_ASSIGNED,
      entityType: 'device',
      summary: `Assigned barcodes to ${assigned} device(s) that had none`,
      detail: { assigned },
    });
  }

  return { assigned };
}
