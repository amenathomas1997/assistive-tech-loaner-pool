<?php
/**
 * Update checking.
 *
 * Asks GitHub whether this installation is behind, and says what to do about
 * it. Two very different operations live here:
 *
 *   - Checking is safe, so the web interface does it and shows a notice.
 *   - Applying replaces the code this server runs. It is available from the
 *     command line, and — because an administrator on shared hosting usually
 *     has no shell, and software that is never updated is the larger risk —
 *     from the browser too, through applyFromWeb(), which is gated harder
 *     than anything else in the application: an administrator by role, their
 *     password re-entered, one at a time, a backup first, and an audit entry.
 *     See the note on that method for the full reasoning.
 *
 * The result is cached on disk rather than in the database: it describes the
 * files on this server, not the organisation's data, and a restored database
 * from another environment should not bring a stale answer with it.
 */

declare(strict_types=1);

namespace Loaner;

final class Updates
{
    /** Where this software comes from. */
    public const REPOSITORY = 'amenathomas1997/assistive-tech-loaner-pool';

    private const API_HOST = 'https://api.github.com';
    private const BRANCH   = 'main';

    /** How long a check is trusted before asking again. */
    private const CACHE_MINUTES = 360;

    /**
     * Shared hosting frequently blocks outbound HTTPS, and GitHub rate-limits
     * unauthenticated callers to 60 requests an hour per address. Neither is
     * worth waiting on, so both fail fast and report rather than hang a page.
     */
    private const TIMEOUT_SECONDS = 8;

    /**
     * How long an update may hold the site in maintenance before the lock is
     * treated as abandoned. Generous — a slow shared host downloading and
     * unpacking a few megabytes is not a stuck update — but finite, because a
     * crashed update must not leave the site returning 503 forever.
     */
    private const LOCK_SECONDS = 600;

    private static function cachePath(): string
    {
        return Config::dataDir() . '/update-check.json';
    }

    /**
     * Where a non-git install records which commit it is running.
     *
     * A git checkout knows this already. An install that was uploaded as files
     * has no history to ask, so the updater writes down what it put there —
     * which is what lets "is there an update?" give a real answer on a cPanel
     * account rather than shrugging.
     *
     * Kept in data/ rather than in the tree, because everything in the tree is
     * replaced on the next update.
     */
    private static function stampPath(): string
    {
        return Config::dataDir() . '/version.json';
    }

    /**
     * Held while files are being swapped.
     *
     * Two things depend on it. Nothing else may start an update at the same
     * time — two processes copying over the same tree would interleave into a
     * mixture of both versions. And the front controller returns 503 while it
     * exists, so no request executes a half-replaced application: PHP loads
     * classes one file at a time, so a request landing mid-swap could run a new
     * Loans.php against an old Util.php.
     */
    public static function lockPath(): string
    {
        return Config::dataDir() . '/updating.lock';
    }

    /**
     * Is an update in progress?
     *
     * A lock older than the window is ignored. An update that died halfway —
     * the process killed, PHP timing out — must not leave the site returning
     * 503 forever with no way back in through the interface.
     */
    public static function isLocked(): bool
    {
        $path = self::lockPath();

        if (!is_file($path)) {
            return false;
        }

        if (time() - (int) @filemtime($path) > self::LOCK_SECONDS) {
            @unlink($path);
            return false;
        }

        return true;
    }

    /** @return array{by: ?string, started_at: ?string}|null */
    public static function lockDetails(): ?array
    {
        if (!self::isLocked()) {
            return null;
        }

        $raw = json_decode((string) @file_get_contents(self::lockPath()), true);

        return is_array($raw) ? $raw : ['by' => null, 'started_at' => null];
    }

    private static function acquireLock(?string $by): void
    {
        if (self::isLocked()) {
            $details = self::lockDetails();

            throw new \RuntimeException(sprintf(
                'An update is already running%s. Wait for it to finish before starting another.',
                !empty($details['by']) ? ' (started by ' . $details['by'] . ')' : '',
            ));
        }

        // x mode: fails rather than truncating if another process won the race
        // between isLocked() and here.
        $handle = @fopen(self::lockPath(), 'x');

        if ($handle === false) {
            throw new \RuntimeException('Another update started a moment ago. Try again shortly.');
        }

        fwrite($handle, json_encode(['by' => $by, 'started_at' => date('c')]));
        fclose($handle);
        @chmod(self::lockPath(), 0600);
    }

