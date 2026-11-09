<?php
/**
 * Authentication, sessions, roles and API keys.
 *
 * Two ways in:
 *   Browser — session cookie backed by the `sessions` table.
 *   API     — `Authorization: Bearer lp_<prefix>_<secret>` against `api_keys`.
 *
 * Both populate $request->auth with the same shape, so handlers never care
 * which was used; only the permission source differs (a user has a role, a key
 * has scopes).
 *
 * Sessions are kept in the database rather than PHP's native session handler.
 * That is what makes "changing your password signs you out everywhere" and
 * "deactivating a user takes effect immediately" actually true — neither is
 * possible when sessions are files in /tmp that only their owner can reach.
 */

declare(strict_types=1);

namespace Loaner;

final class Auth
{
    public const SESSION_COOKIE = 'loaner_session';

    private const BCRYPT_COST = 12;

    // Failed-login throttling. Deliberately modest: this is an internal tool,
    // and locking a technician out of the check-in desk mid-clinic is its own
    // kind of outage.
    private const MAX_FAILED_LOGINS = 8;
    private const LOCKOUT_MINUTES   = 15;

    public const ROLES = ['admin', 'tech', 'vrc', 'viewer'];

    public const ROLE_LABELS = [
        'admin'  => 'Administrator',
        'tech'   => 'Technician',
        'vrc'    => 'Vocational Rehabilitation Counselor',
        'viewer' => 'Read-only',
    ];

    /**
     * Capability map. Routes ask for a capability, not a role, so adding a
     * role later means editing this table rather than hunting for role checks.
     */
    public const CAPABILITIES = [
        'admin' => [
            'devices.read', 'devices.write', 'devices.import', 'devices.delete',
            'loans.read', 'loans.write', 'loans.cancel',
            'requests.read', 'requests.write', 'requests.approve', 'requests.fulfill',
            'clients.read', 'clients.write',
            'programs.read', 'programs.write',
            'users.read', 'users.write',
            'settings.read', 'settings.write',
            'audit.read', 'reports.read',
            'apikeys.read', 'apikeys.write',
            'scan.use',
        ],
        'tech' => [
            'devices.read', 'devices.write', 'devices.import',
            'loans.read', 'loans.write', 'loans.cancel',
            'requests.read', 'requests.write', 'requests.approve', 'requests.fulfill',
            'clients.read', 'clients.write',
            'programs.read',
            'users.read',
            'settings.read',
            'audit.read', 'reports.read',
            'scan.use',
        ],
        'vrc' => [
            'devices.read',
            'loans.read',
            'requests.read', 'requests.write',
            'clients.read', 'clients.write',
            'programs.read',
            'reports.read',
        ],
        'viewer' => [
            'devices.read', 'loans.read', 'requests.read',
            'clients.read', 'programs.read', 'reports.read', 'audit.read',
        ],
    ];

    /**
     * API key scopes. Coarse on purpose: fine-grained scopes are a maintenance
     * burden nobody audits, and three levels mapping onto roles are enough.
     */
    public const API_SCOPES = ['read', 'write', 'admin'];

    private const SCOPE_CAPABILITIES = [
        'read'  => 'viewer',
        'write' => 'tech',
        'admin' => 'admin',
    ];

    public static function capabilitiesForRole(?string $role): array
    {
        return self::CAPABILITIES[$role] ?? [];
    }

    private static function capabilitiesForScopes(array $scopes): array
    {
        $caps = [];
        foreach ($scopes as $scope) {
            $role = self::SCOPE_CAPABILITIES[$scope] ?? null;
            if ($role !== null) {
                $caps = array_merge($caps, self::CAPABILITIES[$role]);
            }
        }
        return array_values(array_unique($caps));
    }

    // -----------------------------------------------------------------------
    // Passwords
    // -----------------------------------------------------------------------

    public static function hashPassword(string $plain): string
    {
        return password_hash($plain, PASSWORD_BCRYPT, ['cost' => self::BCRYPT_COST]);
    }

    public static function verifyPassword(string $plain, ?string $hash): bool
    {
        return $hash !== null && $hash !== '' && password_verify($plain, $hash);
    }

