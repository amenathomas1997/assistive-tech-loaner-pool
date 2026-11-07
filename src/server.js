/**
 * Application entry point.
 *
 * Two modes, decided by whether a config file exists:
 *   uninstalled — only the installer and its API are reachable.
 *   installed   — the full application.
 *
 * The mode is re-checked per request rather than captured at boot, so
 * finishing the installer does not require restarting the process (which on
 * shared hosting the admin often cannot do).
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';

import {
  APP_ROOT, APP_VERSION, PORT, TRUST_PROXY, isInstalled, getConfig, configPath,
} from './config.js';
import { attachAuth, pruneExpiredSessions } from './lib/auth.js';
import { HttpError, notFound } from './lib/util.js';
import { pruneExpiredChannels, shutdown as shutdownScanHub } from './lib/scanhub.js';
import { runMigrations } from './migrations.js';
import { startScheduler, stopScheduler } from './lib/jobs.js';

import installRouter from './routes/install.js';
import authRouter from './routes/auth.js';
import devicesRouter from './routes/devices.js';
import loansRouter from './routes/loans.js';
import requestsRouter from './routes/requests.js';
import { clientsRouter, programsRouter, usersRouter } from './routes/directory.js';
import adminRouter from './routes/admin.js';
import scanRouter from './routes/scan.js';
import { auditRouter, reportsRouter } from './routes/insights.js';
import {
  kitsRouter, groupsRouter, reservationsRouter, repairsRouter,
  agreementsRouter, attachmentsRouter, bulkRouter, jobsRouter,
} from './routes/workshop.js';

const app = express();
const PUBLIC_DIR = path.join(APP_ROOT, 'public');

if (TRUST_PROXY) app.set('trust proxy', true);
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

// The limit is generous because device imports arrive as a JSON string of CSV
// text rather than as a multipart upload.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  // No inline event handlers or remote assets anywhere in this app, so the
  // policy can be strict. 'unsafe-inline' is allowed for styles only, which
  // the label sheet and installer use for print-specific rules.
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'",
  );
  next();
});

// ---------------------------------------------------------------------------
// Installer gate
// ---------------------------------------------------------------------------

app.use('/api/install', installRouter);

/**
 * While uninstalled, everything except the installer, its assets and the
 * health check redirects to /install.html. This is what makes a fresh upload
 * usable from a browser alone.
 */