    private static function releaseLock(): void
    {
        @unlink(self::lockPath());
    }

    private static function readStamp(): ?array
    {
        $raw = @file_get_contents(self::stampPath());

        if ($raw === false) {
            return null;
        }

        $stamp = json_decode($raw, true);

        return is_array($stamp) && !empty($stamp['commit']) ? $stamp : null;
    }

    private static function writeStamp(string $commit, ?string $subject): void
    {
        @file_put_contents(self::stampPath(), json_encode([
            'commit'       => $commit,
            'subject'      => $subject,
            'app_version'  => APP_VERSION,
            'applied_at'   => date('c'),
        ], JSON_PRETTY_PRINT));

        @chmod(self::stampPath(), 0640);
    }

    // -----------------------------------------------------------------------
    // Local state
    // -----------------------------------------------------------------------

    /**
     * What this installation is, as far as it can tell.
     *
     * A git checkout can say exactly which commit it is on, which is the only
     * precise answer. A ZIP install cannot, so it falls back to the version
     * constant — which is coarse, and the report says so rather than implying
     * a precision it does not have.
     */
    public static function local(): array
    {
        $root     = APP_ROOT;
        $isGit    = is_dir($root . '/.git');
        $commit   = null;
        $branch   = null;
        $dirty    = null;
        $strays   = [];

        if ($isGit) {
            $commit = self::git($root, 'rev-parse HEAD');
            $branch = self::git($root, 'rev-parse --abbrev-ref HEAD');

            // --untracked-files=no on purpose. Modified TRACKED files are a
            // real obstacle: updating would overwrite somebody's edit. An
            // untracked file is not — it cannot conflict with a fast-forward,
            // and nothing will touch it.
            //
            // Counting untracked files here meant a stray directory left
            // beside the application refused every update with "uncommitted
            // changes", which is both wrong and impossible to act on: there
            // was nothing to commit.
            $status = self::git($root, 'status --porcelain --untracked-files=no');
            $dirty  = $status === null ? null : ($status !== '');

            // Reported, not enforced, so the panel can mention clutter without
            // it blocking anything.
            $untracked = self::git($root, 'ls-files --others --exclude-standard --directory');
            $strays    = ($untracked === null || $untracked === '')
                ? [] : array_slice(explode("\n", $untracked), 0, 10);
        }

        // No git, or git present but unusable (exec disabled): fall back to
        // what a previous file update wrote down.
        if ($commit === null) {
            $stamp  = self::readStamp();
            $commit = $stamp['commit'] ?? null;
        }

        return [
            'app_version'    => APP_VERSION,
            'schema_version' => Migrations::TARGET_VERSION,
            'install_method' => $isGit ? 'git' : 'files',
            'commit'         => $commit,
            'commit_short'   => $commit === null ? null : substr($commit, 0, 7),
            'branch'         => $branch,
            'has_local_changes' => $dirty,
            'untracked_files'   => $strays,
            'root'           => $root,
        ];
    }

    /**
     * Run a git command in the project, or null when git is unavailable.
     *
     * Shared hosting often has no git binary and often disables exec(), so
     * every call has to tolerate both without raising anything.
     */
    private static function git(string $root, string $arguments): ?string
    {
        if (!function_exists('exec') || in_array('exec', self::disabledFunctions(), true)) {
            return null;
        }

        $command = sprintf('cd %s && git %s 2>/dev/null', escapeshellarg($root), $arguments);

        $output = [];
        $code   = 1;

        try {
            @exec($command, $output, $code);
        } catch (\Throwable $e) {
            return null;
        }

        return $code === 0 ? trim(implode("\n", $output)) : null;
    }

    /** @return array<int, string> */
    private static function disabledFunctions(): array
    {
        return array_map('trim', explode(',', (string) ini_get('disable_functions')));
    }

