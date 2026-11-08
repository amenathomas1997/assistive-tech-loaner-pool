<?php
/**
 * Scheduled work: reminders, expiries and housekeeping.
 *
 * Run from cron rather than from inside the web process. A PHP request ends
 * when the response is sent, so there is nowhere for a timer to live; an
 * in-process scheduler would only run while someone happened to be using the
 * app, which is precisely when overdue reminders are not needed.
 *
 * Every run is recorded in job_runs so an administrator can see whether cron
 * is actually firing, rather than discovering months later that it never was.
 */

declare(strict_types=1);

namespace Loaner;

final class Jobs
{
    public const NAMES = [
        'due_soon', 'overdue', 'reservation_expiry', 'outcome_chase',
        'session_prune', 'scan_prune', 'retention_purge',
    ];

    public const LABELS = [
        'due_soon'           => 'Due-soon reminders',
        'overdue'            => 'Overdue notices',
        'reservation_expiry' => 'Expire unclaimed reservations',
        'session_prune'      => 'Remove expired sessions',
        'scan_prune'         => 'Clear old scan events',
        'outcome_chase'      => 'Chase missing trial outcomes',
        'retention_purge'    => 'Apply the data retention policy',
    ];

    /**
     * Run everything for one organisation.
     *
     * A failure in one job must not stop the others: an unreachable mail
     * service should not also leave expired sessions in the table.
     */
    public static function runAll(?array $actor, int $organizationId, string $triggeredBy = 'cron'): array
    {
        $results = [];

        foreach (self::NAMES as $name) {
            $results[$name] = self::run($actor, $organizationId, $name, $triggeredBy);
        }

        $failed = array_filter($results, static fn (array $r): bool => $r['status'] === 'failed');

        return [
            'ran_at'  => date('c'),
            'jobs'    => $results,
            'ok'      => $failed === [],
            'failed'  => array_keys($failed),
            'summary' => $failed === []
                ? 'All scheduled jobs completed.'
                : count($failed) . ' job(s) failed: ' . implode(', ', array_keys($failed)),
        ];
    }

    /** Run one job, recording the attempt either way. */
    public static function run(?array $actor, int $organizationId, string $name, string $triggeredBy = 'cron'): array
    {
        if (!in_array($name, self::NAMES, true)) {
            throw Util::badRequest("\"{$name}\" is not a scheduled job.", ['allowed' => self::NAMES]);
        }

        $runId = Db::insert(
            'INSERT INTO job_runs (organization_id, job_name, status, started_at, triggered_by)
             VALUES (?, ?, "running", NOW(), ?)',
            [$organizationId, $name, $triggeredBy],
        );

        try {
            $outcome = match ($name) {
                'due_soon'           => self::dueSoonReminders($actor, $organizationId),
                'overdue'            => self::overdueNotices($actor, $organizationId),
                'reservation_expiry' => self::expireReservations($actor, $organizationId),
                'outcome_chase'      => self::chaseOutcomes($actor, $organizationId),
                'session_prune'      => self::pruneSessions(),
                'scan_prune'         => Scan::prune(),
                'retention_purge'    => Retention::purge($actor, $organizationId),
            };

            $summary = $outcome['summary'] ?? 'Completed.';
            unset($outcome['summary']);

            Db::execute(
                'UPDATE job_runs SET status = "ok", finished_at = NOW(), summary = ?, detail = ? WHERE id = ?',
                [mb_substr($summary, 0, 500), json_encode($outcome), $runId],
            );

            return ['status' => 'ok', 'summary' => $summary, 'detail' => $outcome, 'run_id' => $runId];
        } catch (\Throwable $e) {
            error_log("[jobs] {$name} failed: " . $e->getMessage());

            Db::execute(
                'UPDATE job_runs SET status = "failed", finished_at = NOW(), summary = ?, detail = ? WHERE id = ?',
                [mb_substr($e->getMessage(), 0, 500), json_encode(['error' => $e->getMessage()]), $runId],
            );

            return ['status' => 'failed', 'summary' => $e->getMessage(), 'detail' => null, 'run_id' => $runId];
        }
    }

    // -----------------------------------------------------------------------
    // The jobs themselves
    // -----------------------------------------------------------------------

