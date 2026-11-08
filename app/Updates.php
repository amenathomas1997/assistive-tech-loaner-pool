<?php
/**
 * Update checking.
 *
 * Asks GitHub whether this installation is behind, and says what to do about
 * it. Deliberately split in two:
 *
 *   - Checking is safe, so the web interface does it and shows a notice.
 *   - Applying is not, so only the command line can do that. A web route that
 *     pulls code and runs migrations is a remote code execution path the day
 *     its credential leaks, and an agency that cannot read a server log is the
 *     last place that should have one.
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

        if ($isGit) {
            $commit = self::git($root, 'rev-parse HEAD');
            $branch = self::git($root, 'rev-parse --abbrev-ref HEAD');

            // Local edits matter: pulling over them either conflicts or
            // silently discards somebody's fix, and they should be told which
            // before anything is applied.
            $status = self::git($root, 'status --porcelain');
            $dirty  = $status === null ? null : ($status !== '');
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
                'Open any page in the app: schema migrations apply on the next request.',
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
     * and anything else is a judgement for the person at the keyboard. Nothing
     * here is reachable from the web.
     */
    public static function apply(array $options = []): array
    {
        if (PHP_SAPI !== 'cli') {
            throw new \RuntimeException('Updates can only be applied from the command line.');
        }

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

        $pull = self::git($local['root'], 'pull --ff-only');

        if ($pull === null) {
            throw new \RuntimeException(
                'git pull failed. The usual cause is a branch that cannot fast-forward, which means '
                . 'this checkout has commits of its own. Run "git pull" directly to see why.',
            );
        }

        $log[] = trim($pull) === 'Already up to date.' ? 'Already up to date.' : 'Pulled the latest code.';

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
            if (empty($options['skipBackup'])) {
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