    // -----------------------------------------------------------------------
    // Checking
    // -----------------------------------------------------------------------

    /**
     * Is there an update? Cached unless $force.
     *
     * Never throws. An update check that takes a settings page down with it
     * would be a worse problem than the one it is reporting.
     */
    public static function check(bool $force = false): array
    {
        $local = self::local();

        if (!$force) {
            $cached = self::readCache();
            if ($cached !== null) {
                return $cached + ['local' => $local, 'from_cache' => true];
            }
        }

        try {
            $result = self::ask($local);
        } catch (\Throwable $e) {
            error_log('[updates] check failed: ' . $e->getMessage());

            // A failure is cached too, briefly, so a blocked host does not
            // retry an eight-second timeout on every page load.
            $result = [
                'checked_at'   => date('c'),
                'reachable'    => false,
                'up_to_date'   => null,
                'behind_by'    => null,
                'latest'       => null,
                'summary'      => 'Could not reach GitHub to check for updates.',
                'detail'       => $e->getMessage()
                    . ' Many shared hosts block outbound HTTPS; if that is the case here, check for '
                    . 'updates from the command line or on github.com instead.',
                'how_to_apply' => null,
            ];
        }

        self::writeCache($result);

        return $result + ['local' => $local, 'from_cache' => false];
    }

    private static function ask(array $local): array
    {
        [$status, $body] = self::httpGet(
            self::API_HOST . '/repos/' . self::REPOSITORY . '/commits/' . self::BRANCH,
        );

        if ($status === 403 || $status === 429) {
            throw new \RuntimeException(
                'GitHub is rate limiting this server (HTTP ' . $status . '). Unauthenticated checks are '
                . 'limited to 60 an hour per address, which a shared host shares between accounts.',
            );
        }

        if ($status !== 200) {
            throw new \RuntimeException("GitHub returned HTTP {$status}.");
        }

        $head = json_decode($body, true);

        if (!is_array($head) || empty($head['sha'])) {
            throw new \RuntimeException('GitHub returned something unexpected.');
        }

        $latest = [
            'commit'       => $head['sha'],
            'commit_short' => substr((string) $head['sha'], 0, 7),
            'subject'      => self::firstLine((string) ($head['commit']['message'] ?? '')),
            'committed_at' => $head['commit']['committer']['date'] ?? null,
            'url'          => $head['html_url'] ?? null,
        ];

        // Without a local commit there is nothing to compare, so say what is
        // available and leave the judgement to a person rather than guessing.
        if ($local['commit'] === null) {
            return [
                'checked_at'   => date('c'),
                'reachable'    => true,
                'up_to_date'   => null,
                'behind_by'    => null,
                'latest'       => $latest,
                'summary'      => sprintf(
                    'The latest published version is %s (%s). This installation cannot tell which version '
                    . 'it is, because it was installed from files rather than cloned.',
                    $latest['commit_short'], self::humanDate($latest['committed_at']),
                ),
                'detail'       => null,
                'how_to_apply' => self::instructions($local, null),
            ];
        }

        if ($local['commit'] === $latest['commit']) {
            return [
                'checked_at'   => date('c'),
                'reachable'    => true,
                'up_to_date'   => true,
                'behind_by'    => 0,
                'latest'       => $latest,
                'summary'      => 'This installation is up to date.',
                'detail'       => null,
                'how_to_apply' => null,
            ];
        }

        $behind = self::countBehind($local['commit'], $latest['commit']);

        return [
            'checked_at'   => date('c'),
            'reachable'    => true,
            'up_to_date'   => false,
            'behind_by'    => $behind,
            'latest'       => $latest,
            'summary'      => $behind === null
                ? sprintf(
                    'An update is available: %s, "%s".',
                    $latest['commit_short'], $latest['subject'],
                )
                : sprintf(
                    '%d update%s available. The newest is %s, "%s" (%s).',
                    $behind, $behind === 1 ? '' : 's',
                    $latest['commit_short'], $latest['subject'],
                    self::humanDate($latest['committed_at']),
                ),
            'detail'       => null,
            'how_to_apply' => self::instructions($local, $behind),
        ];
    }

