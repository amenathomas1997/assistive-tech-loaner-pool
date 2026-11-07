/**
 * CSV / TSV parsing for spreadsheet ingest.
 *
 * Written by hand rather than pulled from a dependency because the input is
 * "whatever Excel produced", and the failure modes that matter here are the
 * ones a generic parser hides: a UTF-8 BOM Excel always writes, CRLF endings,
 * quoted fields containing commas and newlines, and duplicate header names.
 *
 * Implements RFC 4180 plus the two extensions Excel actually emits:
 *   - semicolon or tab delimiters (locale-dependent exports)
 *   - a leading BOM
 */

import { badRequest } from './util.js';

const BOM = '﻿';

/**
 * Guess the delimiter by counting candidates outside quoted regions in the
 * first few lines. Counting naively across the whole file gets this wrong the
 * moment a description field contains a comma.
 */
export function detectDelimiter(text) {
  const candidates = [',', ';', '\t', '|'];
  const sample = text.slice(0, 64 * 1024);

  let best = ',';
  let bestScore = -1;

  for (const delimiter of candidates) {
    let inQuotes = false;
    let count = 0;
    let lines = 0;

    for (let i = 0; i < sample.length && lines < 5; i += 1) {
      const ch = sample[i];
      if (ch === '"') {
        if (inQuotes && sample[i + 1] === '"') i += 1;
        else inQuotes = !inQuotes;
      } else if (!inQuotes && ch === delimiter) {
        count += 1;
      } else if (!inQuotes && ch === '\n') {
        lines += 1;
      }
    }

    if (count > bestScore) {
      bestScore = count;
      best = delimiter;
    }
  }

  return bestScore > 0 ? best : ',';
}

/**
 * Parse CSV text into an array of string arrays.
 * Throws on unterminated quotes rather than silently swallowing the tail of
 * the file, which is the classic way a broken import loses half its rows.
 */