    /**
     * Password rules. Length does the heavy lifting; character-class rules
     * mostly produce "Password1!", so this requires one non-letter rather
     * than four classes.
     */
    public static function validatePassword(?string $password): void
    {
        $value    = (string) $password;
        $problems = [];

        if (mb_strlen($value) < 12) {
            $problems[] = 'be at least 12 characters long';
        }
        if (mb_strlen($value) > 200) {
            $problems[] = 'be no longer than 200 characters';
        }
        if (!preg_match('/[a-zA-Z]/', $value)) {
            $problems[] = 'contain at least one letter';
        }
        if (!preg_match('/[^a-zA-Z]/', $value)) {
            $problems[] = 'contain at least one number or symbol';
        }

        $lowered = strtolower($value);
        foreach (['password', 'loanerpool', 'letmein', '12345678', 'qwerty', 'changeme'] as $bad) {
            if (str_contains($lowered, $bad)) {
                $problems[] = 'not contain a common word like "password" or "changeme"';
                break;
            }
        }

        if ($problems !== []) {
            throw Util::badRequest(
                'Password must ' . implode(', ', $problems) . '.',
                ['field' => 'password', 'problems' => $problems],
            );
        }
    }

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    public static function createSession(int $userId, string $ip, ?string $userAgent, ?int $lifetimeHours = null): array
    {
        $id           = bin2hex(random_bytes(32));
        $lifetimeDays = (int) (Config::get()['session']['lifetimeDays'] ?? 14);
        $expiresAt    = $lifetimeHours !== null
            ? new \DateTimeImmutable("+{$lifetimeHours} hours")
            : Util::addDays(new \DateTimeImmutable(), $lifetimeDays ?: 14);

        Db::execute(
            'INSERT INTO sessions (id, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)',
            [$id, $userId, $ip ?: null, $userAgent !== null ? mb_substr($userAgent, 0, 255) : null,
             Util::mysqlDateTime($expiresAt)],
        );

        return ['id' => $id, 'expiresAt' => $expiresAt];
    }

    public static function loadSession(?string $sessionId): ?array
    {
        if ($sessionId === null || !preg_match('/^[a-f0-9]{64}$/', $sessionId)) {
            return null;
        }

        $row = Db::one(
            'SELECT s.id, s.user_id, s.expires_at,
                    u.organization_id, u.email, u.full_name, u.role, u.active, u.must_change_password
               FROM sessions s
               JOIN users u ON u.id = s.user_id
              WHERE s.id = ? AND s.expires_at > NOW()',
            [$sessionId],
        );

        if ($row === null || (int) $row['active'] !== 1) {
            return null;
        }

        return $row;
    }

    public static function destroySession(?string $sessionId): void
    {
        if ($sessionId === null || $sessionId === '') {
            return;
        }
        Db::execute('DELETE FROM sessions WHERE id = ?', [$sessionId]);
    }

    public static function destroyAllSessionsForUser(int $userId): void
    {
        Db::execute('DELETE FROM sessions WHERE user_id = ?', [$userId]);
    }

    public static function pruneExpiredSessions(): int
    {
        return Db::execute('DELETE FROM sessions WHERE expires_at < NOW()');
    }

    public static function sendSessionCookie(string $id, \DateTimeInterface $expiresAt): void
    {
        setcookie(self::SESSION_COOKIE, $id, [
            'expires'  => $expiresAt->getTimestamp(),
            'path'     => '/',
            'httponly' => true,
            'samesite' => 'Lax',
            'secure'   => self::cookieMustBeSecure(),
        ]);
    }

    public static function clearSessionCookie(): void
    {
        setcookie(self::SESSION_COOKIE, '', [
            'expires'  => time() - 3600,
            'path'     => '/',
            'httponly' => true,
            'samesite' => 'Lax',
            'secure'   => self::cookieMustBeSecure(),
        ]);
    }