    /**
     * How many commits this installation is behind.
     *
     * Best effort: a fork-point comparison needs both commits to exist on the
     * server, and one installed from a ZIP has no history at all. Null means
     * "an update exists but the distance is unknown", which is honest.
     */
    private static function countBehind(string $localCommit, string $latestCommit): ?int
    {
        try {
            [$status, $body] = self::httpGet(sprintf(
                '%s/repos/%s/compare/%s...%s',
                self::API_HOST, self::REPOSITORY, $localCommit, $latestCommit,
            ));

            if ($status !== 200) {
                return null;
            }

            $compare = json_decode($body, true);

            return isset($compare['ahead_by']) ? (int) $compare['ahead_by'] : null;
        } catch (\Throwable $e) {
            return null;
        }
    }

    /**
     * What a person should actually type.
     *
     * Written out rather than left to the documentation, because the one thing
     * an administrator needs at this moment is the command for their own
     * installation, with their own path in it.
     */
    private static function instructions(array $local, ?int $behind): array
    {
        $root = $local['root'];

        if ($local['install_method'] !== 'git') {
            return [
                'method' => 'files',
                'steps'  => [
                    'Back up the database.',
                    'Run the command below on the server. It downloads the new version from '
                    . 'GitHub, keeps your data/ directory, and runs any database migrations.',
                    'Your configuration and uploaded photos are not touched.',
                ],
                'command' => sprintf('php %s --apply', escapeshellarg($root . '/bin/update.php')),
                'notice'  => 'This installation was uploaded rather than cloned, so the updater '
                           . 'replaces the files itself. It takes a backup first and tells you where '
                           . 'it put it.',
            ];
        }

        $warning = $local['has_local_changes'] === true
            ? 'This checkout has uncommitted local changes. Updating would conflict with them, so '
            . 'review `git status` before doing anything.'
            : null;

        return [
            'method'  => 'git',
            'steps'   => [
                'Back up the database and ' . $root . '/data.',
                'Run the command below on the server.',
                'Check the output: it says whether the database was upgraded.',
            ],
            'command' => sprintf('php %s --apply', escapeshellarg($root . '/bin/update.php')),
            'notice'  => $warning,
        ];
    }

    // -----------------------------------------------------------------------
    // Applying — command line only, never over HTTP
    // -----------------------------------------------------------------------

    /**
     * Pull and migrate.
     *
     * Refuses rather than forces: a clean, current checkout updates cleanly,
     * and anything else is a judgement for the person at the keyboard. From
     * the web this is reached only through applyFromWeb(), which has done the
     * authorisation first; any other non-console caller is refused below.
     */
    public static function apply(array $options = []): array
    {
        // The web path reaches this through applyFromWeb(), which does the
        // authorisation first. Anything else must be a console.
        if (PHP_SAPI !== 'cli' && empty($options['allowWeb'])) {
            throw new \RuntimeException('Updates can only be applied from the command line.');
        }

        self::acquireLock($options['by'] ?? 'the command line');

        try {
            return self::applyLocked($options);
        } finally {
            // Always released, including on failure: a crashed update must not
            // leave the site in maintenance.
            self::releaseLock();
        }
    }

