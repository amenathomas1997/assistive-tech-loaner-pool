/**
 * Usage reporting.
 *
 * Everything here answers a question someone actually asks about a loaner
 * pool: what gets borrowed, what never moves, who has things out, what comes
 * back late, and whether there is enough of a given category to meet demand.
 *
 * Cancelled loans are excluded from utilisation figures throughout — a loan
 * cancelled because the wrong barcode was scanned is not a use of the device,
 * and counting it inflates exactly the numbers used to justify purchases.
 */

import { query, queryOne } from '../db.js';
import { toMysqlDateTime } from './util.js';

/** Headline counts for the dashboard. */
export async function getDashboardSummary(organizationId) {
  const [devices, loans, requests, overdue, dueSoon] = await Promise.all([
    queryOne(
      `SELECT
         COUNT(*) AS total,
         SUM(status = 'available') AS available,
         SUM(status = 'checked_out') AS checked_out,
         SUM(status = 'reserved') AS reserved,
         SUM(status = 'maintenance') AS maintenance,
         SUM(status = 'retired') AS retired,
         SUM(status = 'lost') AS lost
       FROM devices WHERE organization_id = ?`,
      [organizationId],
    ),
    queryOne(
      `SELECT
         SUM(status = 'active') AS active,
         SUM(status = 'returned') AS returned,
         SUM(status = 'cancelled') AS cancelled,
         COUNT(*) AS total
       FROM loans WHERE organization_id = ?`,
      [organizationId],
    ),
    queryOne(
      `SELECT
         SUM(status = 'submitted') AS awaiting_review,
         SUM(status = 'approved') AS approved,
         SUM(status = 'approved' AND fulfillment_state = 'provisioning') AS provisioning,
         SUM(status = 'approved' AND fulfillment_state = 'in_transit') AS in_transit,
         SUM(status = 'approved' AND fulfillment_state = 'ready_pickup') AS ready_pickup
       FROM loan_requests WHERE organization_id = ?`,
      [organizationId],
    ),
    queryOne(
      `SELECT COUNT(*) AS n FROM loans
        WHERE organization_id = ? AND status = 'active'
          AND due_at IS NOT NULL AND due_at < NOW()`,
      [organizationId],
    ),
    queryOne(
      `SELECT COUNT(*) AS n FROM loans
        WHERE organization_id = ? AND status = 'active'
          AND due_at IS NOT NULL AND due_at >= NOW()
          AND due_at <= DATE_ADD(NOW(), INTERVAL 7 DAY)`,
      [organizationId],
    ),
  ]);

  const totalDevices = Number(devices?.total ?? 0);
  const checkedOut = Number(devices?.checked_out ?? 0);

  return {
    devices: {
      total: totalDevices,
      available: Number(devices?.available ?? 0),
      checked_out: checkedOut,
      reserved: Number(devices?.reserved ?? 0),
      maintenance: Number(devices?.maintenance ?? 0),
      retired: Number(devices?.retired ?? 0),
      lost: Number(devices?.lost ?? 0),
      // Share of the lendable fleet currently out. Retired and lost devices are
      // excluded from the denominator; including them makes a pool look idle
      // when it is actually fully committed.
      utilisation_percent: lendableUtilisation(devices),
    },
    loans: {
      active: Number(loans?.active ?? 0),
      returned: Number(loans?.returned ?? 0),
      cancelled: Number(loans?.cancelled ?? 0),
      total: Number(loans?.total ?? 0),
      overdue: Number(overdue?.n ?? 0),
      due_within_7_days: Number(dueSoon?.n ?? 0),
    },
    requests: {
      awaiting_review: Number(requests?.awaiting_review ?? 0),
      approved: Number(requests?.approved ?? 0),
      provisioning: Number(requests?.provisioning ?? 0),
      in_transit: Number(requests?.in_transit ?? 0),
      ready_pickup: Number(requests?.ready_pickup ?? 0),
    },
  };
}

function lendableUtilisation(devices) {
  const lendable =
    Number(devices?.available ?? 0) +
    Number(devices?.checked_out ?? 0) +
    Number(devices?.reserved ?? 0) +
    Number(devices?.maintenance ?? 0);
  if (!lendable) return 0;
  return Math.round((Number(devices?.checked_out ?? 0) / lendable) * 1000) / 10;
}