    /**
     * Whether the session cookie carries the Secure flag.
     *
     * Either because the configuration says so, or because this very request
     * arrived over TLS. The second rule is the one that matters: the installer
     * sets the configuration flag from the URL it was run at, and a site that
     * later gained HTTPS keeps a config that says false. A session issued over
     * HTTPS must never be sent back over plain HTTP, whatever a file written
     * on installation day says — and a cookie marked Secure costs nothing on a
     * site that is HTTPS anyway.
     */
    public static function cookieMustBeSecure(): bool
    {
        return (bool) (Config::get()['session']['secureCookies'] ?? false) || Request::detectSecure();
    }

    // -----------------------------------------------------------------------
    // Sign in
    // -----------------------------------------------------------------------

    /**
     * Verify credentials.
     *
     * Returns ['ok' => false, 'reason' => ...] rather than throwing, so the
     * caller can audit the real reason before telling the client the same
     * generic message regardless.
     */
    public static function attemptLogin(string $email, string $password): array
    {
        $user = Db::one(
            'SELECT id, organization_id, email, password_hash, full_name, role, active,
                    failed_logins, locked_until, must_change_password,
                    totp_enabled, totp_secret
               FROM users WHERE email = ? LIMIT 1',
            [strtolower($email)],
        );

        if ($user === null) {
            // Spend roughly the same time as a real verify so response timing
            // does not reveal whether an address is registered.
            password_hash('timing-equalisation-placeholder', PASSWORD_BCRYPT, ['cost' => self::BCRYPT_COST]);
            return ['ok' => false, 'reason' => 'no_such_user'];
        }

        if ((int) $user['active'] !== 1) {
            return ['ok' => false, 'reason' => 'inactive', 'user' => $user];
        }

        if ($user['locked_until'] !== null && strtotime((string) $user['locked_until']) > time()) {
            return ['ok' => false, 'reason' => 'locked', 'user' => $user, 'lockedUntil' => $user['locked_until']];
        }

        if (!self::verifyPassword($password, $user['password_hash'])) {
            $failed     = self::failedLoginsAfterMiss((int) $user['failed_logins'], $user['locked_until']);
            $shouldLock = $failed >= self::MAX_FAILED_LOGINS;

            Db::execute(
                'UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?',
                [
                    $failed,
                    $shouldLock
                        ? Util::mysqlDateTime(new \DateTimeImmutable('+' . self::LOCKOUT_MINUTES . ' minutes'))
                        : null,
                    $user['id'],
                ],
            );

            return ['ok' => false, 'reason' => 'bad_password', 'user' => $user];
        }

        Db::execute(
            'UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?',
            [$user['id']],
        );

        // After the password check, so only somebody who knows the password
        // learns that this account has to use Microsoft instead.
        if (!Sso::passwordAllowed($user)) {
            return ['ok' => false, 'reason' => 'sso_required', 'user' => $user];
        }

        // The password was right, but it is not a sign-in yet if a second
        // factor is expected. last_login_at is deliberately not touched here:
        // it should mean "last got in", not "last typed the right password".
        if (self::needsSecondFactor($user)) {
            return [
                'ok'          => false,
                'reason'      => 'totp_required',
                'user'        => $user,
                'pendingId'   => self::createPendingLogin((int) $user['id']),
                'canRecover'  => Totp::remainingRecoveryCodes((int) $user['id']) > 0,
            ];
        }

        Db::execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [$user['id']]);