    private static function applyLocked(array $options): array
    {
        $local = self::local();
        $log   = [];

        // No git, or git present but unusable: replace the files directly.
        // This is the common case on cPanel, where the project was uploaded as
        // a ZIP and exec() is often disabled.
        if ($local['install_method'] !== 'git' || self::git($local['root'], 'rev-parse HEAD') === null) {
            return self::applyFromArchive($local, $options);
        }

        if ($local['has_local_changes'] === true) {
            throw new \RuntimeException(
                'This checkout has uncommitted changes. Updating would overwrite or conflict with '
                . 'them. Run "git status" in ' . $local['root'] . ' and deal with them first.',
            );
        }

        $before = $local['commit'];
        $log[]  = 'Currently on ' . substr($before, 0, 7) . ' (' . ($local['branch'] ?? 'unknown branch') . ').';

        // Fetch and merge explicitly rather than `git pull`. Pull needs the
        // branch to have upstream tracking configured, and a checkout made with
        // `git init` + `git remote add` + `git reset --hard origin/main` has
        // none — it sits on a local branch (often "master") that pull refuses
        // with "there is no tracking information for the current branch".
        // Naming the remote and branch sidesteps all of that.
        if (self::git($local['root'], 'fetch origin ' . self::BRANCH) === null) {
            throw new \RuntimeException(
                'Could not fetch from GitHub. Check that this server has outbound HTTPS access, '
                . 'and that "git fetch origin ' . self::BRANCH . '" works in ' . $local['root'] . '.',
            );
        }

        $merge = self::git($local['root'], 'merge --ff-only FETCH_HEAD');

        if ($merge === null) {
            throw new \RuntimeException(
                'The update could not be applied as a fast-forward, which means this checkout has '
                . 'commits of its own that are not on GitHub. Run "git status" and "git log" in '
                . $local['root'] . ' to see what they are.',
            );
        }

        $log[] = str_contains($merge, 'Already up to date')
            ? 'Already up to date.'
            : 'Fetched and applied the latest code.';

        $after = self::git($local['root'], 'rev-parse HEAD');
        $log[] = 'Now on ' . substr((string) $after, 0, 7) . '.';

        // Migrations run against the database the new code expects. Done here
        // rather than left to the first web request so that a failure is seen
        // by the person doing the update, not by whoever next opens the app.
        if (Config::isInstalled()) {
            $from = Migrations::currentVersion();
            $migration = Migrations::run();
            $to   = Migrations::currentVersion();

            $log[] = $from === $to
                ? "Database schema already at version {$to}."
                : "Database schema upgraded from version {$from} to {$to}.";

            foreach (($migration['log'] ?? []) as $line) {
                $log[] = '  ' . $line;
            }
        } else {
            $log[] = 'Not installed yet, so no migrations were run.';
        }

        self::clearCache();

        return [
            'ok'      => true,
            'from'    => substr($before, 0, 7),
            'to'      => substr((string) $after, 0, 7),
            'changed' => $before !== $after,
            'log'     => $log,
        ];
    }

    /**
     * Apply an update from the browser.
     *
     * This exists because an administrator on shared hosting often has no
     * shell, and telling them to use one means they never update at all — an
     * application that is never patched is a worse risk than this endpoint.
     *
     * It is not simply the CLI path exposed over HTTP. Updating replaces the
     * code the server runs, so it is gated harder than anything else here:
     *
     *   - an administrator, by role, never an API key;
     *   - their password, re-entered, so a stolen session cookie or an XSS
     *     hole is not enough on its own;
     *   - one at a time, and the site returns 503 while files are swapped;
     *   - a backup first, with no option to skip it from the web;
     *   - recorded in the audit log with who, from what, to what.
     */
    public static function applyFromWeb(array $auth, mixed $password): array
    {
        if (($auth['actorType'] ?? '') !== 'user') {
            throw Util::forbidden(
                'Updating the software needs a signed-in administrator. An API key cannot do it, '
                . 'because a key that can replace the application is a key that can do anything.',
            );
        }

        if (($auth['role'] ?? '') !== 'admin') {
            throw Util::forbidden('Only an administrator can update the software.');
        }

        if (!is_string($password) || $password === '') {
            throw Util::badRequest(
                'Enter your password to confirm. Updating replaces the code this server runs, so it '
                . 'asks again rather than trusting the open session.',
                ['field' => 'password'],
            );
        }

        $user = Db::one(
            'SELECT id, password_hash, full_name FROM users WHERE id = ? AND organization_id = ?',
            [$auth['userId'], $auth['organizationId']],
        );

        if ($user === null || !Auth::verifyPassword($password, $user['password_hash'])) {
            // Logged, because repeated failures here are worth noticing.
            Audit::record($auth, [
                'action'     => Audit::LOGIN_FAILED,
                'entityType' => 'update',
                'summary'    => 'Failed password confirmation on a software update',
            ]);

            throw Util::badRequest('That password is not correct.', ['field' => 'password']);
        }

        $before = self::local();

        // Downloading and unpacking on a slow shared host takes longer than a
        // default web request is allowed. Nothing else in this application
        // raises the limit.
        @set_time_limit(600);
        @ignore_user_abort(true);

        $result = self::apply([
            'allowWeb' => true,
            'by'       => $user['full_name'],
        ]);

        Audit::record($auth, [
            'action'      => Audit::SETTINGS_UPDATED,
            'entityType'  => 'update',
            'entityLabel' => $result['to'],
            'summary'     => $result['changed']
                ? sprintf('Software updated from %s to %s by %s',
                    $result['from'], $result['to'], $user['full_name'])
                : 'Software update run; already on the latest version',
            'detail'      => [
                'from'           => $before['commit'] ?? null,
                'to'             => $result['to'],
                'install_method' => $before['install_method'],
                'log'            => $result['log'],
            ],
        ]);

        return $result;
    }

