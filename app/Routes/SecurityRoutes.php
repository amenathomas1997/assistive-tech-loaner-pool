<?php
/**
 * Two-factor enrolment, backups and data retention.
 *
 * The three places where an administrator does something consequential to the
 * installation rather than to a loan. All of them re-confirm the password,
 * for the same reason the updater does: an open session on an unattended
 * machine should not be enough.
 */

declare(strict_types=1);

namespace Loaner\Routes;

use Loaner\Audit;
use Loaner\Auth;
use Loaner\Backup;
use Loaner\Db;
use Loaner\Qr;
use Loaner\Request;
use Loaner\Response;
use Loaner\Retention;
use Loaner\Router;
use Loaner\Secrets;
use Loaner\Settings;
use Loaner\Totp;
use Loaner\Util;

final class SecurityRoutes
{
    public static function register(Router $router): void
    {
        // --- Two-factor, for your own account --------------------------------
        $router->get('/auth/2fa', [self::class, 'status']);
        $router->post('/auth/2fa/begin', [self::class, 'begin']);
        $router->post('/auth/2fa/confirm', [self::class, 'confirm']);
        $router->post('/auth/2fa/disable', [self::class, 'disable']);
        $router->post('/auth/2fa/recovery-codes', [self::class, 'regenerateRecoveryCodes']);

        // --- Backups ---------------------------------------------------------
        $router->get('/admin/backup', [self::class, 'backupSummary'], 'settings.read');
        $router->post('/admin/backup', [self::class, 'downloadBackup']);

        // --- Retention -------------------------------------------------------
        $router->get('/admin/retention', [self::class, 'retention'], 'settings.read');
        $router->post('/admin/retention/purge', [self::class, 'purge']);
    }

    // -----------------------------------------------------------------------
    // Two-factor
    // -----------------------------------------------------------------------

    public static function status(Request $request): never
    {
        $auth = Auth::requireAuth($request);

        if (($auth['actorType'] ?? '') !== 'user') {
            throw Util::badRequest('API keys do not sign in, so they have no second factor.');
        }

        $user = Db::one(
            'SELECT totp_enabled, totp_confirmed_at, role FROM users WHERE id = ?',
            [$auth['userId']],
        );

        $required = (bool) Settings::get((int) $auth['organizationId'], 'security.require_2fa_for_admins');

        Response::json([
            'enabled'       => (bool) ($user['totp_enabled'] ?? false),
            'confirmed_at'  => $user['totp_confirmed_at'] ?? null,
            'recovery_codes_remaining' => Totp::remainingRecoveryCodes((int) $auth['userId']),
            'required_for_you' => $required && ($user['role'] ?? '') === 'admin',
            'required_for_admins' => $required,
            'notice' => $required && ($user['role'] ?? '') === 'admin' && empty($user['totp_enabled'])
                ? 'This organisation requires administrators to use a second factor. Set one up now.'
                : null,
        ]);
    }

