<?php
/**
 * Sign in with Microsoft Entra ID (formerly Azure AD).
 *
 * OpenID Connect authorization code flow with PKCE, written against the
 * protocol directly because this application has no Composer dependencies.
 * The browser is sent to Microsoft and comes back with a one-time code; this
 * server swaps the code for an ID token over TLS and creates an ordinary
 * session from it. Nothing after that point knows how the person signed in.
 *
 * The decisions that matter:
 *
 * One tenant, by GUID. "common" and "organizations" would accept an account
 * from any Microsoft directory on earth, so they are refused, and the token's
 * tid has to match.
 *
 * The account is identified by oid, never by email. The email claim is an
 * attribute that can be edited and is not verified, and trusting it is the
 * flaw known as nOAuth. preferred_username is used exactly once, to find the
 * staff account the first time somebody signs in, and from then on the oid
 * recorded against that account is what counts. A new person who inherits a
 * departed colleague's address has a different oid and is refused.
 *
 * The ID token's signature is not checked, and that is deliberate: it came
 * straight from Microsoft's token endpoint over TLS, in exchange for a code
 * and a client secret, which OpenID Connect Core 3.1.3.7 says is sufficient.
 * Its claims are all checked.
 *
 * Multi-factor is Microsoft's. A Microsoft sign-in does not also ask for this
 * application's own second factor; Conditional Access is the place to set that
 * policy.
 *
 * Sessions are shorter than password sessions (sso.session_hours, 24 by
 * default). Disabling somebody in Entra cannot reach into this database, so
 * the session length is how long a departed employee could keep working.
 */

declare(strict_types=1);

namespace Loaner;

final class Sso
{
    private const STATE_MINUTES = 10;
    private const COOKIE        = 'loaner_sso';

    /** What an account created at first sign-in may be. Never administrator. */
    public const CREATABLE_ROLES = ['viewer', 'vrc', 'tech'];

    private const GUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    /** Overridable only from the server's environment, for the test suite's stand-in. */
    private static function authority(): string
    {
        return rtrim(getenv('LOANER_SSO_AUTHORITY') ?: 'https://login.microsoftonline.com', '/');
    }

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    /** @return array<string, mixed> */
    public static function config(int $organizationId): array
    {
        $settings = Settings::all($organizationId);

        $config = [
            'enabled'      => (bool) $settings['sso.enabled'],
            'tenantId'     => trim((string) $settings['sso.tenant_id']),
            'clientId'     => trim((string) $settings['sso.client_id']),
            'clientSecret' => (string) ($settings['sso.client_secret'] ?? ''),
        ];

        $missing = [];
        if ($config['tenantId'] === '')     { $missing[] = 'Directory (tenant) ID'; }
        if ($config['clientId'] === '')     { $missing[] = 'Application (client) ID'; }
        if ($config['clientSecret'] === '') { $missing[] = 'Client secret'; }

        $badTenant = $config['tenantId'] !== '' && !preg_match(self::GUID, $config['tenantId']);

        $config['missing'] = $missing;
        $config['usable']  = $config['enabled'] && $missing === [] && !$badTenant;
        $config['reason']  = match (true) {
            !$config['enabled'] => 'Microsoft sign-in is switched off.',
            $missing !== []     => 'Microsoft sign-in is not fully set up. Missing: ' . implode(', ', $missing) . '.',
            $badTenant          => 'The tenant has to be your directory\'s ID, in the form '
                                 . '00000000-0000-0000-0000-000000000000. A name such as "common" would '
                                 . 'let in accounts from any organisation.',
            default             => null,
        };

        return $config;
    }

    /** Which organisation the sign-in button belongs to. One tenant per installation. */
    public static function organization(): ?int
    {
        foreach (Db::all('SELECT id FROM organizations WHERE active = 1 ORDER BY id') as $row) {
            if (self::config((int) $row['id'])['usable']) {
                return (int) $row['id'];
            }
        }

        return null;
    }

    /** What the sign-in page needs. Contains nothing secret. */
    public static function publicStatus(): array
    {
        $organizationId = self::organization();

        return [
            'enabled'  => $organizationId !== null,
            'required' => $organizationId !== null
                && (bool) Settings::get($organizationId, 'sso.required'),
        ];
    }

    /** For the settings screen. */
    public static function adminStatus(int $organizationId, Request $request): array
    {
        $config = self::config($organizationId);

        return [
            'usable'       => $config['usable'],
            'reason'       => $config['reason'],
            'redirect_uri' => self::redirectUri($request),
            'https'        => str_starts_with(self::redirectUri($request), 'https://'),
        ];
    }