    /**
     * Remind about loans coming due.
     *
     * A loan_event is written for each notice so the same loan is not
     * reminded about twice in one day — cron firing more than once, or an
     * administrator pressing "run now", should not mean two emails.
     */
    private static function dueSoonReminders(?array $actor, int $organizationId): array
    {
        if (!Settings::get($organizationId, 'notify.due_soon')) {
            return ['summary' => 'Due-soon reminders are switched off.', 'sent' => 0, 'skipped' => 0];
        }

        $withinDays = (int) Settings::get($organizationId, 'notify.due_soon_days');
        $loans      = Loans::dueSoon($organizationId, $withinDays);

        $sent    = 0;
        $skipped = 0;

        foreach ($loans as $loan) {
            $alreadyToday = Db::value(
                'SELECT id FROM loan_events
                  WHERE loan_id = ? AND event_type = "due_soon_notice" AND created_at >= CURDATE()',
                [$loan['id']],
            );

            if ($alreadyToday !== null) {
                $skipped++;
                continue;
            }

            $result = Notifications::send($actor, $organizationId, 'due_soon', $loan + ['__loan_id' => (int) $loan['id']]);

            if ($result['sent']) {
                Db::execute(
                    'INSERT INTO loan_events (loan_id, event_type, notes) VALUES (?, "due_soon_notice", ?)',
                    [$loan['id'], 'Reminder sent'],
                );
                $sent++;
            } else {
                $skipped++;
            }
        }

        return [
            'summary' => sprintf(
                '%d loan%s due within %d day%s; %d reminder%s sent, %d skipped.',
                count($loans), count($loans) === 1 ? '' : 's',
                $withinDays, $withinDays === 1 ? '' : 's',
                $sent, $sent === 1 ? '' : 's', $skipped,
            ),
            'candidates' => count($loans), 'sent' => $sent, 'skipped' => $skipped,
        ];
    }

    /**
     * Notify about overdue loans.
     *
     * Chased once a day rather than once ever: a device that is three weeks
     * late is the one worth chasing, and a single notice on the day it became
     * overdue is easily missed.
     */
    private static function overdueNotices(?array $actor, int $organizationId): array
    {
        if (!Settings::get($organizationId, 'notify.overdue')) {
            return ['summary' => 'Overdue notices are switched off.', 'sent' => 0, 'skipped' => 0];
        }

        $loans   = Loans::overdue($organizationId);
        $sent    = 0;
        $skipped = 0;

        foreach ($loans as $loan) {
            $alreadyToday = Db::value(
                'SELECT id FROM loan_events
                  WHERE loan_id = ? AND event_type = "overdue_notice" AND created_at >= CURDATE()',
                [$loan['id']],
            );

            if ($alreadyToday !== null) {
                $skipped++;
                continue;
            }

            $result = Notifications::send($actor, $organizationId, 'overdue', $loan + ['__loan_id' => (int) $loan['id']]);

            if ($result['sent']) {
                Db::execute(
                    'INSERT INTO loan_events (loan_id, event_type, notes) VALUES (?, "overdue_notice", ?)',
                    [$loan['id'], 'Overdue notice sent'],
                );
                $sent++;
            } else {
                $skipped++;
            }
        }

        return [
            'summary' => sprintf(
                '%d overdue loan%s; %d notice%s sent, %d skipped.',
                count($loans), count($loans) === 1 ? '' : 's',
                $sent, $sent === 1 ? '' : 's', $skipped,
            ),
            'candidates' => count($loans), 'sent' => $sent, 'skipped' => $skipped,
        ];
    }

    private static function expireReservations(?array $actor, int $organizationId): array
    {
        $expired = Reservations::expireStaleClaims($organizationId);

        return [
            'summary' => $expired === 0
                ? 'No reservation claims had lapsed.'
                : sprintf('%d unclaimed reservation%s expired and passed on.',
                    $expired, $expired === 1 ? '' : 's'),
            'expired' => $expired,
        ];
    }