    /**
     * Start enrolment: issue a secret and the QR to scan.
     *
     * The secret is stored immediately but not switched on, so a half-finished
     * enrolment leaves nothing behind that could lock anyone out. Only
     * confirm() — which proves a working app — turns it on.
     */
    public static function begin(Request $request): never
    {
        $auth = self::requireOwnAccount($request);

        // Re-enrolling replaces a working second factor, which is the same
        // weakening disable() asks for a password before doing. Without this,
        // begin() was a password-free way to strip two-factor from an account
        // using nothing but a stolen session.
        $current = Db::one('SELECT totp_enabled FROM users WHERE id = ?', [$auth['userId']]);

        if (!empty($current['totp_enabled'])) {
            self::confirmPassword($auth, $request->input('password'));
        }

        $secret = Totp::generateSecret();

        // The pending secret is kept apart from the live one, so an enrolment
        // that is started and then abandoned leaves a working account exactly
        // as it was. Writing over totp_secret here meant a half-finished
        // set-up silently removed the protection it was meant to renew.
        Db::execute(
            'UPDATE users SET totp_pending_secret = ? WHERE id = ?',
            [Secrets::encrypt($secret), $auth['userId']],
        );

        $organization = Settings::organization((int) $auth['organizationId']);

        $uri = Totp::provisioningUri(
            $secret,
            (string) ($auth['email'] ?? 'account'),
            (string) ($organization['name'] ?? 'Loaner Pool'),
        );

        Response::json([
            // The QR is rendered here rather than in the browser so the page
            // needs no library, and the same encoder prints the device labels.
            'qr_svg'          => Qr::svg($uri, ['moduleSize' => 5, 'quietZone' => 2,
                                                'title' => 'Set-up code for your authenticator app']),
            'secret'          => $secret,
            'secret_formatted' => Totp::formatSecret($secret),
            'uri'             => $uri,
            'steps' => [
                'Install an authenticator app if you do not have one — Google Authenticator, Microsoft '
                . 'Authenticator, 1Password and many password managers all work.',
                'Scan the square code with it, or type the letters in by hand if the camera will not focus.',
                'Enter the six-digit code the app shows, to prove it is working.',
            ],
            'notice' => 'Nothing changes until you enter a code. If you stop here, your sign-in stays '
                      . 'exactly as it is.',
        ]);
    }

    /**
     * Prove the app works, then switch it on.
     *
     * Recovery codes are issued at this moment and shown once. Without them a
     * lost phone means a locked-out administrator and nobody able to help.
     */
    public static function confirm(Request $request): never
    {
        $auth = self::requireOwnAccount($request);

        $code = (string) ($request->input('code') ?? '');

        $user   = Db::one('SELECT totp_pending_secret FROM users WHERE id = ?', [$auth['userId']]);
        $secret = Secrets::decrypt($user['totp_pending_secret'] ?? null);

        if ($secret === null || $secret === '') {
            throw Util::badRequest('Start the set-up again — there is no pending secret for this account.');
        }

        $counter = Totp::matchCounter($secret, $code);

        if ($counter === null) {
            throw Util::badRequest(
                'That code is not right. Check the app is showing a code for this account, and that '
                . 'the phone\'s clock is correct.',
                ['field' => 'code'],
            );
        }

        // Only now does the new secret become the live one. The step just
        // used is recorded with it, so the code that proved the app works
        // cannot also be the code that signs somebody in a moment later.
        Db::execute(
            'UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
                    totp_enabled = 1, totp_confirmed_at = NOW(), totp_last_counter = ?
              WHERE id = ?',
            [$counter, $auth['userId']],
        );

        $codes = Totp::issueRecoveryCodes((int) $auth['userId']);

        Audit::record(Audit::actor($request), [
            'action'      => Audit::TWOFACTOR_ENABLED,
            'entityType'  => 'user',
            'entityId'    => (int) $auth['userId'],
            'entityLabel' => $auth['fullName'] ?? null,
            'summary'     => ($auth['fullName'] ?? 'Someone') . ' turned on two-factor sign-in',
        ]);

        Response::json([
            'enabled'        => true,
            'recovery_codes' => $codes,
            'notice' => 'Save these recovery codes somewhere safe and away from your phone. Each works '
                      . 'once. They are the only way back in if you lose the phone, and they cannot be '
                      . 'shown again.',
        ], 201);
    }