app.use((req, res, next) => {
  if (isInstalled()) {
    // Once installed the installer page itself is pointless; send people home.
    if (req.path === '/install.html') return res.redirect('/');
    return next();
  }

  const allowed = ['/install.html', '/health', '/css/app.css', '/js/install.js'];
  if (allowed.includes(req.path) || req.path.startsWith('/vendor/')) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(503).json({
      error: {
        code: 'not_installed',
        message: 'This Loaner Pool has not been set up yet. Open /install.html in a browser to configure it.',
        details: { installer_url: '/install.html', config_path: configPath() },
      },
    });
  }

  return res.redirect('/install.html');
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', async (req, res) => {
  const status = {
    ok: true,
    app_version: APP_VERSION,
    installed: isInstalled(),
    node_version: process.version,
    uptime_seconds: Math.round(process.uptime()),
  };

  if (isInstalled()) {
    try {
      const { query } = await import('./db.js');
      await query('SELECT 1 AS ok');
      status.database = 'connected';
    } catch (err) {
      status.ok = false;
      status.database = 'unreachable';
      status.database_error = err.message;
      return res.status(503).json(status);
    }
  }

  res.json(status);
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

app.use(attachAuth);

// ---------------------------------------------------------------------------
// API
//
// Everything lives under /api/v1. The unversioned /api/* aliases exist so the
// browser client and hand-written curl commands both work, but the versioned
// path is the contract third parties should build against.
// ---------------------------------------------------------------------------

const api = express.Router();

api.use('/auth', authRouter);
api.use('/devices', devicesRouter);
api.use('/loans', loansRouter);
api.use('/requests', requestsRouter);
api.use('/clients', clientsRouter);
api.use('/programs', programsRouter);
api.use('/users', usersRouter);
api.use('/admin', adminRouter);
api.use('/scan', scanRouter);
api.use('/audit', auditRouter);
api.use('/reports', reportsRouter);
api.use('/kits', kitsRouter);
api.use('/groups', groupsRouter);
api.use('/reservations', reservationsRouter);
api.use('/repairs', repairsRouter);
api.use('/agreements', agreementsRouter);
api.use('/attachments', attachmentsRouter);
api.use('/bulk', bulkRouter);
api.use('/jobs', jobsRouter);

app.use('/api/v1', api);
app.use('/api', api);

/** Machine-readable API description. */
app.get(['/api/openapi.json', '/api/v1/openapi.json'], (req, res) => {
  const specPath = path.join(APP_ROOT, 'docs', 'openapi.json');
  if (!fs.existsSync(specPath)) {
    return res.status(404).json({
      error: { code: 'spec_missing', message: 'The OpenAPI document is not present in this deployment.' },
    });
  }

  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const base = getConfig()?.baseUrl
    || `${req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http'}://${req.get('host')}`;
  spec.servers = [{ url: `${String(base).replace(/\/$/, '')}/api/v1` }];

  res.json(spec);
});

// ---------------------------------------------------------------------------
// Static files and SPA fallback
// ---------------------------------------------------------------------------

/**
 * Static assets.
 *
 * Application code is served `no-cache`, which means "revalidate every time",
 * not "never cache" — the browser still gets a cheap 304 when nothing has
 * changed. There is no build step here and therefore no content hash in the
 * filenames, so a long max-age would leave every user running stale
 * JavaScript for that long after a deploy, with no way to tell them.
 *
 * Third-party assets under /vendor change only when the app is upgraded, so
 * they keep a long max-age.
 */
app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}vendor${path.sep}`)) {
      res.set('Cache-Control', 'public, max-age=86400');
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  },
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/**
 * Client-side routing fallback: anything that is not an API call, has no file
 * extension and accepts HTML gets the app shell.
 */
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  if (path.extname(req.path)) return next();
  if (!req.accepts('html')) return next();
  return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  next(notFound(`No route matches ${req.method} ${req.path}.`));
});

/**
 * Single error envelope for the whole API:
 *   { error: { code, message, details } }
 *
 * Known HttpErrors pass their message through — they are written for the
 * person reading them. Anything else becomes a generic 500 with a reference,
 * so a stack trace or SQL fragment never reaches a client.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
    });
  }

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: {
        code: 'payload_too_large',
        message: 'That upload is too large. Split the spreadsheet into smaller files and import them separately.',
      },
    });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      error: { code: 'malformed_json', message: 'The request body was not valid JSON.' },
    });
  }

  const reference = Math.random().toString(36).slice(2, 10);
  console.error(`[error ${reference}] ${req.method} ${req.path}`, err);

  res.status(500).json({
    error: {
      code: 'internal_error',
      message:
        'Something went wrong on the server. If this keeps happening, give your administrator this ' +
        `reference so they can find it in the server log: ${reference}`,
      details: { reference },
    },
  });
});

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Hourly cleanup of expired sessions and scan channels. unref() so the timer
 * never holds the process open during shutdown.
 */
const housekeeping = setInterval(async () => {
  if (!isInstalled()) return;
  try {
    const sessions = await pruneExpiredSessions();
    const channels = await pruneExpiredChannels();
    if (sessions || channels) {
      console.log(`[housekeeping] removed ${sessions} expired session(s), ${channels} expired scan channel(s)`);
    }
  } catch (err) {
    console.error('[housekeeping] failed:', err.message);
  }
}, 60 * 60 * 1000);
housekeeping.unref();

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, async () => {
  console.log(`Loaner Pool ${APP_VERSION} listening on port ${PORT}`);

  if (!isInstalled()) {
    console.log('Not yet installed — open /install.html in a browser to set it up.');
    return;
  }

  console.log(`Configuration: ${configPath()}`);

  // Bring an existing install up to the current schema. A failure here is
  // logged loudly but does not stop the server: an upgrade that cannot apply
  // is a problem for an administrator to fix, not a reason to take the
  // check-in desk offline.
  try {
    const result = await runMigrations();
    if (result.applied.length) {
      console.log(`[migrate] schema ${result.from} → ${result.to}`);
    }
  } catch (err) {
    console.error('[migrate]', err.message);
  }

  startScheduler();
});

function stop(signal) {
  console.log(`\n${signal} received, shutting down.`);
  shutdownScanHub();
  stopScheduler();
  clearInterval(housekeeping);
  server.close(() => process.exit(0));
  // Do not let an SSE client that ignores the close frame hold the process up.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

export default app;
