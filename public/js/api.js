/**
 * API client.
 *
 * One place that knows how to talk to the server, so error handling, session
 * expiry and the response envelope are handled once rather than in every view.
 */

const BASE = '/api/v1';

/**
 * An API error carrying the server's structured payload.
 * Views read `.message` for display and `.details.field` to mark the offending
 * input, so a 422 becomes an inline field error rather than a generic toast.
 */
export class ApiError extends Error {
  constructor(status, payload) {
    const message = payload?.error?.message || `Request failed (HTTP ${status}).`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code || 'unknown';
    this.details = payload?.error?.details || null;
    this.payload = payload;
  }

  /** True when this is worth showing against a specific form field. */
  get field() {
    return this.details?.field || null;
  }
}

/** Fired when the server says the session is gone, so the shell can react. */
const SESSION_EXPIRED = new EventTarget();

export function onSessionExpired(handler) {
  SESSION_EXPIRED.addEventListener('expired', handler);
}

async function request(method, path, { body = null, query = null, signal = null, raw = false } = {}) {
  // Paths are given relative to the versioned API root, with or without a
  // leading slash. Only a fully-qualified URL bypasses the prefix.
  const url0 = path.startsWith('http://') || path.startsWith('https://')
    ? path
    : `${BASE}/${path.replace(/^\/+/, '')}`;
  let url = url0;

  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;
  }

  const options = {
    method,
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal,
  };

  if (body !== null) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // A network-level failure is not a server error, and saying "server error"
    // sends people to the wrong place — most often this is simply offline.
    throw new ApiError(0, {
      error: {
        code: 'network_error',
        message: 'Could not reach the server. Check your connection and try again.',
      },
    });
  }

  if (response.status === 204) return null;
  if (raw) return response;

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : null;

  if (!response.ok) {
    if (response.status === 401 && !path.includes('/auth/')) {
      SESSION_EXPIRED.dispatchEvent(new CustomEvent('expired'));
    }
    throw new ApiError(response.status, payload);
  }

  return payload;
}