    /**
     * Update an installation that was uploaded rather than cloned.
     *
     * Downloads the exact commit the check reported — pinned by SHA, not by
     * branch name, so what is installed is what was inspected — verifies the
     * archive really is this application, backs up the current files, then
     * replaces them. data/ is never touched.
     *
     * There is no signature checking. The integrity story is HTTPS to GitHub
     * plus a SHA-pinned URL, and that is stated plainly rather than implied.
     */
    private static function applyFromArchive(array $local, array $options = []): array
    {
        $root = $local['root'];
        $log  = [];

        if (!is_writable($root)) {
            throw new \RuntimeException(
                "The application directory is not writable: {$root}. The web server user needs write "
                . 'access there to replace the files.',
            );
        }

        // 1. What should we be installing?
        $check = self::check(true);

        if (($check['reachable'] ?? false) !== true) {
            throw new \RuntimeException($check['summary'] . ' ' . ($check['detail'] ?? ''));
        }

        $target  = $check['latest']['commit'] ?? null;
        $subject = $check['latest']['subject'] ?? null;

        if ($target === null) {
            throw new \RuntimeException('GitHub did not report a current version.');
        }

        if ($local['commit'] === $target) {
            return [
                'ok' => true, 'from' => substr($target, 0, 7), 'to' => substr($target, 0, 7),
                'changed' => false, 'log' => ['Already on the latest version.'],
            ];
        }

        $log[] = 'Updating to ' . substr($target, 0, 7) . ($subject !== null ? ": {$subject}" : '');

        // 2. Fetch it, pinned to that exact commit.
        $workspace = Config::dataDir() . '/update-' . bin2hex(random_bytes(6));

        if (!@mkdir($workspace, 0700, true)) {
            throw new \RuntimeException("Could not create a working directory at {$workspace}.");
        }

        try {
            $extracted = self::downloadAndExtract($target, $workspace, $log);

            // 3. Refuse anything that is not recognisably this application,
            //    rather than emptying someone's site over a redirect page.
            foreach (['public/index.php', 'app/bootstrap.php', 'schema.sql', 'bin/update.php'] as $marker) {
                if (!is_file($extracted . '/' . $marker)) {
                    throw new \RuntimeException(
                        "The downloaded archive does not look like Loaner Pool ({$marker} is missing). "
                        . 'Nothing has been changed.',
                    );
                }
            }
            $log[] = 'Downloaded and verified the new version.';

            // 4. Back up what is about to be overwritten.
            // skipBackup is a console-only courtesy. From the browser there is
            // no way to turn it off: the person pressing the button is the one
            // least able to recover without it.
            if (empty($options['skipBackup']) || !empty($options['allowWeb'])) {
                $backup = self::backup($root, $log);
                $log[]  = 'Backup written to ' . $backup;
            } else {
                $log[] = 'Backup skipped at your request.';
            }

            // 5. Replace.
            $replaced = self::replaceFiles($extracted, $root);
            $log[]    = "Replaced {$replaced} file(s).";

            self::writeStamp($target, $subject);
        } finally {
            self::removeTree($workspace);
        }

        // 6. Bring the database up to the schema the new code expects.
        if (Config::isInstalled()) {
            Db::reset();

            $from      = Migrations::currentVersion();
            $migration = Migrations::run();
            $to        = Migrations::currentVersion();

            $log[] = $from === $to
                ? "Database schema already at version {$to}."
                : "Database schema upgraded from version {$from} to {$to}.";

            foreach (($migration['log'] ?? []) as $line) {
                $log[] = '  ' . $line;
            }
        }

        self::clearCache();

        return [
            'ok'      => true,
            'from'    => $local['commit'] === null ? 'unknown' : substr($local['commit'], 0, 7),
            'to'      => substr($target, 0, 7),
            'changed' => true,
            'log'     => $log,
        ];
    }