        return ['ok' => true, 'user' => $user];
    }

    /**
     * The failed-attempt count after one more miss.
     *
     * The count was never reset when a lockout expired. It sat at the
     * threshold, so the first wrong password after the fifteen minutes were
     * up locked the account again — and the person was told "not recognised"
     * rather than "locked", because the lock is set on the attempt that
     * trips it and only reported on the next. One mistyped password every
     * fifteen minutes kept an account locked indefinitely, which is the
     * outage the comment on MAX_FAILED_LOGINS says this must not cause.
     *
     * So an expired lockout starts a fresh window: the miss that ends it
     * counts as the first of a new eight, not the ninth of the old.
     *
     * Pure, so the rule can be checked without a database.
     *
     * @param string|null $lockedUntil MySQL datetime, or null when never locked
     */
    public static function failedLoginsAfterMiss(int $previousFailed, ?string $lockedUntil, ?int $now = null): int
    {
        $now = $now ?? time();

        if ($lockedUntil !== null && strtotime($lockedUntil) <= $now) {
            return 1;
        }

        return $previousFailed + 1;
    }

    /**
     * Does this account have to produce a code?
     *
     * Either because the person turned it on, or because the organisation
     * requires it of administrators. In the second case an administrator who
     * has not set it up yet is NOT blocked at the door — they would have no
     * way to enrol — they are let in and told to enrol.
     */
    public static function needsSecondFactor(array $user): bool
    {
        return (int) ($user['totp_enabled'] ?? 0) === 1 && !empty($user['totp_secret']);
    }

    /**
     * Must this person enrol before they can do anything else?
     *
     * Checked after sign-in rather than during it, so turning the requirement
     * on cannot lock out the administrator who turned it on.
     */
    public static function mustEnrolSecondFactor(array $user, int $organizationId): bool
    {
        return ($user['role'] ?? '') === 'admin'
            && (int) ($user['totp_enabled'] ?? 0) !== 1
            && (bool) Settings::get($organizationId, 'security.require_2fa_for_admins');
    }

    // -----------------------------------------------------------------------
    // The half-finished sign-in
    //
    // Held server-side rather than in a cookie or a hidden field, so the
    // browser cannot skip from "password accepted" to "signed in" by editing
    // what it was given.
    // -----------------------------------------------------------------------

    /** Minutes to produce a code before the attempt has to start again. */
    private const PENDING_MINUTES = 10;

    /** Wrong codes allowed before the attempt is abandoned. */
    private const MAX_TOTP_ATTEMPTS = 5;

    private static function createPendingLogin(int $userId): string
    {
        Db::execute('DELETE FROM pending_logins WHERE user_id = ? OR expires_at < NOW()', [$userId]);

        $id = Util::randomToken(32);

        Db::execute(
            'INSERT INTO pending_logins (id, user_id, ip, user_agent, expires_at)
             VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))',
            [
                Util::sha256($id), $userId,
                $_SERVER['REMOTE_ADDR'] ?? null,
                mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
                self::PENDING_MINUTES,
            ],
        );

        return $id;
    }

    /**
     * Finish a sign-in with a code, or with a recovery code.
     *
     * @return array{ok: bool, reason?: string, user?: array, usedRecovery?: bool}
     */
    public static function completeSecondFactor(string $pendingId, string $code): array
    {
        // Columns are named explicitly rather than taking p.*, because
        // pending_logins has its own "id" and a SELECT p.* quietly puts that
        // where a caller reasonably expects the user's id. That cost a
        // foreign-key violation on session creation, from a value that looked
        // like an id right up until it was used as one.
        $pending = Db::one(
            'SELECT p.attempts, p.expires_at,
                    u.id AS user_id, u.organization_id, u.email, u.full_name, u.role,
                    u.active, u.must_change_password, u.totp_secret, u.totp_enabled,
                    u.totp_last_counter
               FROM pending_logins p JOIN users u ON u.id = p.user_id
              WHERE p.id = ? AND p.expires_at > NOW()',
            [Util::sha256($pendingId)],
        );

        if ($pending === null) {
            return ['ok' => false, 'reason' => 'expired'];
        }

        if ((int) $pending['attempts'] >= self::MAX_TOTP_ATTEMPTS) {
            Db::execute('DELETE FROM pending_logins WHERE id = ?', [Util::sha256($pendingId)]);
            return ['ok' => false, 'reason' => 'too_many_attempts'];
        }

        $secret = Secrets::decrypt((string) $pending['totp_secret']);
        $clean  = trim($code);

        // A recovery code is the way back in from a lost phone, which is the
        // commonest reason anyone is stuck here. Tried second so a genuine
        // six-digit code never burns one.
        $usedRecovery = false;

        // A code is right for a particular thirty-second step, and that step
        // may be spent once. Without this, a code glimpsed over a shoulder
        // worked for the rest of its ninety-second window — after the owner
        // had already used it. claimCounter() refuses a step at or before the
        // last one accepted, atomically, so two sign-ins racing on one code
        // cannot both get through (RFC 6238 §5.2).
        $counter = Totp::matchCounter((string) $secret, $clean);
        $accepted = $counter !== null && Totp::claimCounter((int) $pending['user_id'], $counter);

        if (!$accepted) {
            if (!Totp::consumeRecoveryCode((int) $pending['user_id'], $clean)) {
                Db::execute(
                    'UPDATE pending_logins SET attempts = attempts + 1 WHERE id = ?',
                    [Util::sha256($pendingId)],
                );

                return [
                    'ok'        => false,
                    'reason'    => 'bad_code',
                    'user'      => $pending,
                    'remaining' => self::MAX_TOTP_ATTEMPTS - ((int) $pending['attempts'] + 1),
                ];
            }

            $usedRecovery = true;
        }

        Db::execute('DELETE FROM pending_logins WHERE id = ?', [Util::sha256($pendingId)]);
        Db::execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [$pending['user_id']]);

        // Built explicitly, so what comes back is unambiguously a user row.
        return [
            'ok'   => true,
            'user' => [
                'id'                   => (int) $pending['user_id'],
                'organization_id'      => (int) $pending['organization_id'],
                'email'                => $pending['email'],
                'full_name'            => $pending['full_name'],
                'role'                 => $pending['role'],
                'must_change_password' => (int) $pending['must_change_password'],
            ],
            'usedRecovery'      => $usedRecovery,
            'recoveryRemaining' => Totp::remainingRecoveryCodes((int) $pending['user_id']),
        ];
    }

    /** Drop abandoned half-finished sign-ins. Called by the housekeeping job. */
    public static function prunePendingLogins(): int
    {
        return Db::execute('DELETE FROM pending_logins WHERE expires_at < NOW()');
    }

    // -----------------------------------------------------------------------
    // API keys
    //
    // Format: lp_<8-char prefix>_<48-char secret>. The prefix is stored plainly
    // so a key can be identified in the UI; only sha256(full key) is stored.
    // -----------------------------------------------------------------------

    public static function generateApiKey(): array
    {
        $prefix    = bin2hex(random_bytes(4));  // 8 chars
        $secret    = Util::randomToken(24);     // 48 chars
        $plaintext = "lp_{$prefix}_{$secret}";

        return ['plaintext' => $plaintext, 'prefix' => $prefix, 'hash' => Util::sha256($plaintext)];
    }

    public static function verifyApiKey(string $plaintext): ?array
    {
        if (!str_starts_with($plaintext, 'lp_')) {
            return null;
        }

        $hash = Util::sha256($plaintext);

        $row = Db::one(
            'SELECT k.*, o.name AS organization_name
               FROM api_keys k
               JOIN organizations o ON o.id = k.organization_id
              WHERE k.key_hash = ?
                AND k.revoked_at IS NULL
                AND (k.expires_at IS NULL OR k.expires_at > NOW())
              LIMIT 1',
            [$hash],
        );

        if ($row === null) {
            return null;
        }

        // Defence in depth: the lookup was by hash, but compare again in
        // constant time so a future index change cannot become a bypass.
        if (!hash_equals((string) $row['key_hash'], $hash)) {
            return null;
        }

        // Telemetry, not correctness — never let it fail the request.
        try {
            Db::execute('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [$row['id']]);
        } catch (\Throwable) {
        }

        return $row;
    }

    // -----------------------------------------------------------------------
    // Request authentication
    // -----------------------------------------------------------------------

    /**
     * Populate $request->auth when a valid session cookie or API key is
     * present. Never rejects — that is the job of requireCapability(), so
     * public routes and the installer share the same pipeline.
     */
    public static function attach(Request $request): void
    {
        $header = $request->header('Authorization') ?? '';

        if (stripos($header, 'bearer ') === 0) {
            $key = self::verifyApiKey(trim(substr($header, 7)));

            if ($key !== null) {
                $scopes = array_values(array_filter(preg_split('/[,\s]+/', (string) $key['scopes']) ?: []));

                $request->auth = [
                    'actorType'      => 'api_key',
                    'apiKeyId'       => (int) $key['id'],
                    'organizationId' => (int) $key['organization_id'],
                    'userId'         => null,
                    'label'          => 'API key: ' . $key['name'],
                    'role'           => null,
                    'scopes'         => $scopes,
                    'capabilities'   => self::capabilitiesForScopes($scopes),
                    'ip'             => $request->ip,
                ];
            }

            return;
        }

        $sessionId = $request->cookie(self::SESSION_COOKIE);
        if ($sessionId === null) {
            return;
        }

        $session = self::loadSession($sessionId);

        if ($session === null) {
            // Stale or revoked cookie — clear it so the browser stops sending it.
            self::clearSessionCookie();
            return;
        }

        $request->auth = [
            'actorType'          => 'user',
            'sessionId'          => $session['id'],
            'userId'             => (int) $session['user_id'],
            'organizationId'     => (int) $session['organization_id'],
            'email'              => $session['email'],
            'fullName'           => $session['full_name'],
            'label'              => $session['full_name'],
            'role'               => $session['role'],
            'mustChangePassword' => (bool) $session['must_change_password'],
            'capabilities'       => self::capabilitiesForRole($session['role']),
            'ip'                 => $request->ip,
        ];
    }

    /**
     * Refuse a state-changing request that a browser sent from another site.
     *
     * The session cookie is SameSite=Lax, which stops a page on a different
     * *site* from posting here with the cookie attached. But "site" means the
     * registrable domain: a page on any other subdomain of the same domain is
     * same-site, its forms and fetches carry this cookie, and Lax does nothing.
     * An installation at loanerpool.example.org therefore trusts every other
     * thing hosted under example.org — on a shared account that is whatever
     * else the owner has put there, and its security, not this application's.
     *
     * Browsers send an Origin header on every cross-origin request that could
     * change state, and on same-origin POSTs too. So: if a cookie-authenticated
     * write arrives with an Origin for a different host, it did not come from
     * this application's own pages, and it is refused. A request with no
     * Origin at all is allowed through — that is a non-browser client such as
     * curl, which has no cookie jar an attacker can borrow.
     *
     * Host only, not scheme. Behind a proxy that terminates TLS the scheme
     * this process sees can differ from the one the browser used, and a check
     * that failed on that would lock every user out of every form.
     *
     * API keys are exempt: a bearer token is not sent by a browser on another
     * site's behalf, which is the whole problem being solved here.
     */
    public static function rejectCrossSiteWrite(Request $request): void
    {
        if (($request->auth['actorType'] ?? null) !== 'user') {
            return;
        }

        if (in_array($request->method, ['GET', 'HEAD', 'OPTIONS'], true)) {
            return;
        }

        $origin = $request->header('Origin');

        if ($origin === null || $origin === '' || $origin === 'null') {
            // No Origin: not a browser form or fetch. "null" is what a browser
            // sends from a sandboxed or opaque context, and a write from one
            // of those is not something this application ever does itself.
            if ($origin === 'null') {
                throw new HttpError(403, 'cross_site_request', self::CROSS_SITE_MESSAGE);
            }

            return;
        }

        if (!self::sameHost($origin, (string) ($_SERVER['HTTP_HOST'] ?? ''))) {
            throw new HttpError(403, 'cross_site_request', self::CROSS_SITE_MESSAGE);
        }
    }

    /**
     * Does an Origin name the host this request was addressed to?
     *
     * Hostnames only. Ports are dropped from both sides: HTTP_HOST carries one
     * only when it is not the scheme's default and Origin likewise, so a
     * literal comparison fails on exactly the ordinary case of a proxy on 443
     * in front of PHP on something else. Two ports on one hostname are not two
     * tenants on the hosting this is written for.
     *
     * Pure, so scripts/verify-security.php can table-test it.
     */
    public static function sameHost(string $origin, string $requestHost): bool
    {
        $originHost = strtolower((string) parse_url($origin, PHP_URL_HOST));

        if ($originHost === '') {
            return false;
        }

        $requestHost = strtolower(preg_replace('/:\d+$/', '', $requestHost) ?? '');

        // Bracketed IPv6 literals: parse_url strips the brackets, HTTP_HOST keeps them.
        $requestHost = trim($requestHost, '[]');
        $originHost  = trim($originHost, '[]');

        return $originHost === $requestHost;
    }

    private const CROSS_SITE_MESSAGE =
        'This request came from a page on a different site, so it was not carried out. '
        . 'If you were using Loaner Pool itself, reload the page and try again.';

    public static function requireAuth(Request $request): array
    {
        if ($request->auth === null) {
            throw Util::unauthorized();
        }
        return $request->auth;
    }

    /** Gate on a capability. Identical for sessions and API keys. */
    public static function requireCapability(Request $request, string $capability): array
    {
        $auth = self::requireAuth($request);

        if (!in_array($capability, $auth['capabilities'] ?? [], true)) {
            throw new HttpError(
                403,
                'forbidden',
                "This action requires the \"{$capability}\" permission.",
                [
                    'required' => $capability,
                    'role'     => $auth['role'] ?? null,
                    'scopes'   => $auth['scopes'] ?? null,
                ],
            );
        }

        return $auth;
    }

    /** Restrict to specific roles. Prefer requireCapability where possible. */
    public static function requireRole(Request $request, string ...$roles): array
    {
        $auth = self::requireAuth($request);

        if (($auth['actorType'] ?? '') === 'api_key') {
            // API keys have scopes, not roles. Treat "admin" scope as admin.
            if (in_array('admin', $roles, true) && in_array('admin', $auth['scopes'] ?? [], true)) {
                return $auth;
            }
            throw Util::forbidden('This endpoint is not available to API keys with these scopes.');
        }

        if (!in_array($auth['role'] ?? '', $roles, true)) {
            $labels = array_map(static fn (string $r): string => self::ROLE_LABELS[$r] ?? $r, $roles);
            throw Util::forbidden('This action is restricted to: ' . implode(', ', $labels) . '.');
        }

        return $auth;
    }

    /**
     * A counselor may only see their own requests and their own clients.
     * Routes call this to decide whether to add an ownership filter.
     */
    public static function isRestrictedToOwnRecords(?array $auth): bool
    {
        return ($auth['actorType'] ?? '') === 'user' && ($auth['role'] ?? '') === 'vrc';
    }

    /**
     * The user id a record-restricted caller is limited to, or null when they
     * may see everything.
     *
     * Routes use this instead of re-deriving the rule, so "a counselor sees
     * their own caseload" is expressed in one place. Returning null for
     * everyone else means a route can pass the result straight into a filter.
     */
    public static function ownRecordsOnly(?array $auth): ?int
    {
        return self::isRestrictedToOwnRecords($auth) ? (int) $auth['userId'] : null;
    }

    /**
     * Refuse a caller who may only see their own records.
     *
     * For the handful of endpoints that are inherently organisation-wide and
     * cannot be meaningfully narrowed — who else is borrowing what, what the
     * equipment cost. Scoping them would produce a report that looks complete
     * and is not, which is worse than refusing.
     */
    public static function requireFullRecordAccess(Request $request, string $what): array
    {
        $auth = self::requireAuth($request);

        if (self::isRestrictedToOwnRecords($auth)) {
            throw new HttpError(
                403,
                'forbidden',
                "{$what} covers everyone's records, so it is limited to technicians and "
                . 'administrators. You can see your own requests and clients from their own screens.',
                ['role' => $auth['role'] ?? null],
            );
        }

        return $auth;
    }

    /** Public-safe view of a user row. */
    public static function publicUser(?array $user): ?array
    {
        if ($user === null) {
            return null;
        }

        return [
            'id'            => (int) $user['id'],
            'email'         => $user['email'],
            'full_name'     => $user['full_name'],
            'role'          => $user['role'],
            'role_label'    => self::ROLE_LABELS[$user['role']] ?? $user['role'],
            'phone'         => $user['phone'] ?? null,
            'employee_ref'  => $user['employee_ref'] ?? null,
            'active'        => !isset($user['active']) || (bool) $user['active'],
            'last_login_at' => $user['last_login_at'] ?? null,
            'created_at'    => $user['created_at'] ?? null,
        ];
    }
}
