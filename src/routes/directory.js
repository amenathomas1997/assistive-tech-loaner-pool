/**
 * People and programs: clients, programs, and staff accounts.
 *
 * Mounted as three separate routers from one module because they share the
 * same shape — list, read, create, update — and splitting them across three
 * files would triple the boilerplate without clarifying anything.
 */

import express from 'express';
import { query, queryOne, execute } from '../db.js';
import {
  asyncRoute, pagination, paged, str, requiredStr, int, bool, oneOf,
  email as parseEmail, notFound, badRequest, conflict, forbidden,
} from '../lib/util.js';
import {
  requireCapability, isRestrictedToOwnRecords, hashPassword, validatePassword,
  ROLES, ROLE_LABELS, destroyAllSessionsForUser,
} from '../lib/auth.js';
import { auditContextFromRequest, recordAudit, AUDIT_ACTIONS, diffRecords } from '../lib/audit.js';
import { publicUser } from './auth.js';

// ===========================================================================
// Clients
// ===========================================================================

export const clientsRouter = express.Router();

clientsRouter.get('/', requireCapability('clients.read'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pagination(req.query);

  const where = ['c.organization_id = ?'];
  const params = [req.auth.organizationId];

  // Counselors see their own caseload by default. They may look up any client
  // by exact reference (to avoid duplicate records) but cannot browse the list.
  if (isRestrictedToOwnRecords(req.auth) && !str(req.query.external_ref)) {
    where.push('c.counselor_id = ?');
    params.push(req.auth.userId);
  }

  if (!bool(req.query.include_inactive)) where.push('c.active = 1');
  if (str(req.query.external_ref)) {
    where.push('c.external_ref = ?');
    params.push(str(req.query.external_ref));
  }
  if (int(req.query.counselor_id, 'counselor_id')) {
    where.push('c.counselor_id = ?');
    params.push(int(req.query.counselor_id, 'counselor_id'));
  }
  if (int(req.query.program_id, 'program_id')) {
    where.push('c.program_id = ?');
    params.push(int(req.query.program_id, 'program_id'));
  }

  const search = str(req.query.search) || str(req.query.q);
  if (search) {
    where.push(
      "(CONCAT(c.first_name, ' ', c.last_name) LIKE ? OR c.email LIKE ? " +
      'OR c.external_ref LIKE ? OR c.phone LIKE ?)',
    );
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const whereSql = where.join(' AND ');

  const rows = await query(
    `SELECT c.*, u.full_name AS counselor_name, p.name AS program_name,
            (SELECT COUNT(*) FROM loans l WHERE l.client_id = c.id AND l.status = 'active') AS active_loan_count,
            (SELECT COUNT(*) FROM loans l WHERE l.client_id = c.id
              AND l.status = 'active' AND l.due_at IS NOT NULL AND l.due_at < NOW()) AS overdue_loan_count
       FROM clients c
       LEFT JOIN users u ON u.id = c.counselor_id
       LEFT JOIN programs p ON p.id = c.program_id
      WHERE ${whereSql}
      ORDER BY c.last_name ASC, c.first_name ASC
      LIMIT ${perPage} OFFSET ${offset}`,
    params,
  );

  const countRow = await queryOne(`SELECT COUNT(*) AS total FROM clients c WHERE ${whereSql}`, params);

  res.json(paged(rows.map(decorateClient), Number(countRow?.total ?? 0), { page, perPage }));
}));

clientsRouter.get('/:id', requireCapability('clients.read'), asyncRoute(async (req, res) => {
  const client = await loadClient(req, Number(req.params.id));

  const loans = await query(
    `SELECT l.id, l.reference, l.status, l.checked_out_at, l.due_at, l.returned_at,
            d.name AS device_name, d.barcode AS device_barcode
       FROM loans l JOIN devices d ON d.id = l.device_id
      WHERE l.client_id = ? ORDER BY l.checked_out_at DESC LIMIT 100`,
    [client.id],
  );

  res.json({ client, loans });
}));