    /** Fetch the commit as an archive and unpack it. Returns the source root. */
    private static function downloadAndExtract(string $commit, string $workspace, array &$log): string
    {
        $url     = sprintf('https://codeload.github.com/%s/zip/%s', self::REPOSITORY, $commit);
        $archive = $workspace . '/release.zip';

        [$status, $body] = self::httpGet($url, 120);

        if ($status !== 200 || $body === '') {
            throw new \RuntimeException("Could not download the update (HTTP {$status}).");
        }

        if (@file_put_contents($archive, $body) === false) {
            throw new \RuntimeException("Could not write the download to {$archive}.");
        }

        if (!class_exists('ZipArchive')) {
            throw new \RuntimeException(
                'The zip extension is not available on this server, so the update cannot be unpacked. '
                . 'Enable it in your hosting control panel, or update the files by hand.',
            );
        }

        $zip = new \ZipArchive();

        if ($zip->open($archive) !== true) {
            throw new \RuntimeException('The downloaded archive could not be opened.');
        }

        if (!$zip->extractTo($workspace)) {
            $zip->close();
            throw new \RuntimeException('The downloaded archive could not be unpacked.');
        }

        $zip->close();

        // GitHub wraps everything in one directory named repo-<sha>.
        foreach ((array) glob($workspace . '/*', GLOB_ONLYDIR) as $candidate) {
            if (is_file($candidate . '/app/bootstrap.php')) {
                return $candidate;
            }
        }

        throw new \RuntimeException('The archive did not contain the application.');
    }

    /**
     * Copy a ZIP of the current files aside before replacing them.
     *
     * data/ is excluded: it is not being touched, and it holds the uploads,
     * which are the one thing on a loaner-pool server large enough to fill a
     * shared hosting quota.
     */
    private static function backup(string $root, array &$log): string
    {
        $path = Config::dataDir() . '/backup-' . date('Y-m-d-His') . '.zip';

        if (!class_exists('ZipArchive')) {
            throw new \RuntimeException(
                'The zip extension is not available, so no backup can be made. Re-run with '
                . '--no-backup only if you have backed the files up yourself.',
            );
        }

        $zip = new \ZipArchive();

        if ($zip->open($path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
            throw new \RuntimeException("Could not create a backup at {$path}.");
        }

        $count = 0;

        foreach (self::walk($root) as $absolute) {
            $relative = ltrim(substr($absolute, strlen($root)), '/');
            $zip->addFile($absolute, $relative);
            $count++;
        }

        $zip->close();
        @chmod($path, 0600);

        $log[] = "Backed up {$count} file(s).";

        return $path;
    }

    /**
     * Copy the new tree over the old one.
     *
     * Only files present in the release are written. Files that exist on the
     * server but not upstream are left alone: an orphan from an older version
     * is inert, because nothing references it, whereas deleting by rule would
     * eventually delete something an administrator put there on purpose.
     */
    private static function replaceFiles(string $source, string $root): int
    {
        $written = 0;

        foreach (self::walk($source) as $absolute) {
            $relative    = ltrim(substr($absolute, strlen($source)), '/');
            $destination = $root . '/' . $relative;

            // Never overwrite the data directory, whatever an archive claims.
            if ($relative === 'data' || str_starts_with($relative, 'data/')) {
                continue;
            }

            $directory = dirname($destination);

            if (!is_dir($directory) && !@mkdir($directory, 0755, true) && !is_dir($directory)) {
                throw new \RuntimeException("Could not create {$directory}.");
            }

            if (!@copy($absolute, $destination)) {
                throw new \RuntimeException(
                    "Could not write {$destination}. The update is incomplete — restore from the "
                    . 'backup noted above.',
                );
            }

            $written++;
        }

        return $written;
    }

    /**
     * Every file under a directory, skipping data/ and .git/.
     *
     * @return \Generator<string>
     */
    private static function walk(string $root): \Generator
    {
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveCallbackFilterIterator(
                new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS),
                static function (\SplFileInfo $file): bool {
                    $name = $file->getFilename();

                    // data/ holds the credentials and uploads; .git/ is huge
                    // and meaningless in a backup of the deployed files.
                    return !($file->isDir() && in_array($name, ['data', '.git'], true));
                },
            ),
            \RecursiveIteratorIterator::LEAVES_ONLY,
        );