    /**
     * Remind somebody that completed trials have no outcome recorded.
     *
     * Not a client-facing message: this goes to the administrators, because an
     * outcome is staff work. Sent once rather than daily — a nag that arrives
     * every morning gets filtered, and then nobody sees the one that mattered.
     */
    private static function chaseOutcomes(?array $actor, int $organizationId): array
    {
        if (!Settings::get($organizationId, 'outcomes.enabled')) {
            return ['summary' => 'Trial outcomes are switched off.', 'outstanding' => 0];
        }

        $after = max(1, (int) Settings::get($organizationId, 'outcomes.chase_after_days'));

        $rows = Db::all(
            'SELECT l.reference, d.name AS device_name,
                    CONCAT(c.first_name, " ", c.last_name) AS client_name, l.returned_at
               FROM loans l
               JOIN devices d ON d.id = l.device_id
               LEFT JOIN clients c ON c.id = l.client_id
              WHERE l.organization_id = ? AND l.status = "returned" AND l.outcome IS NULL
                AND l.returned_at < DATE_SUB(NOW(), INTERVAL ? DAY)
                AND l.returned_at > DATE_SUB(NOW(), INTERVAL ? DAY)
              ORDER BY l.returned_at
              LIMIT 50',
            [$organizationId, $after, $after + 1],
        );

        if ($rows === []) {
            return ['summary' => 'No trials became overdue for an outcome today.', 'outstanding' => 0];
        }

        $recipients = Settings::parseRecipients(
            (string) Settings::get($organizationId, 'notify.admin_recipients'),
        );

        if ($recipients === []) {
            $recipients = array_column(Db::all(
                'SELECT email FROM users WHERE organization_id = ? AND role = "admin" AND active = 1',
                [$organizationId],
            ), 'email');
        }

        $list = '';
        foreach ($rows as $row) {
            $list .= '<li>' . Util::escapeHtml($row['device_name'])
                  . ($row['client_name'] !== null ? ' — ' . Util::escapeHtml($row['client_name']) : '')
                  . ' (' . Util::escapeHtml($row['reference']) . ')</li>';
        }

        $result = Mailer::send($actor, $organizationId, [
            'to'        => $recipients,
            'subject'   => count($rows) . ' trial(s) need an outcome recorded',
            'html'      => Mailer::layout(
                'Trials waiting for an outcome',
                '<p>These devices came back ' . $after . ' day(s) ago and no trial outcome has been '
                . 'recorded. Without one they are missing from the purchasing reports.</p><ul>'
                . $list . '</ul>',
            ),
            'eventType' => 'outcome_chase',
        ]);

        return [
            'summary' => sprintf(
                '%d trial(s) chased for an outcome; reminder %s.',
                count($rows), $result['sent'] ? 'sent' : 'not sent (' . ($result['reason'] ?? '') . ')',
            ),
            'outstanding' => count($rows),
            'sent'        => $result['sent'],
        ];
    }

    private static function pruneSessions(): array
    {
        $sessions = Auth::pruneExpiredSessions();
        $pending  = Auth::prunePendingLogins();
        $resets   = Db::execute(
            'DELETE FROM password_resets WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)',
        );

        return [
            'summary' => sprintf(
                '%d expired session(s), %d half-finished sign-in(s) and %d old reset token(s) removed.',
                $sessions, $pending, $resets,
            ),
            'sessions' => $sessions, 'pending_logins' => $pending, 'reset_tokens' => $resets,
        ];
    }

    // -----------------------------------------------------------------------
    // Status
    // -----------------------------------------------------------------------

    /**
     * Recent runs, plus whether each job looks like it is running at all.
     *
     * The "cron does not appear to be set up" notice is the point of this
     * screen: a reminder system nobody has wired to cron fails silently, and
     * the first sign is usually a device that never came back.
     */
    public static function status(int $organizationId): array
    {
        $latest = Db::all(
            'SELECT j1.* FROM job_runs j1
               JOIN (SELECT job_name, MAX(id) AS id FROM job_runs
                      WHERE organization_id = ? OR organization_id IS NULL
                      GROUP BY job_name) latest
                 ON latest.id = j1.id
              ORDER BY j1.job_name',
            [$organizationId],
        );

        $byName = array_column($latest, null, 'job_name');

        $jobs = [];
        foreach (self::NAMES as $name) {
            $run = $byName[$name] ?? null;

            $jobs[] = [
                'name'        => $name,
                'label'       => self::LABELS[$name],
                'last_run_at' => $run['finished_at'] ?? $run['started_at'] ?? null,
                'last_status' => $run['status'] ?? null,
                'last_summary' => $run['summary'] ?? null,
                'triggered_by' => $run['triggered_by'] ?? null,
                'ever_run'    => $run !== null,
            ];
        }

        $history = Db::all(
            'SELECT id, job_name, status, started_at, finished_at, summary, triggered_by
               FROM job_runs
              WHERE organization_id = ? OR organization_id IS NULL
              ORDER BY id DESC LIMIT 50',
            [$organizationId],
        );

        $lastCron = Db::value(
            'SELECT MAX(started_at) FROM job_runs WHERE triggered_by = "cron"',
        );

        $cronHealthy = $lastCron !== null && strtotime((string) $lastCron) > time() - 36 * 3600;

        // The most recent successful run FROM CRON specifically, because the
        // sentence it appears in is "reminders are running" — and that is only
        // true of cron. Counting a manual "Run now" here would let an
        // administrator who pressed the button an hour ago see a healthy panel
        // over a cron entry that has not fired in a month, which is exactly the
        // failure this screen exists to make visible.
        $lastSuccess = Db::one(
            'SELECT id, job_name, status, started_at, finished_at, summary, triggered_by
               FROM job_runs
              WHERE (organization_id = ? OR organization_id IS NULL)
                AND status = "ok" AND triggered_by = "cron"
              ORDER BY id DESC LIMIT 1',
            [$organizationId],
        );

        // Reported separately so the panel can still say when somebody last
        // ran it by hand, without that standing in for cron working.
        $lastManual = Db::one(
            'SELECT id, job_name, status, started_at, summary
               FROM job_runs
              WHERE (organization_id = ? OR organization_id IS NULL)
                AND status = "ok" AND triggered_by <> "cron"
              ORDER BY id DESC LIMIT 1',
            [$organizationId],
        );

        return [
            'jobs'    => $jobs,
            'history' => $history,
            // The run log, under the name the settings screen reads it by.
            'runs'    => $history,
            // Healthy means cron has run recently enough to be trusted, not
            // merely that something ran once.
            'healthy'      => $cronHealthy,
            'last_success' => $lastSuccess,
            'last_manual'  => $lastManual,
            // Stated explicitly so nobody assumes the app reminds people on its
            // own. A PHP request ends when the response is sent, so there is
            // nowhere for a timer to live: without cron, no reminder is ever
            // sent, and that is worth saying on the screen rather than in docs.
            'in_process_scheduler' => false,
            'cron'    => [
                'last_run_at' => $lastCron,
                'healthy'     => $cronHealthy,
                'notice'      => $cronHealthy
                    ? null
                    : ($lastCron === null
                        ? 'Scheduled jobs have never run from cron. Until cron is set up, nobody will be '
                        . 'reminded about loans coming due or overdue.'
                        : 'Cron last ran on ' . date('j M Y H:i', strtotime((string) $lastCron))
                        . ', which is more than a day ago. Check that the cron entry is still in place.'),
            ],
        ];
    }