clientsRouter.post('/', requireCapability('clients.write'), asyncRoute(async (req, res) => {
  const data = readClientBody(req.body, true);

  // A counselor creating a client is implicitly that client's counselor.
  if (isRestrictedToOwnRecords(req.auth) && !data.counselor_id) {
    data.counselor_id = req.auth.userId;
  }

  let result;
  try {
    result = await execute(
      `INSERT INTO clients (organization_id, external_ref, first_name, last_name, email, phone,
                            counselor_id, program_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.auth.organizationId, data.external_ref, data.first_name, data.last_name,
        data.email, data.phone, data.counselor_id, data.program_id, data.notes,
      ],
    );
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      throw conflict('A client with that reference already exists.', { field: 'external_ref' });
    }
    throw err;
  }

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.CLIENT_CREATED,
    entityType: 'client',
    entityId: result.insertId,
    entityLabel: `${data.first_name} ${data.last_name}`,
    summary: `Added client ${data.first_name} ${data.last_name}`,
  });

  res.status(201).json({ client: await fetchClient(req.auth.organizationId, result.insertId) });
}));

clientsRouter.patch('/:id', requireCapability('clients.write'), asyncRoute(async (req, res) => {
  const before = await loadClient(req, Number(req.params.id));
  const data = readClientBody(req.body, false);

  const fields = Object.keys(data).filter((key) => key in (req.body ?? {}));
  if (!fields.length) throw badRequest('No changes were supplied.');

  await execute(
    `UPDATE clients SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW()
      WHERE id = ? AND organization_id = ?`,
    [...fields.map((f) => data[f]), before.id, req.auth.organizationId],
  );

  const after = await fetchClient(req.auth.organizationId, before.id);

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.CLIENT_UPDATED,
    entityType: 'client',
    entityId: before.id,
    entityLabel: `${after.first_name} ${after.last_name}`,
    summary: `Updated client ${after.first_name} ${after.last_name}: ${fields.join(', ')}`,
    detail: { changes: diffRecords(before, after, fields) },
  });

  res.json({ client: after });
}));

async function loadClient(req, clientId) {
  const client = await fetchClient(req.auth.organizationId, clientId);
  if (!client) throw notFound('That client does not exist.');
  if (isRestrictedToOwnRecords(req.auth) && client.counselor_id !== req.auth.userId) {
    throw forbidden('You can only view clients on your own caseload.');
  }
  return client;
}

async function fetchClient(organizationId, clientId) {
  const row = await queryOne(
    `SELECT c.*, u.full_name AS counselor_name, p.name AS program_name,
            (SELECT COUNT(*) FROM loans l WHERE l.client_id = c.id AND l.status = 'active') AS active_loan_count,
            (SELECT COUNT(*) FROM loans l WHERE l.client_id = c.id
              AND l.status = 'active' AND l.due_at IS NOT NULL AND l.due_at < NOW()) AS overdue_loan_count
       FROM clients c
       LEFT JOIN users u ON u.id = c.counselor_id
       LEFT JOIN programs p ON p.id = c.program_id
      WHERE c.id = ? AND c.organization_id = ?`,
    [clientId, organizationId],
  );
  return row ? decorateClient(row) : null;
}

function decorateClient(row) {
  return {
    ...row,
    full_name: `${row.first_name} ${row.last_name}`,
    active_loan_count: Number(row.active_loan_count ?? 0),
    overdue_loan_count: Number(row.overdue_loan_count ?? 0),
  };
}

function readClientBody(body, isCreate) {
  const data = {
    external_ref: str(body?.external_ref, { max: 64 }),
    first_name: isCreate
      ? requiredStr(body?.first_name, 'First name', { max: 120 })
      : str(body?.first_name, { max: 120 }),
    last_name: isCreate
      ? requiredStr(body?.last_name, 'Last name', { max: 120 })
      : str(body?.last_name, { max: 120 }),
    email: parseEmail(body?.email, 'Email address'),
    phone: str(body?.phone, { max: 40 }),
    counselor_id: int(body?.counselor_id, 'counselor_id'),
    program_id: int(body?.program_id, 'program_id'),
    notes: str(body?.notes),
  };
  if (!isCreate) data.active = body?.active === undefined ? undefined : (bool(body.active) ? 1 : 0);
  return data;
}

// ===========================================================================
// Programs
// ===========================================================================

export const programsRouter = express.Router();

programsRouter.get('/', requireCapability('programs.read'), asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM devices d WHERE d.owner_program_id = p.id) AS device_count,
            (SELECT COUNT(*) FROM loans l WHERE l.program_id = p.id AND l.status = 'active') AS active_loan_count,
            (SELECT COUNT(*) FROM loans l WHERE l.program_id = p.id) AS total_loan_count
       FROM programs p
      WHERE p.organization_id = ? ${bool(req.query.include_inactive) ? '' : 'AND p.active = 1'}
      ORDER BY p.name ASC`,
    [req.auth.organizationId],
  );

  res.json({
    data: rows.map((row) => ({
      ...row,
      device_count: Number(row.device_count),
      active_loan_count: Number(row.active_loan_count),
      total_loan_count: Number(row.total_loan_count),
    })),
  });
}));

programsRouter.post('/', requireCapability('programs.write'), asyncRoute(async (req, res) => {
  const data = readProgramBody(req.body, true);

  let result;
  try {
    result = await execute(
      `INSERT INTO programs (organization_id, name, code, description, contact_email, default_loan_days)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.auth.organizationId, data.name, data.code, data.description, data.contact_email, data.default_loan_days],
    );
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      throw conflict('A program with that code already exists.', { field: 'code' });
    }
    throw err;
  }

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.PROGRAM_CREATED,
    entityType: 'program',
    entityId: result.insertId,
    entityLabel: data.name,
    summary: `Added program "${data.name}"`,
  });

  res.status(201).json({
    program: await queryOne('SELECT * FROM programs WHERE id = ?', [result.insertId]),
  });
}));

programsRouter.patch('/:id', requireCapability('programs.write'), asyncRoute(async (req, res) => {
  const before = await queryOne(
    'SELECT * FROM programs WHERE id = ? AND organization_id = ?',
    [Number(req.params.id), req.auth.organizationId],
  );
  if (!before) throw notFound('That program does not exist.');

  const data = readProgramBody(req.body, false);
  const fields = Object.keys(data).filter((key) => key in (req.body ?? {}));
  if (!fields.length) throw badRequest('No changes were supplied.');

  await execute(
    `UPDATE programs SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND organization_id = ?`,
    [...fields.map((f) => data[f]), before.id, req.auth.organizationId],
  );

  const after = await queryOne('SELECT * FROM programs WHERE id = ?', [before.id]);

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.PROGRAM_UPDATED,
    entityType: 'program',
    entityId: before.id,
    entityLabel: after.name,
    summary: `Updated program "${after.name}": ${fields.join(', ')}`,
    detail: { changes: diffRecords(before, after, fields) },
  });

  res.json({ program: after });
}));

function readProgramBody(body, isCreate) {
  const data = {
    name: isCreate ? requiredStr(body?.name, 'Program name', { max: 190 }) : str(body?.name, { max: 190 }),
    code: str(body?.code, { max: 40 }),
    description: str(body?.description),
    contact_email: parseEmail(body?.contact_email, 'Contact email'),
    default_loan_days: int(body?.default_loan_days, 'default_loan_days', { min: 0, max: 3650 }),
  };
  if (!isCreate) data.active = body?.active === undefined ? undefined : (bool(body.active) ? 1 : 0);
  return data;
}

// ===========================================================================
// Users (technicians, counselors, administrators)
// ===========================================================================

export const usersRouter = express.Router();

usersRouter.get('/', requireCapability('users.read'), asyncRoute(async (req, res) => {
  const where = ['organization_id = ?'];
  const params = [req.auth.organizationId];

  if (!bool(req.query.include_inactive)) where.push('active = 1');
  if (str(req.query.role)) {
    where.push('role = ?');
    params.push(oneOf(req.query.role, ROLES, 'role'));
  }

  const rows = await query(
    `SELECT id, organization_id, email, full_name, role, phone, employee_ref, active,
            last_login_at, created_at,
            (SELECT COUNT(*) FROM loans l WHERE l.tech_id = users.id AND l.status = 'active') AS active_loan_count
       FROM users WHERE ${where.join(' AND ')}
      ORDER BY full_name ASC`,
    params,
  );

  res.json({
    data: rows.map((row) => ({
      ...publicUser(row),
      active_loan_count: Number(row.active_loan_count ?? 0),
    })),
  });
}));

usersRouter.post('/', requireCapability('users.write'), asyncRoute(async (req, res) => {
  const email = parseEmail(req.body?.email, 'Email address', { required: true });
  const fullName = requiredStr(req.body?.full_name, 'Full name', { max: 190 });
  const role = oneOf(req.body?.role, ROLES, 'role', { required: true });
  const password = String(req.body?.password ?? '');

  validatePassword(password);

  let result;
  try {
    result = await execute(
      `INSERT INTO users (organization_id, email, password_hash, full_name, role, phone,
                          employee_ref, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.auth.organizationId, email, await hashPassword(password), fullName, role,
        str(req.body?.phone, { max: 40 }), str(req.body?.employee_ref, { max: 64 }),
        // Default on: the administrator who typed this password knows it.
        bool(req.body?.must_change_password, true) ? 1 : 0,
      ],
    );
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      throw conflict('A user with that email address already exists.', { field: 'email' });
    }
    throw err;
  }

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.USER_CREATED,
    entityType: 'user',
    entityId: result.insertId,
    entityLabel: email,
    summary: `Created ${ROLE_LABELS[role]} account for ${fullName} (${email})`,
    detail: { role },
  });

  res.status(201).json({
    user: publicUser(await queryOne('SELECT * FROM users WHERE id = ?', [result.insertId])),
  });
}));