    /**
     * May this person sign in with a password?
     *
     * Administrators always may. With Microsoft sign-in required and the tenant
     * unreachable or misconfigured, somebody has to be able to get in and fix it.
     */
    public static function passwordAllowed(array $user): bool
    {
        $organizationId = (int) $user['organization_id'];

        return ($user['role'] ?? '') === 'admin'
            || !Settings::get($organizationId, 'sso.required')
            || !self::config($organizationId)['usable'];
    }

    private static function redirectUri(Request $request): string
    {
        return $request->baseUrl() . '/api/v1/auth/sso/callback';
    }

    // -----------------------------------------------------------------------
    // Leaving for Microsoft
    // -----------------------------------------------------------------------

    public static function start(Request $request): never
    {
        $popup          = (string) $request->queryParam('popup') === '1';
        $organizationId = self::organization();

        if ($organizationId === null) {
            self::finish('not_configured', $popup);
        }

        // This endpoint needs no sign-in and adds a row, so old rows go here as
        // well as in the nightly job, which may not be set up yet.
        self::prune();

        $config   = self::config($organizationId);
        $state    = bin2hex(random_bytes(32));
        $nonce    = bin2hex(random_bytes(32));
        $verifier = self::base64Url(random_bytes(48));
        $browser  = bin2hex(random_bytes(32));

        Db::execute(
            'INSERT INTO sso_states
                 (state_hash, browser_hash, organization_id, nonce, code_verifier, popup, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))',
            [Util::sha256($state), Util::sha256($browser), $organizationId, $nonce, $verifier,
             $popup ? 1 : 0, self::STATE_MINUTES],
        );

        // Ties the round trip to this browser. Without it somebody could start
        // a sign-in of their own, get a victim to finish it, and have the
        // victim working inside the attacker's account.
        setcookie(self::COOKIE, $browser, [
            'expires'  => time() + self::STATE_MINUTES * 60,
            'path'     => '/api/',
            'httponly' => true,
            'samesite' => 'Lax',
            'secure'   => Auth::cookieMustBeSecure(),
        ]);

