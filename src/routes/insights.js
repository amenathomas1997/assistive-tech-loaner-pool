/**
 * Audit log and usage reporting.
 */

import express from 'express';
import {
  asyncRoute, pagination, paged, str, int, toCsv, badRequest,
} from '../lib/util.js';
import { requireCapability } from '../lib/auth.js';
import { searchAudit, AUDIT_ACTIONS } from '../lib/audit.js';
import {
  getDashboardSummary, getDeviceUtilisation, getCategoryDemand, getHolderActivity,
  getLoanTrend, getReturnPerformance, getRequestPerformance, getIdleDevices,
  getScanAdoption, getFullReport, getFundingReport,
} from '../lib/reports.js';

// ===========================================================================
// Audit
// ===========================================================================

export const auditRouter = express.Router();

auditRouter.get('/', requireCapability('audit.read'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pagination(req.query);

  const { rows, total } = await searchAudit(
    req.auth.organizationId,
    {
      action: str(req.query.action),
      actionPrefix: str(req.query.action_prefix),
      actorId: int(req.query.actor_id, 'actor_id'),
      entityType: str(req.query.entity_type),
      entityId: int(req.query.entity_id, 'entity_id'),
      from: str(req.query.from),
      to: str(req.query.to),
      search: str(req.query.search) || str(req.query.q),
    },
    { limit: perPage, offset },
  );

  res.json(paged(rows, total, { page, perPage }));
}));

/** The action vocabulary, so the UI's filter can be built from the server. */
auditRouter.get('/actions', requireCapability('audit.read'), asyncRoute(async (req, res) => {
  res.json({
    data: Object.entries(AUDIT_ACTIONS).map(([key, value]) => ({
      key,
      action: value,
      group: value.split('.')[0],
    })),
  });
}));

auditRouter.get('/export.csv', requireCapability('audit.read'), asyncRoute(async (req, res) => {
  const { rows } = await searchAudit(
    req.auth.organizationId,
    {
      action: str(req.query.action),
      actionPrefix: str(req.query.action_prefix),
      from: str(req.query.from),
      to: str(req.query.to),
      search: str(req.query.search),
    },
    { limit: 50000, offset: 0 },
  );

  const csv = toCsv(
    ['timestamp', 'actor', 'actor_type', 'action', 'entity_type', 'entity_id', 'entity', 'summary', 'ip'],
    rows.map((r) => [
      r.created_at, r.actor_name || r.actor_label, r.actor_type, r.action,
      r.entity_type, r.entity_id, r.entity_label, r.summary, r.ip,
    ]),
  );

  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// ===========================================================================
// Reports
// ===========================================================================

export const reportsRouter = express.Router();

function readFilters(query) {
  return {
    from: str(query.from),
    to: str(query.to),
    category: str(query.category),
    programId: int(query.program_id, 'program_id'),
    status: str(query.status),
    idleDays: int(query.idle_days, 'idle_days', { min: 1, max: 3650 }),
  };
}

/** Dashboard headline numbers. */
reportsRouter.get('/summary', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  res.json(await getDashboardSummary(req.auth.organizationId));
}));

/** Everything the reports screen needs in one request. */
reportsRouter.get('/', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  res.json(await getFullReport(req.auth.organizationId, readFilters(req.query)));
}));

/** Per-device usage frequency — the "what actually gets borrowed" report. */
reportsRouter.get('/devices', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pagination(req.query);
  const { rows, total } = await getDeviceUtilisation(
    req.auth.organizationId,
    readFilters(req.query),
    { limit: perPage, offset, sort: str(req.query.sort) || 'loan_count' },
  );
  res.json(paged(rows, total, { page, perPage }));
}));

reportsRouter.get('/categories', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  res.json({ data: await getCategoryDemand(req.auth.organizationId, readFilters(req.query)) });
}));

reportsRouter.get('/activity/:holder', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  const holder = req.params.holder;
  if (!['tech', 'client', 'program'].includes(holder)) {
    throw badRequest('Holder type must be one of: tech, client, program.', {
      allowed: ['tech', 'client', 'program'],
    });
  }
  res.json({
    data: await getHolderActivity(req.auth.organizationId, holder, readFilters(req.query), {
      limit: int(req.query.limit, 'limit', { min: 1, max: 500 }) ?? 50,
    }),
  });
}));

reportsRouter.get('/trend', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  res.json({
    data: await getLoanTrend(req.auth.organizationId, {
      months: int(req.query.months, 'months', { min: 1, max: 60 }) ?? 12,
    }),
  });
}));

reportsRouter.get('/returns', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  res.json(await getReturnPerformance(req.auth.organizationId, readFilters(req.query)));
}));

reportsRouter.get('/requests', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  res.json(await getRequestPerformance(req.auth.organizationId, readFilters(req.query)));
}));

/** Devices nobody has borrowed — the list that justifies redeploying stock. */
reportsRouter.get('/idle', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  res.json({
    data: await getIdleDevices(req.auth.organizationId, {
      sinceDays: int(req.query.since_days, 'since_days', { min: 1, max: 3650 }) ?? 180,
      limit: int(req.query.limit, 'limit', { min: 1, max: 1000 }) ?? 100,
    }),
  });
}));

/** Scan vs manual split — whether barcode adoption is actually happening. */
reportsRouter.get('/scan-adoption', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  res.json(await getScanAdoption(req.auth.organizationId, readFilters(req.query)));
}));

/** Utilisation and spend by funding source — the shape funders ask for. */
reportsRouter.get('/funding', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  res.json(await getFundingReport(req.auth.organizationId, readFilters(req.query)));
}));

reportsRouter.get('/funding.csv', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  const report = await getFundingReport(req.auth.organizationId, readFilters(req.query));

  const csv = toCsv(
    ['funding_source', 'devices', 'total_cost', 'loans', 'clients_served', 'days_out',
     'loans_per_device', 'cost_per_loan', 'cost_per_client', 'retired', 'lost'],
    report.by_funding_source.map((r) => [
      r.funding_source, r.device_count, r.total_cost, r.loan_count, r.clients_served,
      r.total_days_out, r.loans_per_device, r.cost_per_loan, r.cost_per_client,
      r.retired_count, r.lost_count,
    ]),
  );

  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="funding-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

reportsRouter.get('/devices.csv', requireCapability('reports.read'), asyncRoute(async (req, res) => {
  const { rows } = await getDeviceUtilisation(
    req.auth.organizationId,
    readFilters(req.query),
    { limit: 100000, offset: 0, sort: str(req.query.sort) || 'loan_count' },
  );

  const csv = toCsv(
    ['barcode', 'asset_tag', 'name', 'category', 'status', 'program', 'loan_count',
     'total_days_out', 'avg_loan_days', 'distinct_clients', 'returned_late', 'last_checked_out_at'],
    rows.map((r) => [
      r.barcode, r.asset_tag, r.name, r.category, r.status, r.program_name, r.loan_count,
      r.total_days_out, r.avg_loan_days, r.distinct_clients, r.overdue_count, r.last_checked_out_at,
    ]),
  );

  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="device-utilisation-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

export default { auditRouter, reportsRouter };