usersRouter.patch('/:id', requireCapability('users.write'), asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  const before = await queryOne(
    'SELECT * FROM users WHERE id = ? AND organization_id = ?',
    [userId, req.auth.organizationId],
  );
  if (!before) throw notFound('That user does not exist.');

  const data = {};
  if ('full_name' in (req.body ?? {})) data.full_name = requiredStr(req.body.full_name, 'Full name', { max: 190 });
  if ('email' in (req.body ?? {})) data.email = parseEmail(req.body.email, 'Email address', { required: true });
  if ('role' in (req.body ?? {})) data.role = oneOf(req.body.role, ROLES, 'role', { required: true });
  if ('phone' in (req.body ?? {})) data.phone = str(req.body.phone, { max: 40 });
  if ('employee_ref' in (req.body ?? {})) data.employee_ref = str(req.body.employee_ref, { max: 64 });
  if ('active' in (req.body ?? {})) data.active = bool(req.body.active) ? 1 : 0;
  if ('locked_until' in (req.body ?? {})) {
    // Only ever used to clear a lockout.
    data.locked_until = null;
    data.failed_logins = 0;
  }

  if (!Object.keys(data).length) throw badRequest('No changes were supplied.');

  // Guard rails against locking the organisation out of its own installation.
  if (before.id === req.auth.userId) {
    if (data.active === 0) throw badRequest('You cannot deactivate your own account.');
    if (data.role && data.role !== 'admin') {
      throw badRequest('You cannot remove your own administrator role.');
    }
  }
  if ((data.active === 0 || (data.role && data.role !== 'admin')) && before.role === 'admin') {
    const admins = await queryOne(
      `SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND role = 'admin' AND active = 1`,
      [req.auth.organizationId],
    );
    if (Number(admins.n) <= 1) {
      throw badRequest(
        'This is the only active administrator. Promote another user to administrator first.',
      );
    }
  }

  const fields = Object.keys(data);
  try {
    await execute(
      `UPDATE users SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = NOW()
        WHERE id = ? AND organization_id = ?`,
      [...fields.map((f) => data[f]), userId, req.auth.organizationId],
    );
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      throw conflict('Another user already uses that email address.', { field: 'email' });
    }
    throw err;
  }

  // Deactivating or demoting must take effect immediately, not whenever the
  // existing session happens to expire.
  if (data.active === 0 || data.role) await destroyAllSessionsForUser(userId);

  const after = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);

  await recordAudit(auditContextFromRequest(req), {
    action: data.active === 0 ? AUDIT_ACTIONS.USER_DEACTIVATED : AUDIT_ACTIONS.USER_UPDATED,
    entityType: 'user',
    entityId: userId,
    entityLabel: after.email,
    summary: `Updated ${after.full_name} (${after.email}): ${fields.join(', ')}`,
    detail: { changes: diffRecords(before, after, fields) },
  });

  res.json({ user: publicUser(after), sessions_ended: Boolean(data.active === 0 || data.role) });
}));

/** Administrator-set password reset. */
usersRouter.post('/:id/reset-password', requireCapability('users.write'), asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  const user = await queryOne(
    'SELECT * FROM users WHERE id = ? AND organization_id = ?',
    [userId, req.auth.organizationId],
  );
  if (!user) throw notFound('That user does not exist.');

  const password = String(req.body?.password ?? '');
  validatePassword(password);

  await execute(
    `UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0,
            locked_until = NULL, updated_at = NOW() WHERE id = ?`,
    [await hashPassword(password), userId],
  );
  await destroyAllSessionsForUser(userId);

  await recordAudit(auditContextFromRequest(req), {
    action: AUDIT_ACTIONS.PASSWORD_CHANGED,
    entityType: 'user',
    entityId: userId,
    entityLabel: user.email,
    summary: `Reset the password for ${user.full_name} (${user.email}) and ended their sessions`,
  });

  res.json({ ok: true, must_change_password: true, sessions_ended: true });
}));

export default { clientsRouter, programsRouter, usersRouter };
