<?php
/**
 * Sign in, sign out, "who am I", password change and password reset.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Audit;
use Loaner\Auth;
use Loaner\Db;
use Loaner\Request;
use Loaner\Response;
use Loaner\Router;
use Loaner\Sso;
use Loaner\Util;

final class Authentication
{
    /**
     * Every failed sign-in returns the same message and status, whatever the
     * underlying reason. The audit log records the real cause; the response
     * does not, so this endpoint cannot be used to enumerate staff.
     */
    private const GENERIC_FAILURE = 'That email address and password combination was not recognised.';

    public static function register(Router $router): void
    {
        $router->post('/auth/login', [self::class, 'login']);
        $router->post('/auth/logout', [self::class, 'logout']);
        $router->get('/auth/me', [self::class, 'me']);
        $router->post('/auth/change-password', [self::class, 'changePassword']);
        $router->post('/auth/forgot-password', [self::class, 'forgotPassword']);
        $router->post('/auth/reset-password', [self::class, 'resetPassword']);
        $router->post('/auth/login/verify', [self::class, 'verifySecondFactor']);

        // No capability: these are how somebody gets one.
        $router->get('/auth/sso/status', [self::class, 'ssoStatus']);
        $router->get('/auth/sso/start', [Sso::class, 'start']);
        $router->get('/auth/sso/callback', [Sso::class, 'callback']);
    }

    public static function login(Request $request): never
    {
        $email    = Util::email($request->input('email'), 'Email address', true);
        $password = Util::text($request->input('password'));

        if ($password === '') {
            throw Util::badRequest('Enter your password.', ['field' => 'password']);
        }

        $result = Auth::attemptLogin($email, $password);

        if (!$result['ok']) {
            if (isset($result['user'])) {
                Audit::record(
                    [
                        'organizationId' => (int) $result['user']['organization_id'],
                        'userId'         => (int) $result['user']['id'],
                        'label'          => $result['user']['full_name'],
                        'actorType'      => 'user',
                        'ip'             => $request->ip,
                    ],
                    [
                        'action'      => Audit::LOGIN_FAILED,
                        'entityType'  => 'user',
                        'entityId'    => (int) $result['user']['id'],
                        'entityLabel' => $result['user']['email'],
                        'summary'     => "Failed sign-in attempt ({$result['reason']})",
                        'detail'      => ['reason' => $result['reason']],
                    ],
                );
            }

            // A locked account is worth saying out loud: the person is
            // legitimate and otherwise has no way to understand why a correct
            // password suddenly stops working.
            if ($result['reason'] === 'locked') {
                $until = date('g:i a', strtotime((string) $result['lockedUntil']));
                Response::error(
                    423,
                    'account_locked',
                    'This account is temporarily locked after too many failed sign-in attempts. '
                    . "Try again after {$until}, or ask an administrator to unlock it.",
                );
            }

            // The password was right but a code is needed. Not an error: the
            // sign-in is half done, and the client is told how to finish it.
            if ($result['reason'] === 'sso_required') {
                Response::error(
                    403,
                    'sso_required',
                    'This organisation signs in with Microsoft. Use the "Sign in with Microsoft" button.',
                );
            }

            if ($result['reason'] === 'totp_required') {
                Response::json([
                    'second_factor_required' => true,
                    'pending_id'  => $result['pendingId'],
                    'can_recover' => $result['canRecover'],
                    'message'     => 'Enter the six-digit code from your authenticator app.',
                    'recovery_hint' => $result['canRecover']
                        ? 'Lost the phone? A recovery code works here too.'
                        : 'You have no recovery codes left. If you cannot produce a code, another '
                          . 'administrator will have to reset two-factor on your account.',
                ], 200);
            }

            if ($result['reason'] === 'inactive') {
                Response::error(
                    403,
                    'account_inactive',
                    'This account has been deactivated. Contact an administrator.',
                );
            }

            Response::error(401, 'invalid_credentials', self::GENERIC_FAILURE);
        }

        $user    = $result['user'];
        $session = Auth::createSession(
            (int) $user['id'],
            $request->ip,
            $request->header('User-Agent'),
        );

        Auth::sendSessionCookie($session['id'], $session['expiresAt']);

        Audit::record(
            [
                'organizationId' => (int) $user['organization_id'],
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
                'summary'     => $user['full_name'] . ' signed in',
            ],
        );

        Response::json([
            'user'                 => Auth::publicUser($user),
            'organization'         => self::organization((int) $user['organization_id']),
            'capabilities'         => Auth::capabilitiesForRole($user['role']),
            'must_change_password' => (bool) $user['must_change_password'],
            // Checked after sign-in rather than at the door: an administrator
            // who has not enrolled yet has to be able to get in to do it, or
            // turning the requirement on would lock out whoever turned it on.
            'must_enrol_2fa'       => Auth::mustEnrolSecondFactor($user, (int) $user['organization_id']),
        ]);
    }

    public static function ssoStatus(Request $request): never
    {
        Response::json(Sso::publicStatus());
    }

    /**
     * Second step of a two-factor sign-in.
     *
     * The half-finished attempt lives server-side, so a browser cannot skip
     * from "password accepted" to "signed in" by editing what it holds.
     */
    public static function verifySecondFactor(Request $request): never
    {
        $pendingId = Util::str($request->input('pending_id'), 128);
        $code      = Util::text($request->input('code'));

        if ($pendingId === null) {
            throw Util::badRequest('Start signing in again.', ['field' => 'pending_id']);
        }

        if (trim($code) === '') {
            throw Util::badRequest('Enter the code from your authenticator app.', ['field' => 'code']);
        }

        $result = Auth::completeSecondFactor($pendingId, $code);

        if (!$result['ok']) {
            if (isset($result['user'])) {
                Audit::record(
                    [
                        'organizationId' => (int) $result['user']['organization_id'],
                        'userId'         => (int) $result['user']['user_id'],
                        'label'          => $result['user']['full_name'],
                        'actorType'      => 'user',
                        'ip'             => $request->ip,
                    ],
                    [
                        'action'     => Audit::TWOFACTOR_FAILED,
                        'entityType' => 'user',
                        'entityId'   => (int) $result['user']['user_id'],
                        'summary'    => 'Wrong two-factor code on sign-in',
                    ],
                );
            }

            if ($result['reason'] === 'locked') {
                Response::error(
                    423,
                    'account_locked',
                    'This account is temporarily locked after too many wrong codes. Try again after '
                    . date('g:i a', strtotime((string) $result['lockedUntil']))
                    . ', or ask an administrator to unlock it.',
                );
            }

            Response::error(401, 'bad_code', match ($result['reason']) {
                'expired' => 'That sign-in attempt has expired. Enter your email and password again.',
                'too_many_attempts' => 'Too many wrong codes. Enter your email and password again.',
                default => isset($result['remaining']) && $result['remaining'] > 0
                    ? "That code is not right. {$result['remaining']} attempt(s) left before you have "
                      . 'to start again.'
                    : 'That code is not right.',
            });
        }

        $user    = $result['user'];
        $session = Auth::createSession((int) $user['id'], $request->ip, $request->header('User-Agent'));

        Auth::sendSessionCookie($session['id'], $session['expiresAt']);

        $actor = [
            'organizationId' => (int) $user['organization_id'],
            'userId'         => (int) $user['id'],
            'label'          => $user['full_name'],
            'actorType'      => 'user',
            'ip'             => $request->ip,
        ];

        Audit::record($actor, [
            'action'      => $result['usedRecovery'] ? Audit::TWOFACTOR_RECOVERY_USED : Audit::LOGIN,
            'entityType'  => 'user',
            'entityId'    => (int) $user['id'],
            'entityLabel' => $user['email'],
            'summary'     => $result['usedRecovery']
                ? $user['full_name'] . ' signed in with a recovery code ('
                  . $result['recoveryRemaining'] . ' left)'
                : $user['full_name'] . ' signed in with a second factor',
        ]);

        Response::json([
            'user'                 => Auth::publicUser($user),
            'organization'         => self::organization((int) $user['organization_id']),
            'capabilities'         => Auth::capabilitiesForRole($user['role']),
            'must_change_password' => (bool) $user['must_change_password'],
            // Said plainly, because somebody down to their last code needs to
            // generate more before they are locked out of their own system.
            'used_recovery_code'   => $result['usedRecovery'],
            'recovery_notice'      => $result['usedRecovery']
                ? sprintf(
                    'You signed in with a recovery code. %d left. Generate a fresh set from your '
                    . 'account settings.',
                    $result['recoveryRemaining'],
                )
                : null,
        ]);
    }

    public static function logout(Request $request): never
    {
        if (($request->auth['sessionId'] ?? null) !== null) {
            Auth::destroySession($request->auth['sessionId']);

            Audit::record(Audit::actor($request), [
                'action'     => Audit::LOGOUT,
                'entityType' => 'user',
                'entityId'   => $request->auth['userId'],
                'summary'    => ($request->auth['fullName'] ?? 'Someone') . ' signed out',
            ]);
        }

        Auth::clearSessionCookie();
        Response::json(['ok' => true]);
    }

    /** Current identity. The client calls this on load to decide what to render. */
    public static function me(Request $request): never
    {
        if ($request->auth === null) {
            Response::error(401, 'unauthorized', 'Not signed in.');
        }

        if ($request->auth['actorType'] === 'api_key') {
            Response::json([
                'actor_type'   => 'api_key',
                'organization' => self::organization((int) $request->auth['organizationId']),
                'scopes'       => $request->auth['scopes'],
                'capabilities' => $request->auth['capabilities'],
            ]);
        }

        $user = Db::one(
            'SELECT id, organization_id, email, full_name, role, phone, employee_ref,
                    last_login_at, must_change_password, created_at
               FROM users WHERE id = ?',
            [$request->auth['userId']],
        );

        if ($user === null) {
            throw Util::unauthorized('Your account no longer exists.');
        }

        Response::json([
            'actor_type'           => 'user',
            'user'                 => Auth::publicUser($user),
            'organization'         => self::organization((int) $user['organization_id']),
            'capabilities'         => Auth::capabilitiesForRole($user['role']),
            'must_change_password' => (bool) $user['must_change_password'],
        ]);
    }

    /**
     * Change your own password.
     *
     * Requires the current password even though the session already proves
     * identity — that is what stops an unattended, unlocked browser from
     * becoming a permanent account takeover.
     */
    public static function changePassword(Request $request): never
    {
        $auth = Auth::requireAuth($request);

        if ($auth['actorType'] !== 'user') {
            throw Util::badRequest('API keys do not have passwords.');
        }

        $current = Util::text($request->input('current_password'));
        $new     = Util::text($request->input('new_password'));
        $confirm = Util::text($request->input('confirm_password') ?? $new);

        if ($new !== $confirm) {
            throw Util::badRequest('The two new passwords do not match.', ['field' => 'confirm_password']);
        }

        $user = Db::one('SELECT id, password_hash, full_name FROM users WHERE id = ?', [$auth['userId']]);
        if ($user === null) {
            throw Util::unauthorized('Your account no longer exists.');
        }

        if (!Auth::verifyPassword($current, $user['password_hash'])) {
            throw Util::badRequest('Your current password is not correct.', ['field' => 'current_password']);
        }

        if ($new === $current) {
            throw Util::badRequest('The new password must be different from the current one.', ['field' => 'new_password']);
        }

        Auth::validatePassword($new);

        Db::execute(
            'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = NOW() WHERE id = ?',
            [Auth::hashPassword($new), $user['id']],
        );

        // Invalidate every other session, then re-issue one for this browser.
        // If the password is being changed because it leaked, leaving other
        // sessions alive would defeat the point.
        Auth::destroyAllSessionsForUser((int) $user['id']);
        $session = Auth::createSession((int) $user['id'], $request->ip, $request->header('User-Agent'));
        Auth::sendSessionCookie($session['id'], $session['expiresAt']);

        Audit::record(Audit::actor($request), [
            'action'      => Audit::PASSWORD_CHANGED,
            'entityType'  => 'user',
            'entityId'    => (int) $user['id'],
            'entityLabel' => $user['full_name'],
            'summary'     => $user['full_name'] . ' changed their password; all other sessions were signed out',
        ]);

        Response::json(['ok' => true, 'other_sessions_ended' => true]);
    }

    // -----------------------------------------------------------------------
    // Self-service reset
    //
    // Both endpoints are unauthenticated by necessity, so both give away
    // nothing: the request endpoint always reports success, and the confirm
    // endpoint distinguishes only "this link works" from "it does not".
    // -----------------------------------------------------------------------

    private const RESET_LIFETIME_MINUTES = 60;
    private const RESET_THROTTLE_MINUTES = 5;

    public static function forgotPassword(Request $request): never
    {
        $email = Util::email($request->input('email'), 'Email address', true);

        $generic = [
            'ok'      => true,
            'message' => 'If that address belongs to an account, a reset link has been sent to it. '
                       . 'The link is valid for one hour.',
        ];

        $user = Db::one(
            'SELECT id, organization_id, email, full_name, active FROM users WHERE email = ?',
            [$email],
        );

        if ($user === null || (int) $user['active'] !== 1) {
            Response::json($generic);
        }

        // A reset would produce a password this account cannot use.
        if (!\Loaner\Sso::passwordAllowed(Db::one(
            'SELECT organization_id, role FROM users WHERE id = ?', [$user['id']],
        ))) {
            Response::json($generic);
        }

        // One message per mailbox every few minutes, however often the form is
        // submitted: nothing else stands between this unauthenticated endpoint
        // and somebody's inbox. The answer is the same either way.
        $recent = Db::value(
            'SELECT id FROM password_resets
              WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE) LIMIT 1',
            [$user['id'], self::RESET_THROTTLE_MINUTES],
        );

        if ($recent !== null) {
            Response::json($generic);
        }

        // Invalidate any outstanding link, so a forwarded old email is useless.
        Db::execute('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [$user['id']]);

        $token     = Util::randomToken(32);
        $expiresAt = new \DateTimeImmutable('+' . self::RESET_LIFETIME_MINUTES . ' minutes');

        Db::execute(
            'INSERT INTO password_resets (user_id, token_hash, expires_at, ip) VALUES (?, ?, ?, ?)',
            [$user['id'], Util::sha256($token), Util::mysqlDateTime($expiresAt), $request->ip ?: null],
        );

        $link = $request->baseUrl() . '/#/reset?token=' . $token;
        $mail = \Loaner\Mailer::sendPasswordReset((int) $user['organization_id'], $user, $link);

        Audit::record(
            [
                'organizationId' => (int) $user['organization_id'],
                'userId'         => (int) $user['id'],
                'label'          => $user['full_name'],
                'actorType'      => 'system',
                'ip'             => $request->ip,
            ],
            [
                'action'      => Audit::PASSWORD_RESET_REQUESTED,
                'entityType'  => 'user',
                'entityId'    => (int) $user['id'],
                'entityLabel' => $user['email'],
                'summary'     => "Password reset requested for {$user['email']}"
                               . ($mail['sent'] ? '' : " (email not sent: {$mail['reason']})"),
            ],
        );

        // If email is not configured the link cannot reach anyone, and
        // silently reporting success leaves an administrator waiting for mail
        // that never comes. Say so — but only to a caller already signed in.
        if (!$mail['sent'] && in_array('settings.write', $request->auth['capabilities'] ?? [], true)) {
            Response::json($generic + ['admin_warning' => 'No email was sent: ' . $mail['reason']]);
        }

        Response::json($generic);
    }

    public static function resetPassword(Request $request): never
    {
        $token   = Util::str($request->input('token'), 128);
        $new     = Util::text($request->input('new_password'));
        $confirm = Util::text($request->input('confirm_password') ?? $new);

        if ($token === null) {
            throw Util::badRequest('That reset link is missing its token.', ['field' => 'token']);
        }

        if ($new !== $confirm) {
            throw Util::badRequest('The two passwords do not match.', ['field' => 'confirm_password']);
        }

        Auth::validatePassword($new);

        $record = Db::one(
            'SELECT r.id, r.user_id, u.email, u.full_name, u.organization_id, u.active
               FROM password_resets r
               JOIN users u ON u.id = r.user_id
              WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW()',
            [Util::sha256($token)],
        );

        if ($record === null || (int) $record['active'] !== 1) {
            throw Util::badRequest(
                'That reset link is not valid. It may have expired, already been used, or been '
                . 'replaced by a newer one. Request a fresh link and try again.',
                ['field' => 'token'],
            );
        }

        // Claimed before it is spent, so a link can only ever be used once even
        // if it is submitted twice at the same moment.
        $claimed = Db::execute(
            'UPDATE password_resets SET used_at = NOW() WHERE id = ? AND used_at IS NULL',
            [$record['id']],
        );

        if ($claimed !== 1) {
            throw Util::badRequest(
                'That reset link is not valid. It may have expired, already been used, or been '
                . 'replaced by a newer one. Request a fresh link and try again.',
                ['field' => 'token'],
            );
        }

        Db::execute(
            'UPDATE users SET password_hash = ?, must_change_password = 0, failed_logins = 0,
                    locked_until = NULL, updated_at = NOW() WHERE id = ?',
            [Auth::hashPassword($new), $record['user_id']],
        );

        // Everything else signed in as this account is now suspect.
        Auth::destroyAllSessionsForUser((int) $record['user_id']);

        Audit::record(
            [
                'organizationId' => (int) $record['organization_id'],
                'userId'         => (int) $record['user_id'],
                'label'          => $record['full_name'],
                'actorType'      => 'system',
                'ip'             => $request->ip,
            ],
            [
                'action'      => Audit::PASSWORD_RESET_COMPLETED,
                'entityType'  => 'user',
                'entityId'    => (int) $record['user_id'],
                'entityLabel' => $record['email'],
                'summary'     => $record['full_name'] . ' reset their password via email; all sessions were ended',
            ],
        );

        Response::json([
            'ok'      => true,
            'message' => 'Your password has been changed. Sign in with the new one.',
        ]);
    }

    /** Public-safe view of the organisation row. */
    public static function organization(int $organizationId): ?array
    {
        $org = Db::one('SELECT * FROM organizations WHERE id = ?', [$organizationId]);

        if ($org === null) {
            return null;
        }

        return [
            'id'                => (int) $org['id'],
            'name'              => $org['name'],
            'slug'              => $org['slug'],
            'timezone'          => $org['timezone'],
            'barcode_symbology' => $org['barcode_symbology'],
            'barcode_prefix'    => $org['barcode_prefix'],
            'contact_email'     => $org['contact_email'],
        ];
    }
}