    /**
     * The exact cron line to paste, including the token.
     *
     * The token authenticates the request without a session, so cron does not
     * need to log in. It is generated at install and stored in the config
     * file, not in the database — a database restore from another environment
     * must not carry a working trigger URL with it.
     */
    public static function cronCommand(?string $baseUrl = null): array
    {
        $token = Config::cronToken();
        $base  = rtrim((string) ($baseUrl ?: ''), '/');
        $url   = ($base !== '' ? $base : 'https://your-site.example') . '/api/v1/jobs/run?token=' . $token;

        $php = PHP_BINARY !== '' && is_file(PHP_BINARY) ? PHP_BINARY : 'php';

        return [
            'url'         => $url,
            'token'       => $token,
            'token_header' => 'X-Cron-Token',
            // The token travels in a header rather than the query string.
            // Query strings end up in access logs, proxy logs and browser
            // history; a header does not.
            'crontab_curl' => sprintf(
                '0 7 * * * curl -fsS -X POST -H %s %s > /dev/null 2>&1',
                escapeshellarg("X-Cron-Token: {$token}"),
                escapeshellarg($url),
            ),
            'crontab_cli'  => sprintf(
                '0 7 * * * %s %s --quiet',
                $php, escapeshellarg(APP_ROOT . '/bin/run-jobs.php'),
            ),
            // The dialog shows one line and one sentence. Which line depends
            // on where cron runs: prefer the command-line form, because it
            // needs no network and no token, and fall back to curl only when
            // PHP cannot be located on this host.
            'crontab' => $php === 'php'
                ? sprintf('0 7 * * * curl -fsS -X POST -H %s %s > /dev/null 2>&1',
                    escapeshellarg("X-Cron-Token: {$token}"), escapeshellarg($url))
                : sprintf('0 7 * * * %s %s --quiet',
                    $php, escapeshellarg(APP_ROOT . '/bin/run-jobs.php')),
            'note' => 'Paste this into cPanel → Cron Jobs, set to run once per day. '
                    . 'Until it is in place, no due-soon or overdue reminder is ever sent — '
                    . 'nothing inside the application schedules itself.',
            'notes' => [
                'Run it once a day. Seven in the morning means notices are waiting when people start work.',
                'The request carries the token in an X-Cron-Token header because cron has no session. '
                . 'Treat it as a secret: it only triggers the job runner, but anyone holding it can.',
                'Either line works. The command-line version needs no network and no token, so prefer it '
                . 'where cron runs on the same host as the site.',
                'cPanel: Advanced → Cron Jobs, set "Once per day", and paste one of the lines above.',
            ],
        ];
    }
}