export const api = {
  get:    (path, opts) => request('GET', path, opts),
  post:   (path, body, opts) => request('POST', path, { ...opts, body }),
  patch:  (path, body, opts) => request('PATCH', path, { ...opts, body }),
  delete: (path, opts) => request('DELETE', path, opts),

  // --- Auth ---------------------------------------------------------------
  login: (email, password) => request('POST', '/auth/login', { body: { email, password } }),
  logout: () => request('POST', '/auth/logout'),
  ssoStatus: () => request('GET', '/auth/sso/status'),
  me: () => request('GET', '/auth/me'),
  changePassword: (body) => request('POST', '/auth/change-password', { body }),
  verifySecondFactor: (pendingId, code) =>
    request('POST', '/auth/login/verify', { body: { pending_id: pendingId, code } }),

  // --- Two-factor, for your own account ------------------------------------
  twoFactor: () => request('GET', '/auth/2fa'),
  beginTwoFactor: () => request('POST', '/auth/2fa/begin', { body: {} }),
  confirmTwoFactor: (code) => request('POST', '/auth/2fa/confirm', { body: { code } }),
  disableTwoFactor: (password) => request('POST', '/auth/2fa/disable', { body: { password } }),
  regenerateRecoveryCodes: (password) =>
    request('POST', '/auth/2fa/recovery-codes', { body: { password } }),

  // --- Outcomes -------------------------------------------------------------
  outcomeMeta: () => request('GET', '/outcomes/meta'),
  outstandingOutcomes: (query) => request('GET', '/outcomes/outstanding', { query }),
  recordOutcome: (loanId, body) => request('POST', `/loans/${loanId}/outcome`, { body }),
  outcomesReport: (query) => request('GET', '/reports/outcomes', { query }),
  clientOutcomes: (clientId) => request('GET', `/clients/${clientId}/outcomes`),

  // --- Client import --------------------------------------------------------
  clientImportPreview: (body) => request('POST', '/clients/import/preview', { body }),
  importClients: (body) => request('POST', '/clients/import', { body }),

  // --- Hygiene --------------------------------------------------------------
  cleaningQueue: () => request('GET', '/hygiene/queue'),
  recordCleaning: (deviceId, body) => request('POST', `/devices/${deviceId}/cleaned`, { body }),
  cleaningHistory: (deviceId) => request('GET', `/devices/${deviceId}/cleaning`),
  hygieneReport: (query) => request('GET', '/reports/hygiene', { query }),

  // --- Disposal -------------------------------------------------------------
  disposeDevice: (deviceId, body) => request('POST', `/devices/${deviceId}/dispose`, { body }),
  disposalReport: (query) => request('GET', '/reports/disposals', { query }),

  // --- Sites and transfers --------------------------------------------------
  sites: (query) => request('GET', '/sites', { query }),
  createSite: (body) => request('POST', '/sites', { body }),
  updateSite: (id, body) => request('PATCH', `/sites/${id}`, { body }),
  transfers: (query) => request('GET', '/transfers', { query }),
  sendTransfer: (body) => request('POST', '/transfers', { body }),
  receiveTransfer: (id, body) => request('POST', `/transfers/${id}/receive`, { body }),
  cancelTransfer: (id, body) => request('POST', `/transfers/${id}/cancel`, { body }),

  // --- Shipping -------------------------------------------------------------
  updateShipping: (loanId, body) => request('PATCH', `/loans/${loanId}/shipping`, { body }),

  // --- Backups and retention ------------------------------------------------
  backupSummary: () => request('GET', '/admin/backup'),
  retentionPreview: () => request('GET', '/admin/retention'),
  purgeRetention: (password) => request('POST', '/admin/retention/purge', { body: { password } }),

  // --- Devices ------------------------------------------------------------
  devices: (query) => request('GET', '/devices', { query }),
  device: (id) => request('GET', `/devices/${id}`),
  deviceFacets: () => request('GET', '/devices/facets'),
  createDevice: (body) => request('POST', '/devices', { body }),
  updateDevice: (id, body) => request('PATCH', `/devices/${id}`, { body }),
  deleteDevice: (id) => request('DELETE', `/devices/${id}`),
  lookupDevice: (code) => request('GET', `/devices/lookup/${encodeURIComponent(code)}`),
  reassignBarcode: (id) => request('POST', `/devices/${id}/reassign-barcode`),
  importPreview: (body) => request('POST', '/devices/import/preview', { body }),
  importDevices: (body) => request('POST', '/devices/import', { body }),
  importHistory: () => request('GET', '/devices/import/history'),

  // --- Loans --------------------------------------------------------------
  loans: (query) => request('GET', '/loans', { query }),
  loan: (id) => request('GET', `/loans/${id}`),
  loanPeriods: () => request('GET', '/loans/periods'),
  checkOut: (body) => request('POST', '/loans/checkout', { body }),
  checkIn: (body) => request('POST', '/loans/checkin', { body }),
  extendLoan: (id, body) => request('POST', `/loans/${id}/extend`, { body }),
  reduceLoan: (id, body) => request('POST', `/loans/${id}/reduce`, { body }),
  cancelLoan: (id, body) => request('POST', `/loans/${id}/cancel`, { body }),
  transferLoan: (id, body) => request('POST', `/loans/${id}/transfer`, { body }),

  // --- Requests -----------------------------------------------------------
  requests: (query) => request('GET', '/requests', { query }),
  requestItem: (id) => request('GET', `/requests/${id}`),
  requestMeta: () => request('GET', '/requests/meta'),
  createRequest: (body) => request('POST', '/requests', { body }),
  approveRequest: (id, body) => request('POST', `/requests/${id}/approve`, { body }),
  denyRequest: (id, body) => request('POST', `/requests/${id}/deny`, { body }),
  setFulfillment: (id, body) => request('POST', `/requests/${id}/fulfillment`, { body }),
  fulfilRequest: (id, body) => request('POST', `/requests/${id}/fulfil`, { body }),
  cancelRequest: (id, body) => request('POST', `/requests/${id}/cancel`, { body }),

  // --- Directory ----------------------------------------------------------
  clients: (query) => request('GET', '/clients', { query }),
  client: (id) => request('GET', `/clients/${id}`),
  createClient: (body) => request('POST', '/clients', { body }),
  updateClient: (id, body) => request('PATCH', `/clients/${id}`, { body }),
  programs: (query) => request('GET', '/programs', { query }),
  createProgram: (body) => request('POST', '/programs', { body }),
  updateProgram: (id, body) => request('PATCH', `/programs/${id}`, { body }),
  users: (query) => request('GET', '/users', { query }),
  createUser: (body) => request('POST', '/users', { body }),
  updateUser: (id, body) => request('PATCH', `/users/${id}`, { body }),
  resetUserPassword: (id, body) => request('POST', `/users/${id}/reset-password`, { body }),

  // --- Admin --------------------------------------------------------------
  organization: () => request('GET', '/admin/organization'),
  updateOrganization: (body) => request('PATCH', '/admin/organization', { body }),
  adminLoanPeriods: () => request('GET', '/admin/loan-periods'),
  createLoanPeriod: (body) => request('POST', '/admin/loan-periods', { body }),
  updateLoanPeriod: (id, body) => request('PATCH', `/admin/loan-periods/${id}`, { body }),
  deleteLoanPeriod: (id) => request('DELETE', `/admin/loan-periods/${id}`),
  settings: () => request('GET', '/admin/settings'),
  updateSettings: (settings) => request('PATCH', '/admin/settings', { body: { settings } }),
  testEmail: (recipient) => request('POST', '/admin/settings/test-email', { body: { recipient } }),
  emailLog: () => request('GET', '/admin/settings/email-log'),
  updates: () => request('GET', '/admin/updates'),
  checkUpdates: () => request('POST', '/admin/updates/check'),
  applyUpdate: (password) => request('POST', '/admin/updates/apply', { body: { password } }),
  apiKeys: () => request('GET', '/admin/api-keys'),
  createApiKey: (body) => request('POST', '/admin/api-keys', { body }),
  revokeApiKey: (id) => request('DELETE', `/admin/api-keys/${id}`),

  // --- Scanning -----------------------------------------------------------
  scanLookup: (barcode) => request('POST', '/scan/lookup', { body: { barcode } }),
  createScanChannel: (body) => request('POST', '/scan/channels', { body }),
  scanChannel: (id) => request('GET', `/scan/channels/${id}`),
  closeScanChannel: (id) => request('DELETE', `/scan/channels/${id}`),
  joinScanChannel: (code) => request('GET', `/scan/join/${encodeURIComponent(code)}`),
  pushScan: (code, body) => request('POST', `/scan/join/${encodeURIComponent(code)}`, { body }),

  // --- Kits and accessories -----------------------------------------------
  kits: (query) => request('GET', '/kits', { query }),
  kit: (id) => request('GET', `/kits/${id}`),
  createKit: (body) => request('POST', '/kits', { body }),
  updateKit: (id, body) => request('PATCH', `/kits/${id}`, { body }),
  deleteKit: (id) => request('DELETE', `/kits/${id}`),
  checkOutKit: (id, body) => request('POST', `/kits/${id}/checkout`, { body }),
  accessories: (deviceId) => request('GET', `/kits/accessories/${deviceId}`),
  setAccessories: (deviceId, accessories) =>
    request('PUT', `/kits/accessories/${deviceId}`, { body: { accessories } }),
  loanGroup: (groupRef) => request('GET', `/groups/${encodeURIComponent(groupRef)}`),
  checkInGroup: (groupRef, body) =>
    request('POST', `/groups/${encodeURIComponent(groupRef)}/checkin`, { body }),

  // --- Reservations --------------------------------------------------------
  reservations: (query) => request('GET', '/reservations', { query }),
  reservation: (id) => request('GET', `/reservations/${id}`),
  createReservation: (body) => request('POST', '/reservations', { body }),
  cancelReservation: (id, body) => request('POST', `/reservations/${id}/cancel`, { body }),
  deviceWaitlist: (deviceId) => request('GET', `/reservations/device/${deviceId}`),

  // --- Repairs -------------------------------------------------------------
  repairs: (query) => request('GET', '/repairs', { query }),
  repair: (id) => request('GET', `/repairs/${id}`),
  repairMeta: () => request('GET', '/repairs/meta'),
  repairSummary: (query) => request('GET', '/repairs/summary', { query }),
  openRepair: (body) => request('POST', '/repairs', { body }),
  updateRepair: (id, body) => request('PATCH', `/repairs/${id}`, { body }),

  // --- Agreements ----------------------------------------------------------
  agreementSettings: () => request('GET', '/agreements/settings'),
  agreementPreview: (loanId) => request('GET', `/agreements/preview/${loanId}`),
  agreement: (loanId) => request('GET', `/agreements/${loanId}`),
  signAgreement: (loanId, body) => request('POST', `/agreements/${loanId}`, { body }),
  missingAgreements: () => request('GET', '/agreements/audit/missing'),

  // --- Attachments ---------------------------------------------------------
  attachPhotos: (loanId, phase, images) =>
    request('POST', `/attachments/loan/${loanId}`, { body: { phase, images } }),
  loanAttachments: (loanId) => request('GET', `/attachments/loan/${loanId}/list`),
  attachRepairPhotos: (repairId, images) =>
    request('POST', `/attachments/repair/${repairId}`, { body: { images } }),
  deleteAttachment: (id) => request('DELETE', `/attachments/${id}`),
  storageUsage: () => request('GET', '/attachments/usage/summary'),

  // --- Bulk ----------------------------------------------------------------
  bulkCheckIn: (body) => request('POST', '/bulk/checkin', { body }),
  bulkDeviceStatus: (body) => request('POST', '/bulk/device-status', { body }),

  // --- Jobs ----------------------------------------------------------------
  jobs: () => request('GET', '/jobs'),
  runJobs: () => request('POST', '/jobs/run'),
  cronCommand: () => request('GET', '/jobs/cron-command'),

  // --- Password reset ------------------------------------------------------
  forgotPassword: (email) => request('POST', '/auth/forgot-password', { body: { email } }),
  resetPassword: (body) => request('POST', '/auth/reset-password', { body }),

  // --- Insights -----------------------------------------------------------
  audit: (query) => request('GET', '/audit', { query }),
  auditActions: () => request('GET', '/audit/actions'),
  summary: () => request('GET', '/reports/summary'),
  report: (query) => request('GET', '/reports', { query }),
  deviceUtilisation: (query) => request('GET', '/reports/devices', { query }),
  categoryDemand: (query) => request('GET', '/reports/categories', { query }),
  holderActivity: (holder, query) => request('GET', `/reports/activity/${holder}`, { query }),
  loanTrend: (query) => request('GET', '/reports/trend', { query }),
  idleDevices: (query) => request('GET', '/reports/idle', { query }),
  fundingReport: (query) => request('GET', '/reports/funding', { query }),
};

/**
 * Every row of a list, not just its first page.
 *
 * For the pickers in dialogs: "choose a client", "choose a device". The
 * server will not return more than 200 rows at a time however many are asked
 * for, so a picker that asked once showed the first 200 clients in
 * alphabetical order and gave no sign that anybody was missing. Somebody
 * called Young or Zhang could not be lent anything from those dialogs.
 *
 * Stops at 25 pages (5,000 rows) so a very large list cannot hang a dialog;
 * `meta.truncated` says when that happened.
 *
 * @param {(query: object) => Promise<{data: any[], meta?: object}>} fetchPage
 */
export async function allPages(fetchPage, query = {}, { maxPages = 25 } = {}) {
  const rows = [];
  let meta = {};

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage({ ...query, per_page: 200, page });
    const batch = result.data || [];

    rows.push(...batch);
    meta = result.meta || {};

    if (batch.length === 0 || page >= (meta.total_pages || 1)) break;
  }

  const total = meta.total ?? rows.length;

  return { data: rows, meta: { ...meta, total, truncated: rows.length < total } };
}

/** Build an absolute download URL with query parameters. */
export function downloadUrl(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return `${BASE}${path}${qs ? `?${qs}` : ''}`;
}
