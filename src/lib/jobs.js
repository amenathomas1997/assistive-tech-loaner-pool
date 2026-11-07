/**
 * Scheduled work: due-soon reminders, overdue chasing, reservation expiry and
 * housekeeping.
 *
 * Two ways to run it, because shared hosting varies:
 *
 *   - **In-process timer.** Enabled by default. Fine for a single instance,
 *     which is what Passenger gives you. Checks hourly and only does real work
 *     inside the configured send window, so a restart at 3pm does not fire a
 *     day's reminders again.
 *   - **External cron** hitting `POST /api/v1/jobs/run` with the cron token.
 *     Use this when the app is behind a process manager that idles it out, or
 *     when you want the timing to be exact.
 *
 * Both paths call the same function, and both are safe to run concurrently:
 * a loan that has been chased in the last day is skipped by the query itself,
 * and every send writes a `loan_events` row that makes the skip stick.
 */

import { query, queryOne, execute } from '../db.js';
import { toMysqlDateTime } from './util.js';
import { findLoansDueSoon, findOverdueLoans } from './loans.js';
import { notify } from './mailer.js';
import { getSettings } from './settings.js';
import { recordAudit } from './audit.js';
import { pruneExpiredSessions } from './auth.js';
import { pruneExpiredChannels } from './scanhub.js';
import { expireStaleClaims } from './reservations.js';
import { getConfig } from '../config.js';

let timer = null;
let running = false;

const HOUR = 60 * 60 * 1000;

/**
 * Reminders are only sent between these hours in the server's local time.
 * An overdue notice at 03:00 is worse than one at 09:00: it lands overnight,
 * gets buried, and looks automated in the bad way.
 */
const SEND_WINDOW_START = 7;
const SEND_WINDOW_END = 19;

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * Run every scheduled task once, for every organisation.
 *
 * `force` bypasses the time-of-day window, for a manual "run it now" from the
 * settings screen.
 */
export async function runScheduledJobs({ trigger = 'timer', force = false } = {}) {
  if (running) {
    return { skipped: true, reason: 'A scheduled run is already in progress.' };
  }
  running = true;

  const startedAt = new Date();
  const [jobRow] = [await execute(
    `INSERT INTO job_runs (job_name, status, started_at, triggered_by) VALUES (?, 'running', ?, ?)`,
    ['reminders', toMysqlDateTime(startedAt), trigger],
  )];
  const jobId = jobRow.insertId;

  const result = {
    due_soon_sent: 0,
    overdue_sent: 0,
    reservations_expired: 0,
    sessions_pruned: 0,
    channels_pruned: 0,
    organizations: 0,
    skipped_outside_window: false,
    errors: [],
  };

  try {
    const hour = startedAt.getHours();
    const inWindow = force || (hour >= SEND_WINDOW_START && hour < SEND_WINDOW_END);
    result.skipped_outside_window = !inWindow;

    // Housekeeping runs regardless of the send window.
    result.sessions_pruned = await pruneExpiredSessions().catch(() => 0);
    result.channels_pruned = await pruneExpiredChannels().catch(() => 0);

    const organizations = await query('SELECT id, name FROM organizations WHERE active = 1');
    result.organizations = organizations.length;

    for (const org of organizations) {
      try {
        result.reservations_expired += await expireStaleClaims(org.id);
      } catch (err) {
        result.errors.push(`Reservation expiry for ${org.name}: ${err.message}`);
      }

      if (!inWindow) continue;

      try {
        const counts = await sendRemindersFor(org.id);
        result.due_soon_sent += counts.dueSoon;
        result.overdue_sent += counts.overdue;
      } catch (err) {
        result.errors.push(`Reminders for ${org.name}: ${err.message}`);
      }
    }

    const summary = result.skipped_outside_window
      ? `Housekeeping only (outside the ${SEND_WINDOW_START}:00–${SEND_WINDOW_END}:00 send window).`
      : `${result.due_soon_sent} due-soon and ${result.overdue_sent} overdue reminder(s) sent.`;

    await execute(
      `UPDATE job_runs SET status = ?, finished_at = NOW(), summary = ?, detail = ? WHERE id = ?`,
      [result.errors.length ? 'failed' : 'ok', summary.slice(0, 500), JSON.stringify(result), jobId],
    );

    return { ...result, summary, job_id: jobId };
  } catch (err) {
    await execute(
      `UPDATE job_runs SET status = 'failed', finished_at = NOW(), summary = ?, detail = ? WHERE id = ?`,
      [String(err.message).slice(0, 500), JSON.stringify({ error: err.message }), jobId],
    ).catch(() => {});
    throw err;
  } finally {
    running = false;
  }
}

