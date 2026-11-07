/**
 * Shared helpers: typed HTTP errors, input coercion, pagination, references.
 */

import crypto from 'node:crypto';

/**
 * An error carrying an HTTP status and a stable machine-readable code.
 * The error handler in server.js turns these into the documented API error
 * envelope; anything else becomes a generic 500 so internals never leak.
 */
export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required.') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, 'not_found', msg);
export const conflict = (msg, details) => new HttpError(409, 'conflict', msg, details);
export const unprocessable = (msg, details) => new HttpError(422, 'unprocessable', msg, details);

/** Wrap an async route so rejections reach Express's error handler. */
export const asyncRoute = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ---------------------------------------------------------------------------
// Input coercion
//
// Every one of these treats "missing" and "empty string" as null rather than
// as 0 / NaN / "undefined", because HTML form fields submit empty strings and
// those must not become real values in the database.
// ---------------------------------------------------------------------------

export function str(value, { max = 65535, trim = true } = {}) {
  if (value === undefined || value === null) return null;
  let s = String(value);
  if (trim) s = s.trim();
  if (s === '') return null;
  return s.slice(0, max);
}

export function requiredStr(value, field, opts = {}) {
  const s = str(value, opts);
  if (s === null) throw badRequest(`"${field}" is required.`, { field });
  return s;
}

export function int(value, field, { min = null, max = null } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`"${field}" must be a whole number.`, { field });
  if (min !== null && n < min) throw badRequest(`"${field}" must be at least ${min}.`, { field });
  if (max !== null && n > max) throw badRequest(`"${field}" must be at most ${max}.`, { field });
  return n;
}

export function decimal(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`"${field}" must be a number.`, { field });
  return n;
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function oneOf(value, allowed, field, { required = false, fallback = null } = {}) {
  const s = str(value);
  if (s === null) {
    if (required) throw badRequest(`"${field}" is required.`, { field });
    return fallback;
  }
  if (!allowed.includes(s)) {
    throw badRequest(`"${field}" must be one of: ${allowed.join(', ')}.`, { field, allowed });
  }
  return s;
}

/** Accepts YYYY-MM-DD. Returns the same string or null; rejects nonsense dates. */
export function dateOnly(value, field) {
  const s = str(value);
  if (s === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw badRequest(`"${field}" must be a date in YYYY-MM-DD format.`, { field });
  }
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw badRequest(`"${field}" is not a real date.`, { field });
  return s;
}

/** Accepts an ISO-ish datetime and returns a Date, or null. */
export function dateTime(value, field) {
  const s = str(value);
  if (s === null) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw badRequest(`"${field}" is not a valid date and time.`, { field });
  }
  return d;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function email(value, field, { required = false } = {}) {
  const s = str(value, { max: 190 });
  if (s === null) {
    if (required) throw badRequest(`"${field}" is required.`, { field });
    return null;
  }
  if (!EMAIL_RE.test(s)) throw badRequest(`"${field}" is not a valid email address.`, { field });
  return s.toLowerCase();
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export function pagination(queryParams) {
  const page = Math.max(1, Number(queryParams.page) || 1);
  const requested = Number(queryParams.per_page) || DEFAULT_PAGE_SIZE;
  const perPage = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));
  return { page, perPage, offset: (page - 1) * perPage };
}

export function paged(items, total, { page, perPage }) {
  return {
    data: items,
    meta: {
      page,
      per_page: perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

/**
 * Build "ORDER BY" from user input without interpolating user text into SQL.
 * Only column names present in `allowed` can ever reach the query.
 */
export function orderBy(sortParam, allowed, fallback) {
  const raw = str(sortParam);
  if (!raw) return fallback;
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  const column = allowed[key];
  if (!column) return fallback;
  return `${column} ${desc ? 'DESC' : 'ASC'}`;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Alphabet for barcode values and pairing codes.
 *
 * Excludes 0/O, 1/I/L — the pairs people transpose when reading a code off a
 * label out loud or typing one in because the scanner failed. 31 characters.
 */
export const UNAMBIGUOUS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Random string from the unambiguous alphabet.
 *
 * Rejection sampling rather than `byte % 31`: 256 is not a multiple of 31, so
 * the modulo approach would make the first eight characters ~3% more likely
 * than the rest. Harmless for a pairing code, but these values are also
 * device barcodes where uniformity is what keeps the collision maths honest.
 */
export function randomCode(length = 6) {
  const size = UNAMBIGUOUS.length;
  const limit = Math.floor(256 / size) * size; // 248 for a 31-char alphabet
  let out = '';

  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const byte of bytes) {
      if (byte >= limit) continue; // Discard the biased tail.
      out += UNAMBIGUOUS[byte % size];
      if (out.length === length) break;
    }
  }

  return out;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Human-facing reference like "LN-2026-4F7K2Q" for loans and "RQ-..." for
 * requests. Uniqueness is guaranteed by a UNIQUE index plus retry at the call
 * site, not by hoping 6 random characters never collide.
 */
export function makeReference(prefix, now = new Date()) {
  return `${prefix}-${now.getFullYear()}-${randomCode(6)}`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** MySQL DATETIME literal in server-local time. */
export function toMysqlDateTime(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + Number(days));
  return d;
}

export function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / 86400000);
}

/**
 * A loan is overdue when it is still active and its due date has passed.
 * Derived rather than stored, so a row can never sit at status "active" while
 * being months overdue because a nightly job failed to run.
 */
export function isOverdue(loan, now = new Date()) {
  if (!loan || loan.status !== 'active' || !loan.due_at) return false;
  return new Date(loan.due_at).getTime() < now.getTime();
}

/** Escape text for safe interpolation into generated HTML (emails, labels). */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a value for a CSV cell, per RFC 4180. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
