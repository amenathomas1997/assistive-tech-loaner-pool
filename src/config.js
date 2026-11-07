/**
 * Runtime configuration.
 *
 * The app has two states:
 *
 *   NOT INSTALLED — no config file on disk. Every request is redirected to the
 *                   web installer, which collects database details, creates the
 *                   tables and the first admin, then writes the config file.
 *
 *   INSTALLED     — config file present and parseable. Normal operation.
 *
 * Config lives outside src/ so redeploying the code never clobbers it.
 * Override the location with LOANER_CONFIG (useful on shared hosting where you
 * may want it above the web root).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(__dirname, '..');
export const APP_VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;

const CONFIG_PATH = process.env.LOANER_CONFIG
  ? path.resolve(process.env.LOANER_CONFIG)
  : path.join(APP_ROOT, 'data', 'config.json');

let cached = null;

/** Absolute path of the config file, for display in the installer. */
export function configPath() {
  return CONFIG_PATH;
}

/**
 * Read config from disk. Returns null when the app has not been installed.
 * Result is cached; call reloadConfig() after writing.
 */
export function getConfig() {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.db?.host || !parsed?.db?.database) return null;
    cached = parsed;
    return cached;
  } catch {
    return null;
  }
}

export function isInstalled() {
  return getConfig() !== null;
}

export function reloadConfig() {
  cached = null;
  return getConfig();
}

/**
 * Persist config atomically (write temp + rename) so a crash mid-write cannot
 * leave a half-written file that reads as "not installed" on restart.
 *
 * Mode 0600: the file holds database credentials.
 */
export function writeConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);

  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Some shared hosts disallow chmod. Not fatal.
  }

  cached = null;
  return getConfig();
}

/**
 * 32-byte hex secret used for session cookie signing and for encrypting
 * settings marked secret (Graph client secret, etc.). Generated once at
 * install and never rotated automatically — rotating it invalidates all
 * sessions and makes stored secrets unreadable.
 */
export function generateAppKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Token authenticating an external cron entry against /api/v1/jobs/run.
 *
 * Lives in the configuration file rather than the database because it
 * authenticates the installation as a whole, and because a cron entry has no
 * session to scope it with. Generated on first request so existing installs
 * pick one up without a migration.
 */
export function getOrCreateCronToken() {
  const config = getConfig();
  if (!config) throw new Error('Not installed.');
  if (config.cronToken) return config.cronToken;

  const token = crypto.randomBytes(24).toString('base64url');
  writeConfig({ ...config, cronToken: token });
  return token;
}

/** Constant-time comparison, so the token cannot be discovered by timing. */
export function verifyCronToken(candidate) {
  const config = getConfig();
  const expected = config?.cronToken;
  if (!expected || !candidate) return false;

  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Defaults applied to any config the installer writes. */
export function defaultConfig() {
  return {
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    installedAt: new Date().toISOString(),
    appKey: generateAppKey(),
    baseUrl: '',
    db: {
      host: 'localhost',
      port: 3306,
      user: '',
      password: '',
      database: '',
      connectionLimit: 10,
      ssl: false,
    },
    session: {
      // Days a session cookie stays valid.
      lifetimeDays: 14,
      // Set true only when the site is served over HTTPS, otherwise the
      // cookie is never sent and nobody can log in.
      secureCookies: false,
    },
  };
}

/**
 * Trust proxy headers when running behind Passenger/nginx/Apache, so
 * req.ip and req.protocol reflect the client rather than the proxy.
 */
export const TRUST_PROXY = process.env.LOANER_TRUST_PROXY !== '0';

export const PORT = Number(process.env.PORT || process.env.LOANER_PORT || 3000);