    public static function disable(Request $request): never
    {
        $auth = self::requireOwnAccount($request);

        // The password again. Otherwise an unattended browser is enough to
        // take the second factor off, which defeats having one.
        self::confirmPassword($auth, $request->input('password'));

        $user = Db::one('SELECT role FROM users WHERE id = ?', [$auth['userId']]);

        if (($user['role'] ?? '') === 'admin'
            && Settings::get((int) $auth['organizationId'], 'security.require_2fa_for_admins')
        ) {
            throw Util::conflict(
                'This organisation requires administrators to use a second factor, so it cannot be '
                . 'switched off for your account. An administrator can change that requirement in '
                . 'Settings first.',
            );
        }

        Db::transaction(static function () use ($auth): void {
            Db::execute(
                'UPDATE users SET totp_enabled = 0, totp_secret = NULL,
                        totp_pending_secret = NULL, totp_confirmed_at = NULL
                  WHERE id = ?',
                [$auth['userId']],
            );
            Db::execute('DELETE FROM totp_recovery_codes WHERE user_id = ?', [$auth['userId']]);
        });

        Audit::record(Audit::actor($request), [
            'action'      => Audit::TWOFACTOR_DISABLED,
            'entityType'  => 'user',
            'entityId'    => (int) $auth['userId'],
            'entityLabel' => $auth['fullName'] ?? null,
            'summary'     => ($auth['fullName'] ?? 'Someone') . ' turned off two-factor sign-in',
        ]);

        Response::json(['enabled' => false, 'message' => 'Two-factor sign-in is off for your account.']);
    }

    public static function regenerateRecoveryCodes(Request $request): never
    {
        $auth = self::requireOwnAccount($request);

        self::confirmPassword($auth, $request->input('password'));

        $user = Db::one('SELECT totp_enabled FROM users WHERE id = ?', [$auth['userId']]);

        if (empty($user['totp_enabled'])) {
            throw Util::badRequest('Two-factor sign-in is not on for this account.');
        }

        $codes = Totp::issueRecoveryCodes((int) $auth['userId']);

        Response::json([
            'recovery_codes' => $codes,
            'notice' => 'These replace your previous codes, which no longer work. Save them somewhere '
                      . 'safe and away from your phone.',
        ]);
    }

    private static function requireOwnAccount(Request $request): array
    {
        $auth = Auth::requireAuth($request);

        if (($auth['actorType'] ?? '') !== 'user') {
            throw Util::forbidden('Only a signed-in person can change their own sign-in settings.');
        }

        return $auth;
    }

    private static function confirmPassword(array $auth, mixed $password): void
    {
        if (!is_string($password) || $password === '') {
            throw Util::badRequest('Enter your password to confirm.', ['field' => 'password']);
        }

        $user = Db::one('SELECT password_hash FROM users WHERE id = ?', [$auth['userId']]);

        if ($user === null || !Auth::verifyPassword($password, $user['password_hash'])) {
            throw Util::badRequest('That password is not correct.', ['field' => 'password']);
        }
    }

    // -----------------------------------------------------------------------
    // Backups
    // -----------------------------------------------------------------------

    public static function backupSummary(Request $request): never
    {
        Response::json(Backup::summary((int) $request->auth['organizationId']));
    }

    /**
     * Download the database.
     *
     * POST rather than GET because it needs the password in the body, and
     * because a URL that dumps the entire database is not something to leave
     * in a browser history.
     */
    public static function downloadBackup(Request $request): never
    {
        $auth = Auth::requireAuth($request);

        Backup::stream($auth, $request->input('password'));
    }

    // -----------------------------------------------------------------------
    // Retention
    // -----------------------------------------------------------------------

    public static function retention(Request $request): never
    {
        Response::json(Retention::preview((int) $request->auth['organizationId']));
    }

    /**
     * Apply the retention policy now.
     *
     * This destroys personal data on purpose, so it is gated like the updater:
     * administrator, password re-entered, and audited — including the entry
     * recording that audit entries were deleted.
     */
    public static function purge(Request $request): never
    {
        $auth = Auth::requireAuth($request);

        if (($auth['actorType'] ?? '') !== 'user' || ($auth['role'] ?? '') !== 'admin') {
            throw Util::forbidden(
                'Only a signed-in administrator can apply the retention policy. It permanently removes '
                . 'personal data.',
            );
        }

        self::confirmPassword($auth, $request->input('password'));

        $organizationId = (int) $auth['organizationId'];

        if (!Settings::get($organizationId, 'retention.enabled')) {
            throw Util::conflict(
                'Retention is switched off. Turn it on in Settings, check what the preview says it '
                . 'would remove, and then run it.',
            );
        }

        Response::json(Retention::purge(Audit::actor($request), $organizationId));
    }
}