        foreach ($iterator as $file) {
            if ($file->isFile()) {
                yield $file->getPathname();
            }
        }
    }

    private static function removeTree(string $path): void
    {
        if (!is_dir($path)) {
            return;
        }

        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST,
        );

        foreach ($iterator as $file) {
            $file->isDir() ? @rmdir($file->getPathname()) : @unlink($file->getPathname());
        }

        @rmdir($path);
    }

    // -----------------------------------------------------------------------
    // Plumbing
    // -----------------------------------------------------------------------

    /** @return array{0:int, 1:string} status, body */
    private static function httpGet(string $url, ?int $timeout = null): array
    {
        if (!function_exists('curl_init')) {
            throw new \RuntimeException('The curl extension is not available on this server.');
        }

        $ch = curl_init($url);

        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $timeout ?? self::TIMEOUT_SECONDS,
            CURLOPT_CONNECTTIMEOUT => 5,
            // codeload redirects; the version check does not, but following
            // is safe here because the URL is pinned to a commit SHA.
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 5,
            CURLOPT_HTTPHEADER     => [
                'Accept: application/vnd.github+json',
                // GitHub requires a User-Agent and rejects requests without
                // one. It names the software, never the site or its operator:
                // checking for an update should not announce who is running it.
                'User-Agent: LoanerPool/' . APP_VERSION,
            ],
        ]);

        $response = curl_exec($ch);
        $status   = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error    = curl_error($ch);
        // See the note in Mailer: curl_close() is a deprecated no-op since 8.0.

        if ($response === false) {
            throw new \RuntimeException($error !== '' ? $error : 'The request failed.');
        }

        return [$status, (string) $response];
    }

    private static function readCache(): ?array
    {
        $path = self::cachePath();

        if (!is_file($path)) {
            return null;
        }

        $raw = @file_get_contents($path);
        if ($raw === false) {
            return null;
        }

        $cached = json_decode($raw, true);
        if (!is_array($cached) || empty($cached['checked_at'])) {
            return null;
        }

        $age = time() - (strtotime((string) $cached['checked_at']) ?: 0);

        // A failed check is retried much sooner than a successful one: a host
        // that was briefly offline should not be told it cannot check for the
        // next six hours.
        $ttl = (($cached['reachable'] ?? false) ? self::CACHE_MINUTES : 15) * 60;

        return $age < $ttl ? $cached : null;
    }

    private static function writeCache(array $result): void
    {
        $path = self::cachePath();
        $dir  = dirname($path);

        if (!is_dir($dir)) {
            return;
        }

        // Best effort throughout: a read-only data directory should not stop
        // the check working, only stop it being remembered.
        $temp = $path . '.' . getmypid() . '.tmp';

        if (@file_put_contents($temp, json_encode($result, JSON_PRETTY_PRINT)) === false) {
            return;
        }

        @chmod($temp, 0600);

        if (!@rename($temp, $path)) {
            @unlink($temp);
        }
    }

    public static function clearCache(): void
    {
        @unlink(self::cachePath());
    }

    private static function firstLine(string $text): string
    {
        $line = trim(explode("\n", $text)[0] ?? '');

        return mb_strlen($line) > 120 ? mb_substr($line, 0, 119) . '…' : $line;
    }

    private static function humanDate(mixed $value): string
    {
        if (empty($value)) {
            return 'date unknown';
        }

        $timestamp = strtotime((string) $value);

        return $timestamp === false ? 'date unknown' : date('j M Y', $timestamp);
    }
}
