/**
 * MySQL access layer.
 *
 * A single lazily-created pool per process. The pool cannot be built at import
 * time because before installation there are no credentials to build it from;
 * getPool() throws a clear error rather than a cryptic connection failure.
 */

import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, APP_ROOT } from './config.js';

let pool = null;

export function getPool() {
  if (pool) return pool;

  const config = getConfig();
  if (!config) {
    throw new Error('Database is not configured. Run the installer first.');
  }
  pool = createPool(config.db);
  return pool;
}

/**
 * Build a pool from a raw credentials object. Exported so the installer can
 * test a connection the user typed in without committing it to disk.
 */
export function createPool(dbConfig) {
  return mysql.createPool({
    host: dbConfig.host,
    port: Number(dbConfig.port) || 3306,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database || undefined,
    waitForConnections: true,
    connectionLimit: Number(dbConfig.connectionLimit) || 10,
    queueLimit: 0,
    charset: 'utf8mb4_unicode_ci',
    // Return DATETIME as JS Date objects in the server's timezone rather than
    // strings, so date arithmetic in the loan engine is not string arithmetic.
    dateStrings: false,
    timezone: 'local',
    multipleStatements: false,
    ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
  });
}

/** Discard the cached pool, e.g. after the installer rewrites credentials. */
export async function resetPool() {
  if (pool) {
    try {
      await pool.end();
    } catch {
      // Pool may already be closed; nothing useful to do.
    }
    pool = null;
  }
}

/** Run a query and return the rows. */
export async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/** Run a query and return the first row, or null. */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** Run an INSERT/UPDATE/DELETE and return the raw result (insertId, affectedRows). */
export async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

/**
 * Run fn inside a transaction, committing on success and rolling back on any
 * throw. fn receives a dedicated connection — use conn.execute, not the
 * module-level helpers, or the statements land outside the transaction.
 */
export async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // Rollback failure is secondary to the original error.
    }
    throw err;
  } finally {
    conn.release();
  }
}

/** Convenience: first row from a transactional connection. */
export async function connOne(conn, sql, params = []) {
  const [rows] = await conn.execute(sql, params);
  return rows.length ? rows[0] : null;
}

export async function connAll(conn, sql, params = []) {
  const [rows] = await conn.execute(sql, params);
  return rows;
}

/**
 * Split schema.sql into individual statements.
 *
 * The file is authored so that this naive split is safe: every statement ends
 * with ";" at end of line, and no string literal contains a semicolon. Comment
 * lines are stripped first so a "--" line containing a semicolon can't split a
 * statement. mysql2 refuses multi-statement queries by default, which is why
 * the installer executes these one at a time.
 */
export function loadSchemaStatements() {
  const sqlPath = path.join(APP_ROOT, 'src', 'schema.sql');
  const raw = fs.readFileSync(sqlPath, 'utf8');

  const withoutComments = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Map MySQL driver errors onto messages an admin can act on. Raw driver text
 * ("ER_ACCESS_DENIED_ERROR") is not useful in an installer dialog.
 */
export function describeDbError(err) {
  const code = err?.code || '';
  switch (code) {
    case 'ECONNREFUSED':
      return 'Could not reach the database server. Check the host and port, and that MySQL is running.';
    case 'ENOTFOUND':
      return 'The database host name could not be resolved. On cPanel this is usually "localhost".';
    case 'ETIMEDOUT':
      return 'Timed out connecting to the database. If the host is remote, its firewall may not allow this server.';
    case 'ER_ACCESS_DENIED_ERROR':
      return 'The database rejected that username or password.';
    case 'ER_DBACCESS_DENIED_ERROR':
      return 'That user exists but has no rights on this database. Grant the user ALL PRIVILEGES on it, then try again.';
    case 'ER_BAD_DB_ERROR':
      return 'That database does not exist. Create it first, then enter its exact name. Note that some control panels prefix the name you typed with your account name.';
    case 'ER_TABLEACCESS_DENIED_ERROR':
      return 'The user cannot create tables in this database. Grant it ALL PRIVILEGES and try again.';
    case 'PROTOCOL_CONNECTION_LOST':
      return 'The database connection was closed unexpectedly. Try again.';
    default:
      return err?.sqlMessage || err?.message || 'Unknown database error.';
  }
}