/**
 * Send reminders for one organisation.
 *
 * The `loan_events` row is written *before* the send is attempted. If the mail
 * fails, the loan is still marked as chased for the next 24 hours — which is
 * deliberate. Retrying a failing mailer every hour would send a burst of
 * duplicates the moment it recovers; a failed send is recorded in email_log
 * and visible in settings, which is the right place to notice it.
 */
async function sendRemindersFor(organizationId) {
  const settings = await getSettings(organizationId);
  const baseUrl = getConfig()?.baseUrl || '';

  let dueSoon = 0;
  let overdue = 0;

  if (settings['notify.due_soon']) {
    const days = Number(settings['notify.due_soon_days']) || 3;
    for (const loan of await findLoansDueSoon(organizationId, days)) {
      await execute(
        `INSERT INTO loan_events (loan_id, event_type, old_due_at, notes)
         VALUES (?, 'due_soon_notice', ?, ?)`,
        [loan.id, toMysqlDateTime(loan.due_at), `Due in ${loan.days_until_due} day(s)`],
      );
      await notify(systemContext(organizationId), organizationId, 'due_soon', loan, { baseUrl });
      dueSoon += 1;
    }
  }

  if (settings['notify.overdue']) {
    for (const loan of await findOverdueLoans(organizationId)) {
      await execute(
        `INSERT INTO loan_events (loan_id, event_type, old_due_at, notes)
         VALUES (?, 'overdue_notice', ?, ?)`,
        [loan.id, toMysqlDateTime(loan.due_at), `${loan.days_overdue} day(s) overdue`],
      );
      await notify(systemContext(organizationId), organizationId, 'overdue', loan, { baseUrl });
      overdue += 1;
    }
  }

  if (dueSoon || overdue) {
    await recordAudit(systemContext(organizationId), {
      organizationId,
      action: 'email.sent',
      entityType: 'job',
      entityLabel: 'reminders',
      summary: `Reminder run: ${dueSoon} due-soon, ${overdue} overdue`,
      detail: { due_soon: dueSoon, overdue },
    });
  }

  return { dueSoon, overdue };
}

function systemContext(organizationId) {
  return {
    organizationId,
    userId: null,
    label: 'Scheduled job',
    actorType: 'system',
    ip: null,
  };
}

// ---------------------------------------------------------------------------
// In-process timer
// ---------------------------------------------------------------------------

export function startScheduler() {
  if (timer) return;

  const enabled = process.env.LOANER_DISABLE_SCHEDULER !== '1';
  if (!enabled) {
    console.log('[scheduler] disabled by LOANER_DISABLE_SCHEDULER=1');
    return;
  }

  // First run after a short delay so a boot storm does not collide with
  // migrations still settling.
  const initial = setTimeout(() => {
    runScheduledJobs({ trigger: 'startup' }).catch((err) =>
      console.error('[scheduler] first run failed:', err.message));
  }, 45_000);
  initial.unref();

  timer = setInterval(() => {
    runScheduledJobs({ trigger: 'timer' }).catch((err) =>
      console.error('[scheduler] run failed:', err.message));
  }, HOUR);
  timer.unref();

  console.log(`[scheduler] hourly reminder check enabled (sends ${SEND_WINDOW_START}:00–${SEND_WINDOW_END}:00 local time)`);
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Recent job history, for the settings screen. */
export async function recentJobRuns(limit = 20) {
  const rows = await query(
    `SELECT id, job_name, status, started_at, finished_at, summary, triggered_by
       FROM job_runs ORDER BY started_at DESC LIMIT ${Number(limit)}`,
  );
  return rows;
}

/** When the reminder job last completed successfully. */
export async function lastSuccessfulRun() {
  return queryOne(
    `SELECT started_at, finished_at, summary FROM job_runs
      WHERE job_name = 'reminders' AND status = 'ok'
      ORDER BY started_at DESC LIMIT 1`,
  );
}