        Response::redirect(self::authority() . '/' . rawurlencode($config['tenantId'])
            . '/oauth2/v2.0/authorize?' . http_build_query([
                'client_id'             => $config['clientId'],
                'response_type'         => 'code',
                'response_mode'         => 'query',
                'redirect_uri'          => self::redirectUri($request),
                'scope'                 => 'openid profile email',
                'state'                 => $state,
                'nonce'                 => $nonce,
                'code_challenge'        => self::base64Url(hash('sha256', $verifier, true)),
                'code_challenge_method' => 'S256',
                // A front desk computer is shared; never assume the last person.
                'prompt'                => 'select_account',
            ]));
    }

    // -----------------------------------------------------------------------
    // Coming back
    // -----------------------------------------------------------------------

    public static function callback(Request $request): never
    {
        $state = $request->queryParam('state');
        $row   = is_string($state) && $state !== ''
            ? Db::one(
                'SELECT * FROM sso_states WHERE state_hash = ? AND expires_at > NOW()',
                [Util::sha256($state)],
            )
            : null;

        $cookie = $request->cookie(self::COOKIE);

        self::clearCookie();

        if ($row === null) {
            self::finish('expired', false);
        }

        $popup          = (int) $row['popup'] === 1;
        $organizationId = (int) $row['organization_id'];

        // Spent whatever happens next, and only one request can spend it.
        if (Db::execute('DELETE FROM sso_states WHERE state_hash = ?', [$row['state_hash']]) !== 1) {
            self::finish('expired', $popup);
        }

        if (!is_string($cookie) || !hash_equals((string) $row['browser_hash'], Util::sha256($cookie))) {
            self::refuse($organizationId, 'expired', 'the sign-in was finished in a different browser', $popup);
        }

        $providerError = $request->queryParam('error');
        if ($providerError !== null) {
            if ($providerError === 'access_denied') {
                self::finish('cancelled', $popup);
            }
            self::refuse($organizationId, 'failed', 'Microsoft returned ' . Util::str($providerError, 80), $popup);
        }

        $code   = $request->queryParam('code');
        $config = self::config($organizationId);

        if (!is_string($code) || $code === '' || !$config['usable']) {
            self::refuse($organizationId, 'failed', 'no authorization code came back', $popup);
        }

        try {
            $claims = self::redeem($config, $code, (string) $row['code_verifier'], self::redirectUri($request));
        } catch (\RuntimeException $e) {
            self::refuse($organizationId, 'failed', $e->getMessage(), $popup);
        }

        $problem = self::claimProblem(
            $claims,
            self::authority(),
            $config['tenantId'],
            $config['clientId'],
            (string) $row['nonce'],
            time(),
        );

        if ($problem !== null) {
            self::refuse($organizationId, $problem === 'guest' ? 'guest' : 'failed', "the token was refused: {$problem}", $popup);
        }

        // The person arrived by following a redirect, so a failure here has to
        // end on a page they can read rather than a block of JSON.
        try {
            $resolved = self::resolveUser($organizationId, $claims);
        } catch (\Throwable $e) {
            error_log('[sso] could not match the account: ' . $e->getMessage());
            self::refuse($organizationId, 'failed', 'the staff account could not be matched or created', $popup);
        }

        if (isset($resolved['refused'])) {
            self::refuse($organizationId, $resolved['refused'], $resolved['why'], $popup);
        }

        $user = $resolved['user'];

        // A temporary password can no longer be needed, and asking somebody who
        // signs in through Microsoft to change a password they never see makes
        // no sense. So it stops working rather than staying valid and forgotten.
        Db::execute(
            'UPDATE users
                SET password_hash = IF(must_change_password = 1, ?, password_hash),
                    must_change_password = 0, last_login_at = NOW()
              WHERE id = ?',
            [Auth::hashPassword(bin2hex(random_bytes(32))), $user['id']],
        );

        $hours   = max(1, min(336, (int) Settings::get($organizationId, 'sso.session_hours')));
        $session = Auth::createSession((int) $user['id'], $request->ip, $request->header('User-Agent'), $hours);

        Auth::sendSessionCookie($session['id'], $session['expiresAt']);

        Audit::record(
            [
                'organizationId' => $organizationId,
                'userId'         => (int) $user['id'],
                'label'          => $user['full_name'],
                'actorType'      => 'user',
                'ip'             => $request->ip,
            ],
            [
                'action'      => Audit::LOGIN,
                'entityType'  => 'user',
                'entityId'    => (int) $user['id'],
                'entityLabel' => $user['email'],
                'summary'     => $user['full_name'] . ' signed in with Microsoft',
                'detail'      => ['method' => 'entra_id', 'linked_now' => $resolved['linked'] ?? false,
                                  'created_now' => $resolved['created'] ?? false],
            ],
        );

        Response::redirect($popup ? '/sso-complete.html' : '/');
    }

    /**
     * Swap the code for the ID token's claims.
     *
     * @throws \RuntimeException with a message for the audit log
     */
    private static function redeem(array $config, string $code, string $verifier, string $redirectUri): array
    {
        if (!function_exists('curl_init')) {
            throw new \RuntimeException('the curl extension is not available on this server');
        }

        $ch = curl_init(self::authority() . '/' . rawurlencode($config['tenantId']) . '/oauth2/v2.0/token');

        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => http_build_query([
                'client_id'     => $config['clientId'],
                'client_secret' => $config['clientSecret'],
                'grant_type'    => 'authorization_code',
                'code'          => $code,
                'redirect_uri'  => $redirectUri,
                'code_verifier' => $verifier,
                'scope'         => 'openid profile email',
            ]),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);

        $response = curl_exec($ch);
        $status   = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error    = curl_error($ch);

        if ($response === false) {
            throw new \RuntimeException("could not reach Microsoft: {$error}");
        }

        $body = json_decode((string) $response, true);

        if ($status !== 200 || !is_array($body) || !is_string($body['id_token'] ?? null)) {
            // "invalid_client" and an AADSTS number, which is what an
            // administrator needs. The description can run on, so it is cut.
            throw new \RuntimeException(sprintf(
                'Microsoft refused the code (HTTP %d): %s %s',
                $status,
                is_array($body) ? (string) ($body['error'] ?? '') : '',
                is_array($body) ? mb_substr(strtok((string) ($body['error_description'] ?? ''), "\r\n") ?: '', 0, 200) : '',
            ));
        }

        $parts   = explode('.', $body['id_token']);
        $payload = count($parts) === 3 ? base64_decode(strtr($parts[1], '-_', '+/'), true) : false;
        $claims  = $payload === false ? null : json_decode($payload, true);

        if (!is_array($claims)) {
            throw new \RuntimeException('Microsoft sent an ID token that could not be read');
        }

        return $claims;
    }

    /**
     * Why these claims cannot be accepted, or null if they can.
     *
     * Pure, so scripts/verify-security.php can walk every case.
     */
    public static function claimProblem(
        array $claims,
        string $authority,
        string $tenantId,
        string $clientId,
        string $nonce,
        int $now,
    ): ?string {
        $tenant = strtolower($tenantId);

        if (($claims['iss'] ?? null) !== "{$authority}/{$tenant}/v2.0") {
            return 'issuer';
        }
        if (strtolower((string) ($claims['tid'] ?? '')) !== $tenant) {
            return 'tenant';
        }
        if (($claims['aud'] ?? null) !== $clientId) {
            return 'audience';
        }
        if (!is_string($claims['nonce'] ?? null) || !hash_equals($nonce, $claims['nonce'])) {
            return 'nonce';
        }

        // Five minutes either way for clocks that disagree.
        if (!is_numeric($claims['exp'] ?? null) || (int) $claims['exp'] < $now - 300) {
            return 'expired';
        }
        if (is_numeric($claims['nbf'] ?? null) && (int) $claims['nbf'] > $now + 300) {
            return 'not_yet_valid';
        }
        if (!is_string($claims['oid'] ?? null) || !preg_match(self::GUID, $claims['oid'])) {
            return 'no_object_id';
        }

        // A B2B guest is in the directory but authenticates somewhere else, and
        // its preferred_username is an address in another organisation.
        if (isset($claims['idp']) && !str_contains(strtolower((string) $claims['idp']), $tenant)) {
            return 'guest';
        }

        return null;
    }

    /**
     * Find, link or create the staff account for these claims.
     *
     * @return array{user?: array, linked?: bool, created?: bool, refused?: string, why?: string}
     */
    private static function resolveUser(int $organizationId, array $claims): array
    {
        $select = 'SELECT id, organization_id, email, full_name, role, active, entra_oid FROM users ';
        $oid    = strtolower((string) $claims['oid']);
        $name   = strtolower(trim((string) ($claims['preferred_username'] ?? '')));

        $user = Db::one($select . 'WHERE organization_id = ? AND entra_oid = ?', [$organizationId, $oid]);

        if ($user !== null) {
            return (int) $user['active'] === 1
                ? ['user' => $user]
                : ['refused' => 'inactive', 'why' => "{$user['email']} is deactivated"];
        }

        $byName = $name === '' ? null
            : Db::one($select . 'WHERE organization_id = ? AND email = ?', [$organizationId, $name]);

        if ($byName !== null) {
            if ($byName['entra_oid'] !== null) {
                return ['refused' => 'mismatch',
                        'why' => "{$name} is linked to a different Microsoft account"];
            }
            if ((int) $byName['active'] !== 1) {
                return ['refused' => 'inactive', 'why' => "{$name} is deactivated"];
            }

            Db::execute('UPDATE users SET entra_oid = ? WHERE id = ?', [$oid, $byName['id']]);

            return ['user' => $byName, 'linked' => true];
        }

        if (!Settings::get($organizationId, 'sso.auto_create') || !filter_var($name, FILTER_VALIDATE_EMAIL)) {
            return ['refused' => 'no_account', 'why' => "no staff account for {$name}"];
        }

        $role = (string) Settings::get($organizationId, 'sso.default_role');
        $role = in_array($role, self::CREATABLE_ROLES, true) ? $role : 'viewer';
        $full = Util::str($claims['name'] ?? null, 190) ?? $name;

        $id = Db::insert(
            'INSERT INTO users (organization_id, email, password_hash, full_name, role, active,
                                must_change_password, entra_oid)
             VALUES (?, ?, ?, ?, ?, 1, 0, ?)',
            [$organizationId, $name, Auth::hashPassword(bin2hex(random_bytes(32))), $full, $role, $oid],
        );

        Audit::record(Audit::system($organizationId, 'Microsoft sign-in'), [
            'organizationId' => $organizationId,
            'action'         => Audit::USER_CREATED,
            'entityType'     => 'user',
            'entityId'       => $id,
            'entityLabel'    => $full,
            'summary'        => "Account created for {$full} ({$name}) as {$role}, at first Microsoft sign-in",
        ]);

        return [
            'user'    => Db::one($select . 'WHERE id = ?', [$id]),
            'created' => true,
        ];
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /** Write down why, then send the person back with a code and no details. */
    private static function refuse(int $organizationId, string $code, string $why, bool $popup): never
    {
        Audit::record(Audit::system($organizationId, 'Microsoft sign-in'), [
            'organizationId' => $organizationId,
            'action'         => Audit::LOGIN_FAILED,
            'entityType'     => 'user',
            'summary'        => "Microsoft sign-in refused: {$why}",
            'detail'         => ['method' => 'entra_id', 'code' => $code],
        ]);

        self::finish($code, $popup);
    }

    private static function finish(string $error, bool $popup): never
    {
        Response::redirect($popup
            ? '/sso-complete.html?error=' . rawurlencode($error)
            : '/?sso_error=' . rawurlencode($error));
    }

    private static function clearCookie(): void
    {
        setcookie(self::COOKIE, '', [
            'expires'  => time() - 3600,
            'path'     => '/api/',
            'httponly' => true,
            'samesite' => 'Lax',
            'secure'   => Auth::cookieMustBeSecure(),
        ]);
    }

    private static function base64Url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    public static function prune(): int
    {
        return Db::execute('DELETE FROM sso_states WHERE expires_at < NOW()');
    }
}