export function parseCsv(text, { delimiter } = {}) {
  let input = String(text ?? '');
  if (input.startsWith(BOM)) input = input.slice(1);
  if (input.trim() === '') return [];

  const sep = delimiter || detectDelimiter(input);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let line = 1;

  const endField = () => {
    // Only trim unquoted fields: a quoted "  x  " asked for those spaces.
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };

  const endRow = () => {
    endField();
    // Skip rows that are entirely empty (trailing newlines, blank separators).
    if (row.some((cell) => cell !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      fieldWasQuoted = true;
      continue;
    }
    if (ch === sep) {
      endField();
      continue;
    }
    if (ch === '\r') {
      // Handled by the \n that follows; a lone \r (old Mac) also ends a row.
      if (input[i + 1] !== '\n') {
        endRow();
        line += 1;
      }
      continue;
    }
    if (ch === '\n') {
      endRow();
      line += 1;
      continue;
    }
    field += ch;
  }

  if (inQuotes) {
    throw badRequest(
      `The file has an unclosed quotation mark starting somewhere before line ${line}. ` +
      'Re-export it from Excel as "CSV UTF-8" and try again.',
    );
  }

  // Flush whatever is left on the final line (files often lack a trailing \n).
  if (field !== '' || row.length) endRow();

  return rows;
}

/**
 * Turn raw rows into objects keyed by header.
 * Duplicate headers get suffixed rather than silently overwriting each other.
 */
export function parseCsvToObjects(text, options = {}) {
  const rows = parseCsv(text, options);
  if (!rows.length) throw badRequest('That file contains no rows.');

  const rawHeaders = rows[0];
  const seen = new Map();
  const headers = rawHeaders.map((h) => {
    const base = normaliseHeader(h) || 'column';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });

  const records = [];
  for (let i = 1; i < rows.length; i += 1) {
    const values = rows[i];
    const record = {};
    for (let c = 0; c < headers.length; c += 1) {
      record[headers[c]] = values[c] !== undefined ? values[c] : '';
    }
    // Line number in the original file, for error messages the user can act on.
    record.__line = i + 1;
    records.push(record);
  }

  return { headers, records, rawHeaders };
}

/** "Serial Number" / "serial_number" / "SERIAL-NUMBER" all become serial_number. */
export function normaliseHeader(header) {
  return String(header ?? '')
    .replace(BOM, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Device fields that can be populated from a spreadsheet, with the header
 * spellings seen in the wild. Anything not listed here is preserved verbatim
 * in the device's custom_fields JSON rather than discarded — an inventory
 * sheet's odd columns are usually the ones a given office cares most about.
 */
export const DEVICE_FIELD_ALIASES = {
  barcode: ['barcode', 'bar_code', 'barcode_id', 'tag_barcode', 'scan_code'],
  asset_tag: ['asset_tag', 'asset', 'asset_id', 'asset_number', 'tag', 'inventory_number', 'inventory_id'],
  serial_number: ['serial_number', 'serial', 'serial_no', 'sn', 'service_tag'],
  name: ['name', 'device', 'device_name', 'item', 'item_name', 'description_short', 'title'],
  category: ['category', 'type', 'device_type', 'equipment_type', 'class'],
  manufacturer: ['manufacturer', 'make', 'brand', 'vendor'],
  model: ['model', 'model_number', 'model_no'],
  description: ['description', 'details', 'notes_long', 'long_description'],
  status: ['status', 'state', 'availability'],
  condition_note: ['condition', 'condition_note', 'device_condition'],
  location: ['location', 'current_location', 'storage_location', 'shelf', 'room'],
  home_location: ['home_location', 'default_location', 'assigned_location'],
  purchase_date: ['purchase_date', 'purchased', 'date_purchased', 'acquired', 'acquisition_date'],
  purchase_cost: ['purchase_cost', 'cost', 'price', 'value', 'purchase_price'],
  warranty_expires: ['warranty_expires', 'warranty', 'warranty_end', 'warranty_expiration'],
  funding_source: ['funding_source', 'funding', 'grant', 'fund'],
  notes: ['notes', 'note', 'comments', 'remarks'],
  program: ['program', 'owner_program', 'activity', 'service', 'program_name'],
};

/**
 * Propose a header -> device field mapping. Returned to the browser so the
 * user can correct it before committing; never applied blind.
 */
export function suggestMapping(headers) {
  const mapping = {};
  const used = new Set();

  for (const [field, aliases] of Object.entries(DEVICE_FIELD_ALIASES)) {
    const match = headers.find((h) => aliases.includes(h) && !used.has(h));
    if (match) {
      mapping[match] = field;
      used.add(match);
    }
  }

  // Unmapped headers are explicitly marked so the UI can offer "ignore" or
  // "keep as custom field" rather than leaving them ambiguous.
  const unmapped = headers.filter((h) => !used.has(h) && h !== '__line');
  return { mapping, unmapped };
}

/** Normalise the many ways a spreadsheet writes a status into our enum. */
export function normaliseStatus(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;

  const table = {
    available: 'available', in: 'available', 'in stock': 'available', instock: 'available',
    ready: 'available', free: 'available', unassigned: 'available', in_stock: 'available',
    checked_out: 'checked_out', 'checked out': 'checked_out', out: 'checked_out',
    loaned: 'checked_out', on_loan: 'checked_out', 'on loan': 'checked_out', assigned: 'checked_out',
    reserved: 'reserved', hold: 'reserved', on_hold: 'reserved',
    maintenance: 'maintenance', repair: 'maintenance', 'in repair': 'maintenance',
    broken: 'maintenance', service: 'maintenance', servicing: 'maintenance',
    retired: 'retired', disposed: 'retired', decommissioned: 'retired', surplus: 'retired',
    lost: 'lost', missing: 'lost', stolen: 'lost',
  };

  return table[s] || null;
}

/**
 * Parse the date formats spreadsheets emit into YYYY-MM-DD.
 *
 * Ambiguous DD/MM vs MM/DD is resolved as MM/DD (US) unless the first number
 * exceeds 12. This is a genuine limitation, surfaced in the import UI rather
 * than hidden: an ISO-formatted column is always unambiguous and preferred.
 */
export function parseSpreadsheetDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;

  // Already ISO.
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return formatDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // Excel serial number (days since 1899-12-30).
  if (/^\d{5}$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 60000) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
  }

  // M/D/YYYY, D-M-YYYY, M.D.YY etc.
  const parts = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (parts) {
    let [, a, b, year] = parts.map(Number);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    // If the first component can't be a month, it must be the day.
    const month = a > 12 ? b : a;
    const day = a > 12 ? a : b;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return formatDate(year, month, day);
    }
  }

  // Fall back to Date parsing for things like "12 March 2024".
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  }

  return null;
}

function formatDate(year, month, day) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = new Date(year, month - 1, day);
  // Reject dates that rolled over, e.g. 2024-02-31.
  if (date.getMonth() + 1 !== month || date.getDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Strip currency symbols and thousands separators. */
export function parseMoney(value) {
  const s = String(value ?? '').replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