function dateWindow(filters) {
  const clauses = [];
  const params = [];
  if (filters.from) {
    clauses.push('l.checked_out_at >= ?');
    params.push(toMysqlDateTime(filters.from));
  }
  if (filters.to) {
    clauses.push('l.checked_out_at <= ?');
    params.push(toMysqlDateTime(filters.to));
  }
  return { clauses, params };
}

/**
 * Per-device usage frequency.
 *
 * `days_out` uses returned_at for closed loans and NOW() for open ones, so a
 * device that has been out for six months counts as six months of use rather
 * than zero until it comes back.
 */
export async function getDeviceUtilisation(organizationId, filters = {}, { limit = 100, offset = 0, sort = 'loan_count' } = {}) {
  const { clauses, params } = dateWindow(filters);
  const loanWindow = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

  const extraWhere = [];
  const extraParams = [];
  if (filters.category) { extraWhere.push('d.category = ?'); extraParams.push(filters.category); }
  if (filters.programId) { extraWhere.push('d.owner_program_id = ?'); extraParams.push(filters.programId); }
  if (filters.status) { extraWhere.push('d.status = ?'); extraParams.push(filters.status); }

  const sortColumns = {
    loan_count: 'loan_count DESC',
    days_out: 'total_days_out DESC',
    never_used: 'loan_count ASC, d.name ASC',
    last_used: 'last_checked_out_at DESC',
    name: 'd.name ASC',
    overdue: 'overdue_count DESC',
  };
  const orderSql = sortColumns[sort] || sortColumns.loan_count;

  const sql = `
    SELECT d.id, d.name, d.barcode, d.asset_tag, d.category, d.status,
           d.manufacturer, d.model, p.name AS program_name,
           COUNT(l.id) AS loan_count,
           COALESCE(SUM(
             CASE WHEN l.status <> 'cancelled'
                  THEN GREATEST(DATEDIFF(COALESCE(l.returned_at, NOW()), l.checked_out_at), 0)
                  ELSE 0 END
           ), 0) AS total_days_out,
           COALESCE(AVG(
             CASE WHEN l.status = 'returned'
                  THEN GREATEST(DATEDIFF(l.returned_at, l.checked_out_at), 0)
                  ELSE NULL END
           ), 0) AS avg_loan_days,
           MAX(l.checked_out_at) AS last_checked_out_at,
           SUM(l.status = 'returned' AND l.due_at IS NOT NULL AND l.returned_at > l.due_at) AS overdue_count,
           COUNT(DISTINCT l.client_id) AS distinct_clients
      FROM devices d
      LEFT JOIN programs p ON p.id = d.owner_program_id
      LEFT JOIN loans l
        ON l.device_id = d.id AND l.status <> 'cancelled' ${loanWindow}
     WHERE d.organization_id = ? ${extraWhere.length ? `AND ${extraWhere.join(' AND ')}` : ''}
     GROUP BY d.id
     ORDER BY ${orderSql}
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;

  const rows = await query(sql, [...params, organizationId, ...extraParams]);

  const countRow = await queryOne(
    `SELECT COUNT(*) AS total FROM devices d
      WHERE d.organization_id = ? ${extraWhere.length ? `AND ${extraWhere.join(' AND ')}` : ''}`,
    [organizationId, ...extraParams],
  );

  return {
    rows: rows.map((row) => ({
      ...row,
      loan_count: Number(row.loan_count),
      total_days_out: Number(row.total_days_out),
      avg_loan_days: Math.round(Number(row.avg_loan_days) * 10) / 10,
      overdue_count: Number(row.overdue_count ?? 0),
      distinct_clients: Number(row.distinct_clients ?? 0),
      never_loaned: Number(row.loan_count) === 0,
    })),
    total: Number(countRow?.total ?? 0),
  };
}

/** Which categories are in demand, and whether supply meets it. */
export async function getCategoryDemand(organizationId, filters = {}) {
  const { clauses, params } = dateWindow(filters);
  const loanWindow = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

  return query(
    `SELECT COALESCE(d.category, '(uncategorised)') AS category,
            COUNT(DISTINCT d.id) AS device_count,
            SUM(d.status = 'checked_out') AS currently_out,
            SUM(d.status = 'available') AS currently_available,
            COUNT(l.id) AS loan_count,
            COALESCE(AVG(
              CASE WHEN l.status = 'returned'
                   THEN GREATEST(DATEDIFF(l.returned_at, l.checked_out_at), 0) END
            ), 0) AS avg_loan_days
       FROM devices d
       LEFT JOIN loans l ON l.device_id = d.id AND l.status <> 'cancelled' ${loanWindow}
      WHERE d.organization_id = ?
      GROUP BY COALESCE(d.category, '(uncategorised)')
      ORDER BY loan_count DESC`,
    [...params, organizationId],
  ).then((rows) => rows.map((row) => ({
    ...row,
    device_count: Number(row.device_count),
    currently_out: Number(row.currently_out ?? 0),
    currently_available: Number(row.currently_available ?? 0),
    loan_count: Number(row.loan_count),
    avg_loan_days: Math.round(Number(row.avg_loan_days) * 10) / 10,
    // Loans per device: how hard each unit in this category is working.
    turns_per_device: Number(row.device_count)
      ? Math.round((Number(row.loan_count) / Number(row.device_count)) * 100) / 100
      : 0,
  })));
}

/** Loan activity grouped by whoever holds the device. */
export async function getHolderActivity(organizationId, holderType, filters = {}, { limit = 50 } = {}) {
  const { clauses, params } = dateWindow(filters);
  const window = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

  const config = {
    tech: {
      join: 'JOIN users h ON h.id = l.tech_id',
      label: 'h.full_name',
      id: 'h.id',
      extra: 'h.email AS email, h.role AS role',
    },
    client: {
      join: 'JOIN clients h ON h.id = l.client_id',
      label: "CONCAT(h.first_name, ' ', h.last_name)",
      id: 'h.id',
      extra: 'h.email AS email, h.external_ref AS external_ref',
    },
    program: {
      join: 'JOIN programs h ON h.id = l.program_id',
      label: 'h.name',
      id: 'h.id',
      extra: 'h.code AS code',
    },
  }[holderType];

  if (!config) throw new Error(`Unknown holder type "${holderType}".`);

  return query(
    `SELECT ${config.id} AS id, ${config.label} AS name, ${config.extra},
            COUNT(l.id) AS loan_count,
            SUM(l.status = 'active') AS active_count,
            SUM(l.status = 'active' AND l.due_at IS NOT NULL AND l.due_at < NOW()) AS overdue_count,
            SUM(l.status = 'returned' AND l.due_at IS NOT NULL AND l.returned_at > l.due_at) AS returned_late_count,
            COALESCE(AVG(
              CASE WHEN l.status = 'returned'
                   THEN GREATEST(DATEDIFF(l.returned_at, l.checked_out_at), 0) END
            ), 0) AS avg_loan_days,
            MAX(l.checked_out_at) AS last_loan_at
       FROM loans l
       ${config.join}
      WHERE l.organization_id = ? AND l.status <> 'cancelled' ${window}
      GROUP BY ${config.id}
      ORDER BY loan_count DESC
      LIMIT ${Number(limit)}`,
    [organizationId, ...params],
  ).then((rows) => rows.map((row) => ({
    ...row,
    loan_count: Number(row.loan_count),
    active_count: Number(row.active_count ?? 0),
    overdue_count: Number(row.overdue_count ?? 0),
    returned_late_count: Number(row.returned_late_count ?? 0),
    avg_loan_days: Math.round(Number(row.avg_loan_days) * 10) / 10,
  })));
}

/** Loan volume over time, for a trend chart. */
export async function getLoanTrend(organizationId, { months = 12 } = {}) {
  const rows = await query(
    `SELECT DATE_FORMAT(l.checked_out_at, '%Y-%m') AS period,
            COUNT(*) AS checked_out,
            SUM(l.status = 'returned') AS returned,
            SUM(l.status = 'cancelled') AS cancelled,
            SUM(l.status = 'returned' AND l.due_at IS NOT NULL AND l.returned_at > l.due_at) AS returned_late
       FROM loans l
      WHERE l.organization_id = ?
        AND l.checked_out_at >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
      GROUP BY DATE_FORMAT(l.checked_out_at, '%Y-%m')
      ORDER BY period ASC`,
    [organizationId, Number(months)],
  );

  return rows.map((row) => ({
    period: row.period,
    checked_out: Number(row.checked_out),
    returned: Number(row.returned ?? 0),
    cancelled: Number(row.cancelled ?? 0),
    returned_late: Number(row.returned_late ?? 0),
    late_rate_percent: Number(row.returned)
      ? Math.round((Number(row.returned_late) / Number(row.returned)) * 1000) / 10
      : 0,
  }));
}

/** Return-punctuality statistics across completed loans. */
export async function getReturnPerformance(organizationId, filters = {}) {
  const { clauses, params } = dateWindow(filters);
  const window = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

  const row = await queryOne(
    `SELECT
       COUNT(*) AS completed_loans,
       SUM(l.due_at IS NOT NULL AND l.returned_at <= l.due_at) AS on_time,
       SUM(l.due_at IS NOT NULL AND l.returned_at > l.due_at) AS late,
       SUM(l.due_at IS NULL) AS open_ended,
       COALESCE(AVG(GREATEST(DATEDIFF(l.returned_at, l.checked_out_at), 0)), 0) AS avg_loan_days,
       COALESCE(AVG(CASE WHEN l.due_at IS NOT NULL AND l.returned_at > l.due_at
                         THEN DATEDIFF(l.returned_at, l.due_at) END), 0) AS avg_days_late,
       COALESCE(MAX(CASE WHEN l.due_at IS NOT NULL AND l.returned_at > l.due_at
                         THEN DATEDIFF(l.returned_at, l.due_at) END), 0) AS max_days_late
     FROM loans l
     WHERE l.organization_id = ? AND l.status = 'returned' ${window}`,
    [organizationId, ...params],
  );

  const completed = Number(row?.completed_loans ?? 0);
  const late = Number(row?.late ?? 0);
  const withDueDate = Number(row?.on_time ?? 0) + late;

  return {
    completed_loans: completed,
    on_time: Number(row?.on_time ?? 0),
    late,
    open_ended: Number(row?.open_ended ?? 0),
    on_time_rate_percent: withDueDate
      ? Math.round((Number(row?.on_time ?? 0) / withDueDate) * 1000) / 10
      : null,
    avg_loan_days: Math.round(Number(row?.avg_loan_days ?? 0) * 10) / 10,
    avg_days_late: Math.round(Number(row?.avg_days_late ?? 0) * 10) / 10,
    max_days_late: Number(row?.max_days_late ?? 0),
  };
}

/** How long requests take to move through the pipeline. */
export async function getRequestPerformance(organizationId, filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.from) { clauses.push('r.created_at >= ?'); params.push(toMysqlDateTime(filters.from)); }
  if (filters.to) { clauses.push('r.created_at <= ?'); params.push(toMysqlDateTime(filters.to)); }
  const window = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

  const row = await queryOne(
    `SELECT
       COUNT(*) AS total,
       SUM(r.status = 'approved') AS approved,
       SUM(r.status = 'denied') AS denied,
       SUM(r.status = 'fulfilled') AS fulfilled,
       SUM(r.status = 'cancelled') AS cancelled,
       SUM(r.status = 'submitted') AS awaiting_review,
       COALESCE(AVG(CASE WHEN r.reviewed_at IS NOT NULL
                         THEN TIMESTAMPDIFF(HOUR, r.created_at, r.reviewed_at) END), 0) AS avg_hours_to_review,
       COALESCE(AVG(CASE WHEN r.status = 'fulfilled' AND r.loan_id IS NOT NULL
                         THEN TIMESTAMPDIFF(HOUR, r.created_at, r.updated_at) END), 0) AS avg_hours_to_fulfil
     FROM loan_requests r
     WHERE r.organization_id = ? ${window}`,
    [organizationId, ...params],
  );

  return {
    total: Number(row?.total ?? 0),
    approved: Number(row?.approved ?? 0),
    denied: Number(row?.denied ?? 0),
    fulfilled: Number(row?.fulfilled ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
    awaiting_review: Number(row?.awaiting_review ?? 0),
    avg_hours_to_review: Math.round(Number(row?.avg_hours_to_review ?? 0) * 10) / 10,
    avg_hours_to_fulfil: Math.round(Number(row?.avg_hours_to_fulfil ?? 0) * 10) / 10,
  };
}

/**
 * Devices that have never been lent, or not since a cutoff. The list that
 * justifies redeploying or retiring stock.
 */
export async function getIdleDevices(organizationId, { sinceDays = 180, limit = 100 } = {}) {
  return query(
    `SELECT d.id, d.name, d.barcode, d.asset_tag, d.category, d.status, d.location,
            d.purchase_date, d.purchase_cost,
            MAX(l.checked_out_at) AS last_checked_out_at,
            COUNT(l.id) AS loan_count
       FROM devices d
       LEFT JOIN loans l ON l.device_id = d.id AND l.status <> 'cancelled'
      WHERE d.organization_id = ?
        AND d.status NOT IN ('retired', 'lost')
      GROUP BY d.id
     HAVING last_checked_out_at IS NULL
         OR last_checked_out_at < DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY loan_count ASC, last_checked_out_at ASC
      LIMIT ${Number(limit)}`,
    [organizationId, Number(sinceDays)],
  ).then((rows) => rows.map((row) => ({
    ...row,
    loan_count: Number(row.loan_count),
    never_loaned: !row.last_checked_out_at,
    days_since_last_loan: row.last_checked_out_at
      ? Math.floor((Date.now() - new Date(row.last_checked_out_at).getTime()) / 86400000)
      : null,
  })));
}

/** Scan-vs-manual split, to show whether barcode adoption is actually happening. */
export async function getScanAdoption(organizationId, filters = {}) {
  const { clauses, params } = dateWindow(filters);
  const window = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

  const row = await queryOne(
    `SELECT
       SUM(l.checkout_method = 'scan') AS checkout_scan,
       SUM(l.checkout_method = 'manual') AS checkout_manual,
       SUM(l.checkout_method = 'api') AS checkout_api,
       SUM(l.checkout_method = 'request') AS checkout_request,
       SUM(l.checkin_method = 'scan') AS checkin_scan,
       SUM(l.checkin_method = 'manual') AS checkin_manual,
       SUM(l.checkin_method = 'api') AS checkin_api
     FROM loans l
     WHERE l.organization_id = ? ${window}`,
    [organizationId, ...params],
  );

  const n = (value) => Number(value ?? 0);
  const checkoutTotal = n(row?.checkout_scan) + n(row?.checkout_manual) + n(row?.checkout_api) + n(row?.checkout_request);
  const checkinTotal = n(row?.checkin_scan) + n(row?.checkin_manual) + n(row?.checkin_api);

  return {
    checkout: {
      scan: n(row?.checkout_scan),
      manual: n(row?.checkout_manual),
      api: n(row?.checkout_api),
      request: n(row?.checkout_request),
      total: checkoutTotal,
      scan_percent: checkoutTotal ? Math.round((n(row?.checkout_scan) / checkoutTotal) * 1000) / 10 : 0,
    },
    checkin: {
      scan: n(row?.checkin_scan),
      manual: n(row?.checkin_manual),
      api: n(row?.checkin_api),
      total: checkinTotal,
      scan_percent: checkinTotal ? Math.round((n(row?.checkin_scan) / checkinTotal) * 1000) / 10 : 0,
    },
  };
}

/**
 * Utilisation and spend grouped by funding source, then by program.
 *
 * This is the shape funders ask for: what was bought with their money, how
 * hard it worked, how many people it reached, and what is sitting idle. The
 * distinct-client count matters more than the loan count in most grant
 * reporting, so both are given.
 */
export async function getFundingReport(organizationId, filters = {}) {
  const { clauses, params } = dateWindow(filters);
  const loanWindow = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

  // Deliberately two queries rather than one.
  //
  // Joining devices to loans and summing purchase_cost multiplies each
  // device's cost by the number of times it was lent — a device borrowed nine
  // times reports nine times its price, which silently overstates every
  // funding figure. Device-level facts are aggregated over devices, loan-level
  // facts over loans, and the two are merged below.
  const deviceTotals = await query(
    `SELECT COALESCE(NULLIF(d.funding_source, ''), '(unattributed)') AS funding_source,
            COUNT(*) AS device_count,
            COALESCE(SUM(d.purchase_cost), 0) AS total_cost,
            SUM(d.status = 'retired') AS retired_count,
            SUM(d.status = 'lost') AS lost_count
       FROM devices d
      WHERE d.organization_id = ?
      GROUP BY COALESCE(NULLIF(d.funding_source, ''), '(unattributed)')`,
    [organizationId],
  );

  const loanTotals = await query(
    `SELECT COALESCE(NULLIF(d.funding_source, ''), '(unattributed)') AS funding_source,
            COUNT(l.id) AS loan_count,
            COUNT(DISTINCT l.client_id) AS clients_served,
            COALESCE(SUM(
              GREATEST(DATEDIFF(COALESCE(l.returned_at, NOW()), l.checked_out_at), 0)
            ), 0) AS total_days_out
       FROM loans l
       JOIN devices d ON d.id = l.device_id
      WHERE d.organization_id = ? AND l.status <> 'cancelled'
        ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
      GROUP BY COALESCE(NULLIF(d.funding_source, ''), '(unattributed)')`,
    [organizationId, ...params],
  );

  const loansBySource = new Map(loanTotals.map((row) => [row.funding_source, row]));

  const byFunding = deviceTotals.map((row) => ({
    ...row,
    loan_count: loansBySource.get(row.funding_source)?.loan_count ?? 0,
    clients_served: loansBySource.get(row.funding_source)?.clients_served ?? 0,
    total_days_out: loansBySource.get(row.funding_source)?.total_days_out ?? 0,
  })).sort((a, b) => Number(b.total_cost) - Number(a.total_cost) || Number(b.loan_count) - Number(a.loan_count));

  const byProgram = await query(
    `SELECT COALESCE(p.name, '(no program)') AS program,
            COUNT(DISTINCT l.id) AS loan_count,
            COUNT(DISTINCT l.client_id) AS clients_served,
            COUNT(DISTINCT l.device_id) AS devices_used,
            COALESCE(AVG(
              CASE WHEN l.status = 'returned'
                   THEN GREATEST(DATEDIFF(l.returned_at, l.checked_out_at), 0) END
            ), 0) AS avg_loan_days
       FROM loans l
       LEFT JOIN programs p ON p.id = l.program_id
      WHERE l.organization_id = ? AND l.status <> 'cancelled'
        ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}
      GROUP BY COALESCE(p.name, '(no program)')
      ORDER BY loan_count DESC`,
    [organizationId, ...params],
  );

  return {
    by_funding_source: byFunding.map((row) => {
      const devices = Number(row.device_count);
      const loans = Number(row.loan_count);
      const cost = Number(row.total_cost);

      return {
        funding_source: row.funding_source,
        device_count: devices,
        total_cost: Math.round(cost * 100) / 100,
        loan_count: loans,
        clients_served: Number(row.clients_served ?? 0),
        total_days_out: Number(row.total_days_out),
        retired_count: Number(row.retired_count ?? 0),
        lost_count: Number(row.lost_count ?? 0),
        loans_per_device: devices ? Math.round((loans / devices) * 100) / 100 : 0,
        // What each loan effectively cost the funder in capital terms. Useful
        // for "was this worth buying"; meaningless without a purchase cost, so
        // reported as null rather than zero.
        cost_per_loan: cost > 0 && loans > 0 ? Math.round((cost / loans) * 100) / 100 : null,
        cost_per_client: cost > 0 && Number(row.clients_served) > 0
          ? Math.round((cost / Number(row.clients_served)) * 100) / 100
          : null,
      };
    }),
    by_program: byProgram.map((row) => ({
      program: row.program,
      loan_count: Number(row.loan_count),
      clients_served: Number(row.clients_served ?? 0),
      devices_used: Number(row.devices_used ?? 0),
      avg_loan_days: Math.round(Number(row.avg_loan_days) * 10) / 10,
    })),
    generated_at: new Date().toISOString(),
    filters,
  };
}

/** Everything the reports screen needs, in one round trip. */
export async function getFullReport(organizationId, filters = {}) {
  const [
    summary, categories, techActivity, clientActivity, programActivity,
    trend, returnPerformance, requestPerformance, idle, scanAdoption,
  ] = await Promise.all([
    getDashboardSummary(organizationId),
    getCategoryDemand(organizationId, filters),
    getHolderActivity(organizationId, 'tech', filters, { limit: 25 }),
    getHolderActivity(organizationId, 'client', filters, { limit: 25 }),
    getHolderActivity(organizationId, 'program', filters, { limit: 25 }),
    getLoanTrend(organizationId, { months: 12 }),
    getReturnPerformance(organizationId, filters),
    getRequestPerformance(organizationId, filters),
    getIdleDevices(organizationId, { sinceDays: Number(filters.idleDays) || 180, limit: 50 }),
    getScanAdoption(organizationId, filters),
  ]);

  return {
    summary,
    categories,
    activity: { techs: techActivity, clients: clientActivity, programs: programActivity },
    trend,
    return_performance: returnPerformance,
    request_performance: requestPerformance,
    idle_devices: idle,
    scan_adoption: scanAdoption,
    generated_at: new Date().toISOString(),
    filters,
  };
}
